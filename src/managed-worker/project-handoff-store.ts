/** Bounded, metadata-only handoff records and their separately rechecked current state. */
import type { DatabaseSync } from 'node:sqlite'
import { readProjectDocument, type ProjectDocumentAccess } from './project-document-store.js'
import { hasJobCandidate } from './project-job-candidate-store.js'
import { isJobState } from './project-job-store.js'
import type { StudioProjectBinding, StudioProjectRun } from './project-store.ts'
import { latestWorkBlockState } from './project-work-block-store.js'
import type { SystemdJobState } from './systemd-job.ts'

/** One work item's origin and bounded state, without request or result bodies. */
export interface ProjectHandoffItem {
  workId: string
  leaderSessionId: string
  managementEpoch: number
  sourceMessageId: string
  /** An active owner hold, without the reason, condition, or command token. */
  blocked?: true
  /** Only the hold is recorded, never the candidate identity or supplied reference. */
  jobUnconfirmed?: true
  run?: {
    state: StudioProjectRun['state']
    managementEpoch: number
    executionEpoch: number
    workerSessionId: string
    result?: { messageId: string; turn: number; eventSeq: number }
  }
  document?: {
    taskId: string
    workerSessionId: string
    executionEpoch: number
    authorizationVersion: number
    documentVersion: number
    paused: boolean
    hold?: string
  }
  job?: {
    state: SystemdJobState
    observedAt: string
    observationVersion: number
    paused: boolean
    authorizationVersion: number
    automatic?: 'armed' | 'spent'
  }
}

/** Keep the immutable handoff state separate from facts rechecked under current management. */
export interface ProjectHandoffReview {
  record: {
    before: StudioProjectBinding
    after: StudioProjectBinding
    commandId: string
    at: string
    items: ProjectHandoffItem[]
    truncated: boolean
  }
  current: { binding: StudioProjectBinding; items: ProjectHandoffItem[] }
}

