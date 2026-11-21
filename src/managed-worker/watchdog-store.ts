/** Bounded evidence projections from the existing Studio ledgers; no live service or Session reads. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { DocumentFailureNotice } from './document-failure-notice-store.js'
import type { DocumentFailure } from './document-recovery-store.js'
import { isJobState } from './project-job-store.js'
import { latestWorkBlockState } from './project-work-block-store.js'
import type { StudioQuotaIncident } from './quota-store.js'
import type { ManagedTask } from './store.js'
import { validSystemdJob } from './systemd-job.js'

export const WATCHDOG_KINDS = ['document', 'job', 'draft', 'feishu', 'project', 'study', 'advice'] as const
export type WatchdogKind = typeof WATCHDOG_KINDS[number]
export type WatchdogTarget = { kind: WatchdogKind; id: string }
export const WATCHDOG_PAGE_LIMIT = 8

export interface WatchdogSnapshot {
  entries: WatchdogEntry[]
  truncated: WatchdogKind[]
  captureUnconfirmed: boolean
  pauseUnconfirmed: boolean
  quotas: WatchdogQuota[]
}

export interface WatchdogQuota {
  poolId: string
  state: 'clear' | 'held' | 'unconfirmed'
  incident?: StudioQuotaIncident
  notice?: 'sending' | 'delivered' | 'unconfirmed'
}

type RefusalSource = { evidenceId: string; eventSeq: number }

export interface WatchdogDocument {
  kind: 'document'
  id: string
  sessionId: string
  executionEpoch: number
  authorizationVersion: number
  documentVersion: number
  paused: boolean
  pendingReview: boolean
  pauseUnconfirmed: boolean
  recoveryPause?: boolean
  recovery?: DocumentFailure
  failureNotice?: DocumentFailureNotice
  repeatedScopeRefusals?: [RefusalSource, RefusalSource]
  shared?: { baseVersion: number; headVersion: number }
  projectId?: string
  workId?: string
  leaderSessionId?: string
  managementEpoch?: number
}

export interface WatchdogJob {
  kind: 'job'
  id: string
  projectId: string
  leaderSessionId: string
  managementEpoch: number
  unit: string
  invocationId: string
  state: 'running' | 'completed' | 'unknown' | 'failed'
  observedAt: string
  observationVersion: number
  paused: boolean
  authorizationVersion: number
  automatic?: 'granted' | 'consumed'
  workState?: string
}

export interface WatchdogExecution {
  kind: 'draft' | 'feishu' | 'project' | 'study' | 'advice'
  id: string
  state: 'pending' | 'reserved' | 'running' | 'completed' | 'failed' | 'interrupted' | 'released'
  sessionId?: string
  executionEpoch?: number
  projectId?: string
  leaderSessionId?: string
  managementEpoch?: number
  reason?: string
  /** Latest project text block status, independent of the last reservation or execution. */
  ownerBlock?: 'active' | 'cleared'
}

export type WatchdogEntry = WatchdogDocument | WatchdogJob | WatchdogExecution

// Key the overview's eligible states directly instead of sorting or scanning historical rows on each read.
export const WATCHDOG_INDEXES = `
  CREATE INDEX IF NOT EXISTS watchdog_document_version ON managed_document (document_version, task_id);
  CREATE INDEX IF NOT EXISTS watchdog_job_state ON studio_project_job (state, work_id);
  CREATE INDEX IF NOT EXISTS watchdog_draft_state ON studio_draft_task (state, task_id);
  CREATE INDEX IF NOT EXISTS watchdog_feishu_state ON studio_feishu_draft (state, task_id);
  CREATE INDEX IF NOT EXISTS watchdog_project_active ON studio_project_dispatch (work_id) WHERE state IN ('reserved', 'running');
  CREATE INDEX IF NOT EXISTS watchdog_study_state ON studio_study (state, task_id);
  CREATE INDEX IF NOT EXISTS watchdog_advice_state ON studio_advice (state, advice_id);
`

type Row = Record<string, SQLOutputValue>
type Management = Pick<WatchdogJob, 'projectId' | 'leaderSessionId' | 'managementEpoch'>
type ExecutionKind = Exclude<WatchdogExecution['kind'], 'project'>
type EntryPage = Pick<WatchdogSnapshot, 'entries' | 'truncated'>

