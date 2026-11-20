/** SQLite persistence for externally observed jobs; no job control or systemd I/O. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { currentJobAuto, type StudioJobAuto } from './project-job-auto-store.js'
import type { StudioProjectBinding } from './project-store.ts'
import type { ManagedResult } from './store.ts'
import { validSystemdJob, type SystemdJobRef, type SystemdJobState } from './systemd-job.js'

/** The exact invocation and two independent revisions for observation and owner authorization. */
export interface StudioProjectJob {
  workId: string
  ref: SystemdJobRef
  state: SystemdJobState
  observedAt: string
  observationVersion: number
  paused: boolean
  authorizationVersion: number
  /** The current management/version grant, including its execution epoch if spent. */
  automatic?: StudioJobAuto
}

type ConfirmedJobState = Exclude<SystemdJobState, 'unknown'>

// Attachments retain their original input for exact replay even after the mutable job snapshot advances.
export const PROJECT_JOB_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_job (
    work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
    unit TEXT NOT NULL,
    invocation_id TEXT NOT NULL UNIQUE,
    attached_project_id TEXT NOT NULL,
    attached_leader_session_id TEXT NOT NULL,
    attached_management_epoch INTEGER NOT NULL,
    attach_command_id TEXT NOT NULL UNIQUE,
    attached_at TEXT NOT NULL,
    attached_state TEXT NOT NULL CHECK (attached_state IN ('running', 'completed', 'failed')),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'unknown')),
    observed_at TEXT NOT NULL,
    observation_version INTEGER NOT NULL CHECK (observation_version BETWEEN 1 AND 9007199254740991),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (attached_project_id, attached_management_epoch, attached_leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_job_watch
    ON studio_project_job (work_id) WHERE state IN ('running', 'unknown');
  CREATE TABLE IF NOT EXISTS studio_project_job_control (
    command_id TEXT NOT NULL PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES studio_project_job (work_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 2 AND 9007199254740991),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    recorded_at TEXT NOT NULL,
    UNIQUE (work_id, authorization_version),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
`

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const terminal = (state: unknown): state is 'completed' | 'failed' => state === 'completed' || state === 'failed'
export const isConfirmedJobState = (state: unknown): state is ConfirmedJobState => state === 'running' || terminal(state)
export const isJobState = (state: unknown): state is SystemdJobState => state === 'unknown' || isConfirmedJobState(state)

function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project job write did not affect exactly one row')
}

function jobRow(db: DatabaseSync, workId: string): Record<string, SQLOutputValue> | undefined {
  return db.prepare('SELECT * FROM studio_project_job WHERE work_id = ?').get(workId)
}

/** Validate the pinned job and project only a grant that is current in this snapshot. */
function decodeJob(db: DatabaseSync, row: Record<string, SQLOutputValue>, projectId: string, workId: string): StudioProjectJob {
  const { unit, invocation_id: invocationId, state, observed_at: observedAt, observation_version: observationVersion,
    paused, authorization_version: authorizationVersion } = row
  if (row.attached_project_id !== projectId || typeof unit !== 'string' || typeof invocationId !== 'string'
    || !validSystemdJob({ unit, invocationId }) || !isJobState(state) || typeof observedAt !== 'string' || !observedAt
    || !isVersion(observationVersion) || !isVersion(authorizationVersion) || (paused !== 0 && paused !== 1)) {
    throw new Error('Invalid Studio project job')
  }
  const automatic = currentJobAuto(db, projectId, workId, authorizationVersion)
  return { workId, ref: { unit, invocationId }, state, observedAt, observationVersion, paused: paused === 1, authorizationVersion,
    ...(automatic === undefined ? {} : { automatic }) }
}

/** The project store checks work membership before using this snapshot. */
export function readProjectJob(db: DatabaseSync, projectId: string, workId: string): StudioProjectJob | undefined {
  const row = jobRow(db, workId)
  return row && decodeJob(db, row, projectId, workId)
}

/** Poll only nonterminal pinned jobs. The work's original binding identifies the project even after a handoff. */
export function watchedJobPage(db: DatabaseSync, afterWorkId: string): StudioProjectJob[] {
  const rows = db.prepare(`SELECT j.*, b.project_id AS work_project_id FROM studio_project_job j
    JOIN studio_project_work w USING (work_id) JOIN studio_project_binding b ON b.leader_session_id = w.leader_session_id
    WHERE j.work_id > ? AND j.state IN ('running', 'unknown') ORDER BY j.work_id ASC LIMIT 8`).all(afterWorkId)
  return rows.map(row => {
    if (typeof row.work_project_id !== 'string' || typeof row.work_id !== 'string') throw new Error('Invalid Studio watched job origin')
    return decodeJob(db, row, row.work_project_id, row.work_id)
  })
}

/** Keep explicit project commands unambiguous across attachment, control, and management. */
export function projectJobCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_project_job WHERE attach_command_id = ?
    UNION ALL SELECT 1 FROM studio_project_job_control WHERE command_id = ? LIMIT 1`).get(commandId, commandId)
}