// The new binding supplies both the handoff origin and the key for the exact preceding epoch.
// Guard duplicate inserts too, so SQLite REPLACE cannot silently overwrite a record.
export const PROJECT_HANDOFF_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_handoff (
    project_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 2 AND 9007199254740991),
    items_json TEXT NOT NULL CHECK (json_valid(items_json)),
    truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
    PRIMARY KEY (project_id, management_epoch),
    FOREIGN KEY (project_id, management_epoch) REFERENCES studio_project_binding (project_id, management_epoch)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_project_handoff_no_update BEFORE UPDATE ON studio_project_handoff BEGIN
    SELECT RAISE(ABORT, 'Studio project handoff records cannot be updated');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_handoff_no_delete BEFORE DELETE ON studio_project_handoff BEGIN
    SELECT RAISE(ABORT, 'Studio project handoff records cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_handoff_no_replace BEFORE INSERT ON studio_project_handoff
    WHEN EXISTS (SELECT 1 FROM studio_project_handoff WHERE project_id = NEW.project_id AND management_epoch = NEW.management_epoch)
  BEGIN
    SELECT RAISE(ABORT, 'Studio project handoff records cannot be replaced');
  END;
`

const ITEM_LIMIT = 12
const WORK_COORDINATES = `SELECT w.work_id, w.leader_session_id, b.management_epoch, w.source_message_id
  FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id) WHERE b.project_id = ?`
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const isHold = (value: unknown): boolean => value === 'INSTRUCTION_PENDING' || value === 'INSTRUCTION_UNCONFIRMED'
  || value === 'SHARED_DOCUMENT_CONFLICT' || value === 'PAUSE_UNCONFIRMED' || value === 'TASK_PAUSED'
const isRunState = (value: unknown): value is StudioProjectRun['state'] => value === 'reserved' || value === 'running'
  || value === 'completed' || value === 'failed' || value === 'interrupted' || value === 'released'

/** Accept only named fields, so a corrupt record cannot introduce content into the review. */
function hasFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function isResult(value: unknown): value is NonNullable<NonNullable<ProjectHandoffItem['run']>['result']> {
  return hasFields(value, ['messageId', 'turn', 'eventSeq']) && isId(value.messageId) && isVersion(value.turn)
    && (value.eventSeq === 0 || isVersion(value.eventSeq))
}

/** Validate archived JSON and current projections with the same field, epoch, and state checks. */
function checkedItem(value: unknown, maxEpoch: number): ProjectHandoffItem {
  if (!hasFields(value, ['workId', 'leaderSessionId', 'managementEpoch', 'sourceMessageId'], ['run', 'document', 'job', 'blocked', 'jobUnconfirmed'])
    || !isId(value.workId) || !isId(value.leaderSessionId) || !isVersion(value.managementEpoch)
    || value.managementEpoch > maxEpoch || !isId(value.sourceMessageId)) throw new Error('Invalid Studio handoff work coordinates')
  const { run, document, job, blocked, jobUnconfirmed } = value
  if (run !== undefined && (!hasFields(run, ['state', 'managementEpoch', 'executionEpoch', 'workerSessionId'], ['result'])
    || !isRunState(run.state) || !isVersion(run.managementEpoch) || run.managementEpoch < value.managementEpoch
    || run.managementEpoch > maxEpoch || !isVersion(run.executionEpoch) || !isId(run.workerSessionId)
    || (run.state === 'completed' ? !isResult(run.result) : run.result !== undefined))) throw new Error('Invalid Studio handoff run')
  if (blocked !== undefined && (blocked !== true || document !== undefined || job !== undefined || (run && run.state !== 'released'))) {
    throw new Error('Invalid Studio handoff text work block')
  }
  if (jobUnconfirmed !== undefined && (jobUnconfirmed !== true || blocked !== undefined || job !== undefined
    || document !== undefined || (run && run.state !== 'released'))) throw new Error('Invalid Studio handoff job candidate hold')
  if (document !== undefined && (!hasFields(document, ['taskId', 'workerSessionId', 'executionEpoch', 'authorizationVersion',
    'documentVersion', 'paused'], ['hold']) || !isId(document.taskId) || !isId(document.workerSessionId)
    || !isVersion(document.executionEpoch) || !isVersion(document.authorizationVersion) || typeof document.paused !== 'boolean'
    || (document.documentVersion !== 1 && document.documentVersion !== 2)
    || (document.hold !== undefined && (document.documentVersion !== 1 || !isHold(document.hold))))) {
    throw new Error('Invalid Studio handoff document')
  }
  if (job !== undefined && (!hasFields(job, ['state', 'observedAt', 'observationVersion', 'paused', 'authorizationVersion'], ['automatic'])
    || !isJobState(job.state) || !isTimestamp(job.observedAt) || !isVersion(job.observationVersion)
    || typeof job.paused !== 'boolean' || !isVersion(job.authorizationVersion)
    || (job.automatic !== undefined && job.automatic !== 'armed' && job.automatic !== 'spent'))) throw new Error('Invalid Studio handoff job')
  return value as unknown as ProjectHandoffItem
}

/** Read the latest attempt, projecting only numeric and string result coordinates from completed work. */
function readRun(db: DatabaseSync, projectId: string, workId: string): unknown {
  const row = db.prepare(`SELECT project_id, state, management_epoch, execution_epoch, worker_session_id,
    CASE WHEN state = 'completed' AND json_type(result_json, '$.messageId') = 'text'
      AND instr(json_extract(result_json, '$.messageId'), char(0)) = 0 THEN json_extract(result_json, '$.messageId') END AS message_id,
    CASE WHEN state = 'completed' AND json_type(result_json, '$.turn') = 'integer' THEN json_extract(result_json, '$.turn') END AS turn,
    CASE WHEN state = 'completed' AND json_type(result_json, '$.eventSeq') = 'integer' THEN json_extract(result_json, '$.eventSeq') END AS event_seq
    FROM studio_project_dispatch WHERE work_id = ? ORDER BY execution_epoch DESC LIMIT 1`).get(workId)
  if (!row) return
  if (row.project_id !== projectId) throw new Error('Studio handoff dispatch belongs to another project')
  const { state, management_epoch: managementEpoch, execution_epoch: executionEpoch, worker_session_id: workerSessionId } = row
  return { state, managementEpoch, executionEpoch, workerSessionId,
    ...(state === 'completed' ? { result: { messageId: row.message_id, turn: row.turn, eventSeq: row.event_seq } } : {}) }
}

/** Match the current grant using only its binding, authorization version and consumption marker. */
function readJob(db: DatabaseSync, binding: StudioProjectBinding, workId: string): unknown {
  const row = db.prepare(`SELECT j.attached_project_id, j.state, j.observed_at, j.observation_version, j.paused, j.authorization_version,
    a.work_id IS NOT NULL AS has_grant, a.consumed_execution_epoch
    FROM studio_project_job j LEFT JOIN studio_project_job_auto a
      ON a.work_id = j.work_id AND a.project_id = j.attached_project_id AND a.authorization_version = j.authorization_version
      AND a.management_epoch = ? AND a.leader_session_id = ?
    WHERE j.work_id = ?`).get(binding.managementEpoch, binding.leaderSessionId, workId)
  if (!row) return
  const { attached_project_id: projectId, state, observed_at: observedAt, observation_version: observationVersion,
    paused, authorization_version: authorizationVersion, has_grant: hasGrant, consumed_execution_epoch: consumed } = row
  if (projectId !== binding.projectId || (paused !== 0 && paused !== 1) || (consumed !== null && !isVersion(consumed))) {
    throw new Error('Invalid Studio handoff job coordinates')
  }
  return { state, observedAt, observationVersion, paused: paused === 1, authorizationVersion,
    ...(hasGrant === 1 ? { automatic: consumed === null ? 'armed' : 'spent' } : {}) }
}

/** Resolve metadata for one same-project work row; document verification does not return its committed text. */
function readItem(db: DatabaseSync, access: ProjectDocumentAccess, binding: StudioProjectBinding,
  row: Record<string, unknown>, maxEpoch: number): ProjectHandoffItem {
  const { work_id: workId, leader_session_id: leaderSessionId, management_epoch: managementEpoch, source_message_id: sourceMessageId } = row
  if (!isId(workId)) throw new Error('Invalid Studio handoff work ID')
  const run = readRun(db, binding.projectId, workId)
  const job = readJob(db, binding, workId)
  const document = readProjectDocument(db, access, { projectId: binding.projectId, workId }, false)
  const blocked = latestWorkBlockState(db, workId) === 'active'
  const jobUnconfirmed = job === undefined && hasJobCandidate(db, workId)
  const task = document?.task
  return checkedItem({ workId, leaderSessionId, managementEpoch, sourceMessageId,
    ...(blocked ? { blocked: true } : {}), ...(jobUnconfirmed ? { jobUnconfirmed: true } : {}),
    ...(run === undefined ? {} : { run }), ...(job === undefined ? {} : { job }),
    ...(task ? { document: { taskId: task.taskId, workerSessionId: task.workerSessionId, executionEpoch: task.executionEpoch,
      authorizationVersion: task.authorizationVersion, documentVersion: task.documentVersion, paused: task.paused,
      ...(document.hold === undefined ? {} : { hold: document.hold }) } } : {}) }, maxEpoch)
}

/** Read one exact record with binding provenance. A legacy binding alone never implies a captured handoff. */
function readRecord(db: DatabaseSync, projectId: string, managementEpoch: number): ProjectHandoffReview['record'] | undefined {
  const row = db.prepare(`SELECT h.items_json, h.truncated, old.leader_session_id AS before_session, old.leader_bot_id AS before_bot,
    next.leader_session_id AS after_session, next.leader_bot_id AS after_bot, next.command_id, next.bound_at
    FROM studio_project_handoff h
    LEFT JOIN studio_project_binding old ON old.project_id = h.project_id AND old.management_epoch = h.management_epoch - 1
    LEFT JOIN studio_project_binding next ON next.project_id = h.project_id AND next.management_epoch = h.management_epoch
    WHERE h.project_id = ? AND h.management_epoch = ?`).get(projectId, managementEpoch)
  if (!row) return
  const { items_json: itemsJson, truncated, before_session: beforeSession, before_bot: beforeBot, after_session: afterSession,
    after_bot: afterBot, command_id: commandId, bound_at: at } = row
  if (managementEpoch < 2 || !isId(beforeSession) || !isId(beforeBot) || !isId(afterSession) || beforeSession === afterSession
    || !isId(afterBot) || !isId(commandId) || !isTimestamp(at) || typeof itemsJson !== 'string' || (truncated !== 0 && truncated !== 1)) {
    throw new Error('Invalid Studio handoff provenance')
  }
  const value: unknown = JSON.parse(itemsJson)
  if (!Array.isArray(value) || value.length > ITEM_LIMIT || (truncated === 1 && value.length !== ITEM_LIMIT)) {
    throw new Error('Invalid Studio handoff item count')
  }
  const items = value.map(item => checkedItem(item, managementEpoch - 1))
  if (new Set(items.map(item => item.workId)).size !== items.length) throw new Error('Duplicate Studio handoff work ID')
  return { before: { projectId, leaderSessionId: beforeSession, leaderBotId: beforeBot, managementEpoch: managementEpoch - 1 },
    after: { projectId, leaderSessionId: afterSession, leaderBotId: afterBot, managementEpoch }, commandId, at, items, truncated: truncated === 1 }
}

/** Capture after changing the binding and verifying release, under the caller's existing write transaction. */
export function captureProjectHandoff(db: DatabaseSync, access: ProjectDocumentAccess, before: StudioProjectBinding,
  after: StudioProjectBinding, commandId: string): void {
  const { projectId, managementEpoch } = after
  // The extra row detects overflow without opening its job, document, or run metadata.
  const rows = db.prepare(`${WORK_COORDINATES} ORDER BY w.rowid DESC LIMIT ?`).all(projectId, ITEM_LIMIT + 1)
  const items = rows.slice(0, ITEM_LIMIT).map(row => readItem(db, access, after, row, before.managementEpoch))
  const itemsJson = JSON.stringify(items)
  const truncated = rows.length > ITEM_LIMIT ? 1 : 0
  const { changes } = db.prepare(`INSERT INTO studio_project_handoff (project_id, management_epoch, items_json, truncated) VALUES (?, ?, ?, ?)`)
    .run(projectId, managementEpoch, itemsJson, truncated)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project handoff insert did not affect exactly one row')
  // Re-read the exact persisted record and provenance; an ignored or altered write must not confirm management transfer.
  const record = readRecord(db, projectId, managementEpoch)
  if (!record || record.commandId !== commandId || record.before.leaderSessionId !== before.leaderSessionId
    || record.before.leaderBotId !== before.leaderBotId || record.before.managementEpoch !== before.managementEpoch
    || record.after.leaderSessionId !== after.leaderSessionId || record.after.leaderBotId !== after.leaderBotId
    || record.truncated !== (truncated === 1) || JSON.stringify(record.items) !== itemsJson) throw new Error('Unverified Studio project handoff')
}

/** Review only the archived IDs, in archived order, under the caller's current-project read fence. */
export function readProjectHandoff(db: DatabaseSync, access: ProjectDocumentAccess, binding: StudioProjectBinding,
  managementEpoch: number): ProjectHandoffReview | undefined {
  const record = readRecord(db, binding.projectId, managementEpoch)
  if (!record) return
  const selectWork = db.prepare(`${WORK_COORDINATES} AND w.work_id = ?`)
  const items = record.items.map(({ workId, leaderSessionId, managementEpoch: originEpoch, sourceMessageId }) => {
    const row = selectWork.get(binding.projectId, workId)
    if (!row || row.leader_session_id !== leaderSessionId || row.management_epoch !== originEpoch || row.source_message_id !== sourceMessageId) {
      throw new Error('Studio handoff work origin does not match its project')
    }
    return readItem(db, access, binding, row, binding.managementEpoch)
  })
  return { record, current: { binding, items } }
}
