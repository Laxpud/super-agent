/** The document instruction ledger shares the Managed Worker database and its run fence. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Original source coordinates and text. Null text retains the reference for unsupported input. */
export interface StudioInstructionInput {
  channel: 'gui' | 'feishu'
  sourceScope: string
  requestId: string
  messageId: string
  eventSeq: number | null
  sourceTimeMs: number
  text: string | null
}

export interface StudioDocumentInstruction {
  instructionId: string
  source: StudioInstructionInput
}

export type InstructionDecision = 'unchanged' | 'pause'

export const INSTRUCTION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_document_instruction (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    instruction_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL REFERENCES managed_task (task_id),
    observed_execution_epoch INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('gui', 'feishu')),
    source_scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    event_seq INTEGER CHECK (event_seq BETWEEN 0 AND 9007199254740991),
    source_time_ms INTEGER NOT NULL CHECK (source_time_ms BETWEEN 0 AND 9007199254740991),
    text TEXT,
    received_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'unchanged', 'pause')),
    review_session_id TEXT REFERENCES managed_session_binding (session_id),
    command_id TEXT UNIQUE,
    reviewed_at TEXT,
    review_authorization_version INTEGER CHECK (review_authorization_version BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (task_id, observed_execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    UNIQUE (channel, source_scope, request_id),
    CHECK ((state = 'pending' AND review_session_id IS NULL AND command_id IS NULL AND reviewed_at IS NULL
          AND review_authorization_version IS NULL)
       OR (state <> 'pending' AND review_session_id IS NOT NULL AND command_id IS NOT NULL AND reviewed_at IS NOT NULL
          AND review_authorization_version IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_document_instruction_pending
    ON studio_document_instruction (task_id, seq) WHERE state = 'pending';
`

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function isSource(source: Record<keyof StudioInstructionInput, unknown>): source is StudioInstructionInput {
  const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text } = source
  return (channel === 'gui' || channel === 'feishu') && isId(sourceScope) && isId(requestId) && isId(messageId)
    && (eventSeq === null || isCoordinate(eventSeq)) && isCoordinate(sourceTimeMs)
    && (text === null || (typeof text === 'string' && text.isWellFormed()))
}

function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio instruction write did not affect exactly one row')
}

/** Mutations must run inside the caller's managed write transaction alongside the authorization version update. */
export class InstructionStore {
  constructor(private readonly database: () => DatabaseSync) {}

  /** Keep the first delivery of each source request, including across reviews and restarts. */
  record(taskId: string, epoch: number, source: StudioInstructionInput): boolean {
    const db = this.database()
    const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text } = source
    if (!isId(requestId)) throw new Error('Invalid Studio instruction request ID')
    if (db.prepare(`SELECT 1 FROM studio_document_instruction WHERE channel = ? AND source_scope = ? AND request_id = ?`)
      .get(channel, sourceScope, requestId)) return false
    if (!isSource(source)) throw new Error('Invalid Studio instruction source')
    // An explicit lookup distinguishes a known duplicate from an insert suppressed by a trigger.
    requireWrite(db.prepare(`INSERT INTO studio_document_instruction (instruction_id, task_id, observed_execution_epoch,
      channel, source_scope, request_id, message_id, event_seq, source_time_ms, text, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), taskId, epoch, channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text,
        new Date().toISOString()).changes)
    return true
  }

  /** Pending work is task-wide; neither runtime config nor historic source scope controls the gate. */
  hasPending(taskId: string): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_document_instruction WHERE task_id = ? AND state = 'pending' LIMIT 1`)
      .get(taskId)
  }

  /** Return the oldest pending instruction and the count from the same SQLite snapshot. */
  inbox(taskId: string): { pending?: StudioDocumentInstruction; remaining: number } {
    const row = this.database().prepare(`SELECT instruction_id, channel, source_scope, request_id, message_id, event_seq,
      source_time_ms, text, (SELECT COUNT(*) FROM studio_document_instruction WHERE task_id = ? AND state = 'pending') AS remaining
      FROM studio_document_instruction WHERE task_id = ? AND state = 'pending' ORDER BY seq LIMIT 1`).get(taskId, taskId)
    if (!row) return { remaining: 0 }
    const { instruction_id: instructionId, channel, source_scope: sourceScope, request_id: requestId, message_id: messageId,
      event_seq: eventSeq, source_time_ms: sourceTimeMs, text, remaining } = row
    const source = { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text }
    if (!isId(instructionId) || !isSource(source) || !isCoordinate(remaining) || remaining < 1) {
      throw new Error('Invalid pending Studio instruction')
    }
    return { pending: { instructionId, source }, remaining }
  }

  /** Persist the explicit disposition and its resulting authorization version without replacing the source record. */
  review(taskId: string, epoch: number, instructionId: string, sessionId: string,
    revision: number, decision: InstructionDecision, commandId: string): void {
    requireWrite(this.database().prepare(`UPDATE studio_document_instruction
      SET state = ?, review_session_id = ?, command_id = ?, reviewed_at = ?, review_authorization_version = ?
      WHERE task_id = ? AND observed_execution_epoch = ? AND instruction_id = ? AND state = 'pending'`)
      .run(decision, sessionId, commandId, new Date().toISOString(), revision, taskId, epoch, instructionId).changes)
  }

  commandUsed(commandId: string): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_document_instruction WHERE command_id = ?').get(commandId)
  }
}
