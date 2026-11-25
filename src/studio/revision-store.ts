import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { ASSISTANT_CONVERSATION, STUDIO_TEXT_LIMIT } from './protocol.ts'
import { studioOwnerMessageId } from './source.ts'

export type StudioRevisionWork = { id: string; type: 'draft' | 'study' | 'work' }
export interface StudioRevisionInput {
  conversationId: string
  ownerSessionId: string
  requestId: string
  messageId: string
  workerSessionId: string
  work: StudioRevisionWork
}

export interface StudioRevisionResult { text: string; eventSeq: number }
export interface StudioRevisionRecord extends StudioRevisionInput {
  id: string
  state: 'running' | 'completed' | 'failed' | 'interrupted'
  createdAt: number
  basedOnRevisionId?: string
  result?: StudioRevisionResult
}

export interface StudioRevisionReservation extends StudioRevisionRecord {
  state: 'running'
  instruction: string
  previousText: string
}

export interface StudioRevisionArtifact extends StudioRevisionResult { id: string; workerSessionId: string }

type RevisionErrorCode = 'REVISION_INVALID_INPUT' | 'REVISION_STALE_OWNER' | 'REVISION_SOURCE_NOT_CURRENT' | 'REVISION_ALREADY_RESERVED'
  | 'REVISION_WORK_NOT_ELIGIBLE' | 'REVISION_WRONG_TOPIC' | 'REVISION_WORKER_BOUND' | 'REVISION_IN_PROGRESS' | 'REVISION_INVALID_RESULT'

/** An exact rejection reason for a topical revision, without including source or result text. */
export class StudioRevisionError extends Error {
  constructor(readonly code: RevisionErrorCode, message: string) { super(message); this.name = 'StudioRevisionError' }
}