interface DocumentEvidence {
  captureUnconfirmed: boolean
  task(id: string): ManagedTask | undefined
  pendingReview(id: string): boolean
  frozen(task: ManagedTask): boolean
  recovery(task: ManagedTask): DocumentFailure | undefined
  failureNotice(id: string): DocumentFailureNotice | undefined
}

const pageSize = WATCHDOG_PAGE_LIMIT + 1
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const draftStates = ['running', 'interrupted', 'failed', 'completed'] as const
const adviceStates = ['reserved', ...draftStates] as const
const dispatchStates = [...adviceStates, 'released'] as const
const jobStates = ['unknown', 'running', 'failed', 'completed'] as const

// Compare in SQL so arbitrary failure strings never leave storage, even when a row is inspected by exact ID.
const reasonColumn = (projectDispatch = false) => `CASE
  WHEN state IN ('interrupted', 'released') AND failure = 'HOST_RESTARTED' THEN 'HOST_RESTARTED'
  WHEN state = 'released' AND failure = 'STALE_MANAGEMENT' THEN 'STALE_MANAGEMENT'
  WHEN state = 'released' AND failure = 'EXTERNAL_JOB_PAUSED' THEN 'EXTERNAL_JOB_PAUSED'
  ${projectDispatch ? "WHEN state = 'released' AND failure = 'PROJECT_WORK_BLOCKED' THEN 'PROJECT_WORK_BLOCKED'" : ''}
  END AS reason`

type ExecutionSource = { table: string; id: string; states: readonly WatchdogExecution['state'][]; coordinates: string }
const executionSources: Record<ExecutionKind, ExecutionSource> = {
  draft: { table: 'studio_draft_task', id: 'task_id', states: draftStates, coordinates: 'worker_session_id AS session_id, execution_epoch' },
  feishu: { table: 'studio_feishu_draft', id: 'task_id', states: draftStates, coordinates: 'worker_session_id AS session_id, execution_epoch' },
  study: { table: 'studio_study', id: 'task_id', states: draftStates, coordinates: 'NULL AS session_id, NULL AS execution_epoch' },
  advice: { table: 'studio_advice', id: 'advice_id', states: adviceStates, coordinates: 'advisor_session_id AS session_id, execution_epoch, project_id, role' },
}

/** Copy a target without invoking any caller-provided getters or coercions. */
export function readWatchdogTarget(value: object): WatchdogTarget | undefined {
  const rawKind: unknown = Object.getOwnPropertyDescriptor(value, 'kind')?.value
  const id: unknown = Object.getOwnPropertyDescriptor(value, 'id')?.value
  const kind = WATCHDOG_KINDS.find(candidate => candidate === rawKind)
  if (kind !== undefined && isId(id)) return { kind, id }
}

/** Follow the historical binding to the work's project, then resolve its current management epoch. */
function management(db: DatabaseSync, projectId: unknown): Management {
  if (!isId(projectId)) throw new Error('Missing Watchdog project origin')
  const row = db.prepare(`SELECT p.management_epoch, b.leader_session_id FROM studio_project p
    LEFT JOIN studio_project_binding b USING (project_id, management_epoch) WHERE p.project_id = ?`).get(projectId)
  if (!isId(row?.leader_session_id) || !isVersion(row.management_epoch)) throw new Error('Invalid Watchdog project management')
  return { projectId, leaderSessionId: row.leader_session_id, managementEpoch: row.management_epoch }
}

function workOrigin(db: DatabaseSync, id: string): string {
  const row = db.prepare(`SELECT b.project_id FROM studio_project_work w
    LEFT JOIN studio_project_binding b USING (leader_session_id) WHERE w.work_id = ?`).get(id)
  if (!isId(row?.project_id)) throw new Error('Missing Watchdog work origin')
  return row.project_id
}

