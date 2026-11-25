/** Idempotent message delivery to DSH agents across Session restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-studio': { kind: 'agent-studio' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
const LEGACY_SOURCE = 'dsh-superagent'
const LEGACY_PREFIX = `${LEGACY_SOURCE}:`
/** The id of a new delivery. Its request identity is stable across retries and the project rename. */
export const messageId = (requestId: string) => MessageId(`agent-studio:${requestId}`)
/** Compare IDs from old inboxes and logs without rewriting the original message or source coordinates. */
export const currentDeliveryId = (id: string): string => id.startsWith(LEGACY_PREFIX) ? messageId(id.slice(LEGACY_PREFIX.length)) : id
export const isStudioSource = (source: { kind: string }): boolean => source.kind === 'agent-studio' || source.kind === LEGACY_SOURCE

/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message: UserMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (isStudioSource(source) || (source.kind === 'plugin' && source.plugin === LEGACY_SOURCE)) return currentDeliveryId(message.id)
  // Requests admitted by the former user RPC retain their original attribution.
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `agent-studio`'s own source (`agent-studio`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const source = typeof mode === 'object' ? { kind: 'agent-studio' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'agent-studio' as const, form: 'relay' as const }
      const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
}
