/** Durable references from Studio work to separately authorized document tasks. */
import type { DatabaseSync } from 'node:sqlite'
import { readProjectDocumentDecisions, type ProjectDocumentDecisionHistory } from './project-document-decision-store.js'
import type { StudioProjectBinding, StudioProjectWork } from './project-store.ts'
import type { ManagedResult, ManagedTask } from './store.ts'

/** The attachment origin, current task metadata, and (on detail reads) its committed result. */
export interface StudioProjectDocument {
  task: ManagedTask
  hold?: string
  linkLeaderSessionId: string
  linkManagementEpoch: number
  scopeDecisions?: ProjectDocumentDecisionHistory
  result?: {
    text: string
    workerSessionId: string
    executionEpoch: number
    authorizationVersion: number
    toolCallId: string
    at: string
  }
}

export const PROJECT_DOCUMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_document (
    work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
    task_id TEXT NOT NULL UNIQUE REFERENCES managed_task (task_id),
    project_id TEXT NOT NULL,
    link_leader_session_id TEXT NOT NULL,
    link_management_epoch INTEGER NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    linked_at TEXT NOT NULL,
    anchored_execution_epoch INTEGER NOT NULL,
    anchored_authorization_version INTEGER NOT NULL CHECK (anchored_authorization_version BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (project_id, link_management_epoch, link_leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
    FOREIGN KEY (task_id, anchored_execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS managed_audit_document_commit ON managed_audit (task_id) WHERE kind = 'commit';
`

export interface ProjectDocumentAccess {
  documentTask(taskId: string): ManagedTask | undefined
  documentHold(task: ManagedTask): string | undefined
}

type DocumentWork = Pick<StudioProjectWork, 'workId' | 'projectId'>
type DocumentResult = NonNullable<StudioProjectDocument['result']>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Check for any attachment before allowing a competing job or text dispatch. */
export function projectDocumentAttached(db: DatabaseSync, workId: string): boolean {
  return !!db.prepare('SELECT 1 FROM studio_project_document WHERE work_id = ?').get(workId)
}

export function projectDocumentCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare('SELECT 1 FROM studio_project_document WHERE command_id = ?').get(commandId)
}

/** Attach identity only, under the caller's write fence and after checking current management and work membership. */
export function attachProjectDocument(db: DatabaseSync, access: ProjectDocumentAccess, actor: StudioProjectBinding, workId: string,
  taskId: string, expectedAuthorizationVersion: number, commandId: string, commandUsed: () => boolean): ManagedResult<StudioProjectDocument> {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const work = { projectId, workId }
  const existing = db.prepare('SELECT * FROM studio_project_document WHERE work_id = ?').get(workId)
  // Replay the exact command even when the task has since changed or committed. Never move the attachment.
  if (existing?.command_id === commandId) {
    if (existing.project_id !== projectId || existing.link_leader_session_id !== leaderSessionId
      || existing.link_management_epoch !== managementEpoch || existing.task_id !== taskId
      || existing.anchored_authorization_version !== expectedAuthorizationVersion) return deny('DUPLICATE_COMMAND')
    const document = readProjectDocument(db, access, work, true)
    if (!document) throw new Error('Missing Studio project document for replay')
    return accept(document)
  }
  if (commandUsed()) return deny('DUPLICATE_COMMAND')
  if (existing) return deny('WORK_HAS_DOCUMENT_TASK')
  if (db.prepare("SELECT 1 FROM studio_project_dispatch WHERE work_id = ? AND state <> 'released'").get(workId)) {
    return deny('WORK_ALREADY_DISPATCHED')
  }
  if (db.prepare('SELECT 1 FROM studio_project_job WHERE work_id = ?').get(workId)) return deny('WORK_ALREADY_HAS_EXTERNAL_JOB')
  const task = access.documentTask(taskId)
  if (!task) return deny('TASK_NOT_FOUND')
  if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
  if (task.authorizationVersion !== expectedAuthorizationVersion) return deny('STALE_AUTHORIZATION')
  if (db.prepare('SELECT 1 FROM studio_project_document WHERE task_id = ?').get(taskId)) return deny('DOCUMENT_TASK_ALREADY_LINKED')
  const { changes } = db.prepare(`INSERT INTO studio_project_document (work_id, task_id, project_id, link_leader_session_id,
    link_management_epoch, command_id, linked_at, anchored_execution_epoch, anchored_authorization_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workId, taskId, projectId, leaderSessionId, managementEpoch, commandId,
    new Date().toISOString(), task.executionEpoch, expectedAuthorizationVersion)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project document attachment did not affect exactly one row')
  const hold = access.documentHold(task)
  return accept({ task, ...(hold === undefined ? {} : { hold }), linkLeaderSessionId: leaderSessionId, linkManagementEpoch: managementEpoch })
}

/** Read the scoped attachment and task state; only an authorized full detail may request decision metadata. */
export function readProjectDocument(db: DatabaseSync, access: ProjectDocumentAccess, work: DocumentWork,
  full: boolean, includeOwnerDocumentDecisions = false): StudioProjectDocument | undefined {
  const row = db.prepare(`SELECT task_id, project_id, link_leader_session_id, link_management_epoch,
    anchored_execution_epoch, anchored_authorization_version FROM studio_project_document WHERE work_id = ?`).get(work.workId)
  if (!row) return
  const { task_id: taskId, link_leader_session_id: linkLeaderSessionId, link_management_epoch: linkManagementEpoch,
    anchored_execution_epoch: anchoredEpoch, anchored_authorization_version: anchoredAuthorization } = row
  if (row.project_id !== work.projectId || !isId(taskId) || !isId(linkLeaderSessionId) || !isVersion(linkManagementEpoch)
    || !isVersion(anchoredEpoch) || !isVersion(anchoredAuthorization)) throw new Error('Invalid Studio project document attachment')
  const task = access.documentTask(taskId)
  if (!task || task.executionEpoch < anchoredEpoch || task.authorizationVersion < anchoredAuthorization) {
    throw new Error('Invalid managed task for Studio project document attachment')
  }
  const document: StudioProjectDocument = { task, linkLeaderSessionId, linkManagementEpoch }
  if (task.documentVersion === 2) {
    const result = committedResult(db, task, anchoredEpoch, anchoredAuthorization, full)
    if (result) document.result = result
  } else {
    const hold = access.documentHold(task)
    if (hold !== undefined) document.hold = hold
  }
  if (full && includeOwnerDocumentDecisions === true) {
    document.scopeDecisions = readProjectDocumentDecisions(db, task, anchoredEpoch, anchoredAuthorization)
  }
  return document
}

/** Verify the unique audit against its exact historical binding and the task's own version 2 snapshot. */
function committedResult(db: DatabaseSync, task: ManagedTask, anchoredEpoch: number, anchoredAuthorization: number,
  full: boolean): DocumentResult | undefined {
  // Count all commit audits, including bad ones. A matching row cannot mask an ambiguous second commit.
  const rows = db.prepare(`SELECT a.session_id, a.execution_epoch, a.authorization_version, a.tool_call_id, a.at,
    a.document_version, a.paused, a.command_id, b.session_id AS bound_session_id
    FROM managed_audit a LEFT JOIN managed_session_binding b ON b.task_id = a.task_id AND b.execution_epoch = a.execution_epoch
    WHERE a.task_id = ? AND a.kind = 'commit' LIMIT 2`).all(task.taskId)
  const row = rows[0]
  if (rows.length !== 1 || !row) throw new Error('Missing or ambiguous Studio project document commit')
  const { session_id: workerSessionId, execution_epoch: executionEpoch, authorization_version: authorizationVersion,
    tool_call_id: toolCallId, at } = row
  if (!isId(workerSessionId) || row.bound_session_id !== workerSessionId || !isVersion(executionEpoch)
    || executionEpoch < anchoredEpoch || executionEpoch > task.executionEpoch || !isVersion(authorizationVersion)
    || authorizationVersion < anchoredAuthorization || authorizationVersion > task.authorizationVersion
    || row.document_version !== 2 || row.paused !== 0 || row.command_id !== null || !isId(toolCallId) || !isId(at)) {
    throw new Error('Invalid Studio project document commit origin')
  }

  // A shared result must agree with the exact immutable revision pinned by this task, not the latest head.
  const shared = task.sharedDocument
  const select = `SELECT ${full ? 'd.text' : '1'} FROM managed_document d`
  const snapshot = shared
    ? db.prepare(`${select} JOIN studio_shared_document_revision r ON r.task_id = d.task_id
      WHERE d.task_id = ? AND d.document_version = 2 AND r.document_id = ? AND r.version = ?
        AND r.session_id = ? AND r.tool_call_id = ? AND r.command_id IS NULL AND r.text = d.text COLLATE BINARY`)
      .get(task.taskId, shared.documentId, shared.committedVersion ?? null, workerSessionId, toolCallId)
    : db.prepare(`${select} WHERE d.task_id = ? AND d.document_version = 2`).get(task.taskId)
  if (!snapshot) throw new Error('Missing Studio project document commit snapshot')
  if (!full) return
  if (typeof snapshot.text !== 'string' || !snapshot.text.isWellFormed()) {
    throw new Error('Invalid Studio project document commit text')
  }
  return { text: snapshot.text, workerSessionId, executionEpoch, authorizationVersion, toolCallId, at }
}
