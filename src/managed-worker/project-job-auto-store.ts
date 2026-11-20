/** Durable, one-use owner grants for continuing pinned jobs, with no Host or model I/O. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import type { StudioProjectJob } from './project-job-store.ts'
import type { StudioProjectBinding } from './project-store.ts'
import type { ManagedResult } from './store.ts'

/** The Host route approved for one automatic reservation. No unspecified fields are persisted. */
export interface StudioJobRoute {
  cwd: string
  model: { provider: string; model: string; reasoningEffort?: string }
  quotaPool?: string
}

/** A recorded grant; an execution epoch means the grant is spent, even after release. */
export interface StudioJobAuto {
  permitId: string
  workId: string
  leaderSessionId: string
  managementEpoch: number
  authorizationVersion: number
  route: StudioJobRoute
  executionEpoch?: number
}

// Retain superseded and spent rows for audit and exact command replay. Dispatch release never unspends a grant.
export const PROJECT_JOB_AUTO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_job_auto (
    permit_id TEXT NOT NULL PRIMARY KEY,
    work_id TEXT NOT NULL REFERENCES studio_project_job (work_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 2 AND 9007199254740991),
    route_json TEXT NOT NULL CHECK (json_valid(route_json)),
    granted_at TEXT NOT NULL,
    consumed_execution_epoch INTEGER,
    consumed_at TEXT,
    UNIQUE (work_id, authorization_version),
    UNIQUE (work_id, consumed_execution_epoch),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
    FOREIGN KEY (work_id, consumed_execution_epoch) REFERENCES studio_project_dispatch (work_id, execution_epoch),
    CHECK ((consumed_execution_epoch IS NULL) = (consumed_at IS NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_job_auto_unspent
    ON studio_project_job_auto (work_id) WHERE consumed_execution_epoch IS NULL;
`

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const hasDispatch = `SELECT 1 FROM studio_project_dispatch d WHERE d.work_id = j.work_id AND d.state <> 'released'`
const activeGrant = `FROM studio_project_job_auto a JOIN studio_project_job j
      ON j.work_id = a.work_id AND j.attached_project_id = a.project_id AND j.authorization_version = a.authorization_version
    JOIN studio_project p ON p.project_id = a.project_id AND p.management_epoch = a.management_epoch`

function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio job auto write did not affect exactly one row')
}

function plainRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

const accessor = Symbol('accessor')
function dataField(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key)
  return property && !Object.hasOwn(property, 'value') ? accessor : property?.value
}

/** Validate and copy only the five route coordinates, in canonical JSON order for SQLite equality. */
export function readJobRoute(value: unknown): StudioJobRoute | undefined {
  if (!plainRecord(value)) return
  const cwd = dataField(value, 'cwd')
  const model = dataField(value, 'model')
  const quotaPool = dataField(value, 'quotaPool')
  if (!isText(cwd) || !plainRecord(model) || (quotaPool !== undefined && !isText(quotaPool))) return
  const provider = dataField(model, 'provider')
  const name = dataField(model, 'model')
  const reasoningEffort = dataField(model, 'reasoningEffort')
  if (!isText(provider) || !isText(name) || (reasoningEffort !== undefined && !isText(reasoningEffort))) return
  return { cwd, model: { provider, model: name, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
    ...(quotaPool === undefined ? {} : { quotaPool }) }
}

/** Compare approved and current Host routes without normalizing paths or model identifiers. */
export function sameJobRoute(a: StudioJobRoute, b: StudioJobRoute): boolean {
  const left = readJobRoute(a)
  const right = readJobRoute(b)
  return !!left && !!right && left.cwd === right.cwd && left.model.provider === right.model.provider
    && left.model.model === right.model.model && left.model.reasoningEffort === right.model.reasoningEffort
    && left.quotaPool === right.quotaPool
}

/** Copy an automatic reservation's exact permit ID and route without invoking caller accessors. */
export function readAutoReservation(value: unknown): { permitId: string; route: StudioJobRoute } | undefined {
  if (!plainRecord(value)) return
  const permitId = dataField(value, 'permitId')
  const route = readJobRoute(dataField(value, 'route'))
  if (isText(permitId) && route) return { permitId, route }
}

function decodeGrant(row: Record<string, SQLOutputValue>): StudioJobAuto {
  const { permit_id: permitId, work_id: workId, leader_session_id: leaderSessionId, management_epoch: managementEpoch,
    authorization_version: authorizationVersion, route_json: routeJson, consumed_execution_epoch: executionEpoch } = row
  const route = typeof routeJson === 'string' ? readJobRoute(JSON.parse(routeJson)) : undefined
  if (!isText(permitId) || !isText(workId) || !isText(leaderSessionId) || !isVersion(managementEpoch)
    || !isVersion(authorizationVersion) || !route || JSON.stringify(route) !== routeJson
    || (executionEpoch !== null && !isVersion(executionEpoch))) throw new Error('Invalid Studio job auto grant')
  return { permitId, workId, leaderSessionId, managementEpoch, authorizationVersion, route,
    ...(executionEpoch === null ? {} : { executionEpoch }) }
}

/** Project a grant only while its management binding and authorization version remain current. */
export function currentJobAuto(db: DatabaseSync, projectId: string, workId: string, authorizationVersion: number): StudioJobAuto | undefined {
  const row = db.prepare(`SELECT a.* ${activeGrant} WHERE a.project_id = ? AND a.work_id = ? AND a.authorization_version = ?`)
    .get(projectId, workId, authorizationVersion)
  return row && decodeGrant(row)
}

/** Check historical permit IDs as well, so no other project command can reuse an old grant ID. */
export function projectJobAutoCommandUsed(db: DatabaseSync, permitId: string): boolean {
  return !!db.prepare('SELECT 1 FROM studio_project_job_auto WHERE permit_id = ?').get(permitId)
}

/** Authorize one future reserve under the caller's checked management and work membership. */
export function armProjectJob(db: DatabaseSync, actor: StudioProjectBinding, job: StudioProjectJob, permitId: string,
  expectedVersion: number, route: StudioJobRoute, commandUsed: () => boolean): ManagedResult<StudioProjectJob> {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const { workId } = job
  const authorizationVersion = expectedVersion + 1
  if (!isVersion(authorizationVersion)) return deny('INVALID_INPUT')
  const routeJson = JSON.stringify(route)
  const prior = db.prepare('SELECT * FROM studio_project_job_auto WHERE permit_id = ?').get(permitId)
  if (prior) {
    // An exact retry returns the current snapshot without restoring a superseded or consumed grant.
    return prior.work_id === workId && prior.project_id === projectId && prior.leader_session_id === leaderSessionId
      && prior.management_epoch === managementEpoch && prior.authorization_version === authorizationVersion && prior.route_json === routeJson
      ? accept(job) : deny('DUPLICATE_COMMAND')
  }
  if (commandUsed()) return deny('DUPLICATE_COMMAND')
  if (job.authorizationVersion !== expectedVersion) return deny('STALE_JOB_AUTHORIZATION')
  if (job.paused) return deny('EXTERNAL_JOB_PAUSED')
  if (job.state === 'failed') return deny('EXTERNAL_JOB_FAILED')
  if (db.prepare(`SELECT 1 FROM studio_project_job j WHERE j.work_id = ? AND EXISTS (${hasDispatch})`).get(workId)) {
    return deny('WORK_ALREADY_DISPATCHED')
  }
  requireWrite(db.prepare(`UPDATE studio_project_job SET authorization_version = ?
    WHERE work_id = ? AND attached_project_id = ? AND authorization_version = ? AND paused = 0 AND state <> 'failed'`)
    .run(authorizationVersion, workId, projectId, expectedVersion).changes)
  requireWrite(db.prepare(`INSERT INTO studio_project_job_auto (permit_id, work_id, project_id, leader_session_id,
    management_epoch, authorization_version, route_json, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(permitId, workId, projectId, leaderSessionId, managementEpoch, authorizationVersion, routeJson, new Date().toISOString()).changes)
  return accept({ ...job, authorizationVersion, automatic: { permitId, workId, leaderSessionId, managementEpoch, authorizationVersion, route } })
}

/** Read one keyset page of unspent grants whose pinned job could be reserved now. */
export function jobAutoPage(db: DatabaseSync, afterWorkId: string): StudioJobAuto[] {
  return db.prepare(`SELECT a.* ${activeGrant}
    WHERE a.work_id > ? AND a.consumed_execution_epoch IS NULL AND j.state = 'completed' AND j.paused = 0
      AND NOT EXISTS (${hasDispatch})
    ORDER BY a.work_id ASC LIMIT 8`).all(afterWorkId).map(decodeGrant)
}

/** Spend the exact active grant against the new reservation; a failed predicate rolls that reservation back. */
export function consumeJobAuto(db: DatabaseSync, grant: StudioJobAuto, projectId: string, executionEpoch: number): void {
  requireWrite(db.prepare(`UPDATE studio_project_job_auto AS target SET consumed_execution_epoch = ?, consumed_at = ?
    WHERE permit_id = ? AND work_id = ? AND project_id = ? AND leader_session_id = ? AND management_epoch = ?
      AND authorization_version = ? AND route_json = ? AND consumed_execution_epoch IS NULL
      AND EXISTS (SELECT 1 ${activeGrant} WHERE a.permit_id = target.permit_id AND j.state = 'completed' AND j.paused = 0)
      AND EXISTS (SELECT 1 FROM studio_project_dispatch d WHERE d.work_id = target.work_id AND d.execution_epoch = ?
        AND d.project_id = target.project_id AND d.leader_session_id = target.leader_session_id
        AND d.management_epoch = target.management_epoch AND d.state = 'reserved')`)
    .run(executionEpoch, new Date().toISOString(), grant.permitId, grant.workId, projectId, grant.leaderSessionId,
      grant.managementEpoch, grant.authorizationVersion, JSON.stringify(grant.route), executionEpoch).changes)
}

/** Identify an automatic reservation even if its grant has since been superseded. */
export function consumedJobAuto(db: DatabaseSync, workId: string, executionEpoch: number): StudioJobAuto | undefined {
  const row = db.prepare(`SELECT * FROM studio_project_job_auto WHERE work_id = ? AND consumed_execution_epoch = ?`)
    .get(workId, executionEpoch)
  return row && decodeGrant(row)
}
