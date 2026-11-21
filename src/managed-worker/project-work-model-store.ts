/** Append-only native selections, withdrawals, and one-time text dispatch provenance. */
import type { DatabaseSync } from 'node:sqlite'
import { types } from 'node:util'
import type { StudioProjectBinding, StudioProjectRun } from './project-store.js'
import type { PinnedTextWorkerModel } from './text-worker-model-policy.js'

/** A Host-pinned tuple for one explicit dispatch, never a default or a Session setting. */
export interface ProjectWorkModelSelection {
  selectionId: string
  route: PinnedTextWorkerModel
}

export interface ProjectWorkModelSelectionView extends ProjectWorkModelSelection {
  state: 'pending' | 'stale' | 'used' | 'cleared'
  executionEpoch?: number
}

/** The Host supplies coordinates from the fresh owner message that named the work and selection. */
export interface ProjectWorkModelDispatch extends ProjectWorkModelSelection {
  sourceMessageId: string
  sourceRequestId: string
}

/** Plain owner dispatch is separate from consent to use a selected model. */
export type ProjectWorkModelDispatchIntent = ProjectWorkModelDispatch | { explicitPlain: true }

interface StoredWorkModel extends ProjectWorkModelSelection {
  projectId: string
  leaderSessionId: string
  managementEpoch: number
  cleared: boolean
  executionEpoch?: number
}

type Actor = Pick<StudioProjectBinding, 'projectId' | 'leaderSessionId' | 'managementEpoch'>
const selectionTable = 'studio_project_work_model'
const clearTable = 'studio_project_work_model_clear'
const consumeTable = 'studio_project_work_model_consume'
const unclearedView = 'studio_project_work_model_uncleared'
// The prospective dispatch columns are either NEW in the SQL guard or d in the runtime recheck.
const exactConsume = (dispatch: string) => `FROM ${unclearedView} m JOIN ${consumeTable} c USING (selection_id, work_id, leader_session_id)
  WHERE c.work_id = ${dispatch}.work_id AND c.execution_epoch = ${dispatch}.execution_epoch
    AND m.project_id = ${dispatch}.project_id AND c.leader_session_id = ${dispatch}.leader_session_id
    AND m.management_epoch = ${dispatch}.management_epoch AND c.run_id = ${dispatch}.run_id`

