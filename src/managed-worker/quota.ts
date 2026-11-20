/** Stop explicitly mapped inference pools at the streaming boundary, independently of the retry policy. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ACCOUNT_QUOTA_EXCEEDED_CODE, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import s from '@deepseek-ai/schemastery'
import type { ManagedWorkerStore } from './store.ts'

export interface StudioQuotaPoolConfig { id: string; providers: string[] }
const poolId = /^[a-z][a-z0-9_-]{0,47}$/u
const providerId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u
export const QuotaPoolConfig: s<StudioQuotaPoolConfig> = s.object({
  id: s.string().pattern(poolId).required(),
  providers: s.array(s.string().pattern(providerId).required()).required(),
})

/** The owner groups provider IDs by account. Neither model names nor a generic 429 imply a pool. */
export function quotaProviderMap(pools: readonly StudioQuotaPoolConfig[]): ReadonlyMap<string, string> {
  if (pools.length > 32) throw new Error('Studio supports at most 32 quota pools')
  const ids = new Set<string>()
  const providers = new Map<string, string>()
  for (const { id, providers: aliases } of pools) {
    if (!poolId.test(id) || ids.has(id) || !aliases.length || aliases.length > 32) throw new Error('Invalid Studio quota pool configuration')
    ids.add(id)
    for (const provider of aliases) {
      if (!providerId.test(provider) || providers.has(provider)) throw new Error('A Studio quota provider must belong to exactly one configured pool')
      providers.set(provider, id)
    }
  }
  return providers
}

interface Attempt { agent: Agent; signal: AbortSignal; pool: string; remove(): void }
interface CommandResult { kind: 'success' | 'error'; text: string }

