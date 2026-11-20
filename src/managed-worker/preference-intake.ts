/** Offer a live owner decision for one exact, explicitly long-term preference in the current turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import { isMemoryKey, PREFERENCE_PROPOSAL_INTENT_LIMIT } from './memory-store.ts'
import { confirmWithOwner, ownerConfirmationAvailable } from './owner-confirmation.ts'
import { preferenceIntent } from './preference-intent.ts'
import type { ManagedWorkerStore } from './store.ts'

export const PROPOSE_PREFERENCE = 'studio_propose_preference'
const TIMEOUT_MS = 90_000
const MAX_TAIL_EVENTS = 96
const argsSchema = z.strictObject({
  key: z.string().refine(isMemoryKey).describe('A new stable lowercase key for this preference. This cannot update or revive a prior key.'),
  intentQuote: z.string().min(1).max(PREFERENCE_PROPOSAL_INTENT_LIMIT).describe('The complete, verbatim current owner message stating one long-term preference.'),
})
const resultSchema = z.strictObject({ text: z.string() })

interface OwnerIntent {
  sourceRequestId: string
  sourceMessageId: string
  sourceEventSeq: number
  turn: number
  intentText: string
}

interface IntentSnapshot { intent: OwnerIntent; end: number }
const denied = (reason: string): Error => new Error(`Studio preference proposal denied: ${reason}`)
const pendingInput = (agent: Agent): boolean => agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0

/** Read a bounded, durable tail through the native store. Historical, compacted, and mixed turns cannot authorize this path. */
async function currentOwnerIntent(ctx: Context, agent: Agent, callId: string, signal: AbortSignal): Promise<IntentSnapshot | undefined> {
  if (pendingInput(agent)) return
  const end = agent.session.seq
  const start = Math.max(0, end - MAX_TAIL_EVENTS)
  await ctx.sessionPersistence.flush()
  signal.throwIfAborted()
  await using handle = await ctx.sessionPersistence.open(agent.id, 'read', { signal })
  const { events } = await handle.read(start, end - start, { signal })
  if (events.length !== end - start || agent.session.seq !== end || pendingInput(agent)) return
  let callTurn: number | undefined
  let input: Omit<OwnerIntent, 'turn'> | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.seq < handle.inheritedEventCount || event.type === 'turn/end') return
    if (event.type === 'turn/start') {
      if (input && callTurn === event.data.turn) return { intent: { ...input, turn: callTurn }, end }
      return
    }
    if (event.type === 'tool/call' && event.data.callId === callId && event.data.name === PROPOSE_PREFERENCE) {
      if (callTurn !== undefined) return
      callTurn = event.data.turn
      continue
    }
    if (event.type !== 'user/message') continue
    const { id, source, content } = event.data
    const attribution: { kind: string; rpcId?: unknown; principal?: unknown } = source
    if (attribution.kind === 'runtime-context') continue
    // The trusted Web controller adds rpcId to its owner prompt. Ignore neither newer inputs nor a second assignment in the turn.
    if (callTurn === undefined || input || event.surfaceOp !== 'append' || attribution.kind !== 'user'
      || typeof attribution.rpcId !== 'string' || !attribution.rpcId || attribution.principal !== undefined || content.length !== 1) return
    const block = content[0]
    if (block?.type !== 'text' || block.text.length > PREFERENCE_PROPOSAL_INTENT_LIMIT) return
    input = { sourceRequestId: attribution.rpcId, sourceMessageId: id, sourceEventSeq: event.seq, intentText: block.text }
  }
}

function sameIntent(first: OwnerIntent, current: OwnerIntent | undefined): boolean {
  return current !== undefined && first.sourceRequestId === current.sourceRequestId && first.sourceMessageId === current.sourceMessageId
    && first.sourceEventSeq === current.sourceEventSeq && first.turn === current.turn && first.intentText === current.intentText
}

/** Bind the proposal to a native owner input and save only after an exact one-use foreground answer. */
export class StudioPreferenceIntake {
  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent) => boolean, private readonly stopping: AbortSignal) {}

  available(agent: Agent): boolean {
    return !this.stopping.aborted && agent.session.header.origin !== 'subagent' && this.ready(agent) && ownerConfirmationAvailable(agent)
  }

  install(agent: Agent): () => void {
    if (agent.session.header.origin === 'subagent' || !ownerConfirmationAvailable(agent)) return () => {}
    return agent.ctx.tools.register({
      name: PROPOSE_PREFERENCE,
      description: 'Ask the owner to save one explicitly long-term preference from the exact current request. It cannot save without confirmation, change an existing key, or grant task authority.',
      parameters: z.toJSONSchema(argsSchema), timeoutMs: TIMEOUT_MS + 10_000,
      presentCall: () => ({ card: 'generic', title: 'Confirm a long-term preference' }),
      output: {
        schema: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: resultSchema.parse(value).text }],
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const fields = argsSchema.safeParse(args)
        if (!fields.success || exec.agent !== agent || exec.parent !== undefined || !this.available(agent)) throw denied('INVALID_EXECUTION')
        const signal = AbortSignal.any([exec.signal, this.stopping, AbortSignal.timeout(TIMEOUT_MS)])
        const snapshot = await currentOwnerIntent(this.ctx, agent, exec.callId, signal)
        signal.throwIfAborted()
        if (!snapshot || snapshot.intent.intentText !== fields.data.intentQuote || agent.session.seq !== snapshot.end
          || pendingInput(agent) || !this.available(agent)) throw denied('EXPECTED_EXACT_CURRENT_OWNER_MESSAGE')
        const source = snapshot.intent
        const text = preferenceIntent(source.intentText)
        if (!text) throw denied('EXPLICIT_LONG_TERM_PREFERENCE_REQUIRED')
        const pending = this.store.memory.propose({ ...source, key: fields.data.key, text, toolCallId: exec.callId, assistantSessionId: agent.id })
        if (!pending.ok) throw denied(pending.reason)
        const { proposal, created } = pending.value
        if (!created) return { text: `Preference proposal ${proposal.proposalId} is already ${proposal.state}. No new confirmation opened.` }
        let saved = false
        try {
          const approved = await confirmWithOwner(agent, signal, { id: proposal.proposalId, approve: 'Save preference',
            question: 'Save this as a long-term preference?',
            detail: `Original request: ${source.intentText}\n\nSave as ${proposal.key} (global):\n${text}\n\nThis does not modify tasks or authorize actions.`,
          })
          if (!approved) return { text: 'Preference not saved. The owner did not confirm.' }
          const current = await currentOwnerIntent(this.ctx, agent, exec.callId, signal)
          signal.throwIfAborted()
          if (!current || agent.session.seq !== current.end || !this.available(agent)
            || pendingInput(agent) || !sameIntent(source, current.intent)) throw denied('PREFERENCE_INPUT_CHANGED')
          const result = this.store.memory.confirmProposal(agent.id, proposal.proposalId)
          if (!result.ok) throw denied(result.reason)
          saved = true
          return { text: `Preference saved: ${result.value.key} v${result.value.revision} (global). No task authorization changed.` }
        } finally {
          if (!saved) {
            const closed = this.store.memory.closeProposal(agent.id, proposal.proposalId)
            if (!closed.ok && !this.stopping.aborted) this.ctx.logger.warn('Could not close Studio preference proposal %s', proposal.proposalId)
          }
        }
      },
    })
  }
}
