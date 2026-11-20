/** Confirm one exact preference change before entering the model, then commit against the reviewed revision. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { confirmWithOwner, ownerConfirmationAvailable } from './owner-confirmation.ts'
import { isOwnerInboxInsertion, isSameOwnerInboxTurn, publishOwnerInboxReceipt,
  type OwnerInboxInput, type OwnerInboxStep } from './owner-inbox-input.ts'
import { preferenceCorrectionIntent } from './preference-correction-intent.ts'
import { preferenceScopeChangeIntent } from './preference-scope-change-intent.ts'
import type { ManagedWorkerStore } from './store.ts'

const TIMEOUT_MS = 90_000
type Intent = NonNullable<ReturnType<typeof preferenceCorrectionIntent> | ReturnType<typeof preferenceScopeChangeIntent>>
type Change = Exclude<Intent, { kind: 'invalid' }>
type Outcome = { kind: 'success' | 'error'; text: string }
const refused = (kind: string, reason: string): Outcome => ({ kind: 'error', text: `Studio preference ${kind}: ${reason}. No change was applied.` })
const actions = {
  correct: { receipt: 'studio-memory-correction', name: 'correction', done: 'corrected', approve: 'Apply preference correction', question: 'Correct this preference?' },
  restrict: { receipt: 'studio-memory-restrict', name: 'restriction', done: 'restricted', approve: 'Restrict preference', question: 'Restrict this preference to one project?' },
  forget: { receipt: 'studio-memory-forget', name: 'forget request', done: 'forgotten', approve: 'Forget preference', question: 'Forget this preference?' },
} as const

const scopeLabel = (projectId?: string): string => projectId === undefined ? 'global' : `project ${projectId}`

/** Show exactly what changes before asking; scope changes do not need to read or display the preference body. */
function reviewDetail(change: Change, originalText: string): string {
  const { key, expectedRevision } = change
  const scope = scopeLabel(change.kind === 'restrict' ? undefined : change.projectId)
  const target = `Original request: ${originalText}\n\nCurrent target: ${key} v${expectedRevision} (${scope}).\n\n`
  switch (change.kind) {
    case 'correct': return `${target}Replacement:\n${change.text}\n\nThe scope stays the same. This does not change any task authorization.`
    case 'restrict': return `${target}New scope: project ${change.targetProjectId} only. The preference text stays the same. Existing references to this revision stop resolving. This does not change any task authorization.`
    case 'forget': return `${target}Stop using this key as a long-term preference. Existing references to this revision stop resolving. Original records are kept, and task authorization does not change.`
  }
}

/** Hold the exact live owner decision while the Store retains one revocable proposal in this Host run. */
export class StudioPreferenceChange {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent) => boolean, private readonly stopping: AbortSignal) {}

  review(step: OwnerInboxStep, input: OwnerInboxInput): Promise<void> | undefined {
    // The correction grammar also recognizes unfinished Chinese starters, so test the explicit scope operations first.
    const scope = preferenceScopeChangeIntent(input.text)
    const intent = scope ?? preferenceCorrectionIntent(input.text)
    if (!intent) return
    const run = this.deliver(step, input, intent, scope !== undefined)
    this.pending.add(run)
    const remove = () => { this.pending.delete(run) }
    void run.then(remove, remove)
    return run
  }

  async drain(): Promise<void> { await Promise.allSettled(this.pending) }

  private async deliver(step: OwnerInboxStep, input: OwnerInboxInput, intent: Intent, scope: boolean): Promise<void> {
    const agent = step.agent
    const signal = AbortSignal.any([step.signal, this.stopping, AbortSignal.timeout(TIMEOUT_MS)])
    const name = intent.kind === 'invalid' ? (scope ? 'scope change' : 'correction') : actions[intent.kind].name
    const receipt = intent.kind === 'invalid' ? (scope ? 'studio-memory-scope-change' : actions.correct.receipt) : actions[intent.kind].receipt
    let result: Outcome
    try {
      result = intent.kind === 'invalid' ? refused(name, scope ? 'EXPECTED_KEY_REVISION_AND_EXACT_SCOPE' : 'EXPECTED_KEY_REVISION_AND_NONSECRET_PREFERENCE_TEXT')
        : await this.decide(agent, input, intent, signal)
    } catch {
      result = refused(name, signal.aborted ? 'PREFERENCE_CHANGE_CANCELLED_OR_EXPIRED' : 'PREFERENCE_CHANGE_UNAVAILABLE')
    }
    if (this.ready(agent) && !this.stopping.aborted) publishOwnerInboxReceipt(agent, input, receipt, result)
  }

  private async decide(agent: Agent, input: OwnerInboxInput, change: Change, signal: AbortSignal): Promise<Outcome> {
    const action = actions[change.kind]
    const fail = (reason: string) => refused(action.name, reason)
    if (!ownerConfirmationAvailable(agent)) return fail('OWNER_CONFIRMATION_UNAVAILABLE')
    // Make the native source durable and recheck the same live turn before reserving a write.
    await this.ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    if (!await this.persisted(agent, input, signal)) return fail('MEMORY_SOURCE_UNCONFIRMED')
    signal.throwIfAborted()
    if (!this.ready(agent) || !isSameOwnerInboxTurn(agent, input)) return fail('PREFERENCE_INPUT_CHANGED')
    const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn } = input
    const { key, expectedRevision } = change
    const source = { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, key, expectedRevision }
    const reserved = change.kind === 'correct' ? this.store.memory.proposeCorrection({ ...source,
      ...(change.projectId === undefined ? {} : { projectId: change.projectId }), text: change.text })
      : change.kind === 'restrict' ? this.store.memory.proposeScopeChange({ ...source, kind: 'restrict', targetProjectId: change.targetProjectId })
        : this.store.memory.proposeScopeChange({ ...source, kind: 'forget', ...(change.projectId === undefined ? {} : { projectId: change.projectId }) })
    if (!reserved.ok) return fail(reserved.reason)
    const { proposalId, state, created } = reserved.value
    if (!created) return { kind: 'success', text: `Preference ${action.name} ${proposalId} is already ${state}. No new confirmation opened.` }

    let committed = false
    try {
      const approved = await confirmWithOwner(agent, signal, { id: proposalId, approve: action.approve,
        question: action.question, detail: reviewDetail(change, input.text),
      })
      if (!approved) return { kind: 'success', text: `Preference ${action.name} not applied. The owner did not confirm.` }
      signal.throwIfAborted()
      if (!this.ready(agent) || !isSameOwnerInboxTurn(agent, input)) return fail('PREFERENCE_INPUT_CHANGED')
      // The head and scope, including changes from a different Assistant Session, are checked again inside the write.
      const result = change.kind === 'correct' ? this.store.memory.confirmCorrection(agent.id, proposalId)
        : this.store.memory.confirmScopeChange(agent.id, proposalId)
      if (!result.ok) return fail(result.reason)
      committed = true
      return { kind: 'success', text: `Preference ${action.done}: ${result.value.key} v${result.value.revision} (${scopeLabel(result.value.projectId)}). No task authorization changed.` }
    } finally {
      if (!committed) {
        const closed = change.kind === 'correct' ? this.store.memory.closeCorrection(agent.id, proposalId)
          : this.store.memory.closeScopeChange(agent.id, proposalId)
        if (!closed.ok && !this.stopping.aborted) this.ctx.logger.warn('Could not close Studio preference change %s', proposalId)
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