/** Read the latest two distinct native calls for the current approval. The indexed per-task ledger holds at most 64 rows. */
function repeatedScopeRefusals(db: DatabaseSync, task: ManagedTask): WatchdogDocument['repeatedScopeRefusals'] {
  const { taskId, workerSessionId, executionEpoch, authorizationVersion, sharedDocument } = task
  // Old records without a native link cannot prove independent calls. A review finding an inconsistent comparison is not scope evidence.
  const calls = db.prepare(`SELECT e.evidence_id, n.event_seq FROM studio_document_guard_evidence e
    JOIN studio_document_guard_native_call n USING (evidence_id)
    LEFT JOIN studio_document_guard_review r USING (evidence_id)
    WHERE e.task_id = ? AND e.worker_session_id = ? AND e.execution_epoch = ? AND e.authorization_version = ?
      AND e.document_id IS ? AND e.expected_version = ? AND e.phase = 'authorize' AND e.reason = 'ACTION_NOT_APPROVED'
      AND (r.outcome IS NULL OR r.outcome = 'refusal-confirmed')
    ORDER BY e.seq DESC`).iterate(taskId, workerSessionId, executionEpoch, authorizationVersion,
    sharedDocument?.documentId ?? null, sharedDocument?.baseVersion ?? 1)
  let latest: RefusalSource | undefined
  for (const { evidence_id: evidenceId, event_seq: eventSeq } of calls) {
    if (!isId(evidenceId) || (eventSeq !== 0 && !isVersion(eventSeq))) throw new Error('Invalid Watchdog document refusal source')
    if (!latest) latest = { evidenceId, eventSeq }
    else if (latest.eventSeq !== eventSeq) return [latest, { evidenceId, eventSeq }]
  }
}

function document(db: DatabaseSync, id: string, evidence: DocumentEvidence): WatchdogDocument {
  const task = evidence.task(id)
  if (!task) throw new Error('Missing Watchdog document or binding')
  const { workerSessionId: sessionId, executionEpoch, authorizationVersion, documentVersion, paused, sharedDocument } = task
  // A transfer changes the task's coordinates. Do not label a pause as recovery unless they still match its record.
  const recoveryPause = paused && !!db.prepare(`SELECT 1 FROM managed_recovery_pause
    WHERE task_id = ? AND authorization_version = ? AND execution_epoch = ?`).get(id, authorizationVersion, executionEpoch)
  const link = db.prepare('SELECT work_id, project_id FROM studio_project_document WHERE task_id = ?').get(id)
  if (link && (!isId(link.work_id) || link.project_id !== workOrigin(db, link.work_id))) throw new Error('Invalid Watchdog document link')
  const project = link && isId(link.work_id) ? { ...management(db, link.project_id), workId: link.work_id } : undefined
  const recovery = evidence.recovery(task)
  // Retain the delivery result even after the task no longer exposes a recovery action.
  const failureNotice = evidence.failureNotice(id)
  const pendingReview = evidence.pendingReview(id)
  const pauseUnconfirmed = evidence.frozen(task)
  // A held, changed, or finished task can still have an audit trail, but there is no current progress concern to infer from it.
  const repeated = documentVersion === 1 && !paused && !pendingReview && !pauseUnconfirmed && !evidence.captureUnconfirmed
    && (!sharedDocument || sharedDocument.baseVersion === sharedDocument.headVersion) ? repeatedScopeRefusals(db, task) : undefined
  return { kind: 'document', id, sessionId, executionEpoch, authorizationVersion, documentVersion, paused, pendingReview, pauseUnconfirmed,
    ...(recoveryPause ? { recoveryPause } : {}),
    ...(recovery ? { recovery } : {}),
    ...(failureNotice ? { failureNotice } : {}),
    ...(repeated ? { repeatedScopeRefusals: repeated } : {}),
    ...(sharedDocument ? { shared: { baseVersion: sharedDocument.baseVersion, headVersion: sharedDocument.headVersion } } : {}),
    ...project }
}

/** Absent execution coordinates describe a pending work item or a study with no active step. */
function coordinates(row: Row): Pick<WatchdogExecution, 'sessionId' | 'executionEpoch'> {
  const { session_id: sessionId, execution_epoch: executionEpoch } = row
  if (sessionId === null && executionEpoch === null) return {}
  if (!isId(sessionId) || !isVersion(executionEpoch)) throw new Error('Invalid Watchdog execution coordinates')
  return { sessionId, executionEpoch }
}

