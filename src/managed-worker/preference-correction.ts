/** Confirm one exact preference correction before entering the model, then commit against the reviewed revision. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { confirmWithOwner, ownerConfirmationAvailable } from './owner-confirmation.ts'
import { isOwnerInboxInsertion, isSameOwnerInboxTurn, publishOwnerInboxReceipt,
  type OwnerInboxInput, type OwnerInboxStep } from './owner-inbox-input.ts'
import { preferenceCorrectionIntent } from './preference-correction-intent.ts'
import type { ManagedWorkerStore } from './store.ts'

const TIMEOUT_MS = 90_000
const RECEIPT = 'studio-memory-correction'
type Correction = Extract<ReturnType<typeof preferenceCorrectionIntent>, { kind: 'correct' }>
type Outcome = { kind: 'success' | 'error'; text: string }
const refused = (reason: string): Outcome => ({ kind: 'error', text: `Studio preference correction: ${reason}. No correction was applied.` })

/** Hold the exact live owner decision while the Store retains one revocable proposal in this Host run. */
export class StudioPreferenceCorrection {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent) => boolean, private readonly stopping: AbortSignal) {}

  review(step: OwnerInboxStep, input: OwnerInboxInput): Promise<void> | undefined {
    const intent = preferenceCorrectionIntent(input.text)
    if (!intent) return
    const run = this.deliver(step, input, intent)
    this.pending.add(run)
    const remove = () => { this.pending.delete(run) }
    void run.then(remove, remove)
    return run
  }

  async drain(): Promise<void> { await Promise.allSettled(this.pending) }

  private async deliver(step: OwnerInboxStep, input: OwnerInboxInput, intent: Correction | { kind: 'invalid' }): Promise<void> {
    const agent = step.agent
    const signal = AbortSignal.any([step.signal, this.stopping, AbortSignal.timeout(TIMEOUT_MS)])
    let result: Outcome
    try {
      result = intent.kind === 'invalid' ? refused('EXPECTED_KEY_REVISION_AND_NONSECRET_PREFERENCE_TEXT')
        : await this.decide(agent, input, intent, signal)
    } catch {
      result = refused(signal.aborted ? 'CORRECTION_CANCELLED_OR_EXPIRED' : 'CORRECTION_UNAVAILABLE')
    }
    if (this.ready(agent) && !this.stopping.aborted) publishOwnerInboxReceipt(agent, input, RECEIPT, result)
  }

  private async decide(agent: Agent, input: OwnerInboxInput, change: Correction, signal: AbortSignal): Promise<Outcome> {
    if (!ownerConfirmationAvailable(agent)) return refused('OWNER_CONFIRMATION_UNAVAILABLE')
    // First make the native source durable, then re-check the same own insertion and live turn before reserving a write.
    await this.ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    if (!await this.persisted(agent, input, signal)) return refused('MEMORY_SOURCE_UNCONFIRMED')
    signal.throwIfAborted()
    if (!this.ready(agent) || !isSameOwnerInboxTurn(agent, input)) return refused('PREFERENCE_INPUT_CHANGED')
    const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn } = input
    const { key, expectedRevision, projectId, text } = change
    const reserved = this.store.memory.proposeCorrection({ assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn,
      key, expectedRevision, ...(projectId === undefined ? {} : { projectId }), text })
    if (!reserved.ok) return refused(reserved.reason)
    const { proposalId, state, created } = reserved.value
    if (!created) return { kind: 'success', text: `Preference correction ${proposalId} is already ${state}. No new confirmation opened.` }

    let committed = false
    try {
      const scope = projectId === undefined ? 'global' : `project ${projectId}`
      const approved = await confirmWithOwner(agent, signal, { id: proposalId, approve: 'Apply preference correction',
        question: 'Correct this preference?',
        detail: `Original request: ${input.text}\n\nCurrent target: ${key} v${expectedRevision} (${scope}).\n\nReplacement:\n${text}\n\nThe scope stays the same. This does not change any task authorization.`,
      })
      if (!approved) return { kind: 'success', text: 'Preference correction not applied. The owner did not confirm.' }
      signal.throwIfAborted()
      if (!this.ready(agent) || !isSameOwnerInboxTurn(agent, input)) return refused('PREFERENCE_INPUT_CHANGED')
      // A different Assistant Session may have changed the preference. The transaction rechecks the active head and scope.
      const result = this.store.memory.confirmCorrection(agent.id, proposalId)
      if (!result.ok) return refused(result.reason)
      committed = true
      return { kind: 'success', text: `Preference corrected: ${result.value.key} v${result.value.revision} (${scope}). No task authorization changed.` }
    } finally {
      if (!committed) {
        const closed = this.store.memory.closeCorrection(agent.id, proposalId)
        if (!closed.ok && !this.stopping.aborted) this.ctx.logger.warn('Could not close Studio preference correction %s', proposalId)
      }
    }
  }

  private async persisted(agent: Agent, input: OwnerInboxInput, signal: AbortSignal): Promise<boolean> {
    await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read', { signal })
    if (input.sourceEventSeq < handle.inheritedEventCount) return false
    const { events } = await handle.read(input.sourceEventSeq, 1, { signal })
    return events[0]?.seq === input.sourceEventSeq && isOwnerInboxInsertion(events[0], input)
  }
}
