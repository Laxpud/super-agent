/** Current execution authority, single-document authorization, and commit audit records for managed Workers. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'

/** A failure does not confirm a write. Use the reason to block the action or guide the user through a retry. */
export type ManagedResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Durable task state. The execution epoch, authorization version, and document version are checked separately. */
export interface ManagedTask {
  taskId: string
  workerSessionId: string
  executionEpoch: number
  authorizationVersion: number
  paused: boolean
  documentVersion: number
}

/** The host retains the original permit for its associated tool call. A structurally identical copy is invalid. */
export interface ManagedWritePermit {
  readonly taskId: string
  readonly workerSessionId: string
  readonly executionEpoch: number
  readonly authorizationVersion: number
  readonly toolCallId: string
  readonly expectedVersion: 1
  readonly text: string
}

type Rejection = Extract<ManagedResult<never>, { ok: false }>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Rejection => ({ ok: false, reason })

// Each epoch points to a Session binding that cannot be reused. Keep old bindings to distinguish unmanaged Sessions from replaced ones.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS managed_task (
    task_id TEXT PRIMARY KEY,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    approved_text TEXT NOT NULL,
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE IF NOT EXISTS managed_session_binding (
    session_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES managed_task (task_id),
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    UNIQUE (task_id, execution_epoch)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS managed_document (
    task_id TEXT PRIMARY KEY REFERENCES managed_task (task_id),
    document_version INTEGER NOT NULL CHECK (document_version IN (1, 2)),
    text TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS managed_audit (
    seq INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'pause', 'transfer', 'resume', 'commit')),
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    execution_epoch INTEGER NOT NULL,
    authorization_version INTEGER NOT NULL,
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    document_version INTEGER NOT NULL CHECK (document_version IN (1, 2)),
    command_id TEXT UNIQUE,
    tool_call_id TEXT,
    at TEXT NOT NULL,
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    UNIQUE (session_id, tool_call_id),
    CHECK ((kind = 'commit' AND command_id IS NULL AND tool_call_id IS NOT NULL AND document_version = 2)
      OR (kind <> 'commit' AND command_id IS NOT NULL AND tool_call_id IS NULL))
  ) STRICT;
