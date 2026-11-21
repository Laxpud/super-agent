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

/** Feishu coordinates from a delivery already authenticated by the host. */
export interface StudioFeishuInstruction extends StudioInstructionInput {
  channel: 'feishu'
  senderId: string
  parentId?: string
  rootId?: string
  threadId?: string
}

export interface StudioDocumentInstruction {
  instructionId: string
  source: StudioInstructionInput
  feishu?: Pick<StudioFeishuInstruction, 'senderId' | 'parentId' | 'rootId' | 'threadId'> & { late: boolean }
}

export type InstructionDecision = 'unchanged' | 'pause'

/** A narrowing receipt is the authoritative outcome, separate from the original input row. */
interface NarrowingReceipt {
  instructionId: string
  taskId: string
  executionEpoch: number
  previousAuthorizationVersion: number
  nextAuthorizationVersion: number
  keptLines: readonly number[]
  reviewSessionId: string
  commandId: string
  previousText: string
  nextText: string
}

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
  CREATE TABLE IF NOT EXISTS studio_document_feishu_binding (
    source_scope TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES managed_task (task_id),
    session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    command_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_document_feishu_instruction (
    instruction_id TEXT PRIMARY KEY REFERENCES studio_document_instruction (instruction_id),
    sender_id TEXT NOT NULL,
    parent_id TEXT,
    root_id TEXT,
    thread_id TEXT,
    late INTEGER NOT NULL CHECK (late IN (0, 1))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_document_instruction_feishu_time
    ON studio_document_instruction (source_scope, source_time_ms) WHERE channel = 'feishu';
  CREATE TABLE IF NOT EXISTS studio_document_narrowing (
    instruction_id TEXT PRIMARY KEY REFERENCES studio_document_instruction (instruction_id),
    task_id TEXT NOT NULL REFERENCES managed_task (task_id),
    execution_epoch INTEGER NOT NULL,
    document_version INTEGER NOT NULL CHECK (document_version = 1),
    pre_authorization_version INTEGER NOT NULL CHECK (pre_authorization_version BETWEEN 1 AND 9007199254740991),
    post_authorization_version INTEGER NOT NULL CHECK (post_authorization_version BETWEEN 1 AND 9007199254740991
      AND post_authorization_version = pre_authorization_version + 1),
    kept_lines TEXT NOT NULL,
    review_session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    command_id TEXT NOT NULL UNIQUE,
    reviewed_at TEXT NOT NULL,
    pre_approved_text TEXT NOT NULL,
    post_approved_text TEXT NOT NULL,
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch)
  ) STRICT;
  -- Project detail looks back through the existing receipts in descending authorization order.
  CREATE INDEX IF NOT EXISTS studio_document_narrowing_task_post
    ON studio_document_narrowing (task_id, post_authorization_version DESC);
  CREATE VIEW IF NOT EXISTS studio_document_effective_pending AS
    SELECT i.* FROM studio_document_instruction i WHERE i.state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM studio_document_narrowing n WHERE n.instruction_id = i.instruction_id);
  -- Legacy readers still see a pending row. Also block legacy review from clearing that fence.
  CREATE TRIGGER IF NOT EXISTS studio_document_narrowing_preserve_source
    BEFORE UPDATE ON studio_document_instruction
    WHEN EXISTS (SELECT 1 FROM studio_document_narrowing WHERE instruction_id = OLD.instruction_id)
    BEGIN
      SELECT RAISE(ABORT, 'Studio instruction already has a narrowing receipt');
    END;
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

  /** Read the fixed target, not a candidate inferred from recent activity or a session name. */
  feishuTask(sourceScope: string): string | undefined {
    const row = this.database().prepare('SELECT task_id FROM studio_document_feishu_binding WHERE source_scope = ?').get(sourceScope)
    if (!row) return
    if (!isId(row.task_id)) throw new Error('Invalid Studio Feishu binding')
    return row.task_id
  }

  hasFeishuScope(taskId: string): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_document_feishu_binding WHERE task_id = ?').get(taskId)
  }

  /** Retain deduplication for every recorded instruction, including reviewed rows from before route claims. */
  feishuDuplicate(scope: string, requestId: string): boolean {
    return this.sourceRecorded('feishu', scope, requestId)
  }

  /** Compare document deliveries only; a new text task must not alter the document review ordering. */
  feishuLate(scope: string, sourceTimeMs: number): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_document_instruction
      WHERE channel = 'feishu' AND source_scope = ? AND source_time_ms > ? LIMIT 1`).get(scope, sourceTimeMs)
  }

  /** Record the original binding command without changing any authorization or pending instruction. */
  linkFeishu(taskId: string, sessionId: string, sourceScope: string, commandId: string): void {
    requireWrite(this.database().prepare(`INSERT INTO studio_document_feishu_binding
      (source_scope, task_id, session_id, command_id, at) VALUES (?, ?, ?, ?, ?)`)
      .run(sourceScope, taskId, sessionId, commandId, new Date().toISOString()).changes)
  }

  record(taskId: string, epoch: number, source: StudioInstructionInput): boolean {
    return this.recordSource(taskId, epoch, source) !== undefined
  }

  /** Keep causal evidence on the same pending row; a strictly older source time is a review hint only. */
  recordFeishu(taskId: string, epoch: number, source: StudioFeishuInstruction): { late: boolean } | undefined {
    if (source.channel !== 'feishu' || source.requestId !== source.messageId || source.eventSeq !== null) {
      throw new Error('Invalid Studio Feishu source coordinates')
    }
    const instructionId = this.recordSource(taskId, epoch, source)
    if (instructionId === undefined) return
    const { senderId, parentId, rootId, threadId } = source
    if (!isId(senderId) || [parentId, rootId, threadId].some(id => id !== undefined && !isId(id))) {
      throw new Error('Invalid Studio Feishu causal evidence')
    }
    const db = this.database()
    // Include already reviewed deliveries; the newly inserted row cannot satisfy the strict comparison against its own time.
    const late = this.feishuLate(source.sourceScope, source.sourceTimeMs)
    requireWrite(db.prepare(`INSERT INTO studio_document_feishu_instruction
      (instruction_id, sender_id, parent_id, root_id, thread_id, late) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(instructionId, senderId, parentId ?? null, rootId ?? null, threadId ?? null, late ? 1 : 0).changes)
    return { late }
  }

  /** Keep the first delivery of each source request, including across reviews and restarts. */
  private recordSource(taskId: string, epoch: number, source: StudioInstructionInput): string | undefined {
    const db = this.database()
    const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text } = source
    if (!isId(requestId)) throw new Error('Invalid Studio instruction request ID')
    if (this.sourceRecorded(channel, sourceScope, requestId)) return
    if (!isSource(source)) throw new Error('Invalid Studio instruction source')
    // An explicit lookup distinguishes a known duplicate from an insert suppressed by a trigger.
    const instructionId = randomUUID()
    requireWrite(db.prepare(`INSERT INTO studio_document_instruction (instruction_id, task_id, observed_execution_epoch,
      channel, source_scope, request_id, message_id, event_seq, source_time_ms, text, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(instructionId, taskId, epoch, channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text,
        new Date().toISOString()).changes)
    return instructionId
  }

  private sourceRecorded(channel: StudioInstructionInput['channel'], scope: string, requestId: string): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_document_instruction WHERE channel = ? AND source_scope = ? AND request_id = ?`)
      .get(channel, scope, requestId)
  }

  /** Pending work is task-wide; neither runtime config nor historic source scope controls the gate. */
  hasPending(taskId: string): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_document_effective_pending WHERE task_id = ? LIMIT 1').get(taskId)
  }

  /** Return the oldest pending instruction and the count from the same SQLite snapshot. */
  inbox(taskId: string): { pending: StudioDocumentInstruction; observedEpoch: number; remaining: number }
    | { pending?: undefined; observedEpoch?: undefined; remaining: 0 } {
    const row = this.database().prepare(`SELECT i.instruction_id, i.observed_execution_epoch, i.channel, i.source_scope,
      i.request_id, i.message_id, i.event_seq, i.source_time_ms, i.text, f.sender_id, f.parent_id, f.root_id, f.thread_id, f.late,
      (SELECT COUNT(*) FROM studio_document_effective_pending WHERE task_id = ?) AS remaining
      FROM studio_document_effective_pending i LEFT JOIN studio_document_feishu_instruction f USING (instruction_id)
      WHERE i.task_id = ? ORDER BY i.seq LIMIT 1`).get(taskId, taskId)
    if (!row) return { remaining: 0 }
    const { instruction_id: instructionId, channel, source_scope: sourceScope, request_id: requestId, message_id: messageId,
      event_seq: eventSeq, source_time_ms: sourceTimeMs, text, remaining, observed_execution_epoch: observedEpoch,
      sender_id: senderId, parent_id: parentId, root_id: rootId, thread_id: threadId, late } = row
    const source = { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text }
    if (!isId(instructionId) || !isSource(source) || !isCoordinate(remaining) || remaining < 1
      || !isCoordinate(observedEpoch) || observedEpoch < 1) {
      throw new Error('Invalid pending Studio instruction')
    }
    const pending: StudioDocumentInstruction = { instructionId, source }
    if (senderId !== null) {
      if (channel !== 'feishu' || !isId(senderId) || (parentId !== null && !isId(parentId))
        || (rootId !== null && !isId(rootId)) || (threadId !== null && !isId(threadId)) || (late !== 0 && late !== 1)) {
        throw new Error('Invalid pending Studio Feishu evidence')
      }
      pending.feishu = { senderId, late: late === 1, ...(parentId === null ? {} : { parentId }),
        ...(rootId === null ? {} : { rootId }), ...(threadId === null ? {} : { threadId }) }
    }
    return { pending, observedEpoch, remaining }
  }

  /** Bind the exact authorization change to the pending source without rewriting the legacy row. */
  recordNarrowing(receipt: NarrowingReceipt): void {
    const { instructionId, taskId, executionEpoch, previousAuthorizationVersion, nextAuthorizationVersion,
      keptLines, reviewSessionId, commandId, previousText, nextText } = receipt
    requireWrite(this.database().prepare(`INSERT INTO studio_document_narrowing (instruction_id, task_id, execution_epoch,
      document_version, pre_authorization_version, post_authorization_version, kept_lines, review_session_id, command_id,
      reviewed_at, pre_approved_text, post_approved_text)
      SELECT instruction_id, task_id, observed_execution_epoch, 1, ?, ?, ?, ?, ?, ?, ?, ?
      FROM studio_document_effective_pending WHERE instruction_id = ? AND task_id = ? AND observed_execution_epoch = ?`)
      .run(previousAuthorizationVersion, nextAuthorizationVersion, JSON.stringify(keptLines), reviewSessionId, commandId,
        new Date().toISOString(), previousText, nextText, instructionId, taskId, executionEpoch).changes)
  }

  /** Persist the explicit disposition and its resulting authorization version without replacing the source record. */
  review(taskId: string, epoch: number, instructionId: string, sessionId: string,
    revision: number, decision: InstructionDecision, commandId: string): void {
    requireWrite(this.database().prepare(`UPDATE studio_document_instruction
      SET state = ?, review_session_id = ?, command_id = ?, reviewed_at = ?, review_authorization_version = ?
      WHERE task_id = ? AND observed_execution_epoch = ?
        AND instruction_id IN (SELECT instruction_id FROM studio_document_effective_pending WHERE instruction_id = ?)`)
      .run(decision, sessionId, commandId, new Date().toISOString(), revision, taskId, epoch, instructionId).changes)
  }

  commandUsed(commandId: string): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_document_instruction WHERE command_id = ?
      UNION ALL SELECT 1 FROM studio_document_feishu_binding WHERE command_id = ?
      UNION ALL SELECT 1 FROM studio_document_narrowing WHERE command_id = ? LIMIT 1`).get(commandId, commandId, commandId)
  }
}