/** Pin one exact reference. Call only after checking current management and work membership in the write transaction. */
export function attachProjectJob(db: DatabaseSync, actor: StudioProjectBinding, workId: string, commandId: string,
  ref: SystemdJobRef, state: ConfirmedJobState, commandUsed: () => boolean): ManagedResult<StudioProjectJob> {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const { unit, invocationId } = ref
  const row = jobRow(db, workId)
  if (row?.attach_command_id === commandId) {
    // Replay the original binding, not an attempt to replace it or restore its initial observation.
    if (row.attached_leader_session_id !== leaderSessionId || row.attached_management_epoch !== managementEpoch
      || row.unit !== unit || row.invocation_id !== invocationId || row.attached_state !== state) return deny('DUPLICATE_COMMAND')
    return accept(decodeJob(db, row, projectId, workId))
  }
  if (commandUsed()) return deny('DUPLICATE_COMMAND')
  if (row) return deny('EXTERNAL_JOB_ALREADY_ATTACHED')
  if (db.prepare("SELECT 1 FROM studio_project_dispatch WHERE work_id = ? AND state <> 'released'").get(workId)) {
    return deny('WORK_ALREADY_DISPATCHED')
  }
  if (db.prepare('SELECT 1 FROM studio_project_job WHERE invocation_id = ?').get(invocationId)) {
    return deny('EXTERNAL_JOB_INVOCATION_ALREADY_ATTACHED')
  }
  const observedAt = new Date().toISOString()
  requireWrite(db.prepare(`INSERT INTO studio_project_job (work_id, unit, invocation_id, attached_project_id,
    attached_leader_session_id, attached_management_epoch, attach_command_id, attached_at, attached_state, state,
    observed_at, observation_version, paused, authorization_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1)`)
    .run(workId, unit, invocationId, projectId, leaderSessionId, managementEpoch, commandId, observedAt, state, state, observedAt).changes)
  return accept({ workId, ref: { unit, invocationId }, state, observedAt, observationVersion: 1, paused: false, authorizationVersion: 1 })
}

/** Record one versioned observation for the Leader's checked project and work. */
export function observeProjectJob(db: DatabaseSync, projectId: string, workId: string, expectedVersion: number,
  state: SystemdJobState): ManagedResult<StudioProjectJob> {
  const job = readProjectJob(db, projectId, workId)
  return job ? mergeObservation(db, job, expectedVersion, state) : deny('EXTERNAL_JOB_NOT_FOUND')
}

/** Merge a Host polling result by its pinned identity and version, without relying on a live Leader Session. */
export function observeWatchedProjectJob(db: DatabaseSync, workId: string, ref: SystemdJobRef, expectedVersion: number,
  state: SystemdJobState): ManagedResult<StudioProjectJob> {
  const origin = db.prepare(`SELECT b.project_id FROM studio_project_work w
    JOIN studio_project_binding b USING (leader_session_id) WHERE w.work_id = ?`).get(workId)
  if (!origin) return deny('WORK_NOT_FOUND')
  if (typeof origin.project_id !== 'string') throw new Error('Invalid Studio watched job origin')
  const job = readProjectJob(db, origin.project_id, workId)
  if (!job) return deny('EXTERNAL_JOB_NOT_FOUND')
  if (job.ref.unit !== ref.unit || job.ref.invocationId !== ref.invocationId) return deny('STALE_JOB_REFERENCE')
  if (job.observationVersion !== expectedVersion) return deny('STALE_JOB_OBSERVATION')
  return mergeObservation(db, job, expectedVersion, state)
}

