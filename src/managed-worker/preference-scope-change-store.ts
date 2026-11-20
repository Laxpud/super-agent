/** Keep scope-change consent and native provenance without storing the preference body or original message. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/** The Host supplies verified inbox coordinates. A forget without a project matches global scope only. */
export type PreferenceScopeChangeInput = {
  assistantSessionId: string
  sourceRequestId: string
  sourceMessageId: string
  sourceEventSeq: number
  turn: number
  key: string
  expectedRevision: number
} & ({ kind: 'restrict'; targetProjectId: string } | { kind: 'forget'; projectId?: string })

export interface PreferenceScopeChangeReceipt {
  proposalId: string
  state: 'pending' | 'confirmed' | 'closed'
  created: boolean
}

export const PREFERENCE_SCOPE_CHANGE_RECEIPT_PREFIX = 'studio-memory-scope-change:'

/** Identify a confirmed proposal in the journal without claiming that a native command ran. */
export function preferenceScopeChangeReceiptId(proposalId: string): string {
  return `${PREFERENCE_SCOPE_CHANGE_RECEIPT_PREFIX}${proposalId}`
}

// Pin the prior revision and admit only an exact pending-to-terminal decision. Explicit duplicate checks also guard OR REPLACE.
export const PREFERENCE_SCOPE_CHANGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_memory_scope_change (
    proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) > 0 AND instr(proposal_id, char(0)) = 0),
    assistant_session_id TEXT NOT NULL,
    assistant_bot_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL CHECK (length(source_request_id) > 0 AND instr(source_request_id, char(0)) = 0),
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0 AND instr(source_message_id, char(0)) = 0),
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    key TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 1 AND 9007199254740990),
    expected_project_id TEXT REFERENCES studio_project (project_id),
    operation TEXT NOT NULL CHECK (operation IN ('restrict', 'forget')),
    target_project_id TEXT REFERENCES studio_project (project_id),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'closed')),
    proposed_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
    FOREIGN KEY (key, expected_revision) REFERENCES studio_memory_revision (key, revision),
    UNIQUE (assistant_session_id, source_request_id),
    UNIQUE (assistant_session_id, source_message_id),
    UNIQUE (assistant_session_id, source_event_seq),
    CHECK ((operation = 'restrict' AND expected_project_id IS NULL AND target_project_id IS NOT NULL)
      OR (operation = 'forget' AND target_project_id IS NULL)),
    CHECK ((state = 'pending') = (decided_at IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS studio_memory_scope_change_pending ON studio_memory_scope_change (proposal_id) WHERE state = 'pending';
  CREATE TRIGGER IF NOT EXISTS studio_memory_scope_change_guard_insert BEFORE INSERT ON studio_memory_scope_change BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory scope change ID or source') WHERE EXISTS (
      SELECT 1 FROM studio_memory_scope_change WHERE proposal_id = NEW.proposal_id OR (assistant_session_id = NEW.assistant_session_id
        AND (source_request_id = NEW.source_request_id OR source_message_id = NEW.source_message_id
          OR source_event_seq = NEW.source_event_seq))
    );
    SELECT RAISE(ABORT, 'Studio memory scope change must start pending against the exact current revision') WHERE NEW.state <> 'pending'
      OR NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0)
      OR NOT EXISTS (SELECT 1 FROM studio_memory_head WHERE key = NEW.key AND revision = NEW.expected_revision
        AND state = 'active' AND project_id IS NEW.expected_project_id);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_scope_change_no_delete BEFORE DELETE ON studio_memory_scope_change BEGIN
    SELECT RAISE(ABORT, 'Studio memory scope change provenance cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_scope_change_guard_update BEFORE UPDATE ON studio_memory_scope_change BEGIN
    SELECT RAISE(ABORT, 'Invalid Studio memory scope change transition') WHERE OLD.state <> 'pending'
      OR NEW.state NOT IN ('confirmed', 'closed') OR NEW.decided_at IS NULL
      OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.assistant_session_id IS NOT OLD.assistant_session_id
      OR NEW.assistant_bot_id IS NOT OLD.assistant_bot_id OR NEW.source_request_id IS NOT OLD.source_request_id
      OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_event_seq IS NOT OLD.source_event_seq
      OR NEW.turn IS NOT OLD.turn OR NEW.key IS NOT OLD.key OR NEW.expected_revision IS NOT OLD.expected_revision
      OR NEW.expected_project_id IS NOT OLD.expected_project_id OR NEW.operation IS NOT OLD.operation
      OR NEW.target_project_id IS NOT OLD.target_project_id OR NEW.run_id IS NOT OLD.run_id OR NEW.proposed_at IS NOT OLD.proposed_at;
    SELECT RAISE(ABORT, 'Studio memory scope change confirmation requires its exact new revision') WHERE NEW.state = 'confirmed'
      AND (NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0)
        OR NOT EXISTS (SELECT 1 FROM studio_memory_revision AS r JOIN studio_memory_head AS h
          ON h.key = r.key AND h.revision = r.revision AND h.state = r.state AND h.project_id IS r.project_id
          JOIN studio_memory_revision AS previous ON previous.key = r.key AND previous.revision = NEW.expected_revision
          WHERE r.key = NEW.key AND r.revision = NEW.expected_revision + 1 AND r.operation = NEW.operation
            AND previous.state = 'active' AND previous.project_id IS NEW.expected_project_id
            AND ((NEW.operation = 'restrict' AND r.state = 'active' AND r.project_id IS NEW.target_project_id AND r.text = previous.text)
              OR (NEW.operation = 'forget' AND r.state = 'forgotten' AND r.project_id IS NEW.expected_project_id AND r.text IS NULL))
            AND r.source_session_id = NEW.assistant_session_id AND r.source_event_seq = NEW.source_event_seq
            AND r.command_id = '${PREFERENCE_SCOPE_CHANGE_RECEIPT_PREFIX}' || NEW.proposal_id));
  END;
