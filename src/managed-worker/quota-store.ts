import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ManagedResult } from './store.js'

export type StudioQuotaReason = 'ACCOUNT_QUOTA' | 'HOST_UNCONFIRMED'

/** Public snapshot of a hold. Clear evidence is retained in SQLite, not returned to callers. */
export interface StudioQuotaIncident {
  incidentId: string
  poolId: string
  reason: StudioQuotaReason
  noticedAt: string
  provider?: string
  model?: string
  sessionId?: string
}

// Keep the first failure and its eventual owner confirmation together. The partial index applies only to active holds.
export const QUOTA_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_quota_incident (
    incident_id TEXT PRIMARY KEY,
    pool_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('ACCOUNT_QUOTA', 'HOST_UNCONFIRMED')),
    noticed_at TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    session_id TEXT,
    cleared_session_id TEXT,
    clear_command_id TEXT UNIQUE,
    clear_evidence TEXT,
    cleared_at TEXT,
    CHECK ((reason = 'ACCOUNT_QUOTA' AND provider IS NOT NULL AND model IS NOT NULL)
      OR (reason = 'HOST_UNCONFIRMED' AND provider IS NULL AND model IS NULL AND session_id IS NULL)),
    CHECK ((cleared_at IS NULL AND cleared_session_id IS NULL AND clear_command_id IS NULL AND clear_evidence IS NULL)
      OR (cleared_at IS NOT NULL AND cleared_session_id IS NOT NULL AND clear_command_id IS NOT NULL AND clear_evidence IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS studio_quota_active_pool ON studio_quota_incident (pool_id) WHERE cleared_at IS NULL;
`

const isId = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed() && value.length > 0 && !value.includes('\0')
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })

type IncidentRow = Record<string, SQLOutputValue>
type QuotaTransaction = <T>(operation: () => ManagedResult<T>) => ManagedResult<T>

/** Reject invalid persisted snapshots rather than interpreting them as an empty pool. */
function readIncident(row: IncidentRow): StudioQuotaIncident {
  const { incident_id: incidentId, pool_id: poolId, reason, noticed_at: noticedAt, provider, model, session_id: sessionId } = row
  if (!isId(incidentId) || !isId(poolId) || !isId(noticedAt)) throw new Error('Invalid Studio quota incident')
  if (reason === 'HOST_UNCONFIRMED' && provider === null && model === null && sessionId === null) {
    return { incidentId, poolId, reason, noticedAt }
  }
  if (reason === 'ACCOUNT_QUOTA' && isId(provider) && isId(model) && (sessionId === null || isId(sessionId))) {
    return { incidentId, poolId, reason, noticedAt, provider, model, ...(sessionId === null ? {} : { sessionId }) }
  }
  throw new Error('Invalid Studio quota incident source')
}

function sameIncident(a: StudioQuotaIncident, b: StudioQuotaIncident): boolean {
  return a.incidentId === b.incidentId && a.poolId === b.poolId && a.reason === b.reason && a.noticedAt === b.noticedAt
    && a.provider === b.provider && a.model === b.model && a.sessionId === b.sessionId
}

/** Quota state shares the Host's SQLite ownership fence, but does not inspect or mutate tasks. */
export class QuotaStore {
  private readonly poolIds: ReadonlySet<string>
  private readonly quotaFault = new Set<string>()
  // Once an active hold has been observed, SQL absence is not enough to confirm recovery.
  private readonly observed = new Map<string, string>()

  constructor(poolIds: readonly string[], private readonly db: () => DatabaseSync,
    private readonly write: QuotaTransaction, private readonly snapshot: QuotaTransaction) {
    if (!Array.isArray(poolIds) || [...poolIds].some(poolId => !isId(poolId))) throw new Error('Invalid Studio quota pool ID')
    this.poolIds = new Set(poolIds)
  }

  /** Seed the active hold fence, adding conservative holds only for an existing unclean Host run. */
  start(previousUnclean: boolean): void {
    for (const poolId of this.poolIds) {
      const incident = this.active(poolId) ?? (previousUnclean ? this.insert(poolId, 'HOST_UNCONFIRMED') : undefined)
      if (incident) this.observed.set(poolId, incident.incidentId)
    }
  }

  /** Check under the same write lock as the clean marker so an unconfirmed hold cannot be forgotten at shutdown. */
  canFinishRun(): boolean {
    if (this.quotaFault.size !== 0) return false
    for (const poolId of this.observed.keys()) {
      if (!this.readCurrent(poolId).ok) return false
    }
    return true
  }

  status(poolId: string): ManagedResult<StudioQuotaIncident | undefined> {
    return this.authorize(poolId) ?? this.snapshot(() => this.readCurrent(poolId))
  }

  trip(poolId: string, provider: string, model: string, sessionId?: string): ManagedResult<{ incident: StudioQuotaIncident; created: boolean }> {
    const rejected = this.authorize(poolId)
    if (rejected) return rejected
    if (!isId(provider) || !isId(model) || (sessionId !== undefined && !isId(sessionId))) return deny('INVALID_INPUT')

    // Reuse a current hold without replacing its first failure. An unconfirmed write fences only this authorized pool.
    const result = this.write(() => {
      const current = this.readCurrent(poolId)
      if (!current.ok) return current
      if (current.value) return accept({ incident: current.value, created: false })
      return accept({ incident: this.insert(poolId, 'ACCOUNT_QUOTA', provider, model, sessionId), created: true })
    })
    if (!result.ok) {
      this.quotaFault.add(poolId)
      return result.reason === 'STORAGE_ERROR' ? deny('QUOTA_UNCONFIRMED') : result
    }
    this.observed.set(poolId, result.value.incident.incidentId)
    return result
  }

  restore(poolId: string, incidentId: string, sessionId: string, commandId: string, evidence: string): ManagedResult<StudioQuotaIncident> {
    const rejected = this.authorize(poolId)
    if (rejected) return rejected
    if (!isId(incidentId) || !isId(sessionId) || !isId(commandId) || !isId(evidence) || !evidence.trim()) return deny('INVALID_INPUT')

    // The Host authenticates the owner and the evidence. The Store ties that confirmation to exactly one active incident.
    const result = this.write(() => {
      const current = this.readCurrent(poolId)
      if (!current.ok) return current
      const incident = current.value
      if (incident?.incidentId !== incidentId) return deny('STALE_QUOTA_INCIDENT')
      const db = this.db()
      if (db.prepare('SELECT 1 FROM studio_quota_incident WHERE clear_command_id = ?').get(commandId)) return deny('DUPLICATE_COMMAND')
      const at = new Date().toISOString()
      const { changes } = db.prepare(`UPDATE studio_quota_incident SET cleared_session_id = ?, clear_command_id = ?, clear_evidence = ?, cleared_at = ?
        WHERE pool_id = ? AND incident_id = ? AND cleared_at IS NULL`).run(sessionId, commandId, evidence, at, poolId, incidentId)
      const row = db.prepare('SELECT * FROM studio_quota_incident WHERE incident_id = ?').get(incidentId)
      // A skipped update or a deleted incident is not a clear. Roll back unless both the audit and the resulting state agree.
      if ((changes !== 1 && changes !== 1n) || !row || row.cleared_session_id !== sessionId || row.clear_command_id !== commandId
        || row.clear_evidence !== evidence || row.cleared_at !== at || !sameIncident(readIncident(row), incident) || this.active(poolId)) {
        throw new Error('Cannot confirm Studio quota restore')
      }
      return accept(incident)
    })
    if (result.ok) this.observed.delete(poolId)
    return result
  }

  private authorize(poolId: string) {
    if (!isId(poolId)) return deny('INVALID_INPUT')
    if (!this.poolIds.has(poolId)) return deny('QUOTA_POOL_NOT_CONFIGURED')
  }

  /** Observe the active ID for this run until a committed clear authorizes its absence. */
  private readCurrent(poolId: string): ManagedResult<StudioQuotaIncident | undefined> {
    if (this.quotaFault.has(poolId)) return deny('QUOTA_UNCONFIRMED')
    const active = this.active(poolId)
    const observed = this.observed.get(poolId)
    if (observed !== undefined && active?.incidentId !== observed) {
      this.quotaFault.add(poolId)
      return deny('QUOTA_UNCONFIRMED')
    }
    if (active) this.observed.set(poolId, active.incidentId)
    return accept(active)
  }

  private active(poolId: string): StudioQuotaIncident | undefined {
    const row = this.db().prepare('SELECT * FROM studio_quota_incident WHERE pool_id = ? AND cleared_at IS NULL').get(poolId)
    return row && readIncident(row)
  }

  /** Confirm the persisted first failure before callers may treat the hold as durable. */
  private insert(poolId: string, reason: StudioQuotaReason, provider?: string, model?: string, sessionId?: string): StudioQuotaIncident {
    const incident: StudioQuotaIncident = { incidentId: randomUUID(), poolId, reason, noticedAt: new Date().toISOString() }
    if (provider !== undefined) incident.provider = provider
    if (model !== undefined) incident.model = model
    if (sessionId !== undefined) incident.sessionId = sessionId
    const { changes } = this.db().prepare(`INSERT INTO studio_quota_incident (incident_id, pool_id, reason, noticed_at, provider, model, session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(incident.incidentId, poolId, reason, incident.noticedAt, provider ?? null, model ?? null, sessionId ?? null)
    const saved = this.active(poolId)
    if ((changes !== 1 && changes !== 1n) || !saved || !sameIncident(saved, incident)) throw new Error('Cannot confirm Studio quota hold')
    return saved
  }
}
