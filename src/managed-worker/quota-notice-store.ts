import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ManagedResult } from './store.js'

/** Public delivery state; destination and run ownership stay in the ledger. */
export type StudioQuotaNotice = { state: 'sending' | 'delivered' | 'unconfirmed'; messageId?: string }

// Key the attempt by incident, not destination, so changing the configured scope cannot authorize another send.
export const QUOTA_NOTICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_quota_notice (
    incident_id TEXT PRIMARY KEY REFERENCES studio_quota_incident (incident_id),
    destination_scope TEXT NOT NULL,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'delivered', 'unconfirmed')),
    claimed_at TEXT NOT NULL,
    settled_at TEXT,
    message_id TEXT,
    CHECK ((state = 'sending') = (settled_at IS NULL)),
    CHECK ((state = 'delivered') = (message_id IS NOT NULL))
  ) STRICT;
`

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })

export function isQuotaNoticeMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^om_[a-zA-Z0-9_-]+$/.test(value)
}

/** Ledger operations run in the caller's Host-owned transaction; they never mutate the quota hold. */
export class QuotaNoticeStore {
  constructor(private readonly db: () => DatabaseSync, private readonly runId: string) {}

  /** A previous run may have sent the message without receiving or recording a receipt. Retain the attempt even on a clean restart. */
  recoverSending(): void {
    const db = this.db()
    db.prepare(`UPDATE studio_quota_notice SET state = 'unconfirmed', settled_at = ? WHERE state = 'sending'`)
      .run(new Date().toISOString())
    if (db.prepare("SELECT 1 FROM studio_quota_notice WHERE state = 'sending' LIMIT 1").get()) {
      throw new Error('Cannot recover previous Studio quota notices')
    }
  }

  /** Recheck closure under the write lock after the caller's in-memory and SQLite quota fence check. */
  claim(poolId: string, incidentId: string, scope: string): ManagedResult<{ claimed: boolean }> {
    const db = this.db()
    const active = db.prepare(`SELECT 1 FROM studio_quota_incident
      WHERE incident_id = ? AND pool_id = ? AND reason = 'ACCOUNT_QUOTA' AND cleared_at IS NULL`)
    if (!active.get(incidentId, poolId)) return { ok: false, reason: 'STALE_QUOTA_INCIDENT' }
    if (this.row(incidentId)) return accept({ claimed: false })

    const at = new Date().toISOString()
    const { changes } = db.prepare(`INSERT INTO studio_quota_notice
      (incident_id, destination_scope, run_id, state, claimed_at) VALUES (?, ?, ?, 'sending', ?)`)
      .run(incidentId, scope, this.runId, at)
    const row = this.row(incidentId)
    // A skipped or altered insert must not authorize the caller to send.
    if ((changes !== 1 && changes !== 1n) || !row || row.destination_scope !== scope || row.run_id !== this.runId
      || row.state !== 'sending' || row.claimed_at !== at || !active.get(incidentId, poolId)) {
      throw new Error('Cannot confirm Studio quota notice claim')
    }
    return accept({ claimed: true })
  }

  /** Record only the original attempt's outcome, even if the quota hold has since been cleared. */
  settle(incidentId: string, scope: string, messageId?: string): ManagedResult<StudioQuotaNotice> {
    const current = this.row(incidentId)
    if (!current || current.destination_scope !== scope || current.run_id !== this.runId || current.state !== 'sending') {
      return { ok: false, reason: 'STALE_QUOTA_NOTICE' }
    }
    const at = new Date().toISOString()
    const state = messageId === undefined ? 'unconfirmed' : 'delivered'
    const { changes } = this.db().prepare(`UPDATE studio_quota_notice SET state = ?, settled_at = ?, message_id = ?
      WHERE incident_id = ? AND destination_scope = ? AND run_id = ? AND state = 'sending'`)
      .run(state, at, messageId ?? null, incidentId, scope, this.runId)
    const row = this.row(incidentId)
    if ((changes !== 1 && changes !== 1n) || !row || row.state !== state || row.settled_at !== at
      || row.message_id !== (messageId ?? null) || row.destination_scope !== scope || row.run_id !== this.runId
      || row.claimed_at !== current.claimed_at) {
      throw new Error('Cannot confirm Studio quota notice settlement')
    }
    return accept(messageId === undefined ? { state } : { state, messageId })
  }

  /** Read the notice by exact incident ID, without returning storage-only metadata. */
  status(incidentId: string): StudioQuotaNotice | undefined {
    const row = this.row(incidentId)
    if (!row) return
    const { state, message_id: messageId } = row
    if (state === 'delivered' && isQuotaNoticeMessageId(messageId)) return { state, messageId }
    if ((state === 'sending' || state === 'unconfirmed') && messageId === null) return { state }
    throw new Error('Invalid Studio quota notice')
  }

  private row(incidentId: string): Record<string, SQLOutputValue> | undefined {
    return this.db().prepare(`SELECT destination_scope, run_id, state, claimed_at, settled_at, message_id
      FROM studio_quota_notice WHERE incident_id = ?`).get(incidentId)
  }
}
