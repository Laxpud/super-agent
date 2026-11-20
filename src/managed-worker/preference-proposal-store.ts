/** Durable provenance for Host-verified preference proposals. Only the decision may change after insertion. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

/** The Host supplies the exact native source and its complete intent; literal inclusion alone is not owner consent. */
export interface PreferenceProposalInput {
  assistantSessionId: string
  sourceRequestId: string
  sourceMessageId: string
  sourceEventSeq: number
  turn: number
  toolCallId: string
  key: string
  intentText: string
  text: string
}

/** Internal Host receipt. Do not return the source text or preference body to the model. */
export interface PreferenceProposal extends PreferenceProposalInput {
  proposalId: string
  state: 'pending' | 'confirmed' | 'closed'
}

export const PREFERENCE_PROPOSAL_INTENT_LIMIT = 2400
export const PREFERENCE_PROPOSAL_RECEIPT_PREFIX = 'studio-memory-proposal:'

/** The memory journal's command ID column holds an opaque audit key, not a native command ID for this act. */
export function preferenceProposalReceiptId(proposalId: string): string {
  return `${PREFERENCE_PROPOSAL_RECEIPT_PREFIX}${proposalId}`
}

// Reject replacements explicitly: SQLite may suppress the implicit delete trigger for INSERT OR REPLACE.
const SAME_SOURCE = `(source_request_id = ? OR source_message_id = ? OR source_event_seq = ? OR tool_call_id = ?)`
export const PREFERENCE_PROPOSAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_memory_proposal (
    proposal_id TEXT PRIMARY KEY CHECK (length(proposal_id) > 0 AND instr(proposal_id, char(0)) = 0),
    assistant_session_id TEXT NOT NULL,
    assistant_bot_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL CHECK (length(source_request_id) > 0 AND instr(source_request_id, char(0)) = 0),
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0 AND instr(source_message_id, char(0)) = 0),
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) > 0 AND instr(tool_call_id, char(0)) = 0),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
      AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
    intent_text TEXT NOT NULL CHECK (length(intent_text) BETWEEN 1 AND ${PREFERENCE_PROPOSAL_INTENT_LIMIT}
      AND instr(intent_text, char(0)) = 0),
    text TEXT NOT NULL CHECK (length(text) > 0 AND instr(text, char(0)) = 0 AND instr(intent_text, text) > 0),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'closed')),
    proposed_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
    UNIQUE (assistant_session_id, source_request_id),
    UNIQUE (assistant_session_id, source_message_id),
    UNIQUE (assistant_session_id, source_event_seq),
    UNIQUE (assistant_session_id, tool_call_id),
    CHECK ((state = 'pending') = (decided_at IS NULL))
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS studio_memory_proposal_pending ON studio_memory_proposal (proposal_id) WHERE state = 'pending';
  CREATE TRIGGER IF NOT EXISTS studio_memory_proposal_guard_insert BEFORE INSERT ON studio_memory_proposal BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory proposal ID or source') WHERE EXISTS (
      SELECT 1 FROM studio_memory_proposal WHERE proposal_id = NEW.proposal_id OR (assistant_session_id = NEW.assistant_session_id
        AND (source_request_id = NEW.source_request_id OR source_message_id = NEW.source_message_id
          OR source_event_seq = NEW.source_event_seq OR tool_call_id = NEW.tool_call_id))
    );
    SELECT RAISE(ABORT, 'Studio memory proposal must start pending in the current run') WHERE NEW.state <> 'pending'
      OR NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_proposal_no_delete BEFORE DELETE ON studio_memory_proposal BEGIN
    SELECT RAISE(ABORT, 'Studio memory proposal provenance cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_proposal_guard_update BEFORE UPDATE ON studio_memory_proposal BEGIN
    SELECT RAISE(ABORT, 'Invalid Studio memory proposal transition') WHERE OLD.state <> 'pending'
      OR NEW.state NOT IN ('confirmed', 'closed') OR NEW.decided_at IS NULL
      OR NEW.proposal_id IS NOT OLD.proposal_id OR NEW.assistant_session_id IS NOT OLD.assistant_session_id
      OR NEW.assistant_bot_id IS NOT OLD.assistant_bot_id OR NEW.source_request_id IS NOT OLD.source_request_id
      OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_event_seq IS NOT OLD.source_event_seq
      OR NEW.turn IS NOT OLD.turn OR NEW.tool_call_id IS NOT OLD.tool_call_id OR NEW.key IS NOT OLD.key
      OR NEW.intent_text IS NOT OLD.intent_text OR NEW.text IS NOT OLD.text OR NEW.run_id IS NOT OLD.run_id
      OR NEW.proposed_at IS NOT OLD.proposed_at;
    SELECT RAISE(ABORT, 'Studio memory proposal confirmation requires its exact new preference') WHERE NEW.state = 'confirmed'
      AND (NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0)
        OR NOT EXISTS (SELECT 1 FROM studio_memory_revision AS r JOIN studio_memory_head AS h
          ON h.key = r.key AND h.revision = r.revision
          WHERE r.key = NEW.key AND r.revision = 1 AND r.operation = 'remember' AND r.state = 'active' AND r.project_id IS NULL
            AND r.text = NEW.text AND r.source_session_id = NEW.assistant_session_id
            AND r.command_id = '${PREFERENCE_PROPOSAL_RECEIPT_PREFIX}' || NEW.proposal_id AND r.source_event_seq = NEW.source_event_seq));
  END;
