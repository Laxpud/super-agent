/** Durable execution authority for managed document Workers, Studio drafts, and Studio projects. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { FEISHU_DELIVERY_SCHEMA, FeishuDeliveryStore, feishuDeliveryCoordinates } from './feishu-delivery-store.js'
import { FEISHU_DRAFT_SCHEMA, FeishuDraftStore, feishuDraftSource, type StudioFeishuDraftTask } from './feishu-draft-store.js'
import { INSTRUCTION_SCHEMA, InstructionStore, type InstructionDecision, type StudioDocumentInstruction,
  type StudioFeishuInstruction, type StudioInstructionInput } from './instruction-store.js'
import { PROJECT_DOCUMENT_SCHEMA, projectDocumentCommandUsed } from './project-document-store.js'
import { PROJECT_JOB_AUTO_SCHEMA } from './project-job-auto-store.js'
import { PROJECT_JOB_SCHEMA } from './project-job-store.js'
import { PROJECT_SCHEMA, ProjectStore } from './project-store.js'
import { QUOTA_NOTICE_SCHEMA, QuotaNoticeStore, isQuotaNoticeMessageId, type StudioQuotaNotice } from './quota-notice-store.js'
import { QUOTA_SCHEMA, QuotaStore, type StudioQuotaIncident } from './quota-store.js'
import { SHARED_DOCUMENT_SCHEMA, appendSharedRevision, readSharedRevision,
  type SharedDocumentRevision, type SharedDocumentTask } from './shared-document-store.js'

export type { StudioFeishuDraftTask } from './feishu-draft-store.js'
export type { StudioFeishuInstruction } from './instruction-store.js'
export type { StudioQuotaNotice } from './quota-notice-store.js'
export type { StudioQuotaIncident, StudioQuotaReason } from './quota-store.js'
export type { SharedDocumentRevision } from './shared-document-store.js'

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
  sharedDocument?: SharedDocumentTask
}

/** The host retains the original permit for its associated tool call. A structurally identical copy is invalid. */
export interface ManagedWritePermit {
  readonly taskId: string
  readonly workerSessionId: string
  readonly executionEpoch: number
  readonly authorizationVersion: number
  readonly toolCallId: string
  readonly expectedVersion: number
  readonly documentId?: string
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

type InstructionInbox = { task: ManagedTask; pending?: StudioDocumentInstruction; remaining: number; narrowableLines?: number[] }

type FeishuInstructionReceipt = {
  disposition: 'recorded' | 'duplicate' | 'unbound' | 'finished'
  taskId?: string
  late?: boolean
}

type Rejection = Extract<ManagedResult<never>, { ok: false }>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Rejection => ({ ok: false, reason })

/** The task never changes its shared base when another actor advances the document. */
function sharedDocumentConflict(task: ManagedTask): boolean {
  const shared = task.sharedDocument
  return !!shared && shared.headVersion !== shared.baseVersion
}

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

/** Copy the caller's line numbers without invoking accessors or allowing sparse or duplicate entries. */
function readKeptLines(value: unknown): Set<number> | undefined {
  if (types.isProxy(value) || !Array.isArray(value)) return
  const lines = new Set<number>()
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, index)
    if (!entry || !Object.hasOwn(entry, 'value') || !isVersion(entry.value) || lines.has(entry.value)) return
    lines.add(entry.value)
  }
  return lines
}

/** Split content and EOLs losslessly. Only content at even offsets can participate in a narrowing. */
function documentLineChanges(baselineText: string, approvedText: string):
  { baseline: string[]; approved: string[]; changedLines: number[] } | undefined {
  const eol = /(\r\n|\r|\n)/
  const baseline = baselineText.split(eol)
  const approved = approvedText.split(eol)
  if (baseline.length !== approved.length) return
  const changedLines: number[] = []
  for (let offset = 0; offset < baseline.length; offset++) {
    if (baseline[offset] === approved[offset]) continue
    if (offset % 2 !== 0) return
    changedLines.push(offset / 2 + 1)
  }
  // Fewer than two changes cannot yield a strict, nonempty subset.
  if (changedLines.length < 2) return
  return { baseline, approved, changedLines }
}