`

/** Key unconfirmed pauses by the resolved database path so reopening the Store in the same process leaves writes blocked. Not shared across hosts. */
interface PendingPause { tasks: Set<string>; sessions: Set<string> }
const pendingPauses = new Map<string, PendingPause>()

const isText = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed()
const isId = (value: unknown): value is string => isText(value) && value.length > 0 && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Restrict file permissions in the trusted host directory before SQLite opens the files. Reject symlinks and other non-regular files. */
function privateFile(path: string, create: boolean): void {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isFile()) throw new Error('Managed Worker database requires regular files')
    // Do not open and close an existing file: on POSIX, closing it may release locks held by SQLite connections in this process.
    if ((existing.mode & 0o7777) !== 0o600) chmodSync(path, 0o600)
  } else if (create) {
    const fd = openSync(path, 'wx', 0o600)
    try { fchmodSync(fd, 0o600) } finally { closeSync(fd) }
  }
}

/** Read only two own data properties. Reject getters and extra fields so callers cannot select another resource or write method. */
function documentAction(action: unknown): { expectedVersion: number; text: string } | undefined {
  if (typeof action !== 'object' || action === null || types.isProxy(action)) return
  const prototype: unknown = Object.getPrototypeOf(action)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(action).length !== 2) return
  const version = Object.getOwnPropertyDescriptor(action, 'expectedVersion')
  const text = Object.getOwnPropertyDescriptor(action, 'text')
  if (version?.enumerable && text?.enumerable && Object.hasOwn(version, 'value') && Object.hasOwn(text, 'value')
    && isVersion(version.value) && isText(text.value)) return { expectedVersion: version.value, text: text.value }
}

/** Do not treat writes ignored by SQLite as successful. This applies to task state, document text, and any audit insert skipped by a trigger. */
function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Managed Worker write did not affect exactly one row')
}

/** Single-host SQLite Store. State and audit records commit together; permits and unconfirmed pauses stay in memory. */
export class ManagedWorkerStore {
  readonly #db: DatabaseSync
  readonly #permits = new WeakMap<ManagedWritePermit, boolean>()
  private readonly path: string
  private closed = false

  /** Open or create the durable database. Throw on initialization failure so the caller cannot enable managed writes. */
  constructor(path: string) {
    if (!isId(path) || path === ':memory:') throw new Error('Managed Worker requires a persistent SQLite path')
    const file = resolve(path)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    privateFile(file, true)
    this.path = realpathSync(file)
    // New WAL and SHM files inherit database permissions. Tighten permissions on existing auxiliary files before reopening the database.
    for (const suffix of ['-wal', '-shm', '-journal']) privateFile(this.path + suffix, false)
    this.#db = new DatabaseSync(this.path)
    try {
      if (this.db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') throw new Error('Cannot enable WAL for Managed Worker')
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      this.transaction(() => { this.db.exec(SCHEMA); return accept(undefined) })
    } catch (error) {
      try { this.close() } catch { /* Preserve the initialization error. */ }
      throw error
    }
  }

  private get db(): DatabaseSync {
    if (this.closed) throw new Error('Managed Worker store is closed')
    return this.#db
  }

  /** Close the SQLite connection without clearing pending pauses. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.#db.close()
  }

  /** Read the durable Session binding. Return undefined only for an unbound Session; throw on storage errors so callers cannot treat the Session as unmanaged. */
  binding(sessionId: string): { taskId: string; executionEpoch: number } | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Managed Worker session ID')
    const row = this.db.prepare('SELECT task_id, execution_epoch FROM managed_session_binding WHERE session_id = ?').get(sessionId)
    if (!row) return
    if (!isId(row.task_id) || !isVersion(row.execution_epoch)) throw new Error('Invalid Managed Worker binding')
    return { taskId: row.task_id, executionEpoch: row.execution_epoch }
  }

  /** Create the version 1 document for the current Session and record the only approved replacement text. */
  create(sessionId: string, initialText: string, approvedText: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isText(initialText) || !isText(approvedText) || !isId(commandId)) return deny('INVALID_INPUT')
    return this.write(() => {
      if (this.binding(sessionId)) return deny('SESSION_ALREADY_BOUND')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const taskId = randomUUID()
      requireWrite(this.db.prepare('INSERT INTO managed_task VALUES (?, 1, 1, 0, ?)').run(taskId, approvedText).changes)
      requireWrite(this.db.prepare('INSERT INTO managed_session_binding VALUES (?, ?, 1)').run(sessionId, taskId).changes)
      requireWrite(this.db.prepare('INSERT INTO managed_document VALUES (?, 1, ?)').run(taskId, initialText).changes)
      const task: ManagedTask = { taskId, workerSessionId: sessionId, executionEpoch: 1, authorizationVersion: 1, paused: false, documentVersion: 1 }
      this.audit('create', task, commandId, null)
      return accept(task)
    })
  }

  /** Block writes to the current task before persisting the pause. A failed state or audit write leaves the block in place and the pause can be retried. */
  pause(sessionId: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isId(commandId)) return deny('INVALID_INPUT')
    let task: ManagedTask | undefined
    try {
      const current = this.currentTask(sessionId)
      if (!current.ok) {
        pendingPauses.get(this.path)?.sessions.delete(sessionId)
        this.clearEmptyPauses()
        return current
      }
      // A committed command is not a new pause. Replaying it cannot block writes again after the task resumes.
      task = current.value
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
    } catch {
      const pending = this.pendingPause()
      if (task) pending.tasks.add(task.taskId)
      else pending.sessions.add(sessionId)
      return deny('PAUSE_UNCONFIRMED')
    }
    // Block writes before acquiring the SQLite write lock. The block remains even if SQLite is busy or the audit insert fails.
    const { taskId, executionEpoch } = task
    const pending = this.pendingPause()
    pending.tasks.add(taskId)
    pending.sessions.delete(sessionId)
    const result = this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok || current.value.taskId !== taskId || current.value.executionEpoch !== executionEpoch) return deny('STALE_EXECUTION')
      requireWrite(this.db.prepare('UPDATE managed_task SET paused = 1, authorization_version = authorization_version + 1 WHERE task_id = ? AND execution_epoch = ?')
        .run(taskId, executionEpoch).changes)
      const paused = { ...current.value, paused: true, authorizationVersion: current.value.authorizationVersion + 1 }
      this.audit('pause', paused, commandId, null)
      return accept(paused)
    })
    if (!result.ok) return deny('PAUSE_UNCONFIRMED')
    // Clear the in-memory block only after COMMIT is confirmed and the durable pause can block writes.
    pending.tasks.delete(taskId)
    this.clearEmptyPauses()
    return result
  }

  /** Transfer to a previously unbound Session only if the expected epoch matches. Preserve the pause and approved text, and invalidate permits from the old epoch. */
  transfer(taskId: string, expectedEpoch: number, nextSessionId: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(taskId) || !isVersion(expectedEpoch) || !isId(nextSessionId) || !isId(commandId)) return deny('INVALID_INPUT')
    return this.write(() => {
      const task = this.task(taskId)
      if (!task) return deny('TASK_NOT_FOUND')
      if (task.executionEpoch !== expectedEpoch) return deny('STALE_EXECUTION')
      if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
      if (this.binding(nextSessionId)) return deny('SESSION_ALREADY_BOUND')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const next = { ...task, workerSessionId: nextSessionId, executionEpoch: expectedEpoch + 1, authorizationVersion: task.authorizationVersion + 1 }
      requireWrite(this.db.prepare('INSERT INTO managed_session_binding VALUES (?, ?, ?)').run(nextSessionId, taskId, next.executionEpoch).changes)
      requireWrite(this.db.prepare('UPDATE managed_task SET execution_epoch = ?, authorization_version = ? WHERE task_id = ? AND execution_epoch = ?')
        .run(next.executionEpoch, next.authorizationVersion, taskId, expectedEpoch).changes)
      this.audit('transfer', next, commandId, null)
      return accept(next)
    })
  }

  /** Resume a durably paused task only when its authorization version matches and no unconfirmed pause remains. */
  resume(sessionId: string, expectedAuthorizationVersion: number, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isVersion(expectedAuthorizationVersion) || !isId(commandId)) return deny('INVALID_INPUT')
    return this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
      if (task.authorizationVersion !== expectedAuthorizationVersion) return deny('STALE_AUTHORIZATION')
      if (!task.paused) return deny('TASK_NOT_PAUSED')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const next = { ...task, paused: false, authorizationVersion: expectedAuthorizationVersion + 1 }
      requireWrite(this.db.prepare(`UPDATE managed_task SET paused = 0, authorization_version = ?
        WHERE task_id = ? AND execution_epoch = ? AND paused = 1 AND authorization_version = ?`)
        .run(next.authorizationVersion, task.taskId, task.executionEpoch, expectedAuthorizationVersion).changes)
      this.audit('resume', next, commandId, null)
      return accept(next)
    })
  }

  /** Issue a permit for the current epoch, exact document version, and approved text without writing the document. */
  authorize(sessionId: string, action: unknown, toolCallId: string): ManagedResult<ManagedWritePermit> {
    if (!isId(sessionId) || !isId(toolCallId)) return deny('INVALID_INPUT')
    try {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      const blocked = this.executionBlocked(task)
      if (blocked) return blocked
      if (this.actionUsed(sessionId, toolCallId)) return deny('DUPLICATE_ACTION')
      const input = documentAction(action)
      if (!input) return deny('INVALID_ACTION')
      if (input.expectedVersion !== 1 || task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      if (!this.textApproved(task.taskId, input.text)) return deny('ACTION_NOT_APPROVED')
      const { taskId, executionEpoch, authorizationVersion } = task
      const permit: ManagedWritePermit = Object.freeze({ taskId, workerSessionId: sessionId, executionEpoch, authorizationVersion,
        toolCallId, expectedVersion: 1, text: input.text })
      this.#permits.set(permit, false)
      return accept(permit)
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** With the write lock held, recheck ownership, the permit, the action, and the document. Commit the one allowed change from version 1 to 2 with its audit record. */
  commit(permit: ManagedWritePermit, action: unknown): ManagedResult<{ documentVersion: number }> {
    const spent = this.#permits.get(permit)
    if (spent === undefined) return deny('INVALID_PERMIT')
    if (spent) return deny('DUPLICATE_ACTION')
    const result = this.write(() => {
      const current = this.currentTask(permit.workerSessionId)
      if (!current.ok || current.value.taskId !== permit.taskId || current.value.executionEpoch !== permit.executionEpoch) return deny('STALE_EXECUTION')
      const task = current.value
      const blocked = this.executionBlocked(task)
      if (blocked) return blocked
      if (task.authorizationVersion !== permit.authorizationVersion) return deny('STALE_AUTHORIZATION')
      if (this.actionUsed(permit.workerSessionId, permit.toolCallId)) return deny('DUPLICATE_ACTION')
      const input = documentAction(action)
      if (!input) return deny('INVALID_ACTION')
      if (input.expectedVersion !== permit.expectedVersion || task.documentVersion !== permit.expectedVersion) return deny('VERSION_CONFLICT')
      if (input.text !== permit.text || !this.textApproved(task.taskId, input.text)) return deny('ACTION_NOT_APPROVED')
      requireWrite(this.db.prepare('UPDATE managed_document SET document_version = 2, text = ? WHERE task_id = ? AND document_version = 1')
        .run(input.text, task.taskId).changes)
      this.audit('commit', { ...task, documentVersion: 2 }, null, permit.toolCallId)
      return accept({ documentVersion: 2 })
    })
    if (result.ok) this.#permits.set(permit, true)
    return result
  }

  /** Acquire the write lock before checking execution authority. Roll back on rejection or error; never report an unconfirmed commit as successful. */
  private transaction<T>(operation: () => ManagedResult<T>): ManagedResult<T> {
    const db = this.db
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec(result.ok ? 'COMMIT' : 'ROLLBACK')
      return result
    } catch (error) {
      try { if (db.isTransaction) db.exec('ROLLBACK') }
      catch { try { this.close() } catch { /* Disable the connection after a rollback failure so writes cannot continue. */ } }
      throw error
    }
  }

  private write<T>(operation: () => ManagedResult<T>): ManagedResult<T> {
    try { return this.transaction(operation) }
    catch { return deny('STORAGE_ERROR') }
  }

  /** Historical bindings are readable but no longer grant execution authority. */
  private currentTask(sessionId: string): ManagedResult<ManagedTask> {
    const binding = this.binding(sessionId)
    if (!binding) return deny('SESSION_NOT_BOUND')
    const task = this.task(binding.taskId)
    if (!task) throw new Error('Missing task or document for Managed Worker binding')
    if (task.workerSessionId !== sessionId || task.executionEpoch !== binding.executionEpoch) return deny('STALE_EXECUTION')
    return accept(task)
  }

  private task(taskId: string): ManagedTask | undefined {
    const row: Record<string, SQLOutputValue> | undefined = this.db.prepare(`SELECT t.execution_epoch, t.authorization_version, t.paused,
      b.session_id, d.document_version FROM managed_task t
      JOIN managed_session_binding b ON b.task_id = t.task_id AND b.execution_epoch = t.execution_epoch
      JOIN managed_document d ON d.task_id = t.task_id WHERE t.task_id = ?`).get(taskId)
    if (!row) return
    const { session_id: workerSessionId, execution_epoch: executionEpoch, authorization_version: authorizationVersion,
      paused, document_version: documentVersion } = row
    if (!isId(workerSessionId) || !isVersion(executionEpoch) || !isVersion(authorizationVersion)
      || (paused !== 0 && paused !== 1) || (documentVersion !== 1 && documentVersion !== 2)) throw new Error('Invalid Managed Worker task state')
    return { taskId, workerSessionId, executionEpoch, authorizationVersion, paused: paused === 1, documentVersion }
  }

  /** Record each committed user command or tool action with the resulting state. Deduplicate commands and tool calls separately. */
  private audit(kind: 'create' | 'pause' | 'transfer' | 'resume' | 'commit', task: ManagedTask, commandId: string | null, toolCallId: string | null): void {
    requireWrite(this.db.prepare(`INSERT INTO managed_audit (kind, task_id, session_id, execution_epoch, authorization_version, paused,
      document_version, command_id, tool_call_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, task.taskId, task.workerSessionId, task.executionEpoch, task.authorizationVersion, task.paused ? 1 : 0,
        task.documentVersion, commandId, toolCallId, new Date().toISOString()).changes)
  }

  private commandUsed(commandId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_audit WHERE command_id = ?').get(commandId)
  }

  private actionUsed(sessionId: string, toolCallId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_audit WHERE session_id = ? AND tool_call_id = ?').get(sessionId, toolCallId)
  }

  /** Use SQLite binary text comparison without trimming whitespace, changing line endings, or normalizing Unicode. */
  private textApproved(taskId: string, text: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_task WHERE task_id = ? AND approved_text = ? COLLATE BINARY').get(taskId, text)
  }

  private pendingPause(): PendingPause {
    let pending = pendingPauses.get(this.path)
    if (!pending) pendingPauses.set(this.path, pending = { tasks: new Set(), sessions: new Set() })
    return pending
  }

  private clearEmptyPauses(): void {
    const pending = pendingPauses.get(this.path)
    if (pending && !pending.tasks.size && !pending.sessions.size) pendingPauses.delete(this.path)
  }

  /** If the initial read fails before the task ID is known, block writes to tasks owned by the Session until the pause can be resolved and persisted. */
  private isFrozen(task: ManagedTask): boolean {
    const pending = pendingPauses.get(this.path)
    return !!pending && (pending.tasks.has(task.taskId) || pending.sessions.has(task.workerSessionId))
  }

  private executionBlocked(task: ManagedTask): Rejection | undefined {
    if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
    if (task.paused) return deny('TASK_PAUSED')
  }
}