`

type Row = Record<string, SQLOutputValue>
const PROPOSAL = `proposal_id AS proposalId, assistant_session_id AS assistantSessionId, assistant_bot_id AS assistantBotId,
  source_request_id AS sourceRequestId, source_message_id AS sourceMessageId, source_event_seq AS sourceEventSeq,
  turn, tool_call_id AS toolCallId, key, intent_text AS intentText, text, run_id AS runId,
  state, proposed_at AS proposedAt, decided_at AS decidedAt`

/** Read any collision in the caller's transaction. Only a row matching all provenance can be an exact replay. */
export function preferenceProposalBySource(db: DatabaseSync, assistantSessionId: string, sourceRequestId: string | null,
  sourceMessageId: string | null, sourceEventSeq: number | null, toolCallId: string | null): Row | undefined {
  return db.prepare(`SELECT ${PROPOSAL} FROM studio_memory_proposal
    WHERE assistant_session_id = ? AND ${SAME_SOURCE} LIMIT 1`)
    .get(assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, toolCallId)
}

export function preferenceProposalById(db: DatabaseSync, assistantSessionId: string, proposalId: string): Row | undefined {
  return db.prepare(`SELECT ${PROPOSAL} FROM studio_memory_proposal WHERE assistant_session_id = ? AND proposal_id = ?`)
    .get(assistantSessionId, proposalId)
}

/** Persist the exact validated input; the caller verifies the retained row before committing. */
export function insertPreferenceProposal(db: DatabaseSync, input: PreferenceProposalInput, proposalId: string,
  assistantBotId: string, runId: string, at: string): void {
  const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, toolCallId, key, intentText, text } = input
  const { changes } = db.prepare(`INSERT INTO studio_memory_proposal (proposal_id, assistant_session_id, assistant_bot_id,
    source_request_id, source_message_id, source_event_seq, turn, tool_call_id, key, intent_text, text, run_id, state, proposed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(proposalId, assistantSessionId, assistantBotId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, toolCallId,
      key, intentText, text, runId, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory proposal insert did not affect exactly one row')
}

/** Change only a current pending decision and confirm that SQLite retained the exact write. */
export function decidePreferenceProposal(db: DatabaseSync, assistantSessionId: string, proposalId: string, runId: string,
  state: 'closed' | 'confirmed'): void {
  const at = new Date().toISOString()
  const { changes } = db.prepare(`UPDATE studio_memory_proposal SET state = ?, decided_at = ?
    WHERE assistant_session_id = ? AND proposal_id = ? AND run_id = ? AND state = 'pending'`)
    .run(state, at, assistantSessionId, proposalId, runId)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory proposal decision did not affect exactly one row')
  const row = preferenceProposalById(db, assistantSessionId, proposalId)
  if (row?.state !== state || row.decidedAt !== at) throw new Error('Studio memory proposal decision was not retained')
}

/** Retain old provenance, but never resume an outstanding native question in a new Host run. */
export function closePreviousPreferenceProposals(db: DatabaseSync): void {
  db.prepare("UPDATE studio_memory_proposal SET state = 'closed', decided_at = ? WHERE state = 'pending'")
    .run(new Date().toISOString())
  if (db.prepare("SELECT 1 FROM studio_memory_proposal WHERE state = 'pending' LIMIT 1").get()) {
    throw new Error('Cannot close previous Studio memory proposals')
  }
}