`

export const SCOPE_CHANGE_SOURCE_CONFLICT = 'Studio memory scope change already owns the source'

// Assistant work routes have request/message coordinates but no inbox event coordinate. Reject a new route after
// a scope change reserved either coordinate, even after consent expires. These guards don't alter legacy rows.
export const SCOPE_CHANGE_ASSISTANT_SOURCE_GUARDS = [
  ['studio_draft_task', 'NEW.assistant_session_id', '1'],
  ['studio_project_proposal', 'NEW.assistant_session_id', '1'],
  ['studio_study', 'NEW.assistant_session_id', '1'],
  ['studio_advice', 'NEW.requester_session_id', "NEW.role = 'assistant'"],
].map(([table, sessionId, assistant]) => `
  CREATE TRIGGER IF NOT EXISTS ${table}_scope_change_source_guard BEFORE INSERT ON ${table}
  WHEN ${assistant} AND EXISTS (SELECT 1 FROM studio_memory_scope_change WHERE assistant_session_id = ${sessionId}
    AND (source_request_id = NEW.source_request_id OR source_message_id = NEW.source_message_id)) BEGIN
    SELECT RAISE(ABORT, '${SCOPE_CHANGE_SOURCE_CONFLICT}');
  END;
`).join('')

type Row = Record<string, SQLOutputValue>
const SCOPE_CHANGE = `proposal_id AS proposalId, assistant_session_id AS assistantSessionId, assistant_bot_id AS assistantBotId,
  source_request_id AS sourceRequestId, source_message_id AS sourceMessageId, source_event_seq AS sourceEventSeq,
  turn, key, expected_revision AS expectedRevision, expected_project_id AS expectedProjectId, operation AS kind,
  target_project_id AS targetProjectId, run_id AS runId, state, proposed_at AS proposedAt, decided_at AS decidedAt`

/** Match any available coordinate; a same-route replay must additionally compare the entire input. */
export function preferenceScopeChangeBySource(db: DatabaseSync, assistantSessionId: string, sourceRequestId: string | null,
  sourceMessageId: string | null, sourceEventSeq: number): Row | undefined {
  return db.prepare(`SELECT ${SCOPE_CHANGE} FROM studio_memory_scope_change
    WHERE assistant_session_id = ? AND (source_request_id = ? OR source_message_id = ? OR source_event_seq = ?) LIMIT 1`)
    .get(assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq)
}

export function preferenceScopeChangeById(db: DatabaseSync, assistantSessionId: string, proposalId: string): Row | undefined {
  return db.prepare(`SELECT ${SCOPE_CHANGE} FROM studio_memory_scope_change WHERE assistant_session_id = ? AND proposal_id = ?`)
    .get(assistantSessionId, proposalId)
}

/** Reserve only validated Host coordinates; the caller checks that SQLite retained the exact reservation. */
export function insertPreferenceScopeChange(db: DatabaseSync, input: PreferenceScopeChangeInput, proposalId: string,
  assistantBotId: string, runId: string, at: string): void {
  const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, key, expectedRevision, kind } = input
  const { changes } = db.prepare(`INSERT INTO studio_memory_scope_change (proposal_id, assistant_session_id, assistant_bot_id,
    source_request_id, source_message_id, source_event_seq, turn, key, expected_revision, expected_project_id, operation,
    target_project_id, run_id, state, proposed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(proposalId, assistantSessionId, assistantBotId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, key, expectedRevision,
      kind === 'forget' ? input.projectId ?? null : null, kind, kind === 'restrict' ? input.targetProjectId : null, runId, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory scope change insert did not affect exactly one row')
}

/** Settle exactly one pending reservation in the caller's fenced transaction, or fail that transaction. */
export function decidePreferenceScopeChange(db: DatabaseSync, assistantSessionId: string, assistantBotId: string,
  proposalId: string, runId: string, state: 'closed' | 'confirmed'): void {
  const at = new Date().toISOString()
  const { changes } = db.prepare(`UPDATE studio_memory_scope_change SET state = ?, decided_at = ?
    WHERE assistant_session_id = ? AND assistant_bot_id = ? AND proposal_id = ? AND run_id = ? AND state = 'pending'`)
    .run(state, at, assistantSessionId, assistantBotId, proposalId, runId)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory scope change decision did not affect exactly one row')
  const row = preferenceScopeChangeById(db, assistantSessionId, proposalId)
  if (row?.state !== state || row.decidedAt !== at) throw new Error('Studio memory scope change decision was not retained')
}

/** Close abandoned questions at startup without releasing their source coordinates for reuse. */
export function closePreviousPreferenceScopeChanges(db: DatabaseSync): void {
  db.prepare("UPDATE studio_memory_scope_change SET state = 'closed', decided_at = ? WHERE state = 'pending'")
    .run(new Date().toISOString())
  if (db.prepare("SELECT 1 FROM studio_memory_scope_change WHERE state = 'pending' LIMIT 1").get()) {
    throw new Error('Cannot close previous Studio memory scope changes')
  }
}
