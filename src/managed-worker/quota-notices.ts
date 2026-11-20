/** Deliver one model-free owner notice for a durable account quota incident. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { StudioFeishuNoticeDestination } from './feishu-inbox.ts'
import type { StudioQuotaPoolConfig } from './quota.ts'
import type { ManagedWorkerStore, StudioQuotaIncident } from './store.ts'

const NOTICE_INTERVAL_MS = 2_000

/** Include only bounded identifiers and deterministic status, not prompts, logs, raw errors, or recovery evidence. */
function quotaNotice(incident: StudioQuotaIncident, providers: readonly string[]): string {
  const aliases = providers.slice(0, 4).join(', ') + (providers.length > 4 ? ` and ${providers.length - 4} more` : '')
  const source = incident.sessionId && /^[a-zA-Z0-9_-]{1,100}$/u.test(incident.sessionId)
    ? ` First observed in Session ${incident.sessionId}.` : ''
  return `Studio system notice: account quota exhausted (ACCOUNT_QUOTA).\nPool ${incident.poolId}; incident ${incident.incidentId}.${source}\n`
    + `Inference and post-processing on this pool are held (${aliases}). External jobs are not stopped.\n`
    + 'Open Studio Web and run /studio-quota status for the current state. Recovery requires independent confirmation; no model or alternate account was used to send this notice.'
}

/** Scan committed stops only. A failed or ambiguous attempt remains visible in Web and is never replayed. */
export class StudioQuotaNotices {
  constructor(private readonly store: ManagedWorkerStore, private readonly pools: readonly StudioQuotaPoolConfig[],
    private readonly destination: () => StudioFeishuNoticeDestination | undefined, private readonly onError: () => void) {}

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.deliverOne(signal)
      } catch {
        if (!signal.aborted) this.onError()
      }
      await delay(NOTICE_INTERVAL_MS, undefined, { signal, ref: false }).catch(() => {})
    }
  }

  private async deliverOne(signal: AbortSignal): Promise<void> {
    const destination = this.destination()
    if (!destination || signal.aborted) return
    for (const { id, providers } of this.pools) {
      const current = this.store.quotaStatus(id)
      if (!current.ok || current.value?.reason !== 'ACCOUNT_QUOTA') continue
      const incident = current.value
      const claim = this.store.claimQuotaNotice(id, incident.incidentId, destination.scope)
      if (!claim.ok || !claim.value.claimed) continue
      // The claim is durable before crossing the channel boundary. A stable key also contains any provider-side retry.
      const hash = createHash('sha256').update(destination.scope).update('\0').update(incident.incidentId).digest('hex').slice(0, 32)
      const sent = await destination.send(quotaNotice(incident, providers), `studio-quota-${hash}`).catch(() => undefined)
      const result = this.store.settleQuotaNotice(incident.incidentId, destination.scope, sent)
      if ((!result.ok || !sent) && !signal.aborted) this.onError()
      return
    }
  }
}