function latestDispatch(db: DatabaseSync, workId: string, projectId: string): Omit<WatchdogExecution, 'kind' | 'id'> | undefined {
  const row = db.prepare(`SELECT state, project_id, worker_session_id AS session_id, execution_epoch, ${reasonColumn(true)}
    FROM studio_project_dispatch WHERE work_id = ? ORDER BY execution_epoch DESC LIMIT 1`).get(workId)
  if (!row) return
  const state = dispatchStates.find(value => value === row.state)
  const { reason } = row
  if (row.project_id !== projectId || state === undefined) throw new Error('Invalid Watchdog dispatch')
  return { state, ...coordinates(row), ...(typeof reason === 'string' ? { reason } : {}) }
}

/** Read job evidence and only the presence/consumption of a current grant, never its route. */
function job(db: DatabaseSync, id: string): WatchdogJob {
  const leader = management(db, workOrigin(db, id))
  const row = db.prepare(`SELECT attached_project_id, unit, invocation_id, state, observed_at,
    observation_version, paused, authorization_version FROM studio_project_job WHERE work_id = ?`).get(id)
  if (!row) throw new Error('Missing Watchdog job')
  const { unit, invocation_id: invocationId, state, observed_at: observedAt, observation_version: observationVersion,
    paused, authorization_version: authorizationVersion } = row
  if (row.attached_project_id !== leader.projectId || !isId(unit) || !isId(invocationId) || !validSystemdJob({ unit, invocationId })
    || !isJobState(state) || !isId(observedAt) || !isVersion(observationVersion) || !isVersion(authorizationVersion)
    || (paused !== 0 && paused !== 1)) throw new Error('Invalid Watchdog job evidence')
  const grant = db.prepare(`SELECT consumed_execution_epoch FROM studio_project_job_auto WHERE work_id = ?
    AND authorization_version = ? AND project_id = ? AND management_epoch = ? AND leader_session_id = ?`)
    .get(id, authorizationVersion, leader.projectId, leader.managementEpoch, leader.leaderSessionId)
  const consumed = grant?.consumed_execution_epoch
  if (grant && consumed !== null && !isVersion(consumed)) throw new Error('Invalid Watchdog job grant')
  const workState = latestDispatch(db, id, leader.projectId)?.state
  return { kind: 'job', id, ...leader, unit, invocationId, state, observedAt, observationVersion,
    paused: paused === 1, authorizationVersion, ...(grant ? { automatic: consumed === null ? 'granted' : 'consumed' } : {}),
    ...(workState === undefined ? {} : { workState }) }
}

function projectWork(db: DatabaseSync, id: string): WatchdogExecution {
  const leader = management(db, workOrigin(db, id))
  // The last attempt stays historical after a block is set or cleared. Read only the current block status, not owner notes.
  const attempt = latestDispatch(db, id, leader.projectId) ?? { state: 'pending' as const }
  const ownerBlock = latestWorkBlockState(db, id)
  if (ownerBlock === 'active' && attempt.state !== 'pending' && attempt.state !== 'released') {
    throw new Error('An active owner block conflicts with the saved Studio text dispatch')
  }
  return { kind: 'project', id, ...leader, ...attempt, ...(ownerBlock === undefined ? {} : { ownerBlock }) }
}

function execution(db: DatabaseSync, kind: ExecutionKind, source: ExecutionSource, row: Row): WatchdogExecution {
  const { id, reason } = row
  const state = source.states.find(value => value === row.state)
  if (!isId(id) || state === undefined) throw new Error('Invalid Watchdog execution state')
  let active: Row | undefined
  if (kind === 'study' && state === 'running') {
    active = db.prepare(`SELECT worker_session_id AS session_id, execution_epoch FROM studio_study_step
      WHERE study_task_id = ? AND state IN ('reserved', 'running')`).get(id)
  }
  // Advice records its origin; the caller needs the current management binding, which may have changed since admission.
  let leader: Management | undefined
  if (kind === 'advice') {
    if (row.role === 'leader') leader = management(db, row.project_id)
    else if (row.role !== 'assistant' || row.project_id !== null) throw new Error('Invalid Watchdog advice origin')
  }
  return { kind, id, state, ...coordinates(active ?? row), ...leader, ...(typeof reason === 'string' ? { reason } : {}) }
}