// Each user turn and Worker Session is spent once, even if execution fails. The original task and result are never mutated.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_studio_revision (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    owner_session_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE REFERENCES agent_studio_message(id),
    message_id TEXT NOT NULL UNIQUE,
    worker_session_id TEXT NOT NULL UNIQUE,
    work_type TEXT NOT NULL CHECK (work_type IN ('draft', 'study', 'work')),
    work_id TEXT NOT NULL,
    origin_request_id TEXT NOT NULL REFERENCES agent_studio_message(id),
    origin_message_id TEXT NOT NULL,
    based_on_revision_id TEXT REFERENCES agent_studio_revision(id),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
    created_at INTEGER NOT NULL,
    result_text TEXT,
    result_event_seq INTEGER CHECK (result_event_seq BETWEEN 0 AND 9007199254740991),
    CHECK (owner_session_id <> worker_session_id AND origin_request_id <> request_id),
    CHECK ((state = 'completed') = (result_text IS NOT NULL) AND (state = 'completed') = (result_event_seq IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_studio_revision_one_live_work ON agent_studio_revision(conversation_id, work_type, work_id) WHERE state = 'running';
  CREATE INDEX IF NOT EXISTS agent_studio_revision_latest_result ON agent_studio_revision(conversation_id, work_type, work_id, sequence DESC)
    WHERE state = 'completed';
`

const BINDING_COLUMNS = `id, conversation_id, owner_session_id, request_id, message_id, worker_session_id,
  work_type, work_id, origin_request_id, origin_message_id, based_on_revision_id, state, created_at`

interface RevisionRow {
  id: string
  conversation_id: string
  owner_session_id: string
  request_id: string
  message_id: string
  worker_session_id: string
  work_type: StudioRevisionWork['type']
  work_id: string
  origin_request_id: string
  origin_message_id: string
  based_on_revision_id: string | null
  state: StudioRevisionRecord['state']
  created_at: number
  result_text?: string | null
  result_event_seq?: number | null
}

interface Origin { requestId: string; messageId: string; text: string }

type Row = Record<string, SQLOutputValue>
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const text = (value: unknown): value is string => id(value) && value.length <= STUDIO_TEXT_LIMIT && value.trim().length > 0
const eventSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function record(row: RevisionRow): StudioRevisionRecord {
  return { id: row.id, conversationId: row.conversation_id, ownerSessionId: row.owner_session_id, requestId: row.request_id,
    messageId: row.message_id, workerSessionId: row.worker_session_id, work: { id: row.work_id, type: row.work_type },
    state: row.state, createdAt: row.created_at, ...(row.based_on_revision_id && { basedOnRevisionId: row.based_on_revision_id }),
    ...(typeof row.result_text === 'string' && typeof row.result_event_seq === 'number' && {
      result: { text: row.result_text, eventSeq: row.result_event_seq },
    }) }
}

/** Use the managed Host's connection and run fence. Only this ledger changes; native task ledgers are read-only inputs. */
export class StudioRevisionStore {
  constructor(private readonly db: DatabaseSync, private readonly assertActive: () => void) {
    this.transaction('write', () => db.exec(SCHEMA))
  }

  /** Reserve once for the exact live owner message, using the latest completed output on the same original task. */
  reserve(input: StudioRevisionInput): StudioRevisionReservation {
    return this.transaction('write', () => {
      const { conversationId, ownerSessionId, requestId, messageId, workerSessionId, work } = input
      if (!id(conversationId) || !id(ownerSessionId) || !id(requestId) || messageId !== studioOwnerMessageId(requestId)
        || !id(workerSessionId) || !id(work?.id) || (work.type !== 'draft' && work.type !== 'study' && work.type !== 'work')) {
        throw new StudioRevisionError('REVISION_INVALID_INPUT', 'Invalid Studio revision coordinates')
      }
      if (!this.ownerCurrent(conversationId, ownerSessionId)) {
        throw new StudioRevisionError('REVISION_STALE_OWNER', 'This Session no longer owns the Studio conversation')
      }
      if (this.db.prepare('SELECT 1 FROM agent_studio_revision WHERE conversation_id = ? AND request_id = ?').get(conversationId, requestId)) {
        throw new StudioRevisionError('REVISION_ALREADY_RESERVED', 'This owner message already reserved a revision')
      }
      const source = this.liveSource(conversationId, ownerSessionId, requestId)
      if (!source) throw new StudioRevisionError('REVISION_SOURCE_NOT_CURRENT', 'This is not a live Studio topic reply from this Session')
      const origin = this.eligibleOrigin(conversationId, work)
      if (!origin) throw new StudioRevisionError('REVISION_WORK_NOT_ELIGIBLE', 'The original task is not eligible for a text revision in this conversation')
      if (!this.isAncestor(conversationId, requestId, origin.requestId)) {
        throw new StudioRevisionError('REVISION_WRONG_TOPIC', 'This topic does not reply to the original owner request')
      }
      if (this.workerBound(workerSessionId)) throw new StudioRevisionError('REVISION_WORKER_BOUND', 'This Worker Session is already bound')

      const target = [conversationId, work.type, work.id] as const
      const running = this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM agent_studio_revision WHERE
        conversation_id = ? AND work_type = ? AND work_id = ? AND state = 'running'`).get(...target) as unknown as RevisionRow | undefined
      if (running) {
        // Do not leave a previous owner or abandoned turn blocking a valid new correction after management changes.
        if (this.reservationCurrent(running)) throw new StudioRevisionError('REVISION_IN_PROGRESS', 'This work already has a live revision')
        this.db.prepare("UPDATE agent_studio_revision SET state = 'interrupted' WHERE id = ? AND state = 'running'").run(running.id)
      }
      const base = this.db.prepare(`SELECT id, result_text FROM agent_studio_revision WHERE conversation_id = ? AND work_type = ?
        AND work_id = ? AND origin_request_id = ? AND origin_message_id = ? AND state = 'completed' ORDER BY sequence DESC LIMIT 1`)
        .get(...target, origin.requestId, origin.messageId)
      const previousText = base ? base.result_text : origin.text
      if (!text(previousText)) throw new StudioRevisionError('REVISION_WORK_NOT_ELIGIBLE', 'The previous Studio result is not valid revision text')

      const row = this.db.prepare(`INSERT INTO agent_studio_revision (id, conversation_id, owner_session_id, request_id, message_id,
        worker_session_id, work_type, work_id, origin_request_id, origin_message_id, based_on_revision_id, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?) RETURNING ${BINDING_COLUMNS}`)
        .get(randomUUID(), conversationId, ownerSessionId, requestId, messageId, workerSessionId, work.type, work.id,
          origin.requestId, origin.messageId, base?.id ?? null, Date.now()) as unknown as RevisionRow | undefined
      if (!row) throw new Error('Studio revision reservation did not write a row')
      return { ...record(row), state: 'running', instruction: source, previousText }
    })
  }

  /** Historical Worker roles stay assigned after recovery and completion. This read is safe within a caller's existing transaction. */
  sourceBinding(workerSessionId: string): StudioRevisionRecord | undefined {
    this.assertActive()
    const row = this.byWorker(workerSessionId)
    return row && record(row)
  }

  /** Recheck the exact reservation and current owner in a snapshot before using its text or entering the model. */
  current(reservation: string | StudioRevisionRecord): boolean {
    return this.transaction('read', () => {
      const row = this.byWorker(typeof reservation === 'string' ? reservation : reservation.workerSessionId)
      return !!row && (typeof reservation === 'string' || reservation.id === row.id) && this.reservationCurrent(row)
    })
  }

  /** Compare-and-set a running revision. A result arriving after its owner/turn loses authority is not retained. */
  finish(workerSessionId: string, result?: StudioRevisionResult): StudioRevisionRecord | undefined {
    return this.transaction('write', () => {
      const row = this.byWorker(workerSessionId)
      if (row?.state !== 'running') return
      const current = this.reservationCurrent(row)
      if (current && result !== undefined && (!text(result?.text) || !eventSeq(result?.eventSeq))) {
        throw new StudioRevisionError('REVISION_INVALID_RESULT', 'Invalid Studio revision output or event sequence')
      }
      const state = !current ? 'interrupted' : result === undefined ? 'failed' : 'completed'
      const changed = this.db.prepare(`UPDATE agent_studio_revision SET state = ?, result_text = ?, result_event_seq = ?
        WHERE id = ? AND state = 'running' RETURNING *`).get(state, state === 'completed' ? result!.text : null,
        state === 'completed' ? result!.eventSeq : null, row.id) as unknown as RevisionRow | undefined
      if (!changed) throw new Error('Studio revision settlement did not write a row')
      return record(changed)
    })
  }

  /** Resolve revision inputs from any state to the immutable origin. This retains the topic link after a failed or interrupted correction. */
  link(conversationId: string, requestId: string, messageId: string): StudioRevisionWork | undefined {
    this.assertActive()
    const row = this.db.prepare(`SELECT work_id, work_type FROM agent_studio_revision WHERE conversation_id = ? AND request_id = ? AND message_id = ?`)
      .get(conversationId, requestId, messageId)
    return row && { id: row.work_id as string, type: row.work_type as StudioRevisionWork['type'] }
  }

  /** Produce only the completed owner-visible artifact for this exact turn, with its dedicated native source. */
  artifact(conversationId: string, requestId: string): StudioRevisionArtifact | undefined {
    return this.transaction('read', () => {
      const row = this.db.prepare(`SELECT * FROM agent_studio_revision WHERE conversation_id = ? AND request_id = ? AND state = 'completed'`)
        .get(conversationId, requestId) as unknown as RevisionRow | undefined
      if (!row || !this.originCurrent(row) || !text(row.result_text) || !eventSeq(row.result_event_seq)) return
      return { id: row.id, workerSessionId: row.worker_session_id, text: row.result_text, eventSeq: row.result_event_seq }
    })
  }

  /** Retain spent input and Session IDs, but never re-enqueue an uncertain revision after restart. */
  recover(): void {
    this.transaction('write', () => this.db.exec("UPDATE agent_studio_revision SET state = 'interrupted' WHERE state = 'running'"))
  }

  private transaction<T>(mode: 'read' | 'write', operation: () => T): T {
    this.assertActive()
    if (this.db.isTransaction) {
      if (mode === 'read') return operation()
      throw new Error('Studio revision mutations require a new transaction')
    }
    this.db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      this.assertActive()
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private byWorker(workerSessionId: string): RevisionRow | undefined {
    return this.db.prepare(`SELECT ${BINDING_COLUMNS} FROM agent_studio_revision WHERE worker_session_id = ?`)
      .get(workerSessionId) as unknown as RevisionRow | undefined
  }

  private ownerCurrent(conversationId: string, ownerSessionId: string): boolean {
    // Assistant replacement changes only the logical pointer. Project authority follows the current epoch, not the origin Leader.
    return conversationId === ASSISTANT_CONVERSATION
      ? !!this.db.prepare(`SELECT 1 FROM agent_studio_assistant a JOIN studio_assistant_binding b USING (session_id)
        WHERE a.singleton = 1 AND a.session_id = ?`).get(ownerSessionId)
      : !!this.db.prepare(`SELECT 1 FROM studio_project p JOIN studio_project_binding b USING (project_id, management_epoch)
        WHERE p.project_id = ? AND b.leader_session_id = ?`).get(conversationId, ownerSessionId)
  }

  private liveSource(conversationId: string, ownerSessionId: string, requestId: string): string | undefined {
    const source = this.db.prepare(`SELECT text FROM agent_studio_message WHERE conversation_id = ? AND run_session_id = ? AND id = ?
      AND role = 'user' AND status = 'running' AND topic_id IS NOT NULL AND reply_to IS NOT NULL`).get(conversationId, ownerSessionId, requestId)
    return text(source?.text) ? source.text : undefined
  }

  private workerBound(sessionId: string): boolean {
    // Also reject any existing native Studio role, including previously observed Sessions not yet bound by a task.
    return !!this.db.prepare(`SELECT 1 FROM agent_studio_revision WHERE worker_session_id = ?1
      UNION ALL SELECT 1 FROM agent_studio_session WHERE id = ?1
      UNION ALL SELECT 1 FROM studio_assistant_binding WHERE session_id = ?1
      UNION ALL SELECT 1 FROM studio_project_binding WHERE leader_session_id = ?1
      UNION ALL SELECT 1 FROM managed_session_binding WHERE session_id = ?1
      UNION ALL SELECT 1 FROM studio_draft_task WHERE worker_session_id = ?1
      UNION ALL SELECT 1 FROM studio_study_step WHERE worker_session_id = ?1
      UNION ALL SELECT 1 FROM studio_project_dispatch WHERE worker_session_id = ?1
      UNION ALL SELECT 1 FROM studio_feishu_draft WHERE worker_session_id = ?1
      UNION ALL SELECT 1 FROM studio_advice WHERE advisor_session_id = ?1 LIMIT 1`).get({ '1': sessionId })
  }

  /** Walk the direct reply chain within the room. Quotes never grant a task link; descending sequence excludes loops. */
  private isAncestor(conversationId: string, requestId: string, originRequestId: string): boolean {
    return !!this.db.prepare(`WITH RECURSIVE parents(id, sequence, reply_to, role) AS (
      SELECT id, sequence, reply_to, role FROM agent_studio_message WHERE conversation_id = ?1 AND id = ?2
      UNION ALL SELECT m.id, m.sequence, m.reply_to, m.role FROM agent_studio_message m JOIN parents p ON m.id = p.reply_to
        WHERE m.conversation_id = ?1 AND m.sequence < p.sequence
      ) SELECT 1 FROM parents WHERE id = ?3 AND id <> ?2 AND role = 'user' LIMIT 1`)
      .get({ '1': conversationId, '2': requestId, '3': originRequestId })
  }

  private originCurrent(row: RevisionRow): boolean {
    const origin = this.eligibleOrigin(row.conversation_id, { id: row.work_id, type: row.work_type })
    return origin !== undefined && origin.requestId === row.origin_request_id && origin.messageId === row.origin_message_id
  }

  private reservationCurrent(row: RevisionRow): boolean {
    return row.state === 'running' && row.message_id === studioOwnerMessageId(row.request_id)
      && this.ownerCurrent(row.conversation_id, row.owner_session_id)
      && this.liveSource(row.conversation_id, row.owner_session_id, row.request_id) !== undefined && this.originCurrent(row)
  }

  /** Read only completed standalone text results; the protection checks apply before returning any native result body. */
  private eligibleOrigin(conversationId: string, work: StudioRevisionWork): Origin | undefined {
    let row: Row | undefined
    if (conversationId === ASSISTANT_CONVERSATION && work.type === 'draft') {
      row = this.db.prepare(`SELECT d.source_request_id, d.source_message_id, d.result_text, d.result_event_seq
        FROM studio_draft_task d WHERE d.task_id = ? AND d.state = 'completed'
        AND NOT EXISTS (SELECT 1 FROM studio_draft_preference p WHERE p.task_id = d.task_id)`).get(work.id)
    } else if (conversationId === ASSISTANT_CONVERSATION && work.type === 'study') {
      row = this.db.prepare(`SELECT s.source_request_id, s.source_message_id, step.result_json
        FROM studio_study s JOIN studio_study_step step ON step.study_task_id = s.task_id
        WHERE s.task_id = ? AND s.state = 'completed' AND step.kind = 'synthesis' AND step.state = 'completed'`).get(work.id)
    } else if (conversationId !== ASSISTANT_CONVERSATION && work.type === 'work') {
      row = this.db.prepare(`SELECT w.source_request_id, w.source_message_id, d.result_json FROM studio_project_work w
        JOIN studio_project_binding b USING (leader_session_id)
        JOIN studio_project_dispatch d ON d.work_id = w.work_id AND d.project_id = b.project_id
        WHERE w.work_id = ? AND b.project_id = ? AND d.state = 'completed'
        AND NOT EXISTS (SELECT 1 FROM studio_project_document x WHERE x.work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_job x WHERE x.work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_job_candidate x WHERE x.work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_work_fact x WHERE x.work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_work_result_use x WHERE x.work_id = w.work_id)`)
        .get(work.id, conversationId)
    }
    if (!row || !id(row.source_request_id) || row.source_message_id !== studioOwnerMessageId(row.source_request_id)) return
    const result = work.type === 'draft' ? { text: row.result_text, eventSeq: row.result_event_seq } : this.nativeResult(row.result_json)
    if (!text(result?.text) || !eventSeq(result?.eventSeq)) return
    return { requestId: row.source_request_id, messageId: row.source_message_id, text: result.text }
  }

  private nativeResult(json: SQLOutputValue | undefined): Partial<StudioRevisionResult> | undefined {
    if (typeof json !== 'string' || json.length > 6 * STUDIO_TEXT_LIMIT + 16_384) return
    try { return JSON.parse(json) as Partial<StudioRevisionResult> }
    catch { return undefined }
  }
}
