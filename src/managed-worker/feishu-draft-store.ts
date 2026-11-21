/** The Feishu draft ledger shares the managed Store's database, transactions, and run fence. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { StudioFeishuInstruction } from './instruction-store.js'
import type { StudioDraftExecution, StudioDraftResult, StudioDraftTask } from './store.js'

/** A Feishu draft keeps its original delivery separate from the text sent to its Worker. */
export interface StudioFeishuDraftTask extends StudioDraftExecution {
  workerBotId: string
  state: StudioDraftTask['state']
  source: StudioFeishuInstruction
  result?: StudioDraftResult
  failure?: string
}

/** Locate a saved task without reading the original request or its result. */
export interface StudioFeishuDraftHeader {
  taskId: string
  messageId: string
  sentAt: string
  state: StudioFeishuDraftTask['state']
}

export const FEISHU_DRAFT_LIST_LIMIT = 8
export const FEISHU_DRAFT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_feishu_draft (
    task_id TEXT PRIMARY KEY NOT NULL,
    worker_bot_id TEXT NOT NULL UNIQUE,
    worker_session_id TEXT NOT NULL UNIQUE,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch = 1),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
    channel TEXT NOT NULL CHECK (channel = 'feishu'),
    source_scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    message_id TEXT NOT NULL CHECK (message_id = request_id),
    event_seq INTEGER CHECK (event_seq IS NULL),
    source_time_ms INTEGER NOT NULL CHECK (source_time_ms BETWEEN 0 AND 9007199254740991),
    sender_id TEXT NOT NULL,
    parent_id TEXT,
    root_id TEXT,
    thread_id TEXT,
    text TEXT NOT NULL,
    request_text TEXT NOT NULL,
    result_text TEXT,
    result_message_id TEXT,
    result_event_seq INTEGER CHECK (result_event_seq BETWEEN 0 AND 9007199254740991),
    result_turn INTEGER CHECK (result_turn BETWEEN 1 AND 9007199254740991),
    failure TEXT,
    UNIQUE (source_scope, request_id),
    CHECK ((state = 'completed' AND result_text IS NOT NULL AND result_message_id IS NOT NULL
      AND result_event_seq IS NOT NULL AND result_turn IS NOT NULL AND failure IS NULL)
      OR (state <> 'completed' AND result_text IS NULL AND result_message_id IS NULL
        AND result_event_seq IS NULL AND result_turn IS NULL AND (failure IS NULL) = (state = 'running')))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS studio_feishu_draft_running_scope ON studio_feishu_draft (source_scope) WHERE state = 'running';
  CREATE INDEX IF NOT EXISTS studio_feishu_draft_scope_time ON studio_feishu_draft (source_scope, source_time_ms);