// A consume row is inserted before the dispatch. The deferred FK forbids spending without the dispatch;
// the dispatch guard forbids inserting the dispatch without the exact spend while a selection is uncleared.
export const PROJECT_WORK_MODEL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${selectionTable} (
    seq INTEGER PRIMARY KEY,
    selection_id TEXT NOT NULL UNIQUE,
    work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 256),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 256),
    reasoning_effort TEXT NOT NULL CHECK (length(reasoning_effort) BETWEEN 1 AND 256),
    command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0),
    bound_at TEXT NOT NULL,
    UNIQUE (selection_id, work_id, leader_session_id),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_work_model_latest ON ${selectionTable} (work_id, seq DESC);
  CREATE TABLE IF NOT EXISTS ${clearTable} (
    selection_id TEXT NOT NULL PRIMARY KEY REFERENCES ${selectionTable} (selection_id),
    leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
    command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0),
    cleared_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ${consumeTable} (
    selection_id TEXT NOT NULL PRIMARY KEY,
    work_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    run_id TEXT NOT NULL CHECK (length(run_id) > 0),
    source_message_id TEXT NOT NULL CHECK (length(source_message_id) > 0),
    source_request_id TEXT NOT NULL CHECK (length(source_request_id) > 0),
    consumed_at TEXT NOT NULL,
    UNIQUE (work_id, execution_epoch),
    UNIQUE (leader_session_id, source_message_id),
    UNIQUE (leader_session_id, source_request_id),
    FOREIGN KEY (selection_id, work_id, leader_session_id)
      REFERENCES ${selectionTable} (selection_id, work_id, leader_session_id),
    FOREIGN KEY (work_id, execution_epoch) REFERENCES studio_project_dispatch (work_id, execution_epoch)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE VIEW IF NOT EXISTS ${unclearedView} AS SELECT m.* FROM ${selectionTable} m
    WHERE NOT EXISTS (SELECT 1 FROM ${clearTable} WHERE selection_id = m.selection_id);
  ${[selectionTable, clearTable, consumeTable].flatMap(table => ['UPDATE', 'DELETE'].map(operation => `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN
      SELECT RAISE(ABORT, 'Studio project work model records are append-only');
    END;`)).join('')}
  CREATE TRIGGER IF NOT EXISTS studio_project_work_model_guard_bind BEFORE INSERT ON ${selectionTable} BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (SELECT 1 FROM ${clearTable} WHERE command_id = NEW.command_id)
      OR EXISTS (SELECT 1 FROM ${selectionTable} WHERE selection_id = NEW.selection_id OR command_id = NEW.command_id OR seq = NEW.seq);
    SELECT RAISE(ABORT, 'WORK_MODEL_SELECTION_ALREADY_BOUND') WHERE EXISTS (
      SELECT 1 FROM ${unclearedView} WHERE work_id = NEW.work_id
    );
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      JOIN studio_project p ON p.project_id = b.project_id
      WHERE w.work_id = NEW.work_id AND p.project_id = NEW.project_id AND p.management_epoch = NEW.management_epoch
    );
    SELECT RAISE(ABORT, 'WORK_ALREADY_DISPATCHED') WHERE EXISTS (
      SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND state <> 'released'
    );
    SELECT RAISE(ABORT, 'WORK_MODEL_TEXT_ONLY') WHERE EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.work_id)
      OR EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_model_guard_clear BEFORE INSERT ON ${clearTable} BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (SELECT 1 FROM ${selectionTable} WHERE command_id = NEW.command_id)
      OR EXISTS (SELECT 1 FROM ${clearTable} WHERE selection_id = NEW.selection_id OR command_id = NEW.command_id);
    SELECT RAISE(ABORT, 'WORK_MODEL_SELECTION_NOT_CURRENT') WHERE NOT EXISTS (
      SELECT 1 FROM ${unclearedView} m JOIN studio_project p USING (project_id)
      JOIN studio_project_binding b ON b.project_id = p.project_id AND b.management_epoch = p.management_epoch
      WHERE m.selection_id = NEW.selection_id AND b.leader_session_id = NEW.leader_session_id
        AND NOT EXISTS (SELECT 1 FROM studio_project_dispatch WHERE work_id = m.work_id AND state <> 'released')
    );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_model_guard_consume BEFORE INSERT ON ${consumeTable} BEGIN
    SELECT RAISE(ABORT, 'WORK_MODEL_SELECTION_NOT_CURRENT') WHERE NOT EXISTS (
      SELECT 1 FROM ${unclearedView} m JOIN studio_project p USING (project_id, management_epoch)
      WHERE m.selection_id = NEW.selection_id AND m.work_id = NEW.work_id AND m.leader_session_id = NEW.leader_session_id
    ) OR NOT EXISTS (SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = NEW.run_id AND clean = 0);
    SELECT RAISE(ABORT, 'WORK_MODEL_SELECTION_USED') WHERE EXISTS (
      SELECT 1 FROM ${consumeTable} WHERE selection_id = NEW.selection_id OR (work_id = NEW.work_id AND execution_epoch = NEW.execution_epoch)
        OR (leader_session_id = NEW.leader_session_id AND (source_message_id = NEW.source_message_id OR source_request_id = NEW.source_request_id))
    ) OR EXISTS (SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND execution_epoch = NEW.execution_epoch);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_model_guard_dispatch BEFORE INSERT ON studio_project_dispatch
    WHEN EXISTS (SELECT 1 FROM ${unclearedView} WHERE work_id = NEW.work_id)
      AND (NEW.state <> 'reserved' OR NOT EXISTS (SELECT 1 ${exactConsume('NEW')})) BEGIN
    SELECT RAISE(ABORT, 'WORK_MODEL_SELECTION_NOT_CURRENT');
  END;
  ${['document', 'job'].flatMap(kind => [['insert', 'INSERT'], ['update', 'UPDATE OF work_id']].map(([name, operation]) => `
    CREATE TRIGGER IF NOT EXISTS studio_project_work_model_guard_${kind}_${name} BEFORE ${operation} ON studio_project_${kind}
      WHEN EXISTS (SELECT 1 FROM ${unclearedView} WHERE work_id = NEW.work_id) BEGIN
      SELECT RAISE(ABORT, 'WORK_MODEL_TEXT_ONLY');
    END;`)).join('')}