/** Stop each shared account independently. A turn signal survives retries, including the idle period between adapter attempts. */
export class StudioQuotaControl {
  private readonly attempts = new Map<Agent, Attempt>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly pools: readonly StudioQuotaPoolConfig[], private readonly providerPool: ReadonlyMap<string, string>,
    private readonly feishuAlerts: boolean) {}

  /** Report what the channel confirmed, without performing a new send or an inference call. */
  private noticeStatus(incidentId: string): string {
    const result = this.store.quotaNoticeStatus(incidentId)
    if (!result.ok) return '\nFeishu owner notice: delivery state could not be confirmed.'
    const notice = result.value
    if (!notice) return this.feishuAlerts ? '\nFeishu owner notice: no attempt yet; waiting for the verified channel.' : ''
    if (notice.state === 'delivered') return `\nFeishu owner notice: confirmed (${notice.messageId}).`
    return `\nFeishu owner notice: ${notice.state === 'sending' ? 'attempt recorded, no delivery receipt yet' : 'delivery unconfirmed'}. No automatic resend.`
  }

  /** Return a stable check for both new dispatch and model attempts; unknown routes are not part of the configured pool. */
  denial(provider: string): string | undefined {
    const pool = this.providerPool.get(provider)
    return pool === undefined ? undefined : this.hold(pool)
  }

  private hold(pool: string): string | undefined {
    const status = this.store.quotaStatus(pool)
    if (!status.ok) return `Studio quota pool ${pool}: stop state could not be confirmed. See /studio-quota.`
    if (status.value) return `Studio quota pool ${pool}: waiting for recovery confirmation. See /studio-quota.`
  }

  install(): void {
    if (!this.providerPool.size) return
    this.ctx.on('llm/stream', (options, next) => this.stream(options, next))
    this.ctx.on('agent/pre-step', async (step, next) => {
      // Capture the native turn's exact signal. The request marker lives in the runtime's LLM module, which may differ from the bundle's import.
      const provider = (step as typeof step & { modelSelection?: { provider: string } }).modelSelection?.provider
      const pool = provider === undefined ? undefined : this.providerPool.get(provider)
      this.track(step.agent, step.signal, pool)
      const denial = pool === undefined ? undefined : this.hold(pool)
      if (!denial) return next()
      step.agent.cancel({ kind: 'hook', reason: denial }, { keepInbox: true })
      return { kind: 'reject' }
    })
    this.ctx.on('agent/disposed', ({ agent }) => { this.attempts.get(agent)?.remove() })
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const agent = this.ctx.agents.get(session.id)
      if (agent?.session === session) this.attempts.get(agent)?.remove()
    })
    this.ctx.effect(() => () => { for (const attempt of this.attempts.values()) attempt.remove() })
  }

  private track(agent: Agent, signal: AbortSignal, pool: string | undefined): void {
    this.attempts.get(agent)?.remove()
    if (pool === undefined || signal.aborted || this.ctx.agents.get(agent.id) !== agent) return
    const attempt: Attempt = { agent, signal, pool, remove: () => {
      signal.removeEventListener('abort', attempt.remove)
      if (this.attempts.get(agent) === attempt) this.attempts.delete(agent)
    } }
    this.attempts.set(agent, attempt)
    signal.addEventListener('abort', attempt.remove, { once: true })
  }

  /** Hand-built inference calls still respect the pool, but cannot cancel a turn by supplying a Session ID alone. */
  private turnFor(options: GenerateOptions, pool: string): Attempt | undefined {
    const agent = options.sessionId === undefined ? undefined : this.ctx.agents.get(options.sessionId)
    const attempt = agent ? this.attempts.get(agent) : undefined
    if (attempt?.pool === pool && attempt.signal === options.signal && !attempt.signal.aborted) return attempt
  }

  private cancel(attempt: Attempt, reason: string): void {
    if (this.attempts.get(attempt.agent) === attempt && !attempt.signal.aborted && this.ctx.agents.get(attempt.agent.id) === attempt.agent) {
      attempt.agent.cancel({ kind: 'hook', reason }, { keepInbox: true })
    }
  }

  private async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const pool = this.providerPool.get(options.provider)
    if (pool === undefined) { yield* next(); return }
    const attempt = this.turnFor(options, pool)
    const denial = this.hold(pool)
    if (denial) {
      if (attempt) this.cancel(attempt, denial)
      // A hand-built caller has no loop turn to cancel. It still cannot reach the adapter while the pool is held.
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'STUDIO_QUOTA_STOPPED', message: denial } } }
      return
    }
    for await (const chunk of next()) {
      if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error' && chunk.reason.failure.code === ACCOUNT_QUOTA_EXCEEDED_CODE) {
          // Commit the closed pool before aborting any turn. An unconfirmed write also fails closed through the Store.
          const outcome = this.store.tripQuota(pool, options.provider, options.model, attempt?.agent.id)
          const reason = this.hold(pool) ?? `Studio quota pool ${pool}: account quota exhausted. See /studio-quota.`
          if (!outcome.ok || outcome.value.created) this.ctx.logger.warn('%s', reason)
          for (const active of this.attempts.values()) if (active.pool === pool) this.cancel(active, reason)
        } else if (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted') {
          attempt?.remove()
        }
        // Error attempts remain tracked during the retry plugin's backoff. Native loop cancellation is independent of its policy.
      }
      yield chunk
    }
  }

  /** Owner-only status and recovery supplied by an operator with independent evidence, never an inference probe. */
  command(sessionId: string, commandId: string, input: string): CommandResult {
    if (!this.pools.length) return { kind: 'error', text: 'No Studio quota pools are configured.' }
    const text = input.trim()
    if (text === '' || text === 'status') {
      const lines = this.pools.map(({ id, providers }) => {
        const status = this.store.quotaStatus(id)
        const routes = `Configured providers: ${providers.join(', ')}.`
        if (!status.ok) return `${id}: stopped; storage state could not be confirmed (${status.reason}). ${routes}`
        if (!status.value) return `${id}: open (not a balance check). ${routes}`
        const { incidentId, reason, noticedAt, provider, model, sessionId: affected } = status.value
        return `${id}: stopped; waiting for recovery confirmation. ${routes}\nIncident ${incidentId}: ${reason}, ${noticedAt}.`
          + (provider && model ? ` Observed at ${provider}/${model}${affected ? ` in Session ${affected}` : ''}.` : '')
          + (reason === 'ACCOUNT_QUOTA' ? this.noticeStatus(incidentId) : '')
      })
      return { kind: 'success', text: `Studio quota status (no model calls)\n\n${lines.join('\n\n')}` }
    }
    const args = /^restore\s+(\S+)\s+(\S+)\s+([\s\S]{1,1000})$/u.exec(text)
    if (!args?.[1] || !args[2] || !args[3]?.trim()) return { kind: 'error', text: 'Use /studio-quota status or /studio-quota restore <pool-id> <incident-id> <independent-evidence>.' }
    const result = this.store.restoreQuota(args[1], args[2], sessionId, commandId, args[3])
    if (!result.ok) return { kind: 'error', text: `Quota stop remains unchanged: ${result.reason}. Check /studio-quota status.` }
    return { kind: 'success', text: `Pool ${result.value.poolId} reopened on owner confirmation. No model was called, no stopped work was replayed, and no task pause was lifted.` }
  }
}