`

type Row = Record<string, SQLOutputValue>
export type FeishuDraftSource = StudioFeishuInstruction & { text: string; eventSeq: null }
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isDraftState = (value: unknown): value is StudioFeishuDraftTask['state'] =>
  value === 'running' || value === 'completed' || value === 'failed' || value === 'interrupted'
const optionalId = (value: string | undefined): boolean => value === undefined || isId(value)

/** Validate and copy a delivery without trimming or substituting the retained source text. */
export function feishuDraftSource(input: StudioFeishuInstruction,
  isDraftText: (value: unknown) => value is string): FeishuDraftSource | undefined {
  if (!input) return
  const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, senderId, text, parentId, rootId, threadId } = input
  if (channel !== 'feishu' || !isId(sourceScope) || !isId(requestId) || messageId !== requestId || eventSeq !== null
    || !isCoordinate(sourceTimeMs) || !isId(senderId) || !isDraftText(text) || text.includes('\0')
    || !optionalId(parentId) || !optionalId(rootId) || !optionalId(threadId)) return
  return { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, senderId, text,
    ...(parentId === undefined ? {} : { parentId }), ...(rootId === undefined ? {} : { rootId }),
    ...(threadId === undefined ? {} : { threadId }) }
}

function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio Feishu draft write did not affect exactly one row')
}

/** Mutations run only inside the caller's managed transaction, including the routing and role checks. */
export class FeishuDraftStore {
  constructor(private readonly database: () => DatabaseSync, private readonly runId: string,
    private readonly isDraftText: (value: unknown) => value is string) {}

  /** Recover every prior running reservation as terminal without starting another Worker. */
  interruptRunning(): void {
    const db = this.database()
    db.exec("UPDATE studio_feishu_draft SET state = 'interrupted', failure = 'HOST_RESTARTED' WHERE state = 'running'")
    if (db.prepare("SELECT 1 FROM studio_feishu_draft WHERE state = 'running' LIMIT 1").get()) {
      throw new Error('Cannot interrupt previous Studio Feishu drafts')
    }
  }

  /** Look up the first registered delivery; no redelivery can replace its evidence. */
  duplicate(scope: string, requestId: string): StudioFeishuDraftTask | undefined {
    const row = this.database().prepare('SELECT * FROM studio_feishu_draft WHERE source_scope = ? AND request_id = ?').get(scope, requestId)
    return row && this.readRow(row)
  }

  /** Completed, failed and interrupted tasks still claim the scope for the text route. */
  scopeBound(scope: string): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_feishu_draft WHERE source_scope = ? LIMIT 1').get(scope)
  }

  /** A strictly newer accepted delivery makes this one late, regardless of the newer task's state. */
  late(scope: string, sourceTimeMs: number): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_feishu_draft WHERE source_scope = ? AND source_time_ms > ? LIMIT 1')
      .get(scope, sourceTimeMs)
  }

  busy(scope: string): boolean {
    return !!this.database().prepare("SELECT 1 FROM studio_feishu_draft WHERE source_scope = ? AND state = 'running'").get(scope)
  }

  insert(taskId: string, workerBotId: string, workerSessionId: string, source: FeishuDraftSource,
    requestText: string): StudioFeishuDraftTask {
    const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text, senderId, parentId, rootId, threadId } = source
    requireWrite(this.database().prepare(`INSERT INTO studio_feishu_draft (task_id, worker_bot_id, worker_session_id,
      execution_epoch, run_id, state, channel, source_scope, request_id, message_id, event_seq, source_time_ms, text,
      sender_id, parent_id, root_id, thread_id, request_text)
      VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, workerBotId, workerSessionId, this.runId, channel, sourceScope, requestId, messageId, eventSeq,
        sourceTimeMs, text, senderId, parentId ?? null, rootId ?? null, threadId ?? null, requestText).changes)
    return { taskId, workerBotId, workerSessionId, executionEpoch: 1, state: 'running', source }
  }

  /** Never infer the requested task from recent activity. */
  read(taskId: string, scope?: string): StudioFeishuDraftTask | undefined {
    const db = this.database()
    const row = scope === undefined
      ? db.prepare('SELECT * FROM studio_feishu_draft WHERE task_id = ?').get(taskId)
      : db.prepare('SELECT * FROM studio_feishu_draft WHERE task_id = ? AND source_scope = ?').get(taskId, scope)
    return row && this.readRow(row)
  }

  /** Page one private chat by original send time, using the scope/time index without opening any bodies. */
  recent(scope: string): StudioFeishuDraftHeader[] {
    return this.database().prepare(`SELECT task_id, message_id, source_time_ms, state FROM studio_feishu_draft
      WHERE source_scope = ? ORDER BY source_time_ms DESC, rowid DESC LIMIT ?`).all(scope, FEISHU_DRAFT_LIST_LIMIT).map(row => {
      const { task_id: taskId, message_id: messageId, source_time_ms: sourceTimeMs, state } = row
      const sentAt = isCoordinate(sourceTimeMs) ? new Date(sourceTimeMs).toJSON() : null
      if (!isId(taskId) || !isId(messageId) || typeof sentAt !== 'string' || !isDraftState(state)) {
        throw new Error('Invalid Studio Feishu draft header')
      }
      return { taskId, messageId, sentAt, state }
    })
  }

  /** Keep the role even after the execution is no longer eligible to run. */
  binding(workerSessionId: string): StudioDraftExecution | undefined {
    const row = this.database().prepare('SELECT task_id, execution_epoch FROM studio_feishu_draft WHERE worker_session_id = ?')
      .get(workerSessionId)
    if (!row) return
    const { task_id: taskId, execution_epoch: executionEpoch } = row
    if (!isId(taskId) || executionEpoch !== 1) throw new Error('Invalid Studio Feishu draft binding')
    return { taskId, workerSessionId, executionEpoch }
  }

  current({ taskId, workerSessionId, executionEpoch }: StudioDraftExecution): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_feishu_draft WHERE task_id = ? AND worker_session_id = ?
      AND execution_epoch = ? AND run_id = ? AND state = 'running'`).get(taskId, workerSessionId, executionEpoch, this.runId)
  }

  /** Resolve the durable execution origin; a task ID alone is insufficient to publish a result. */
  execution({ taskId, workerSessionId, executionEpoch }: StudioDraftExecution): StudioFeishuDraftTask | undefined {
    const row = this.database().prepare(`SELECT * FROM studio_feishu_draft WHERE task_id = ? AND worker_session_id = ?
      AND execution_epoch = ? AND run_id = ?`).get(taskId, workerSessionId, executionEpoch, this.runId)
    return row && this.readRow(row)
  }

  settle(task: StudioFeishuDraftTask, result: StudioDraftResult | undefined, failure: string): StudioFeishuDraftTask {
    const state = result === undefined ? 'failed' : 'completed'
    requireWrite(this.database().prepare(`UPDATE studio_feishu_draft SET state = ?, result_text = ?, result_message_id = ?,
      result_event_seq = ?, result_turn = ?, failure = ?
      WHERE task_id = ? AND worker_session_id = ? AND execution_epoch = ? AND run_id = ? AND state = 'running'`)
      .run(state, result?.text ?? null, result?.messageId ?? null, result?.eventSeq ?? null, result?.turn ?? null,
        result === undefined ? failure : null, task.taskId, task.workerSessionId, task.executionEpoch, this.runId).changes)
    return result === undefined ? { ...task, state, failure } : { ...task, state, result }
  }

  /** Decode the original delivery and outcome rather than casting unchecked SQLite values. */
  private readRow(row: Row): StudioFeishuDraftTask {
    const { task_id: taskId, worker_bot_id: workerBotId, worker_session_id: workerSessionId, execution_epoch: executionEpoch,
      state, channel, source_scope: sourceScope, request_id: requestId, message_id: messageId, event_seq: eventSeq,
      source_time_ms: sourceTimeMs, sender_id: senderId, text, parent_id: parentId, root_id: rootId, thread_id: threadId,
      result_text: resultText, result_message_id: resultMessageId, result_event_seq: resultEventSeq, result_turn: resultTurn, failure } = row
    if (!isId(taskId) || !isId(workerBotId) || !isId(workerSessionId) || executionEpoch !== 1
      || !isDraftState(state)
      || channel !== 'feishu' || !isId(sourceScope) || !isId(requestId) || messageId !== requestId || eventSeq !== null
      || !isCoordinate(sourceTimeMs) || !isId(senderId) || !this.isDraftText(text) || text.includes('\0')
      || (parentId !== null && !isId(parentId)) || (rootId !== null && !isId(rootId)) || (threadId !== null && !isId(threadId))) {
      throw new Error('Invalid Studio Feishu draft')
    }
    const task: StudioFeishuDraftTask = { taskId, workerBotId, workerSessionId, executionEpoch, state,
      source: { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, senderId, text,
        ...(parentId === null ? {} : { parentId }), ...(rootId === null ? {} : { rootId }),
        ...(threadId === null ? {} : { threadId }) } }
    if (state === 'completed') {
      if (!this.isDraftText(resultText) || !isId(resultMessageId) || !isCoordinate(resultEventSeq)
        || !isCoordinate(resultTurn) || resultTurn === 0) throw new Error('Invalid Studio Feishu draft result')
      task.result = { text: resultText, messageId: resultMessageId, eventSeq: resultEventSeq, turn: resultTurn }
    } else if (state !== 'running') {
      if (!this.isDraftText(failure)) throw new Error('Invalid Studio Feishu draft failure')
      task.failure = failure
    }
    return task
  }
}
