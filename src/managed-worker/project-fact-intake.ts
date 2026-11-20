/** Register one fact-linked work item directly from a fresh native owner message, without starting an execution. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { isOwnerInboxInsertion, isSameOwnerInboxTurn, publishOwnerInboxReceipt,
  type OwnerInboxInput, type OwnerInboxStep } from './owner-inbox-input.ts'
import { parseProjectFactRequest, PROJECT_FACT_HEADER, type ProjectFactRequest } from './project-fact-request.ts'
import type { ManagedWorkerStore } from './store.ts'

const RECEIPT = 'studio-project-fact-work'
type Role = 'assistant' | 'leader'
type RecognizedRequest = Exclude<ProjectFactRequest, { kind: 'plain' }>
type Outcome = { kind: 'success' | 'error'; text: string }
const refused = (reason: string, hint = ''): Outcome => ({ kind: 'error', text: `Project fact registration rejected: ${reason}. No work was registered.${hint}` })

/** Match and persist a fact-linked registration before any Leader model step can see the request. */
export class StudioProjectFactIntake {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent, role: Role) => boolean, private readonly enabled: boolean,
    private readonly stopping: AbortSignal) {}

  /** Consume only the reserved syntax. Errors do not send the same text to another model route. */
  review(step: OwnerInboxStep, input: OwnerInboxInput, role: Role): Promise<void> | undefined {
    const request = parseProjectFactRequest(input.text)
    if (request.kind === 'plain') return
    const run = this.deliver(step, input, role, request)
    this.pending.add(run)
    const remove = () => { this.pending.delete(run) }
    void run.then(remove, remove)
    return run
  }

  async drain(): Promise<void> { await Promise.allSettled(this.pending) }

  private async deliver(step: OwnerInboxStep, input: OwnerInboxInput, role: Role, request: RecognizedRequest): Promise<void> {
    const signal = AbortSignal.any([step.signal, this.stopping])
    let outcome: Outcome
    try {
      if (!this.enabled) outcome = refused('PROJECT_FACT_USE_DISABLED')
      else if (role !== 'leader') outcome = refused('LEADER_SESSION_REQUIRED', ' Send the request in the current Leader Session of its project.')
      else if (request.kind === 'invalid') outcome = refused('INVALID_FACT_REFERENCE', ` Start with ${PROJECT_FACT_HEADER} <project-id> <key> v<revision>, then put one task below it.`)
      else outcome = await this.save(step.agent, input, request, signal)
    } catch {
      outcome = refused(signal.aborted ? 'PROJECT_FACT_REGISTRATION_CANCELLED' : 'PROJECT_FACT_REGISTRATION_UNAVAILABLE')
    }
    if (this.ready(step.agent, role) && !this.stopping.aborted) publishOwnerInboxReceipt(step.agent, input, RECEIPT, outcome)
  }

  private async save(agent: Agent, input: OwnerInboxInput, request: Extract<ProjectFactRequest, { kind: 'fact' }>, signal: AbortSignal): Promise<Outcome> {
    // Bind to the original own inbox event only after the Host has durably stored it.
    await this.ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    const checked = await this.verifySource(agent, input, signal)
    signal.throwIfAborted()
    if (!checked) return refused('FACT_SOURCE_UNCONFIRMED')
    if (!this.ready(agent, 'leader') || !isSameOwnerInboxTurn(agent, input)) return refused('FACT_INPUT_CHANGED')
    const { sourceRequestId, sourceMessageId, sourceEventSeq, turn, text: requestText } = input
    const result = this.store.projects.recordFactWork({ leaderSessionId: agent.id, sourceRequestId, sourceMessageId, sourceEventSeq, turn, requestText })
    if (!result.ok) {
      const hint = result.reason === 'FACT_NOT_CURRENT' ? ' Check the current fact with /studio-project fact <key>.'
        : result.reason === 'STALE_MANAGEMENT' || result.reason === 'FACT_PROJECT_MISMATCH' ? ' Use /studio-project status to find the current Leader of the named project.' : ''
      return refused(result.reason, hint)
    }
    const { work, created } = result.value
    return { kind: 'success', text: `Work ${work.workId} ${created ? 'registered' : 'already registered'} in project ${work.projectId} with fact ${request.key} v${request.revision}. No Worker started.\n\nTo dispatch, send this as a separate message:\nDispatch work ${work.workId}\n\nUse /studio-project work ${work.workId} to check its status and retrieve any eligible result.` }
  }

  private async verifySource(agent: Agent, input: OwnerInboxInput, signal: AbortSignal): Promise<boolean> {
    await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read', { signal })
    if (input.sourceEventSeq < handle.inheritedEventCount) return false
    const { events } = await handle.read(input.sourceEventSeq, 1, { signal })
    return events[0]?.seq === input.sourceEventSeq && isOwnerInboxInsertion(events[0], input)
  }
}
