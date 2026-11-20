/** Keep the exact source of each Host-parsed preference correction. Only its decision can change. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/** The Host reads its own persisted native inbox event. An omitted project means exact global scope. */
export interface PreferenceCorrectionInput {
  assistantSessionId: string
  sourceRequestId: string
  sourceMessageId: string
  sourceEventSeq: number
  turn: number
  key: string
  expectedRevision: number
  projectId?: string
  text: string
}

export interface PreferenceCorrectionReceipt {
  proposalId: string
  state: 'pending' | 'confirmed' | 'closed'
  created: boolean
}

export const PREFERENCE_CORRECTION_RECEIPT_PREFIX = 'studio-memory-correction:'

/** The journal's command ID is an audit reference, not a synthetic native command or tool call. */
export function preferenceCorrectionReceiptId(proposalId: string): string {
  return `${PREFERENCE_CORRECTION_RECEIPT_PREFIX}${proposalId}`
}

// Guard replacements explicitly, because SQLite may suppress the implicit delete trigger for OR REPLACE.
export const PREFERENCE_CORRECTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_memory_correction (
    proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) > 0 AND instr(proposal_id, char(0)) = 0),
    assistant_session_id TEXT NOT NULL,
    assistant_bot_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL CHECK (length(source_request_id) > 0 AND instr(source_request_id, char(0)) = 0),
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0 AND instr(source_message_id, char(0)) = 0),
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    key TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740991),
    project_id TEXT REFERENCES studio_project (project_id),
    text TEXT NOT NULL CHECK (length(text) > 0 AND instr(text, char(0)) = 0),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'closed')),
    proposed_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
    FOREIGN KEY (key, expected_revision) REFERENCES studio_memory_revision (key, revision),
    UNIQUE (assistant_session_id, source_request_id),
    UNIQUE (assistant_session_id, source_message_id),
    UNIQUE (assistant_session_id, source_event_seq),
    CHECK ((state = 'pending') = (decided_at IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS studio_memory_correction_pending ON studio_memory_correction (proposal_id) WHERE state = 'pending';
  CREATE TRIGGER IF NOT EXISTS studio_memory_correction_guard_insert BEFORE INSERT ON studio_memory_correction BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory correction ID or source') WHERE EXISTS (
      SELECT 1 FROM studio_memory_correction WHERE proposal_id = NEW.proposal_id OR (assistant_session_id = NEW.assistant_session_id
        AND (source_request_id = NEW.source_request_id OR source_message_id = NEW.source_message_id
          OR source_event_seq = NEW.source_event_seq))
    );
    SELECT RAISE(ABORT, 'Studio memory correction must start pending in the current run') WHERE NEW.state <> 'pending'
      OR NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_correction_no_delete BEFORE DELETE ON studio_memory_correction BEGIN
    SELECT RAISE(ABORT, 'Studio memory correction provenance cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_correction_guard_update BEFORE UPDATE ON studio_memory_correction BEGIN
    SELECT RAISE(ABORT, 'Invalid Studio memory correction transition') WHERE OLD.state <> 'pending'
      OR NEW.state NOT IN ('confirmed', 'closed') OR NEW.decided_at IS NULL
      OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.assistant_session_id IS NOT OLD.assistant_session_id
      OR NEW.assistant_bot_id IS NOT OLD.assistant_bot_id OR NEW.source_request_id IS NOT OLD.source_request_id
      OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_event_seq IS NOT OLD.source_event_seq
      OR NEW.turn IS NOT OLD.turn OR NEW.key IS NOT OLD.key OR NEW.expected_revision IS NOT OLD.expected_revision
      OR NEW.project_id IS NOT OLD.project_id OR NEW.text IS NOT OLD.text OR NEW.run_id IS NOT OLD.run_id
      OR NEW.proposed_at IS NOT OLD.proposed_at;
    SELECT RAISE(ABORT, 'Studio memory correction confirmation requires its exact new revision') WHERE NEW.state = 'confirmed'
      AND (NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0)
        OR NOT EXISTS (SELECT 1 FROM studio_memory_revision AS r JOIN studio_memory_head AS h
          ON h.key = r.key AND h.revision = r.revision AND h.state = r.state AND h.project_id IS r.project_id
          WHERE r.key = NEW.key AND r.revision = NEW.expected_revision + 1 AND r.operation = 'correct'
            AND r.state = 'active' AND r.project_id IS NEW.project_id AND r.text = NEW.text
            AND r.source_session_id = NEW.assistant_session_id AND r.source_event_seq = NEW.source_event_seq
            AND r.command_id = '${PREFERENCE_CORRECTION_RECEIPT_PREFIX}' || NEW.proposal_id));
  END;
`

type Row = Record<string, SQLOutputValue>
type CorrectionSource = Pick<PreferenceCorrectionInput, 'assistantSessionId' | 'sourceRequestId' | 'sourceMessageId' | 'sourceEventSeq'>
const CORRECTION = `proposal_id AS proposalId, assistant_session_id AS assistantSessionId, assistant_bot_id AS assistantBotId,
  source_request_id AS sourceRequestId, source_message_id AS sourceMessageId, source_event_seq AS sourceEventSeq,
  turn, key, expected_revision AS expectedRevision, project_id AS projectId, text, run_id AS runId,
  state, proposed_at AS proposedAt, decided_at AS decidedAt`

/** Any matching coordinate consumes the source. The caller compares all fields before returning a replay. */
export function preferenceCorrectionBySource(db: DatabaseSync, source: CorrectionSource): Row | undefined {
  return db.prepare(`SELECT ${CORRECTION} FROM studio_memory_correction
    WHERE assistant_session_id = ? AND (source_request_id = ? OR source_message_id = ? OR source_event_seq = ?) LIMIT 1`)
    .get(source.assistantSessionId, source.sourceRequestId, source.sourceMessageId, source.sourceEventSeq)
}

export function preferenceCorrectionById(db: DatabaseSync, assistantSessionId: string, proposalId: string): Row | undefined {
  return db.prepare(`SELECT ${CORRECTION} FROM studio_memory_correction WHERE assistant_session_id = ? AND proposal_id = ?`)
    .get(assistantSessionId, proposalId)
}

/** Insert only validated Host input; the caller verifies the retained provenance before committing. */
export function insertPreferenceCorrection(db: DatabaseSync, input: PreferenceCorrectionInput, proposalId: string,
  assistantBotId: string, runId: string, at: string): void {
  const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, key, expectedRevision, projectId, text } = input
  const { changes } = db.prepare(`INSERT INTO studio_memory_correction (proposal_id, assistant_session_id, assistant_bot_id,
    source_request_id, source_message_id, source_event_seq, turn, key, expected_revision, project_id, text, run_id, state, proposed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(proposalId, assistantSessionId, assistantBotId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, key, expectedRevision,
      projectId ?? null, text, runId, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory correction insert did not affect exactly one row')
}

/** Decide only the exact pending binding in this run, and fail the transaction if SQLite did not retain it. */
export function decidePreferenceCorrection(db: DatabaseSync, assistantSessionId: string, assistantBotId: string,
  proposalId: string, runId: string, state: 'closed' | 'confirmed'): void {
  const at = new Date().toISOString()
  const { changes } = db.prepare(`UPDATE studio_memory_correction SET state = ?, decided_at = ?
    WHERE assistant_session_id = ? AND assistant_bot_id = ? AND proposal_id = ? AND run_id = ? AND state = 'pending'`)
    .run(state, at, assistantSessionId, assistantBotId, proposalId, runId)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory correction decision did not affect exactly one row')
  const row = preferenceCorrectionById(db, assistantSessionId, proposalId)
  if (row?.state !== state || row.decidedAt !== at) throw new Error('Studio memory correction decision was not retained')
}

/** Keep all source coordinates and replacement text, but do not carry pending native questions into the next run. */
export function closePreviousPreferenceCorrections(db: DatabaseSync): void {
  db.prepare("UPDATE studio_memory_correction SET state = 'closed', decided_at = ? WHERE state = 'pending'")
    .run(new Date().toISOString())
  if (db.prepare("SELECT 1 FROM studio_memory_correction WHERE state = 'pending' LIMIT 1").get()) {
    throw new Error('Cannot close previous Studio memory corrections')
  }
}
