/** Resolve a fresh owner request to one existing document task, then use the ordinary guarded continuation relay. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { AgentDelivery } from '../app/delivery.ts'
import { documentContinuationIntent, type DocumentContinuationIntent } from './document-continuation-intent.ts'
import type { DocumentContinuationSource } from './document-continuation-store.ts'
import { continueDocument, documentHoldError } from './instructions.ts'
import { isOwnerInboxInsertion, isSameOwnerInboxTurn, publishOwnerInboxReceipt,
  type OwnerInboxInput, type OwnerInboxStep } from './owner-inbox-input.ts'
import type { ManagedTask, ManagedWorkerStore, StudioFeishuInstruction } from './store.ts'

type Role = 'assistant' | 'document-worker'
type Outcome = { kind: 'success' | 'error'; text: string }

/** Only routing coordinates belong in a reply. Never echo the approved text or another channel's messages. */
function coordinates(task: ManagedTask): string {
  return `Task ${task.taskId}; Worker Session ${task.workerSessionId}; execution epoch ${task.executionEpoch}; authorization version ${task.authorizationVersion}.`
}

function refused(reason: string, task?: ManagedTask): Outcome {
  const hints: Record<string, string> = {
    TASK_PAUSED: ' Check /studio-doc status in the current Worker. Resume explicitly only if the current approval still applies, then send a new continuation request.',
    INSTRUCTION_PENDING: ' Review all pending input before sending a new continuation request.',
    WORKER_NOT_OPEN: ' Open the current Worker in Studio Web and check /studio-doc status before sending a new request.',
    MANAGED_SESSION_REQUIRED: ' Check that the current Worker uses the Studio managed Worker preset and read-only permissions.',
    FEISHU_DOCUMENT_NOT_BOUND: ' Link the intended task from its current Worker in Studio Web with /studio-doc bind-feishu.',
    TASK_SCOPE_MISMATCH: ' This chat can only continue its linked document task.',
    FEISHU_MESSAGE_LATE: ' Check the current task in Studio Web before sending a new request.',
    VERSION_CONFLICT: ' Read the task status in Studio Web; this request did not repeat a completed write.',
  }
  return { kind: 'error', text: (documentHoldError(reason)?.text ?? `Document continuation not queued: ${reason}.`)
    + (hints[reason] ?? '') + (task ? `\n${coordinates(task)}` : '') }
}

/** Admit exactly one native route from each source; the task stays under its original Worker and authorization. */
export class StudioDocumentContinuation {
  private readonly pending = new Set<Promise<unknown>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly delivery: AgentDelivery,
    private readonly ready: (agent: Agent, role: Role) => boolean, private readonly stopping: AbortSignal) {}

  reviewWeb(step: OwnerInboxStep, input: OwnerInboxInput, topicTaskId?: string): Promise<void> | undefined {
    const intent = documentContinuationIntent(input.text)
    if (!intent) return
    if (topicTaskId && intent.taskId && intent.taskId !== topicTaskId) {
      publishOwnerInboxReceipt(step.agent, input, 'studio-document-continuation', refused('TASK_SCOPE_MISMATCH'))
      return Promise.resolve()
    }
    return this.track(this.web(step, input, topicTaskId ? { taskId: topicTaskId } : intent))
  }

  /** The listener calls this only after checking the dedicated bot, private chat and owner. */
  receiveFeishu(source: StudioFeishuInstruction, intent: DocumentContinuationIntent, caller: AbortSignal): Promise<string | undefined> {
    const signal = AbortSignal.any([caller, this.stopping])
    const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs } = source
    const coordinates = { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs }
    return this.track(this.route(coordinates, intent, signal, () => !signal.aborted).then(result => result?.text))
  }

  async drain(): Promise<void> { await Promise.allSettled(this.pending) }

  private track<T>(run: Promise<T>): Promise<T> {
    this.pending.add(run)
    const remove = () => { this.pending.delete(run) }
    void run.then(remove, remove)
    return run
  }

  private async web(step: OwnerInboxStep, input: OwnerInboxInput, intent: DocumentContinuationIntent): Promise<void> {
    const { agent } = step
    const signal = AbortSignal.any([step.signal, this.stopping])
    const current = () => !signal.aborted && this.ready(agent, 'assistant') && isSameOwnerInboxTurn(agent, input)
    let result: Outcome | undefined
    try {
      await this.ctx.sessionPersistence.flush()
      signal.throwIfAborted()
      const verified = await this.verifyWebSource(agent, input, signal)
      signal.throwIfAborted()
      result = !verified ? refused('CONTINUATION_SOURCE_UNCONFIRMED') : await this.route({ channel: 'gui', sourceScope: agent.id,
        requestId: input.sourceRequestId, messageId: input.sourceMessageId, eventSeq: input.sourceEventSeq, sourceTimeMs: null },
      intent, signal, current)
    } catch {
      result = refused(signal.aborted ? 'CONTINUATION_CANCELLED' : 'CONTINUATION_UNAVAILABLE')
    }
    if (result && !this.stopping.aborted && this.ready(agent, 'assistant')) {
      publishOwnerInboxReceipt(agent, input, 'studio-document-continuation', result)
    }
  }

  private async verifyWebSource(agent: Agent, input: OwnerInboxInput, signal: AbortSignal): Promise<boolean> {
    await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read', { signal })
    if (input.sourceEventSeq < handle.inheritedEventCount) return false
    const { events } = await handle.read(input.sourceEventSeq, 1, { signal })
    return events[0]?.seq === input.sourceEventSeq && isOwnerInboxInsertion(events[0], input)
  }

  private async route(source: DocumentContinuationSource, intent: DocumentContinuationIntent, signal: AbortSignal,
    sourceCurrent: () => boolean): Promise<Outcome | undefined> {
    if (signal.aborted || !sourceCurrent()) return refused('CONTINUATION_SOURCE_CHANGED')
    // Claim also consumes a refused or ambiguous delivery. Replaying it cannot select a later task or authorization.
    const resolution = this.store.claimDocumentContinuation(source, intent.taskId)
    if (!resolution.ok) return refused(resolution.reason)
    const selection = resolution.value
    if (selection.kind === 'duplicate') return
    if (selection.kind === 'blocked') return refused(selection.reason, selection.task)
    if (selection.kind === 'ambiguous') {
      return { kind: 'error', text: ['DOCUMENT_TASK_AMBIGUOUS: More than one document task is unfinished. No continuation was queued.',
        'Choose the intended task and send the line below it as a new message. Eligibility is checked again.',
        ...selection.candidates.map(task => `${coordinates(task)} ${task.paused ? 'Paused.' : 'Not paused; other holds may apply.'}\nContinue document task ${task.taskId}`),
        ...(selection.more ? ['Only the first candidates are shown. To select one not listed, use its full task ID from the original registration receipt.'] : []),
      ].join('\n') }
    }
    const { task } = selection
    const worker = this.ctx.agents.get(SessionId(task.workerSessionId))
    if (!worker) return refused('WORKER_NOT_OPEN', task)
    if (!this.ready(worker, 'document-worker')) return refused('MANAGED_SESSION_REQUIRED', task)
    // Both native and natural-language entries use the same versioned relay ID, preflight and tool guard.
    const result = await continueDocument(this.delivery, this.store, worker, String(task.authorizationVersion), signal,
      () => sourceCurrent() && this.ready(worker, 'document-worker'), task)
    return { ...result, text: `${result.text}\n${coordinates(task)}` }
  }
}