function requiredId(row: Row): string {
  if (!isId(row.id)) throw new Error('Invalid Watchdog entry ID')
  return row.id
}

/** Read one indexed state at a time to prefer active work without a sort across the whole ledger. */
function statePage(db: DatabaseSync, select: string, order: string, states: readonly string[]): Row[] {
  const statement = db.prepare(`${select} WHERE state = ? ORDER BY ${order} LIMIT ?`)
  const rows: Row[] = []
  for (const state of states) {
    rows.push(...statement.all(state, pageSize - rows.length))
    if (rows.length === pageSize) break
  }
  return rows
}

/** Surface every active dispatch up to the cap before sampling recent work; exact reads can find older work. */
function projectPage(db: DatabaseSync): WatchdogExecution[] {
  const active = db.prepare(`SELECT work_id AS id FROM studio_project_dispatch
    WHERE state IN ('reserved', 'running') ORDER BY work_id LIMIT ?`).all(pageSize)
  const entries = active.map(row => projectWork(db, requiredId(row)))
  if (entries.length === pageSize) return entries
  // Prioritize holds and pending work within a bounded recent window, without scanning historical block records.
  // If the window cannot contain all project work, the extra row proves truncation.
  const seen = new Set(entries.map(entry => entry.id))
  const order = (entry: WatchdogExecution) => entry.ownerBlock === 'active' ? 0 : entry.state === 'pending' ? 1 : 2
  const recent = db.prepare('SELECT work_id AS id FROM studio_project_work ORDER BY rowid DESC LIMIT ?').all(pageSize)
    .map(requiredId).filter(id => !seen.has(id)).map(id => projectWork(db, id)).sort((a, b) => order(a) - order(b))
  return [...entries, ...recent].slice(0, pageSize)
}

function entriesFor(db: DatabaseSync, kind: WatchdogKind, documents: DocumentEvidence, id?: string): WatchdogEntry[] {
  switch (kind) {
    case 'document': {
      const rows = id === undefined ? db.prepare(`SELECT task_id AS id FROM managed_document
        WHERE document_version = 1 ORDER BY task_id LIMIT ?`).all(pageSize)
        : db.prepare('SELECT task_id AS id FROM managed_task WHERE task_id = ?').all(id)
      return rows.map(row => document(db, requiredId(row), documents))
    }
    case 'job': {
      const select = 'SELECT work_id AS id FROM studio_project_job'
      const rows = id === undefined ? statePage(db, select, 'work_id', jobStates) : db.prepare(`${select} WHERE work_id = ?`).all(id)
      return rows.map(row => job(db, requiredId(row)))
    }
    case 'project':
      if (id === undefined) return projectPage(db)
      return db.prepare('SELECT 1 FROM studio_project_work WHERE work_id = ?').get(id) ? [projectWork(db, id)] : []
    default: {
      const source = executionSources[kind]
      const select = `SELECT ${source.id} AS id, state, ${source.coordinates}, ${reasonColumn()} FROM ${source.table}`
      const rows = id === undefined ? statePage(db, select, source.id, source.states) : db.prepare(`${select} WHERE ${source.id} = ?`).all(id)
      return rows.map(row => execution(db, kind, source, row))
    }
  }
}

/** Read inside the caller's Host-owned snapshot. Exact reads include retained history and never claim overview coverage. */
export function readWatchdogEntries(db: DatabaseSync, documents: DocumentEvidence, target?: WatchdogTarget): EntryPage {
  if (target) return { entries: entriesFor(db, target.kind, documents, target.id), truncated: [] }
  const page: EntryPage = { entries: [], truncated: [] }
  for (const kind of WATCHDOG_KINDS) {
    const entries = entriesFor(db, kind, documents)
    if (entries.length > WATCHDOG_PAGE_LIMIT) page.truncated.push(kind)
    page.entries.push(...entries.slice(0, WATCHDOG_PAGE_LIMIT))
  }
  return page
}
