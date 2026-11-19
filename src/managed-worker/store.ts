/** Durable execution authority for managed document Workers, Studio drafts, and Studio projects. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { PROJECT_SCHEMA, ProjectStore } from './project-store.js'

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

/** Maximum request and result length in UTF-16 code units. */
export const DRAFT_TEXT_LIMIT = 32_000

/** Snapshot of the Worker's final text message and its event coordinates. */
export interface StudioDraftResult {
  text: string
  messageId: string
  eventSeq: number
  turn: number
}

export interface StudioDraftTask {
  taskId: string
  assistantBotId: string
  assistantSessionId: string
  sourceMessageId: string
  sourceRequestId: string
  workerBotId: string
  workerSessionId: string
  executionEpoch: number
  state: 'running' | 'completed' | 'failed' | 'interrupted'
  result?: StudioDraftResult
  failure?: string
}

/** Source coordinates describe the GUI request; they are not a permit for any action. */
export interface StudioDraftInput {
  assistantSessionId: string
  sourceMessageId: string
  sourceRequestId: string
  workerSessionId: string
  requestText: string
}

export interface StudioDraftExecution {
  taskId: string
  workerSessionId: string
  executionEpoch: number
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
  CREATE TABLE IF NOT EXISTS managed_host_run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    run_id TEXT NOT NULL,
    clean INTEGER NOT NULL CHECK (clean IN (0, 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS managed_recovery_pause (
    task_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL,
    authorization_version INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (task_id, authorization_version),
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_assistant_bot (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    bot_id TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_assistant_binding (
    session_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES studio_assistant_bot (bot_id),
    UNIQUE (session_id, bot_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_draft_task (
    seq INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE,
    assistant_bot_id TEXT NOT NULL,
    assistant_session_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    worker_bot_id TEXT NOT NULL UNIQUE,
    worker_session_id TEXT NOT NULL UNIQUE,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
    result_text TEXT,
    result_message_id TEXT,
    result_event_seq INTEGER CHECK (result_event_seq BETWEEN 0 AND 9007199254740991),
    result_turn INTEGER CHECK (result_turn BETWEEN 1 AND 9007199254740991),
    failure TEXT,
    FOREIGN KEY (assistant_session_id, assistant_bot_id) REFERENCES studio_assistant_binding (session_id, bot_id),
    UNIQUE (assistant_session_id, source_request_id),
    CHECK (assistant_session_id <> worker_session_id),
    CHECK ((state = 'completed' AND result_text IS NOT NULL AND result_message_id IS NOT NULL
      AND result_event_seq IS NOT NULL AND result_turn IS NOT NULL AND failure IS NULL)
      OR (state <> 'completed' AND result_text IS NULL AND result_message_id IS NULL
        AND result_event_seq IS NULL AND result_turn IS NULL AND (failure IS NULL) = (state = 'running')))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_draft_session_latest ON studio_draft_task (assistant_session_id, seq DESC);
`

const isText = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed()
const isId = (value: unknown): value is string => isText(value) && value.length > 0 && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isDraftText = (value: unknown): value is string => isText(value) && value.length > 0 && value.length <= DRAFT_TEXT_LIMIT
const isEventSeq = (value: unknown): value is number => value === 0 || isVersion(value)

/** Decode the stored snapshot without casting unchecked SQL values into a public task. */
function readDraftRow(row: Record<string, SQLOutputValue>): StudioDraftTask {
  const { task_id: taskId, assistant_bot_id: assistantBotId, assistant_session_id: assistantSessionId,
    source_message_id: sourceMessageId, source_request_id: sourceRequestId, worker_bot_id: workerBotId,
    worker_session_id: workerSessionId, execution_epoch: executionEpoch, state, result_text: text,
    result_message_id: messageId, result_event_seq: eventSeq, result_turn: turn, failure } = row
  if (!isId(taskId) || !isId(assistantBotId) || !isId(assistantSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId)
    || !isId(workerBotId) || !isId(workerSessionId) || !isVersion(executionEpoch)
    || (state !== 'running' && state !== 'completed' && state !== 'failed' && state !== 'interrupted')) {
    throw new Error('Invalid Studio draft task')
  }
  const task: StudioDraftTask = { taskId, assistantBotId, assistantSessionId, sourceMessageId, sourceRequestId,
    workerBotId, workerSessionId, executionEpoch, state }
  if (state === 'completed') {
    if (!isDraftText(text) || !isId(messageId) || !isEventSeq(eventSeq) || !isVersion(turn)) throw new Error('Invalid Studio draft result')
    task.result = { text, messageId, eventSeq, turn }
  } else if (state !== 'running') {
    if (!isDraftText(failure)) throw new Error('Invalid Studio draft failure')
    task.failure = failure
  }
  return task
}

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

/** Single-host SQLite Store. State, recovery fences, and audit records are durable; tool permits belong only to this Store. */
export class ManagedWorkerStore {
  readonly #db: DatabaseSync
  readonly #permits = new WeakMap<ManagedWritePermit, boolean>()
  readonly #runId = randomUUID()
  private readonly frozenTasks = new Set<string>()
  private readonly frozenSessions = new Set<string>()
  private closed = false
  readonly recoveredTasks: number
  /** Internal Studio project facade sharing this Store's connection and run fence. */
  readonly projects: ProjectStore

  /** Open the database under the host directory lock. Do not enable actions until the recovery transaction has committed. */
  constructor(path: string) {
    if (!isId(path) || path === ':memory:') throw new Error('Managed Worker requires a persistent SQLite path')
    const file = resolve(path)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    privateFile(file, true)
    const dbPath = realpathSync(file)
    // New WAL and SHM files inherit database permissions. Tighten permissions on existing auxiliary files before reopening the database.
    for (const suffix of ['-wal', '-shm', '-journal']) privateFile(dbPath + suffix, false)
    this.#db = new DatabaseSync(dbPath)
    try {
      if (this.db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') throw new Error('Cannot enable WAL for Managed Worker')
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      const started = this.transaction(() => {
        this.db.exec(SCHEMA)
        this.db.exec(PROJECT_SCHEMA)
        const previous = this.db.prepare('SELECT clean FROM managed_host_run WHERE singleton = 1').get()
        // A failed pause may have left no task ID in durable storage. A dirty run (or a pre-fence database) cannot carry forward any pending write authorization.
        const recoveredTasks = previous?.clean === 1 ? 0 : this.pauseUnfinishedTasks()
        // A draft can never be resumed by a new host run, even after a clean stop.
        this.db.exec(`UPDATE studio_draft_task SET state = 'interrupted', failure = 'HOST_RESTARTED' WHERE state = 'running'`)
        if (this.db.prepare("SELECT 1 FROM studio_draft_task WHERE state = 'running' LIMIT 1").get()) {
          throw new Error('Cannot interrupt previous Studio drafts')
        }
        requireWrite(this.db.prepare(`INSERT INTO managed_host_run VALUES (1, ?, 0)
          ON CONFLICT (singleton) DO UPDATE SET run_id = excluded.run_id, clean = 0`).run(this.#runId).changes)
        return accept(recoveredTasks)
      })
      if (!started.ok) throw new Error('Cannot establish Managed Worker run')
      this.recoveredTasks = started.value
      this.projects = new ProjectStore({
        db: () => this.db,
        write: operation => this.write(operation),
        ownsRun: () => this.ownsRun(),
        nonProjectSessionBound: sessionId => this.nonProjectSessionBound(sessionId),
      })
    } catch (error) {
      try { this.close() } catch { /* Preserve the initialization error. */ }
      throw error
    }
  }

  /** Audit each system pause separately from user commands. Leave committed documents and already paused tasks unchanged. */
  private pauseUnfinishedTasks(): number {
    const rows = this.db.prepare(`SELECT task_id, execution_epoch, authorization_version FROM managed_task
      JOIN managed_document USING (task_id) WHERE paused = 0 AND document_version = 1`).all()
    const update = this.db.prepare('UPDATE managed_task SET paused = 1, authorization_version = authorization_version + 1 WHERE task_id = ?')
    const audit = this.db.prepare(`INSERT INTO managed_recovery_pause (task_id, execution_epoch, authorization_version, run_id, at)
      VALUES (?, ?, ?, ?, ?)`)
    for (const { task_id: taskId, execution_epoch: epoch, authorization_version: revision } of rows) {
      if (!isId(taskId) || !isVersion(epoch) || !isVersion(revision)) throw new Error('Invalid Managed Worker recovery state')
      requireWrite(update.run(taskId).changes)
      requireWrite(audit.run(taskId, epoch, revision + 1, this.#runId, new Date().toISOString()).changes)
    }
    return rows.length
  }

  private get db(): DatabaseSync {
    if (this.closed) throw new Error('Managed Worker store is closed')
    return this.#db
  }

  /** Mark a normal stop only after admission is disabled and every pause is confirmed. Otherwise leave the committed dirty marker intact. */
  finishRun(): void {
    if (this.closed || this.frozenTasks.size || this.frozenSessions.size) return
    this.transaction(() => {
      if (!this.ownsRun()) return deny('STALE_HOST_RUN')
      requireWrite(this.db.prepare('UPDATE managed_host_run SET clean = 1 WHERE singleton = 1 AND run_id = ?')
        .run(this.#runId).changes)
      return accept(undefined)
    })
  }

  /** Close without attesting that the run was safe to resume. Used on both normal teardown and storage failure. */
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

  /** Give each Assistant Session the same durable Bot identity without changing an existing Session role. */
  bindAssistant(sessionId: string): ManagedResult<string> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    return this.write(() => {
      if (this.binding(sessionId) || this.draftBinding(sessionId) || this.projects.binding(sessionId)) return deny('SESSION_ALREADY_BOUND')
      const existing = this.assistantBinding(sessionId)
      if (existing) return accept(existing)
      const bot = this.db.prepare('SELECT bot_id FROM studio_assistant_bot WHERE singleton = 1').get()
      const botId = bot ? bot.bot_id : randomUUID()
      if (!isId(botId)) throw new Error('Invalid Studio Assistant Bot ID')
      if (!bot) requireWrite(this.db.prepare('INSERT INTO studio_assistant_bot VALUES (1, ?)').run(botId).changes)
      requireWrite(this.db.prepare('INSERT INTO studio_assistant_binding VALUES (?, ?)').run(sessionId, botId).changes)
      return accept(botId)
    })
  }

  /** Read the persisted Assistant role. Invalid input or storage errors are not an unbound result. */
  assistantBinding(sessionId: string): string | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Studio Assistant session ID')
    const row = this.db.prepare('SELECT bot_id FROM studio_assistant_binding WHERE session_id = ?').get(sessionId)
    if (!row) return
    if (!isId(row.bot_id)) throw new Error('Invalid Studio Assistant binding')
    return row.bot_id
  }

  /** Keep classifying a draft Worker after its task ends; a historical execution does not grant document tools. */
  draftBinding(sessionId: string): StudioDraftExecution | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Studio draft Worker session ID')
    const row = this.db.prepare('SELECT task_id, execution_epoch FROM studio_draft_task WHERE worker_session_id = ?').get(sessionId)
    if (!row) return
    const { task_id: taskId, execution_epoch: executionEpoch } = row
    if (!isId(taskId) || !isVersion(executionEpoch)) throw new Error('Invalid Studio draft binding')
    return { taskId, workerSessionId: sessionId, executionEpoch }
  }

  /** Reserve a Worker Session before launching it. Only a new GUI request may create another draft. */
  startDraft(input: StudioDraftInput): ManagedResult<{ task: StudioDraftTask; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { assistantSessionId, sourceMessageId, sourceRequestId, workerSessionId, requestText } = input
    if (!isId(assistantSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId) || !isId(workerSessionId)
      || !isDraftText(requestText)) return deny('INVALID_INPUT')
    return this.write<{ task: StudioDraftTask; created: boolean }>(() => {
      const assistantBotId = this.assistantBinding(assistantSessionId)
      if (!assistantBotId) return deny('SESSION_NOT_BOUND')
      // Check the original request before the proposed Worker so duplicate delivery cannot create another execution.
      const existing = this.db.prepare('SELECT * FROM studio_draft_task WHERE assistant_session_id = ? AND source_request_id = ?')
        .get(assistantSessionId, sourceRequestId)
      if (existing) return accept({ task: readDraftRow(existing), created: false })
      if (this.sessionBound(workerSessionId)) return deny('SESSION_ALREADY_BOUND')
      const taskId = randomUUID()
      const workerBotId = randomUUID()
      requireWrite(this.db.prepare(`INSERT INTO studio_draft_task (task_id, assistant_bot_id, assistant_session_id, source_message_id,
        source_request_id, request_text, worker_bot_id, worker_session_id, execution_epoch, run_id, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'running')`)
        .run(taskId, assistantBotId, assistantSessionId, sourceMessageId, sourceRequestId, requestText, workerBotId, workerSessionId, this.#runId).changes)
      return accept({ task: { taskId, assistantBotId, assistantSessionId, sourceMessageId, sourceRequestId,
        workerBotId, workerSessionId, executionEpoch: 1, state: 'running' }, created: true })
    })
  }

  /** Persist the final message snapshot only for the exact running execution. */
  completeDraft(execution: StudioDraftExecution, result: StudioDraftResult): ManagedResult<StudioDraftTask> {
    if (!result) return deny('INVALID_INPUT')
    const { text, messageId, eventSeq, turn } = result
    if (!isDraftText(text) || !isId(messageId) || !isEventSeq(eventSeq) || !isVersion(turn)) return deny('INVALID_INPUT')
    return this.finishDraft(execution, { text, messageId, eventSeq, turn })
  }

  /** Stop the exact execution without replacing any previously recorded outcome. */
  failDraft(execution: StudioDraftExecution, reason: string): ManagedResult<StudioDraftTask> {
    if (!isDraftText(reason)) return deny('INVALID_INPUT')
    return this.finishDraft(execution, reason)
  }

  private finishDraft(execution: StudioDraftExecution, outcome: StudioDraftResult | string): ManagedResult<StudioDraftTask> {
    if (!execution) return deny('INVALID_INPUT')
    const { taskId, workerSessionId, executionEpoch } = execution
    if (!isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch)) return deny('INVALID_INPUT')
    return this.write(() => {
      const row = this.db.prepare(`SELECT * FROM studio_draft_task
        WHERE task_id = ? AND worker_session_id = ? AND execution_epoch = ? AND run_id = ?`)
        .get(taskId, workerSessionId, executionEpoch, this.#runId)
      if (!row) return deny('STALE_EXECUTION')
      const task = readDraftRow(row)
      if (task.state !== 'running') return deny('TASK_NOT_RUNNING')
      const failed = typeof outcome === 'string'
      const state = failed ? 'failed' : 'completed'
      requireWrite(this.db.prepare(`UPDATE studio_draft_task SET state = ?, result_text = ?, result_message_id = ?,
        result_event_seq = ?, result_turn = ?, failure = ?
        WHERE task_id = ? AND worker_session_id = ? AND execution_epoch = ? AND run_id = ? AND state = 'running'`)
        .run(state, failed ? null : outcome.text, failed ? null : outcome.messageId, failed ? null : outcome.eventSeq,
          failed ? null : outcome.turn, failed ? outcome : null, taskId, workerSessionId, executionEpoch, this.#runId).changes)
      return accept(failed ? { ...task, state: 'failed', failure: outcome } : { ...task, state: 'completed', result: outcome })
    })
  }

  /** An explicit task ID can follow the Assistant Bot across Sessions; the implicit lookup stays in this Session. */
  readDraft(assistantSessionId: string, taskId?: string): ManagedResult<StudioDraftTask> {
    if (!isId(assistantSessionId) || (taskId !== undefined && !isId(taskId))) return deny('INVALID_INPUT')
    try {
      const assistantBotId = this.assistantBinding(assistantSessionId)
      if (!assistantBotId) return deny('SESSION_NOT_BOUND')
      const row = taskId === undefined
        ? this.db.prepare(`SELECT * FROM studio_draft_task WHERE assistant_session_id = ? AND assistant_bot_id = ?
          ORDER BY seq DESC LIMIT 1`).get(assistantSessionId, assistantBotId)
        : this.db.prepare('SELECT * FROM studio_draft_task WHERE task_id = ? AND assistant_bot_id = ?').get(taskId, assistantBotId)
      return row ? accept(readDraftRow(row)) : deny('TASK_NOT_FOUND')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Check the existing roles without calling back into the project facade. */
  private nonProjectSessionBound(sessionId: string): boolean {
    return !!(this.binding(sessionId) || this.assistantBinding(sessionId) || this.draftBinding(sessionId))
  }

  private studioSessionBound(sessionId: string): boolean {
    return !!(this.assistantBinding(sessionId) || this.draftBinding(sessionId) || this.projects.binding(sessionId))
  }

  private sessionBound(sessionId: string): boolean {
    return !!this.binding(sessionId) || this.studioSessionBound(sessionId)
  }

  /** Show the current authorization version without exposing document text or treating an unconfirmed pause as active. */
  status(sessionId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    try {
      if (!this.ownsRun()) return deny('STALE_HOST_RUN')
      const current = this.currentTask(sessionId)
      return current.ok && this.isFrozen(current.value) ? deny('PAUSE_UNCONFIRMED') : current
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Create the version 1 document for the current Session and record the only approved replacement text. */
  create(sessionId: string, initialText: string, approvedText: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isText(initialText) || !isText(approvedText) || !isId(commandId)) return deny('INVALID_INPUT')
    return this.write(() => {
      if (this.sessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
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
      if (!this.ownsRun()) return deny('STALE_HOST_RUN')
      const current = this.currentTask(sessionId)
      if (!current.ok) {
        this.frozenSessions.delete(sessionId)
        return current
      }
      // A committed command is not a new pause. Replaying it cannot block writes again after the task resumes.
      task = current.value
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
    } catch {
      if (task) this.frozenTasks.add(task.taskId)
      else this.frozenSessions.add(sessionId)
      return deny('PAUSE_UNCONFIRMED')
    }
    // Block writes before taking the SQLite write lock. A failed transaction leaves the local block in place and prevents a clean-stop marker.
    const { taskId, executionEpoch } = task
    this.frozenTasks.add(taskId)
    this.frozenSessions.delete(sessionId)
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
    // Clear the local block only after COMMIT is confirmed and the durable pause can block writes.
    this.frozenTasks.delete(taskId)
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
      if (this.sessionBound(nextSessionId)) return deny('SESSION_ALREADY_BOUND')
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
      if (!this.ownsRun()) return deny('STALE_HOST_RUN')
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      // Even if conflicting role bindings exist, Studio Sessions cannot receive document permits.
      if (this.studioSessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
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
      if (this.studioSessionBound(permit.workerSessionId)) return deny('SESSION_ALREADY_BOUND')
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

  /** Serialize writes with run replacement. A host overtaken after its directory lock expires cannot commit a previous run's action. */
  private write<T>(operation: () => ManagedResult<T>): ManagedResult<T> {
    try { return this.transaction(() => this.ownsRun() ? operation() : deny('STALE_HOST_RUN')) }
    catch { return deny('STORAGE_ERROR') }
  }

  private ownsRun(): boolean {
    return !!this.db.prepare('SELECT 1 FROM managed_host_run WHERE singleton = 1 AND run_id = ? AND clean = 0').get(this.#runId)
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

  /** If the initial read fails before the task ID is known, block writes from the Session until the pause can be resolved and persisted. */
  private isFrozen(task: ManagedTask): boolean {
    return this.frozenTasks.has(task.taskId) || this.frozenSessions.has(task.workerSessionId)
  }

  private executionBlocked(task: ManagedTask): Rejection | undefined {
    if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
    if (task.paused) return deny('TASK_PAUSED')
  }
}