`

// Route fields are opaque identifiers, not metadata to interpret or inputs to a global model policy.
const isRouteId = (value: unknown): value is string => typeof value === 'string' && value.length <= 256
  && /^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u.test(value)
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
export const isWorkModelSelectionId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)

function plainRecord(value: unknown): value is object {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function field(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function copyRoute(provider: unknown, model: unknown, reasoningEffort: unknown): PinnedTextWorkerModel | undefined {
  if (isRouteId(provider) && isRouteId(model) && isRouteId(reasoningEffort)) return { provider, model, reasoningEffort }
}

/** Validate and copy only the exact route tuple; do not read inherited properties or invoke accessors. */
export function readPinnedWorkModel(value: unknown): PinnedTextWorkerModel | undefined {
  if (plainRecord(value)) return copyRoute(field(value, 'provider'), field(value, 'model'), field(value, 'reasoningEffort'))
}

/** Copy the Host's dispatch proof before entering the write transaction. */
export function readWorkModelDispatch(value: unknown): ProjectWorkModelDispatchIntent | undefined {
  if (!plainRecord(value)) return
  if (Object.hasOwn(value, 'explicitPlain')) {
    if (field(value, 'explicitPlain') === true && !['selectionId', 'route', 'sourceMessageId', 'sourceRequestId'].some(key => Object.hasOwn(value, key))) {
      return { explicitPlain: true }
    }
    return
  }
  const selectionId = field(value, 'selectionId')
  const route = readPinnedWorkModel(field(value, 'route'))
  const sourceMessageId = field(value, 'sourceMessageId')
  const sourceRequestId = field(value, 'sourceRequestId')
  if (isWorkModelSelectionId(selectionId) && route && isId(sourceMessageId) && isId(sourceRequestId)) {
    return { selectionId, route, sourceMessageId, sourceRequestId }
  }
}

export function sameWorkModel(left: PinnedTextWorkerModel, right: PinnedTextWorkerModel): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Load the latest binding. A clear leaves that record readable, but does not make older selections current again. */
export function latestWorkModel(db: DatabaseSync, workId: string): StoredWorkModel | undefined {
  const row = db.prepare(`SELECT m.*, c.execution_epoch, x.selection_id IS NOT NULL AS cleared FROM ${selectionTable} m
    LEFT JOIN ${consumeTable} c USING (selection_id) LEFT JOIN ${clearTable} x USING (selection_id)
    WHERE m.work_id = ? ORDER BY m.seq DESC LIMIT 1`).get(workId)
  if (!row) return
  const { selection_id: selectionId, project_id: projectId, leader_session_id: leaderSessionId,
    management_epoch: managementEpoch, execution_epoch: executionEpoch, cleared } = row
  const route = copyRoute(row.provider, row.model, row.reasoning_effort)
  if (!isWorkModelSelectionId(selectionId) || !route || !isId(projectId) || !isId(leaderSessionId) || !isEpoch(managementEpoch)
    || (executionEpoch !== null && !isEpoch(executionEpoch)) || (cleared !== 0 && cleared !== 1)) {
    throw new Error('Invalid Studio project work model record')
  }
  return { selectionId, route, projectId, leaderSessionId, managementEpoch, cleared: cleared === 1,
    ...(executionEpoch === null ? {} : { executionEpoch }) }
}

/** A predecessor's pending selection is stale, while a spent selection stays spent across handoff and restart. */
export function workModelState(record: StoredWorkModel, actor: Actor): ProjectWorkModelSelectionView['state'] {
  if (record.cleared) return 'cleared'
  if (record.executionEpoch !== undefined) return 'used'
  return record.projectId === actor.projectId && record.leaderSessionId === actor.leaderSessionId
    && record.managementEpoch === actor.managementEpoch ? 'pending' : 'stale'
}

export function workModelView(record: StoredWorkModel, actor: Actor): ProjectWorkModelSelectionView {
  const { selectionId, route, executionEpoch } = record
  return { selectionId, route, state: workModelState(record, actor), ...(executionEpoch === undefined ? {} : { executionEpoch }) }
}

export function hasUnclearedWorkModel(db: DatabaseSync, workId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${unclearedView} WHERE work_id = ?`).get(workId)
}