/** Preserve the first confirmed terminal observation and update neither pause nor authorization. */
function mergeObservation(db: DatabaseSync, job: StudioProjectJob, expectedVersion: number,
  state: SystemdJobState): ManagedResult<StudioProjectJob> {
  if (terminal(job.state)) return accept(job)
  if (job.observationVersion !== expectedVersion) return deny('STALE_JOB_OBSERVATION')
  const observationVersion = expectedVersion + 1
  if (!isVersion(observationVersion)) return deny('INVALID_INPUT')
  // Even a matching nonterminal state consumes the observation version and fences slower reads of the same version.
  const observedAt = new Date().toISOString()
  requireWrite(db.prepare(`UPDATE studio_project_job SET state = ?, observed_at = ?, observation_version = ?
    WHERE work_id = ? AND unit = ? AND invocation_id = ? AND observation_version = ? AND state IN ('running', 'unknown')`)
    .run(state, observedAt, observationVersion, job.workId, job.ref.unit, job.ref.invocationId, expectedVersion).changes)
  return accept({ ...job, state, observedAt, observationVersion })
}

/** Change only owner authorization. Record each accepted command and its origin atomically with the CAS. */
export function setProjectJobPaused(db: DatabaseSync, actor: StudioProjectBinding, workId: string, commandId: string,
  expectedVersion: number, paused: boolean, commandUsed: () => boolean): ManagedResult<StudioProjectJob> {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const job = readProjectJob(db, projectId, workId)
  if (!job) return deny('EXTERNAL_JOB_NOT_FOUND')
  const authorizationVersion = expectedVersion + 1
  if (!isVersion(authorizationVersion)) return deny('INVALID_INPUT')
  const flag = paused ? 1 : 0
  const replay = db.prepare('SELECT * FROM studio_project_job_control WHERE command_id = ?').get(commandId)
  if (replay) {
    return replay.work_id === workId && replay.project_id === projectId && replay.leader_session_id === leaderSessionId
      && replay.management_epoch === managementEpoch && replay.authorization_version === authorizationVersion && replay.paused === flag
      ? accept(job) : deny('DUPLICATE_COMMAND')
  }
  if (commandUsed()) return deny('DUPLICATE_COMMAND')
  if (job.authorizationVersion !== expectedVersion) return deny('STALE_JOB_AUTHORIZATION')
  requireWrite(db.prepare(`UPDATE studio_project_job SET paused = ?, authorization_version = ?
    WHERE work_id = ? AND authorization_version = ?`).run(flag, authorizationVersion, workId, expectedVersion).changes)
  requireWrite(db.prepare(`INSERT INTO studio_project_job_control (command_id, work_id, project_id, leader_session_id,
    management_epoch, authorization_version, paused, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(commandId, workId, projectId, leaderSessionId, managementEpoch, authorizationVersion, flag, new Date().toISOString()).changes)
  if (paused) {
    // Revoke unstarted reservations so a later resume cannot revive an earlier dispatch request.
    db.prepare(`UPDATE studio_project_dispatch SET state = 'released', failure = 'EXTERNAL_JOB_PAUSED'
      WHERE work_id = ? AND state = 'reserved'`).run(workId)
    if (db.prepare("SELECT 1 FROM studio_project_dispatch WHERE work_id = ? AND state = 'reserved'").get(workId)) {
      throw new Error('Cannot release Studio project reservations during job pause')
    }
  }
  // The new authorization version invalidates the projected grant; its audit row remains intact.
  const { automatic: _previousGrant, ...snapshot } = job
  return accept({ ...snapshot, paused, authorizationVersion })
}
