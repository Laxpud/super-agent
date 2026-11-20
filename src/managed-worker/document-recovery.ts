/** Observe one confirmed document-turn failure and replace its execution only after a fresh owner decision. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { sharedDocumentError } from './document-command.ts'
import { documentHoldError, verifiedDocumentRelay } from './instructions.ts'
import { confirmWithOwner, ownerConfirmationAvailable } from './owner-confirmation.ts'
import type { DocumentFailureInput, ManagedWorkerStore } from './store.ts'

type InputEvidence = Omit<DocumentFailureInput, 'failureEventSeq'>
interface ObservedTurn {
  turn: number
  inputSeen: boolean
  evidence?: InputEvidence
}

const argumentsSchema = z.tuple([z.uuid(), z.uuid()])
const DECISION_TIMEOUT_MS = 90_000
const APPROVE = 'Replace execution once'
interface CommandResult { kind: 'success' | 'error'; text: string }
const denied = (reason: string): CommandResult => documentHoldError(reason) ?? sharedDocumentError(reason)
  ?? { kind: 'error', text: `Document recovery rejected: ${reason}. No replacement was confirmed.` }

/** Watch native append events, not assistant prose, retry timers, or Session visibility. */
export class StudioDocumentRecovery {
  private readonly turns = new WeakMap<Session, ObservedTurn>()
  private readonly confirmingEvidence = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent) => boolean, private readonly available: () => boolean,
    private readonly stopping: AbortSignal) {}

  install(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/start' && event.type !== 'user/message' && event.type !== 'turn/end') return
      if (this.stopping.aborted || !this.available()) return
      if (event.type === 'turn/start') {
        const agent = this.ctx.agents.get(session.id)
        if (agent?.session === session && this.ready(agent)) this.turns.set(session, { turn: event.data.turn, inputSeen: false })
        return
      }
      const turn = this.turns.get(session)
      if (!turn) return
      if (event.type === 'user/message') {
        const message = event.data
        // The installed loop may append a context projection; the older declarations do not include this source.
        if ((message.source.kind as string) === 'runtime-context') return
        const agent = this.ctx.agents.get(session.id)
        const task = !turn.inputSeen && agent?.session === session && this.ready(agent)
          ? verifiedDocumentRelay(this.store, agent, message) : undefined
        // A mixed turn cannot explain which assignment failed. Do not treat any of its input as recovery evidence.
        turn.inputSeen = true
        if (!task) { delete turn.evidence; return }
        turn.evidence = { taskId: task.taskId, workerSessionId: task.workerSessionId, executionEpoch: task.executionEpoch,
          authorizationVersion: task.authorizationVersion, turn: turn.turn, sourceMessageId: message.id, messageEventSeq: event.seq }
        return
      }
      this.turns.delete(session)
      const { turn: ended, reason } = event.data
      if (ended !== turn.turn || reason.kind !== 'error' || reason.error.code !== 'TRANSPORT' || !turn.evidence) return
      const agent = this.ctx.agents.get(session.id)
      if (agent?.session !== session || !this.ready(agent)) return
      this.confirmEvidence({ ...turn.evidence, failureEventSeq: event.seq })
    })
  }

  /** The native log must flush before the SQLite receipt can advertise these event coordinates. */
  private confirmEvidence(input: DocumentFailureInput): void {
    // Leave append publication first so every persistence listener has seen the boundary event before the flush.
    const attempt = Promise.resolve().then(async () => {
      if (this.stopping.aborted || !this.available()) return
      await this.ctx.sessionPersistence.flush()
      if (this.stopping.aborted || !this.available()) return
      const result = this.store.recordDocumentFailure(input)
      if (!result.ok && result.reason === 'STORAGE_ERROR') this.ctx.logger.warn('Studio could not confirm document recovery evidence')
    }).catch(() => {
      if (!this.stopping.aborted) this.ctx.logger.warn('Studio could not flush the document failure event')
    }).finally(() => { this.confirmingEvidence.delete(attempt) })
    this.confirmingEvidence.add(attempt)
  }

  async drain(): Promise<void> { await Promise.allSettled(this.confirmingEvidence) }

  /** Confirm one exact transfer in the replacement Session. Neither confirmation nor success sends the Worker a message. */
  async command(agent: Agent, argument: string, commandId: string, caller: AbortSignal): Promise<CommandResult> {
    const signal = AbortSignal.any([caller, this.stopping, AbortSignal.timeout(DECISION_TIMEOUT_MS)])
    signal.throwIfAborted()
    const parsed = argumentsSchema.safeParse(argument.length <= 96 ? argument.split(/\s+/u) : undefined)
    if (!parsed.success) return denied('EXPECTED_TASK_ID_AND_EVIDENCE_ID')
    if (!this.ready(agent) || agent.status !== 'idle' || !ownerConfirmationAvailable(agent)) return denied('REPLACEMENT_SESSION_UNAVAILABLE')
    const [taskId, evidenceId] = parsed.data
    const pending = this.store.previewDocumentRecovery(taskId, evidenceId, agent.id)
    if (!pending.ok) return denied(pending.reason)
    const { task, failure } = pending.value
    const confirmationId = randomUUID()
    const confirmed = await confirmWithOwner(agent, signal, { id: confirmationId, approve: APPROVE,
      question: 'Replace this document execution once?',
      detail: `Task ${taskId}; evidence ${evidenceId}. Worker Session ${failure.workerSessionId}, turn ${failure.turn}, event ${failure.failureEventSeq} ended with TRANSPORT.\n\n`
        + `Replace execution epoch ${task.executionEpoch} and authorization version ${task.authorizationVersion} with this Session (${agent.id}). `
        + 'The approved scope stays unchanged. Writes will be paused. This does not resume work or cancel the old Session.',
    })
    if (!confirmed) return { kind: 'success', text: 'Document recovery not performed. No execution or authorization changed.' }
    signal.throwIfAborted()
    if (!this.ready(agent) || agent.status !== 'idle') return denied('REPLACEMENT_SESSION_UNAVAILABLE')
    // Consent names the exact evidence and target shown above. Recheck both under the managed write lock and consume them with the transfer.
    const result = this.store.recoverDocument(taskId, evidenceId, agent.id, commandId, confirmationId)
    if (!result.ok) return denied(result.reason)
    const next = result.value
    return { kind: 'success', text: `Document execution replaced once: task ${taskId}; execution epoch ${next.executionEpoch}; authorization version ${next.authorizationVersion}. `
      + `Writes are paused. No Worker was started and no document was written. Check /studio-doc status before a separate resume.` }
  }
}