export function projectWorkModelCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${selectionTable} WHERE command_id = ? UNION ALL
    SELECT 1 FROM ${clearTable} WHERE command_id = ? LIMIT 1`).get(commandId, commandId)
}

/** A prior registration or spend cannot be presented as a fresh dispatch from the same Leader Session. */
export function workModelSourceUsed(db: DatabaseSync, leaderSessionId: string, proof: ProjectWorkModelDispatch): boolean {
  const { sourceMessageId, sourceRequestId } = proof
  return !!db.prepare(`SELECT 1 FROM ${consumeTable} WHERE leader_session_id = ? AND (source_message_id = ? OR source_request_id = ?)
    UNION ALL SELECT 1 FROM studio_project_work WHERE leader_session_id = ? AND (source_message_id = ? OR source_request_id = ?)
    LIMIT 1`).get(leaderSessionId, sourceMessageId, sourceRequestId, leaderSessionId, sourceMessageId, sourceRequestId)
}

/** Confirm the reservation has the exact persisted spend, not merely a route or a matching execution epoch. */
export function exactConsumedWorkModel(db: DatabaseSync, run: StudioProjectRun, runId: string): string | undefined {
  const row = db.prepare(`SELECT c.selection_id FROM studio_project_dispatch d JOIN ${consumeTable} c USING (work_id, execution_epoch)
    WHERE d.work_id = ? AND d.execution_epoch = ? AND d.run_id = ? AND c.selection_id IN (SELECT c.selection_id ${exactConsume('d')})`)
    .get(run.workId, run.executionEpoch, runId)
  if (!row) return
  if (!isWorkModelSelectionId(row.selection_id)) throw new Error('Invalid Studio project work model consume record')
  return row.selection_id
}

function requireAppend(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project work model append did not affect exactly one row')
}

/** Append a native bind in the caller's run-fenced write transaction. */
export function appendWorkModel(db: DatabaseSync, actor: Actor, workId: string, selection: ProjectWorkModelSelection, commandId: string): void {
  const { provider, model, reasoningEffort } = selection.route
  requireAppend(db.prepare(`INSERT INTO ${selectionTable} (selection_id, work_id, project_id, leader_session_id, management_epoch,
    provider, model, reasoning_effort, command_id, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(selection.selectionId,
    workId, actor.projectId, actor.leaderSessionId, actor.managementEpoch, provider, model, reasoningEffort, commandId,
    new Date().toISOString()).changes)
}

/** Append a withdrawal without deleting the bind, consumption, or either native command ID. */
export function appendWorkModelClear(db: DatabaseSync, actor: Actor, selectionId: string, commandId: string): void {
  requireAppend(db.prepare(`INSERT INTO ${clearTable} (selection_id, leader_session_id, command_id, cleared_at) VALUES (?, ?, ?, ?)`)
    .run(selectionId, actor.leaderSessionId, commandId, new Date().toISOString()).changes)
}

/** Spend the checked selection for one prospective dispatch; the caller must insert that dispatch before commit. */
export function appendWorkModelConsume(db: DatabaseSync, run: StudioProjectRun, runId: string, proof: ProjectWorkModelDispatch): void {
  requireAppend(db.prepare(`INSERT INTO ${consumeTable} (selection_id, work_id, leader_session_id, execution_epoch,
    run_id, source_message_id, source_request_id, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proof.selectionId, run.workId, run.leaderSessionId, run.executionEpoch, runId, proof.sourceMessageId,
      proof.sourceRequestId, new Date().toISOString()).changes)
}