/** A Feishu source without a confirmed non-late ordering cannot narrow the document. */
function instructionOrderKnown(instruction: StudioDocumentInstruction): boolean {
  return instruction.source.channel !== 'feishu' || instruction.feishu?.late === false
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
  private readonly feishuDrafts = new FeishuDraftStore(() => this.db, this.#runId, isDraftText)
  private readonly feishuDeliveries = new FeishuDeliveryStore(() => this.db, this.#runId)
  // Only fresh draft claims grant a synchronous start attempt. Unused grants expire, but the SQLite claims remain.
  private readonly pendingFeishuDraftClaims = new Map<string, number>()
  private readonly instructions = new InstructionStore(() => this.db)
  private readonly quota: QuotaStore
  private readonly quotaNotices = new QuotaNoticeStore(() => this.db, this.#runId)
  // The failed capture may not identify a task. Keep this document-wide fence until a new run recovers the dirty marker.
  private captureFault = false
  private closed = false
  readonly recoveredTasks: number
  /** Internal Studio project facade sharing this Store's connection and run fence. */
  readonly projects: ProjectStore

  /** Open the database under the host directory lock. Do not enable actions until the recovery transaction has committed. */
  constructor(path: string, quotaPoolIds: readonly string[] = [], private readonly quotaNoticeScope?: string,
    private readonly feishuCombinedScope?: string) {
    if (!isId(path) || path === ':memory:') throw new Error('Managed Worker requires a persistent SQLite path')
    if (quotaNoticeScope !== undefined && !isId(quotaNoticeScope)) throw new Error('Invalid Studio quota notice scope')
    if (feishuCombinedScope !== undefined && !isId(feishuCombinedScope)) throw new Error('Invalid Studio Feishu combined scope')
    this.quota = new QuotaStore(quotaPoolIds, () => this.db, operation => this.write(operation), operation => this.snapshot(operation))
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
        this.db.exec(PROJECT_DOCUMENT_SCHEMA)
        this.db.exec(PROJECT_JOB_SCHEMA)
        this.db.exec(PROJECT_JOB_AUTO_SCHEMA)
        this.db.exec(INSTRUCTION_SCHEMA)
        this.db.exec(FEISHU_DRAFT_SCHEMA)
        this.db.exec(FEISHU_DELIVERY_SCHEMA)
        this.db.exec(SHARED_DOCUMENT_SCHEMA)
        this.db.exec(QUOTA_SCHEMA)
        this.db.exec(QUOTA_NOTICE_SCHEMA)
        this.quotaNotices.recoverSending()
        const previous = this.db.prepare('SELECT clean FROM managed_host_run WHERE singleton = 1').get()
        // Unlike document recovery, a previously unrecorded Host run is not evidence of an unconfirmed quota stop.
        this.quota.start(previous !== undefined && previous.clean !== 1)
        // A failed pause may have left no task ID in durable storage. A dirty run (or a pre-fence database) cannot carry forward any pending write authorization.
        const recoveredTasks = previous?.clean === 1 ? 0 : this.pauseUnfinishedTasks()
        // A draft can never be resumed by a new host run, even after a clean stop.
        this.db.exec(`UPDATE studio_draft_task SET state = 'interrupted', failure = 'HOST_RESTARTED' WHERE state = 'running'`)
        if (this.db.prepare("SELECT 1 FROM studio_draft_task WHERE state = 'running' LIMIT 1").get()) {
          throw new Error('Cannot interrupt previous Studio drafts')
        }
        this.feishuDrafts.interruptRunning()
        // A restart frees only reservations that never entered the model. Running attempts remain terminal.
        // Releasing a reservation never unspends its automatic grant; grants not yet tried survive the restart.
        this.db.exec(`UPDATE studio_project_dispatch SET
          state = CASE state WHEN 'reserved' THEN 'released' ELSE 'interrupted' END,
          failure = 'HOST_RESTARTED' WHERE state IN ('reserved', 'running')`)
        if (this.db.prepare("SELECT 1 FROM studio_project_dispatch WHERE state IN ('reserved', 'running') LIMIT 1").get()) {
          throw new Error('Cannot recover previous Studio project dispatches')
        }
        // Native confirmation prompts belong to the previous run. Retain their evidence but do not recover consent.
        this.db.prepare(`UPDATE studio_project_proposal SET state = 'closed', decided_at = ? WHERE state = 'pending'`)
          .run(new Date().toISOString())
        if (this.db.prepare("SELECT 1 FROM studio_project_proposal WHERE state = 'pending' LIMIT 1").get()) {
          throw new Error('Cannot close previous Studio project proposals')
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
        snapshot: operation => this.snapshot(operation),
        ownsRun: () => this.ownsRun(),
        runId: this.#runId,
        assistantBinding: sessionId => this.assistantBinding(sessionId),
        nonProjectSessionBound: sessionId => this.nonProjectSessionBound(sessionId),
        documentTask: taskId => this.task(taskId),
        documentHold: task => this.projectDocumentHold(task),
        documentCommandUsed: commandId => this.commandUsed(commandId),
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

  /** Mark a normal stop only after admission is disabled and all pause, capture, and quota fences are confirmed. */
  finishRun(): void {
    if (this.closed || this.captureFault || this.frozenTasks.size || this.frozenSessions.size) return
    this.transaction(() => {
      if (!this.ownsRun()) return deny('STALE_HOST_RUN')
      if (!this.quota.canFinishRun()) return deny('QUOTA_UNCONFIRMED')
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

  /** Read only the active hold for a Host-configured pool. Treat a failure as unavailable, not as a clear pool. */
  quotaStatus(poolId: string): ManagedResult<StudioQuotaIncident | undefined> {
    return this.quota.status(poolId)
  }

  /** Stop a Host-configured pool, preserving the first observed incident until explicit restoration. */
  tripQuota(poolId: string, provider: string, model: string, sessionId?: string):
    ManagedResult<{ incident: StudioQuotaIncident; created: boolean }> {
    return this.quota.trip(poolId, provider, model, sessionId)
  }

  /** Persist the Host-authenticated owner's confirmation for exactly this active incident. This does not resume any task. */
  restoreQuota(poolId: string, incidentId: string, sessionId: string, commandId: string, evidence: string): ManagedResult<StudioQuotaIncident> {
    return this.quota.restore(poolId, incidentId, sessionId, commandId, evidence)
  }

  /** Allow a send only after committing the sole attempt for this exact active, confirmed quota incident. */
  claimQuotaNotice(poolId: string, incidentId: string, scope: string): ManagedResult<{ claimed: boolean }> {
    if (!isId(incidentId) || !isId(scope)) return deny('INVALID_INPUT')
    if (this.quotaNoticeScope !== scope) return deny('QUOTA_NOTICE_SCOPE_NOT_CONFIGURED')
    // Read the quota store's memory and SQLite fences before opening the notice write transaction.
    const current = this.quotaStatus(poolId)
    if (!current.ok) return current
    if (current.value?.incidentId !== incidentId || current.value.reason !== 'ACCOUNT_QUOTA') return deny('STALE_QUOTA_INCIDENT')
    return this.write(() => this.quotaNotices.claim(poolId, incidentId, scope))
  }

  /** Keep the confirmed receipt, or record an unknown outcome without authorizing another attempt. */
  settleQuotaNotice(incidentId: string, scope: string, messageId?: string): ManagedResult<StudioQuotaNotice> {
    if (!isId(incidentId) || !isId(scope) || (messageId !== undefined && !isQuotaNoticeMessageId(messageId))) return deny('INVALID_INPUT')
    if (this.quotaNoticeScope !== scope) return deny('QUOTA_NOTICE_SCOPE_NOT_CONFIGURED')
    return this.write(() => this.quotaNotices.settle(incidentId, scope, messageId))
  }

  /** Read retained notice state in this profile without exposing the destination or limiting visibility to the current scope. */
  quotaNoticeStatus(incidentId: string): ManagedResult<StudioQuotaNotice | undefined> {
    if (!isId(incidentId)) return deny('INVALID_INPUT')
    return this.snapshot(() => accept(this.quotaNotices.status(incidentId)))
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
      if (this.binding(sessionId) || this.draftBinding(sessionId) || this.feishuDraftBinding(sessionId) || this.projects.binding(sessionId)
        || this.projects.workerBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
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

  /** Claim a combined-scope text route before parsing or checking quota. A duplicate never grants another attempt. */
  claimFeishuTextDelivery(source: StudioFeishuInstruction, route: 'draft' | 'result'): ManagedResult<{ claimed: boolean }> {
    const result = this.write<ReturnType<typeof feishuDeliveryCoordinates>>(() => {
      const delivery = feishuDeliveryCoordinates(source)
      if (!delivery || (route !== 'draft' && route !== 'result')) return deny('INVALID_INPUT')
      const { sourceScope, requestId } = delivery
      if (sourceScope !== this.feishuCombinedScope) return deny('FEISHU_COMBINED_SCOPE_REQUIRED')
      if (this.feishuDeliverySeen(sourceScope, requestId)) return accept(undefined)
      this.feishuDeliveries.insert(delivery, route)
      return accept(delivery)
    })
    if (!result.ok) return result
    if (result.value && route === 'draft') {
      // Grant a start only after the claim commits, and only to the synchronous dispatch that won it.
      const { requestId, sourceTimeMs } = result.value
      this.pendingFeishuDraftClaims.set(requestId, sourceTimeMs)
      queueMicrotask(() => { this.pendingFeishuDraftClaims.delete(requestId) })
    }
    return accept({ claimed: result.value !== undefined })
  }

  /** Reserve one execution for an authenticated Feishu text delivery before launching a Worker. */
  startFeishuDraft(input: StudioFeishuInstruction, requestText: string, workerSessionId: string):
    ManagedResult<{ task: StudioFeishuDraftTask; created: boolean }> {
    const delivery = input?.sourceScope === this.feishuCombinedScope ? feishuDeliveryCoordinates(input) : undefined
    // Consume the opportunity before checking the body, busy state, or Worker binding; a refusal must not be retryable.
    const freshClaim = !!delivery && this.pendingFeishuDraftClaims.get(delivery.requestId) === delivery.sourceTimeMs
    if (freshClaim) this.pendingFeishuDraftClaims.delete(delivery.requestId)
    const source = feishuDraftSource(input, isDraftText)
    if (!source) return deny('INVALID_INPUT')
    return this.write<{ task: StudioFeishuDraftTask; created: boolean }>(() => {
      const scope = source.sourceScope
      // A redelivery can return its original task without starting anything, even after a routing change.
      const existing = this.feishuDrafts.duplicate(scope, source.requestId)
      if (existing) return accept({ task: existing, created: false })
      const combined = scope === this.feishuCombinedScope
      if (combined) {
        if (!freshClaim || delivery.requestId !== source.requestId || delivery.sourceTimeMs !== source.sourceTimeMs
          || !this.feishuDeliveries.currentDraft(source)) return deny('FEISHU_DELIVERY_ALREADY_ROUTED')
        if (this.instructions.feishuLate(scope, source.sourceTimeMs) || this.feishuDeliveries.actionLate(scope, source.sourceTimeMs)) {
          return deny('FEISHU_MESSAGE_LATE')
        }
      } else {
        // A first route chosen in combined mode still owns the ID after reverting to a legacy configuration.
        if (this.feishuDeliveries.has(scope, source.requestId)) return deny('FEISHU_DELIVERY_ALREADY_ROUTED')
        if (this.instructions.feishuTask(scope) !== undefined) return deny('FEISHU_DOCUMENT_BOUND')
      }
      if (this.feishuDrafts.late(scope, source.sourceTimeMs)) return deny('FEISHU_MESSAGE_LATE')
      if (this.feishuDrafts.busy(scope)) return deny('FEISHU_TEXT_BUSY')
      if (!isId(workerSessionId) || !isDraftText(requestText) || requestText.includes('\0')) return deny('INVALID_INPUT')
      if (this.sessionBound(workerSessionId)) return deny('SESSION_ALREADY_BOUND')
      const task = this.feishuDrafts.insert(randomUUID(), randomUUID(), workerSessionId, source, requestText)
      return accept({ task, created: true })
    })
  }

  /** The Host authorizes the caller; Feishu replies must pass the exact scope, and Web must supply an exact task ID. */
  readFeishuDraft(taskId: string, scope?: string): ManagedResult<StudioFeishuDraftTask> {
    if (!isId(taskId) || (scope !== undefined && !isId(scope))) return deny('INVALID_INPUT')
    return this.snapshot(() => {
      const task = this.feishuDrafts.read(taskId, scope)
      return task ? accept(task) : deny('TASK_NOT_FOUND')
    })
  }

  /** Retain the verified final message, or a failure when there is no result, only for the exact running origin. */
  settleFeishuDraft(execution: StudioDraftExecution, result: StudioDraftResult | undefined, failure: string): ManagedResult<StudioFeishuDraftTask> {
    if (!execution) return deny('INVALID_INPUT')
    const { taskId, workerSessionId, executionEpoch } = execution
    if (!isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch)) return deny('INVALID_INPUT')
    let outcome: StudioDraftResult | undefined
    if (result === undefined) {
      if (!isDraftText(failure) || failure.includes('\0')) return deny('INVALID_INPUT')
    } else {
      if (!result) return deny('INVALID_INPUT')
      const { text, messageId, eventSeq, turn } = result
      if (!isDraftText(text) || text.includes('\0') || !isId(messageId) || !isEventSeq(eventSeq) || !isVersion(turn)) return deny('INVALID_INPUT')
      outcome = { text, messageId, eventSeq, turn }
    }
    return this.write(() => {
      const task = this.feishuDrafts.execution({ taskId, workerSessionId, executionEpoch })
      if (!task) return deny('STALE_EXECUTION')
      if (task.state !== 'running') return deny('TASK_NOT_RUNNING')
      return accept(this.feishuDrafts.settle(task, outcome, failure))
    })
  }

  /** Recheck the run and reservation before creating the Session and again before sending its request. */
  feishuDraftCurrent(execution: StudioDraftExecution): boolean {
    if (!execution) return false
    const { taskId, workerSessionId, executionEpoch } = execution
    if (!isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch)) return false
    const result = this.snapshot(() => accept(this.feishuDrafts.current({ taskId, workerSessionId, executionEpoch })))
    return result.ok && result.value
  }

  /** A Feishu Worker Session keeps its own role, including past runs and terminal tasks. */
  feishuDraftBinding(sessionId: string): StudioDraftExecution | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Studio Feishu draft Worker session ID')
    return this.feishuDrafts.binding(sessionId)
  }

  /** Only the configured combined scope may route text when bound to a document; the Host must own this run. */
  feishuDraftScopeAvailable(scope: string): boolean {
    if (!isId(scope)) return false
    const result = this.snapshot(() => accept(scope === this.feishuCombinedScope || this.instructions.feishuTask(scope) === undefined))
    return result.ok && result.value
  }

  /** Check roles other than project Leader; the permanent project Worker lookup does not call back into the Store. */
  private nonProjectSessionBound(sessionId: string): boolean {
    return !!(this.binding(sessionId) || this.assistantBinding(sessionId) || this.draftBinding(sessionId)
      || this.feishuDraftBinding(sessionId) || this.projects.workerBound(sessionId))
  }

  private studioSessionBound(sessionId: string): boolean {
    return !!(this.assistantBinding(sessionId) || this.draftBinding(sessionId) || this.feishuDraftBinding(sessionId)
      || this.projects.binding(sessionId) || this.projects.workerBound(sessionId))
  }

  private sessionBound(sessionId: string): boolean {
    return !!this.binding(sessionId) || this.studioSessionBound(sessionId)
  }

  /** Capture a GUI delivery only for the current writable document binding. A failed capture cannot be cleared in this run. */
  receiveGuiInstruction(sessionId: string, input: StudioInstructionInput): ManagedResult<{ recorded: boolean }> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    try {
      const { channel, sourceScope } = input ?? {}
      if (channel !== 'gui' || sourceScope !== sessionId) return deny('INVALID_INPUT')
      const { requestId, messageId, eventSeq, sourceTimeMs, text } = input
      const source: StudioInstructionInput = { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs, text }
      return this.captureInstruction<{ recorded: boolean }>(() => {
        const current = this.currentTask(sessionId)
        if (!current.ok || current.value.documentVersion !== 1) return accept({ recorded: false })
        const task = current.value
        if (!this.instructions.record(task.taskId, task.executionEpoch, source)) return accept({ recorded: false })
        this.invalidatePriorPermits(task)
        return accept({ recorded: true })
      })
    } catch {
      // Source fields could not be read safely, even before opening the transaction.
      return this.unconfirmedCapture()
    }
  }

  /** Link this current version 1 document to one host-validated scope, without changing its authorization. */
  linkFeishuDocument(sessionId: string, sourceScope: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isId(sourceScope) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      // Outside the exact configured combined scope, a past text task still bars a document binding.
      if (sourceScope !== this.feishuCombinedScope && this.feishuDrafts.scopeBound(sourceScope)) return deny('FEISHU_TEXT_BOUND')
      const boundTask = this.instructions.feishuTask(sourceScope)
      // The first binding remains the audit record, even if the current session has since changed.
      if (boundTask === task.taskId) return current
      if (boundTask !== undefined) return deny('FEISHU_SCOPE_ALREADY_BOUND')
      if (this.instructions.hasFeishuScope(task.taskId)) return deny('TASK_ALREADY_BOUND')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      this.instructions.linkFeishu(task.taskId, sessionId, sourceScope, commandId)
      return current
    })
  }

  /** Check both legacy ledgers as well as the route table without rewriting historic records. */
  private feishuDeliverySeen(scope: string, requestId: string): boolean {
    return this.feishuDeliveries.has(scope, requestId) || this.instructions.feishuDuplicate(scope, requestId)
      || this.feishuDrafts.duplicate(scope, requestId) !== undefined
  }

  /** Capture an authenticated Feishu delivery at the fixed target's current epoch, including while paused. */
  receiveFeishuInstruction(input: StudioFeishuInstruction): ManagedResult<FeishuInstructionReceipt> {
    return this.captureInstruction<FeishuInstructionReceipt>(() => {
      const { channel, sourceScope } = input
      if (channel !== 'feishu' || !isId(sourceScope)) throw new Error('Invalid Studio Feishu scope')
      const { requestId, messageId, eventSeq, sourceTimeMs } = input
      const coordinates = { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs }
      const combined = sourceScope === this.feishuCombinedScope
      const delivery = combined ? feishuDeliveryCoordinates(coordinates) : undefined
      if (combined && !delivery) throw new Error('Invalid Studio Feishu source coordinates')
      const taskId = this.instructions.feishuTask(sourceScope)
      if (isId(requestId) && messageId === requestId && eventSeq === null && this.feishuDeliverySeen(sourceScope, requestId)) {
        return accept({ disposition: 'duplicate', ...(taskId === undefined ? {} : { taskId }) })
      }
      // Fix the document route even with no writable target. On a capture failure, the claim rolls back with the other writes.
      if (delivery) this.feishuDeliveries.insert(delivery, 'document')
      if (taskId === undefined) return accept({ disposition: 'unbound' })
      const task = this.task(taskId)
      if (!task) throw new Error('Missing task or document for Studio Feishu binding')
      if (task.documentVersion !== 1) return accept({ disposition: 'finished', taskId })
      const { text, senderId, parentId, rootId, threadId } = input
      const recorded = this.instructions.recordFeishu(taskId, task.executionEpoch,
        { ...coordinates, text, senderId, parentId, rootId, threadId })
      if (!recorded) return accept({ disposition: 'duplicate', taskId })
      this.invalidatePriorPermits(task)
      return accept({ disposition: 'recorded', taskId, late: recorded.late })
    })
  }

  /** Use the document write fence for every capture; any unconfirmed outcome keeps this run blocked. */
  private captureInstruction<T>(operation: () => ManagedResult<T>): ManagedResult<T> {
    const result = this.write(operation)
    return result.ok ? result : this.unconfirmedCapture()
  }

  private unconfirmedCapture(): Rejection {
    this.captureFault = true
    return deny('INSTRUCTION_UNCONFIRMED')
  }

  /** In the capture transaction, invalidate old permits without clearing a pause or changing approved text. */
  private invalidatePriorPermits(task: ManagedTask): void {
    requireWrite(this.db.prepare(`UPDATE managed_task SET authorization_version = authorization_version + 1
      WHERE task_id = ? AND execution_epoch = ? AND authorization_version = ?`)
      .run(task.taskId, task.executionEpoch, task.authorizationVersion).changes)
  }

  /** Read the oldest pending item and any eligible line numbers from the same authorization snapshot. */
  instructionInbox(sessionId: string): ManagedResult<InstructionInbox> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    return this.snapshot<InstructionInbox>(() => {
      if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
      const { pending, observedEpoch, remaining } = this.instructions.inbox(task.taskId)
      if (!pending) return accept({ task, remaining })
      if (task.documentVersion === 1 && !sharedDocumentConflict(task)
        && observedEpoch === task.executionEpoch && instructionOrderKnown(pending)) {
        const { baselineText, approvedText } = this.documentTargets(task.taskId)
        const changes = documentLineChanges(baselineText, approvedText)
        if (changes) return accept({ task, pending, remaining, narrowableLines: changes.changedLines })
      }
      return accept({ task, pending, remaining })
    })
  }

  /** Review one source by retaining only a strict, nonempty subset of the current approved content changes. */
  narrowInstruction(sessionId: string, instructionId: string, expectedEpoch: number, expectedAuthorizationVersion: number,
    expectedDocumentVersion: number, keepLines: readonly number[], commandId: string):
    ManagedResult<{ task: ManagedTask; remaining: number; keptLines: number[] }> {
    if (!isId(sessionId) || !isId(instructionId) || !isVersion(expectedEpoch) || !isVersion(expectedAuthorizationVersion)
      || !isVersion(expectedDocumentVersion) || !isId(commandId)) return deny('INVALID_INPUT')
    const requested = readKeptLines(keepLines)
    if (!requested) return deny('INVALID_INPUT')
    return this.write(() => {
      if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
      if (task.executionEpoch !== expectedEpoch) return deny('STALE_EXECUTION')
      if (task.documentVersion !== 1 || expectedDocumentVersion !== 1) return deny('VERSION_CONFLICT')
      if (sharedDocumentConflict(task)) return deny('SHARED_DOCUMENT_CONFLICT')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      if (task.authorizationVersion !== expectedAuthorizationVersion) return deny('STALE_AUTHORIZATION')
      const { pending, observedEpoch, remaining } = this.instructions.inbox(task.taskId)
      if (pending?.instructionId !== instructionId) return deny('INSTRUCTION_NOT_PENDING')
      if (observedEpoch !== expectedEpoch) return deny('STALE_EXECUTION')
      if (!instructionOrderKnown(pending)) return deny('INSTRUCTION_ORDER_UNCLEAR')

      // Derive the exact text under the write lock; unselected content and every EOL come from the version 1 baseline.
      const { baselineText, approvedText } = this.documentTargets(task.taskId)
      const changes = documentLineChanges(baselineText, approvedText)
      if (!changes) return deny('INSTRUCTION_NOT_NARROWABLE')
      const keptLines = changes.changedLines.filter(line => requested.has(line))
      if (keptLines.length === 0 || keptLines.length !== requested.size || keptLines.length === changes.changedLines.length) {
        return deny('INVALID_KEEP_LINES')
      }
      const { baseline, approved } = changes
      for (const line of keptLines) {
        const offset = (line - 1) * 2
        baseline[offset] = approved[offset]!
      }
      const revisedText = baseline.join('')
      const authorizationVersion = expectedAuthorizationVersion + 1

      // Advance authorization and close the effective pending item together, without changing the pause or document version.
      requireWrite(this.db.prepare(`UPDATE managed_task SET approved_text = ?, authorization_version = ?
        WHERE task_id = ? AND execution_epoch = ? AND authorization_version = ?`)
        .run(revisedText, authorizationVersion, task.taskId, expectedEpoch, expectedAuthorizationVersion).changes)
      this.instructions.recordNarrowing({ instructionId, taskId: task.taskId, executionEpoch: expectedEpoch,
        previousAuthorizationVersion: expectedAuthorizationVersion, nextAuthorizationVersion: authorizationVersion, keptLines,
        reviewSessionId: sessionId, commandId, previousText: approvedText, nextText: revisedText })
      return accept({ task: { ...task, authorizationVersion }, remaining: remaining - 1, keptLines })
    })
  }

  /** Read the exact current target for Host dispatch to this Worker; do not issue a permit or change the task. */
  documentContinuation(sessionId: string, expectedAuthorizationVersion: number): ManagedResult<{ task: ManagedTask; text: string }> {
    if (!isId(sessionId) || !isVersion(expectedAuthorizationVersion)) return deny('INVALID_INPUT')
    return this.snapshot(() => {
      if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (this.studioSessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
      if (task.documentVersion === 1 && sharedDocumentConflict(task)) return deny('SHARED_DOCUMENT_CONFLICT')
      const blocked = this.executionBlocked(task)
      if (blocked) return blocked
      if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      if (task.authorizationVersion !== expectedAuthorizationVersion) return deny('STALE_AUTHORIZATION')
      return accept({ task, text: this.documentTargets(task.taskId).approvedText })
    })
  }

  /** Review exactly the oldest pending item without changing the approved text or lifting any prior pause. */
  reviewInstruction(sessionId: string, instructionId: string, expectedAuthorizationVersion: number,
    decision: InstructionDecision, commandId: string): ManagedResult<{ task: ManagedTask; remaining: number }> {
    if (!isId(sessionId) || !isId(instructionId) || !isVersion(expectedAuthorizationVersion) || !isId(commandId)
      || (decision !== 'unchanged' && decision !== 'pause')) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
      if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      if (task.authorizationVersion !== expectedAuthorizationVersion) return deny('STALE_AUTHORIZATION')
      const { pending, remaining } = this.instructions.inbox(task.taskId)
      if (pending?.instructionId !== instructionId) return deny('INSTRUCTION_NOT_PENDING')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const next = { ...task, paused: task.paused || decision === 'pause', authorizationVersion: expectedAuthorizationVersion + 1 }
      // Updating both rows under the write lock binds the disposition to this authorization version and epoch.
      requireWrite(this.db.prepare(`UPDATE managed_task SET paused = ?, authorization_version = ?
        WHERE task_id = ? AND execution_epoch = ? AND authorization_version = ?`)
        .run(next.paused ? 1 : 0, next.authorizationVersion, task.taskId, task.executionEpoch, expectedAuthorizationVersion).changes)
      this.instructions.review(task.taskId, task.executionEpoch, instructionId, sessionId, next.authorizationVersion, decision, commandId)
      return accept({ task: next, remaining: remaining - 1 })
    })
  }

  /** Show the current authorization version only if no unconfirmed instruction or pause blocks it. */
  status(sessionId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.snapshot(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      return this.authorizationBlocked(current.value) ?? current
    })
  }

  /** Create the version 1 document for the current Session and record the only approved replacement text. */
  create(sessionId: string, initialText: string, approvedText: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isText(initialText) || !isText(approvedText) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      if (this.sessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      return accept(this.createDocumentTask(sessionId, initialText, approvedText, commandId))
    })
  }

  /** Create an independent document and record the Host-authenticated owner command on version 1. */
  createSharedDocument(sessionId: string, text: string, commandId: string): ManagedResult<SharedDocumentRevision> {
    if (!isId(sessionId) || !isText(text) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const revision = { documentId: randomUUID(), version: 1, text }
      requireWrite(appendSharedRevision(this.db, revision, { sessionId, commandId }))
      return accept(revision)
    })
  }

  /** Read any retained revision, defaulting to the global head rather than a task's local snapshot. */
  readSharedDocument(documentId: string, version?: number): ManagedResult<SharedDocumentRevision> {
    if (!isId(documentId) || (version !== undefined && !isVersion(version))) return deny('INVALID_INPUT')
    return this.snapshot(() => {
      const revision = readSharedRevision(this.db, documentId, version)
      return revision ? accept(revision) : deny('DOCUMENT_NOT_FOUND')
    })
  }

  /** Append a Host-authenticated edit at exactly the expected head, without changing any task authorization. */
  editSharedDocument(sessionId: string, documentId: string, expectedVersion: number, text: string, commandId: string): ManagedResult<SharedDocumentRevision> {
    if (!isId(sessionId) || !isId(documentId) || !isVersion(expectedVersion) || !isText(text) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const head = readSharedRevision(this.db, documentId)
      if (!head) return deny('DOCUMENT_NOT_FOUND')
      if (head.version !== expectedVersion) return deny('SHARED_DOCUMENT_CONFLICT')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const revision = { documentId, version: expectedVersion + 1, text }
      requireWrite(appendSharedRevision(this.db, revision, { sessionId, commandId }))
      return accept(revision)
    })
  }

  /** Bind a new Worker to the expected shared head and copy that immutable baseline into its private version 1. */
  createSharedTask(sessionId: string, documentId: string, expectedVersion: number, approvedText: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(sessionId) || !isId(documentId) || !isVersion(expectedVersion) || !isText(approvedText) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const head = readSharedRevision(this.db, documentId)
      if (!head) return deny('DOCUMENT_NOT_FOUND')
      if (head.version !== expectedVersion) return deny('SHARED_DOCUMENT_CONFLICT')
      if (this.sessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const task = this.createDocumentTask(sessionId, head.text, approvedText, commandId)
      requireWrite(this.db.prepare('INSERT INTO studio_shared_document_task (task_id, document_id, base_version) VALUES (?, ?, ?)')
        .run(task.taskId, documentId, expectedVersion).changes)
      return accept({ ...task, sharedDocument: { documentId, baseVersion: expectedVersion, headVersion: expectedVersion } })
    })
  }

  /** Insert the private document, its initial Session binding, and the existing create audit in one transaction. */
  private createDocumentTask(sessionId: string, initialText: string, approvedText: string, commandId: string): ManagedTask {
    const taskId = randomUUID()
    requireWrite(this.db.prepare('INSERT INTO managed_task VALUES (?, 1, 1, 0, ?)').run(taskId, approvedText).changes)
    requireWrite(this.db.prepare('INSERT INTO managed_session_binding VALUES (?, ?, 1)').run(sessionId, taskId).changes)
    requireWrite(this.db.prepare('INSERT INTO managed_document VALUES (?, 1, ?)').run(taskId, initialText).changes)
    const task: ManagedTask = { taskId, workerSessionId: sessionId, executionEpoch: 1, authorizationVersion: 1, paused: false, documentVersion: 1 }
    this.audit('create', task, commandId, null)
    return task
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
    const wasFrozen = this.isFrozen(task)
    this.frozenTasks.add(taskId)
    this.frozenSessions.delete(sessionId)
    const result = this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok || current.value.taskId !== taskId || current.value.executionEpoch !== executionEpoch) return deny('STALE_EXECUTION')
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      requireWrite(this.db.prepare('UPDATE managed_task SET paused = 1, authorization_version = authorization_version + 1 WHERE task_id = ? AND execution_epoch = ?')
        .run(taskId, executionEpoch).changes)
      const paused = { ...current.value, paused: true, authorizationVersion: current.value.authorizationVersion + 1 }
      this.audit('pause', paused, commandId, null)
      return accept(paused)
    })
    if (!result.ok) {
      if (result.reason === 'STORAGE_ERROR') return deny('PAUSE_UNCONFIRMED')
      // Known rejections did not attempt a pause. Keep only a fence from an earlier unconfirmed attempt.
      if (!wasFrozen) this.frozenTasks.delete(taskId)
      return result
    }
    // A confirmed COMMIT replaces the local block with a durable pause.
    this.frozenTasks.delete(taskId)
    return result
  }

  /** Transfer to a previously unbound Session only if the expected epoch matches. Preserve the pause and approved text, and invalidate permits from the old epoch. */
  transfer(taskId: string, expectedEpoch: number, nextSessionId: string, commandId: string): ManagedResult<ManagedTask> {
    if (!isId(taskId) || !isVersion(expectedEpoch) || !isId(nextSessionId) || !isId(commandId)) return deny('INVALID_INPUT')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const task = this.task(taskId)
      if (!task) return deny('TASK_NOT_FOUND')
      if (task.executionEpoch !== expectedEpoch) return deny('STALE_EXECUTION')
      const blocked = this.authorizationBlocked(task)
      if (blocked) return blocked
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
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.write(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      if (task.documentVersion === 1 && sharedDocumentConflict(task)) return deny('SHARED_DOCUMENT_CONFLICT')
      const blocked = this.authorizationBlocked(task)
      if (blocked) return blocked
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
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    return this.snapshot(() => {
      const current = this.currentTask(sessionId)
      if (!current.ok) return current
      const task = current.value
      // Even if conflicting role bindings exist, Studio Sessions cannot receive document permits.
      if (this.studioSessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
      if (task.documentVersion === 1 && sharedDocumentConflict(task)) return deny('SHARED_DOCUMENT_CONFLICT')
      const blocked = this.executionBlocked(task)
      if (blocked) return blocked
      if (this.actionUsed(sessionId, toolCallId)) return deny('DUPLICATE_ACTION')
      const input = documentAction(action)
      if (!input) return deny('INVALID_ACTION')
      if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      const expectedVersion = task.sharedDocument?.baseVersion ?? 1
      if (input.expectedVersion !== expectedVersion) return deny(task.sharedDocument ? 'SHARED_DOCUMENT_CONFLICT' : 'VERSION_CONFLICT')
      if (!this.textApproved(task.taskId, input.text)) return deny('ACTION_NOT_APPROVED')
      const { taskId, executionEpoch, authorizationVersion, sharedDocument } = task
      const permit: ManagedWritePermit = Object.freeze({ taskId, workerSessionId: sessionId, executionEpoch, authorizationVersion,
        toolCallId, expectedVersion, text: input.text, ...(sharedDocument ? { documentId: sharedDocument.documentId } : {}) })
      this.#permits.set(permit, false)
      return accept(permit)
    })
  }

  /** With the write lock held, recheck ownership, the permit, the action, and the document. Commit the one allowed change from version 1 to 2 with its audit record. */
  commit(permit: ManagedWritePermit, action: unknown): ManagedResult<{ documentVersion: number; documentId?: string }> {
    const spent = this.#permits.get(permit)
    if (spent === undefined) return deny('INVALID_PERMIT')
    if (spent) return deny('DUPLICATE_ACTION')
    if (this.captureFault) return deny('INSTRUCTION_UNCONFIRMED')
    const result = this.write<{ documentVersion: number; documentId?: string }>(() => {
      const current = this.currentTask(permit.workerSessionId)
      if (!current.ok || current.value.taskId !== permit.taskId || current.value.executionEpoch !== permit.executionEpoch) return deny('STALE_EXECUTION')
      if (this.studioSessionBound(permit.workerSessionId)) return deny('SESSION_ALREADY_BOUND')
      const task = current.value
      const shared = task.sharedDocument
      if (task.documentVersion === 1 && sharedDocumentConflict(task)) return deny('SHARED_DOCUMENT_CONFLICT')
      const blocked = this.executionBlocked(task)
      if (blocked) return blocked
      if (task.authorizationVersion !== permit.authorizationVersion) return deny('STALE_AUTHORIZATION')
      if (this.actionUsed(permit.workerSessionId, permit.toolCallId)) return deny('DUPLICATE_ACTION')
      const input = documentAction(action)
      if (!input) return deny('INVALID_ACTION')
      if (task.documentVersion !== 1) return deny('VERSION_CONFLICT')
      if (permit.documentId !== shared?.documentId) return deny('INVALID_PERMIT')
      if (input.expectedVersion !== permit.expectedVersion || permit.expectedVersion !== (shared?.baseVersion ?? 1)) {
        return deny(shared ? 'SHARED_DOCUMENT_CONFLICT' : 'VERSION_CONFLICT')
      }
      if (input.text !== permit.text || !this.textApproved(task.taskId, input.text)) return deny('ACTION_NOT_APPROVED')
      const committedVersion = shared ? shared.baseVersion + 1 : 2
      if (shared) {
        // Append before updating the private result. The trigger requires this exact revision as proof.
        requireWrite(appendSharedRevision(this.db, { documentId: shared.documentId, version: committedVersion, text: input.text },
          { sessionId: permit.workerSessionId, taskId: task.taskId, toolCallId: permit.toolCallId }))
        requireWrite(this.db.prepare(`UPDATE studio_shared_document_task SET committed_version = ?
          WHERE task_id = ? AND document_id = ? AND base_version = ? AND committed_version IS NULL`)
          .run(committedVersion, task.taskId, shared.documentId, shared.baseVersion).changes)
      }
      requireWrite(this.db.prepare('UPDATE managed_document SET document_version = 2, text = ? WHERE task_id = ? AND document_version = 1')
        .run(input.text, task.taskId).changes)
      this.audit('commit', { ...task, documentVersion: 2 }, null, permit.toolCallId)
      return accept(shared ? { documentVersion: committedVersion, documentId: shared.documentId } : { documentVersion: 2 })
    })
    if (result.ok) this.#permits.set(permit, true)
    return result
  }

  /** Use a write lock for mutations and a deferred transaction for read-only snapshots. Roll back on rejection or error. */
  private transaction<T>(operation: () => ManagedResult<T>, mode: 'write' | 'read' = 'write'): ManagedResult<T> {
    const db = this.db
    db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
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

  /** Observe the run fence, binding, and document state together without taking a writer lock. */
  private snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T> {
    try { return this.transaction(() => this.ownsRun() ? operation() : deny('STALE_HOST_RUN'), 'read') }
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
      b.session_id, d.document_version, shared.document_id, shared.base_version, shared.committed_version,
      (SELECT MAX(version) FROM studio_shared_document_revision WHERE document_id = shared.document_id) AS head_version
      FROM managed_task t
      JOIN managed_session_binding b ON b.task_id = t.task_id AND b.execution_epoch = t.execution_epoch
      JOIN managed_document d ON d.task_id = t.task_id
      LEFT JOIN studio_shared_document_task shared ON shared.task_id = t.task_id WHERE t.task_id = ?`).get(taskId)
    if (!row) return
    const { session_id: workerSessionId, execution_epoch: executionEpoch, authorization_version: authorizationVersion,
      paused, document_version: documentVersion } = row
    if (!isId(workerSessionId) || !isVersion(executionEpoch) || !isVersion(authorizationVersion)
      || (paused !== 0 && paused !== 1) || (documentVersion !== 1 && documentVersion !== 2)) throw new Error('Invalid Managed Worker task state')
    const task: ManagedTask = { taskId, workerSessionId, executionEpoch, authorizationVersion, paused: paused === 1, documentVersion }
    const { document_id: documentId, base_version: baseVersion, head_version: headVersion, committed_version: committedVersion } = row
    if (documentId !== null) {
      if (!isId(documentId) || !isVersion(baseVersion) || !isVersion(headVersion) || headVersion < baseVersion
        || (documentVersion === 1 ? committedVersion !== null : committedVersion !== baseVersion + 1 || headVersion < committedVersion)) {
        throw new Error('Invalid Studio shared document task state')
      }
      task.sharedDocument = { documentId, baseVersion, headVersion, ...(isVersion(committedVersion) ? { committedVersion } : {}) }
    }
    return task
  }

  /** Load the baseline and exact currently approved target from the same version 1 document. */
  private documentTargets(taskId: string): { baselineText: string; approvedText: string } {
    const row = this.db.prepare(`SELECT d.text AS baseline_text, t.approved_text FROM managed_task t
      JOIN managed_document d USING (task_id) WHERE t.task_id = ? AND d.document_version = 1`).get(taskId)
    if (!isText(row?.baseline_text) || !isText(row?.approved_text)) throw new Error('Invalid Managed Worker document targets')
    return { baselineText: row.baseline_text, approvedText: row.approved_text }
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
      || this.instructions.commandUsed(commandId)
      || !!this.db.prepare('SELECT 1 FROM studio_shared_document_revision WHERE command_id = ?').get(commandId)
      || projectDocumentCommandUsed(this.db, commandId)
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

  /** Check the durable inbox before the pause so callers can route pending work to the owner review command. */
  private authorizationBlocked(task: ManagedTask): Rejection | undefined {
    if (this.instructions.hasPending(task.taskId)) return deny('INSTRUCTION_PENDING')
    if (this.isFrozen(task)) return deny('PAUSE_UNCONFIRMED')
  }

  private executionBlocked(task: ManagedTask): Rejection | undefined {
    return this.authorizationBlocked(task) ?? (task.paused ? deny('TASK_PAUSED') : undefined)
  }

  /** Expose only the blocker code for an unfinished task, never its instructions or approved replacement. */
  private projectDocumentHold(task: ManagedTask): string | undefined {
    if (this.captureFault) return 'INSTRUCTION_UNCONFIRMED'
    if (sharedDocumentConflict(task)) return 'SHARED_DOCUMENT_CONFLICT'
    return this.executionBlocked(task)?.reason
  }
}
