/** Keep one outbound notice attempt per immutable document failure, independent of recovery. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { DocumentFailure } from './document-recovery-store.js'
import type { ManagedResult } from './store.js'

/** Delivery state and its original evidence, without the destination or run metadata. */
export interface DocumentFailureNotice {
  evidenceId: string
  state: 'sending' | 'delivered' | 'unconfirmed'
  messageId?: string
}

export const DOCUMENT_FAILURE_NOTICE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_document_failure_notice (
    evidence_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_document_failure (evidence_id),
    destination_scope TEXT NOT NULL,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'delivered', 'unconfirmed')),
    claimed_at TEXT NOT NULL,
    settled_at TEXT,
    message_id TEXT,
    CHECK ((state = 'sending') = (settled_at IS NULL)),
    CHECK ((state = 'delivered') = (message_id IS NOT NULL)),
    CHECK (message_id IS NULL OR (substr(message_id, 1, 3) = 'om_' AND length(message_id) > 3
      AND instr(message_id, char(0)) = 0 AND substr(message_id, 4) NOT GLOB '*[^a-zA-Z0-9_-]*'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_document_failure_run_evidence
    ON studio_document_failure (run_id, evidence_id);
  CREATE INDEX IF NOT EXISTS studio_document_failure_notice_sending
    ON studio_document_failure_notice (evidence_id) WHERE state = 'sending';
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_notice_once
    BEFORE INSERT ON studio_document_failure_notice
    WHEN EXISTS (SELECT 1 FROM studio_document_failure_notice WHERE evidence_id = NEW.evidence_id)
    BEGIN SELECT RAISE(ABORT, 'Studio document failure notice already attempted'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_notice_keep
    BEFORE DELETE ON studio_document_failure_notice
    BEGIN SELECT RAISE(ABORT, 'Studio document failure notice attempts must be retained'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_notice_transition
    BEFORE UPDATE ON studio_document_failure_notice
    WHEN OLD.state <> 'sending' OR NEW.state NOT IN ('delivered', 'unconfirmed')
      OR NEW.evidence_id IS NOT OLD.evidence_id OR NEW.run_id IS NOT OLD.run_id
      OR NEW.destination_scope IS NOT OLD.destination_scope OR NEW.claimed_at IS NOT OLD.claimed_at
    BEGIN SELECT RAISE(ABORT, 'Only the original Studio document failure notice may be settled'); END;
`

const PAGE_LIMIT = 8
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isReceipt = (value: unknown): value is string => typeof value === 'string' && /^om_[a-zA-Z0-9_-]+$/.test(value)

/** Run ledger operations inside the caller's Host-owned snapshot or write transaction. */
export class DocumentFailureNoticeStore {
  constructor(private readonly db: () => DatabaseSync, private readonly runId: string,
    private readonly eligible: (evidenceId: string) => ManagedResult<DocumentFailure>) {}

  /** A restart cannot distinguish an unsent attempt from a lost receipt. Finalize it without granting another send. */
  recoverSending(): void {
    const db = this.db()
    db.prepare("UPDATE studio_document_failure_notice SET state = 'unconfirmed', settled_at = ? WHERE state = 'sending'")
      .run(new Date().toISOString())
    if (db.prepare("SELECT 1 FROM studio_document_failure_notice WHERE state = 'sending' LIMIT 1").get()) {
      throw new Error('Cannot recover previous Studio document failure notices')
    }
  }

  /** Read indexed metadata from this run only. This is a candidate list, not a grant to send. */
  page(afterEvidenceId = ''): { evidenceIds: string[]; next?: string } {
    const rows = this.db().prepare(`SELECT f.evidence_id FROM studio_document_failure f INDEXED BY studio_document_failure_run_evidence
      WHERE f.run_id = ? AND f.evidence_id > ?
        AND EXISTS (SELECT 1 FROM managed_task t
          JOIN managed_document d ON d.task_id = t.task_id
          JOIN managed_session_binding b ON b.task_id = t.task_id AND b.execution_epoch = t.execution_epoch
          WHERE t.task_id = f.task_id AND t.execution_epoch = f.execution_epoch
            AND t.authorization_version = f.authorization_version AND b.session_id = f.worker_session_id
            AND t.paused = 0 AND d.document_version = 1)
        AND NOT EXISTS (SELECT 1 FROM studio_document_effective_pending p WHERE p.task_id = f.task_id)
        AND NOT EXISTS (SELECT 1 FROM studio_shared_document_task s WHERE s.task_id = f.task_id AND s.base_version IS NOT
          (SELECT MAX(r.version) FROM studio_shared_document_revision r WHERE r.document_id = s.document_id))
        AND NOT EXISTS (SELECT 1 FROM studio_document_recovery r WHERE r.evidence_id = f.evidence_id)
        AND NOT EXISTS (SELECT 1 FROM studio_document_failure_notice n WHERE n.evidence_id = f.evidence_id)
      ORDER BY f.evidence_id LIMIT ?`).all(this.runId, afterEvidenceId, PAGE_LIMIT + 1)
    const evidenceIds = rows.slice(0, PAGE_LIMIT).map(({ evidence_id: id }) => {
      if (!isId(id)) throw new Error('Invalid Studio document failure evidence ID')
      return id
    })
    return rows.length > PAGE_LIMIT ? { evidenceIds, next: evidenceIds[PAGE_LIMIT - 1]! } : { evidenceIds }
  }

  /** Grant a send only after the caller commits the sole attempt for still-eligible evidence. */
  claim(evidenceId: string, scope: string): ManagedResult<{ failure?: DocumentFailure }> {
    // Evidence, not the destination or run, is the idempotency key.
    if (this.row(evidenceId)) return accept({})
    const current = this.eligible(evidenceId)
    if (!current.ok) return current
    const at = new Date().toISOString()
    const { changes } = this.db().prepare(`INSERT INTO studio_document_failure_notice
      (evidence_id, destination_scope, run_id, state, claimed_at) VALUES (?, ?, ?, 'sending', ?)`)
      .run(evidenceId, scope, this.runId, at)
    const row = this.row(evidenceId)
    // A skipped or altered insert must not authorize a send, even if a trigger changed another row.
    if ((changes !== 1 && changes !== 1n) || !row || row.destination_scope !== scope || row.run_id !== this.runId
      || row.state !== 'sending' || row.claimed_at !== at || !this.eligible(evidenceId).ok) {
      throw new Error('Cannot confirm Studio document failure notice claim')
    }
    return accept({ failure: current.value })
  }

  /** Settle the original sending row even if the evidence has since become ineligible or been consumed. */
  settle(evidenceId: string, scope: string, messageId?: string): ManagedResult<DocumentFailureNotice> {
    const current = this.row(evidenceId)
    if (!current || current.destination_scope !== scope || current.run_id !== this.runId || current.state !== 'sending') {
      return { ok: false, reason: 'STALE_DOCUMENT_FAILURE_NOTICE' }
    }
    const receipt = isReceipt(messageId) ? messageId : null
    const state = receipt === null ? 'unconfirmed' : 'delivered'
    const at = new Date().toISOString()
    const { changes } = this.db().prepare(`UPDATE studio_document_failure_notice SET state = ?, settled_at = ?, message_id = ?
      WHERE evidence_id = ? AND destination_scope = ? AND run_id = ? AND state = 'sending'`)
      .run(state, at, receipt, evidenceId, scope, this.runId)
    const row = this.row(evidenceId)
    if ((changes !== 1 && changes !== 1n) || !row || row.state !== state || row.settled_at !== at || row.message_id !== receipt
      || row.destination_scope !== scope || row.run_id !== this.runId || row.claimed_at !== current.claimed_at) {
      throw new Error('Cannot confirm Studio document failure notice settlement')
    }
    return accept(receipt === null ? { evidenceId, state } : { evidenceId, state, messageId: receipt })
  }

  /** Read retained history independently of current recovery eligibility. Attempts follow the task's increasing coordinates. */
  latestForTask(taskId: string): DocumentFailureNotice | undefined {
    const row = this.db().prepare(`SELECT n.evidence_id, n.state, n.message_id FROM studio_document_failure f
      JOIN studio_document_failure_notice n ON n.evidence_id = f.evidence_id WHERE f.task_id = ?
      ORDER BY f.execution_epoch DESC, f.authorization_version DESC LIMIT 1`).get(taskId)
    if (!row) return
    const { evidence_id: evidenceId, state, message_id: messageId } = row
    if (isId(evidenceId)) {
      if (state === 'delivered' && isReceipt(messageId)) return { evidenceId, state, messageId }
      if ((state === 'sending' || state === 'unconfirmed') && messageId === null) return { evidenceId, state }
    }
    throw new Error('Invalid Studio document failure notice')
  }

  private row(evidenceId: string): Record<string, SQLOutputValue> | undefined {
    return this.db().prepare(`SELECT destination_scope, run_id, state, claimed_at, settled_at, message_id
      FROM studio_document_failure_notice WHERE evidence_id = ?`).get(evidenceId)
  }
}
