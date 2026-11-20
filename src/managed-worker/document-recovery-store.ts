/** Record terminal continuation failures and consume them only in a Host-fenced document transfer. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { messageId } from '../app/delivery.js'
import type { ManagedResult, ManagedTask } from './store.js'

/** Coordinates supplied synchronously by the Host observer after confirming a native, single-input TRANSPORT termination. */
export interface DocumentFailureInput {
  taskId: string
  workerSessionId: string
  executionEpoch: number
  authorizationVersion: number
  turn: number
  sourceMessageId: string
  messageEventSeq: number
  failureEventSeq: number
}

/** Immutable failure evidence. No provider details, error message, or document text are retained. */
export interface DocumentFailure extends DocumentFailureInput {
  evidenceId: string
  recordedAt: string
  reason: 'TRANSPORT'
}

export const DOCUMENT_RECOVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_document_failure (
    evidence_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    execution_epoch INTEGER NOT NULL,
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    source_message_id TEXT NOT NULL,
    message_event_seq INTEGER NOT NULL CHECK (message_event_seq BETWEEN 0 AND 9007199254740991),
    failure_event_seq INTEGER NOT NULL CHECK (failure_event_seq BETWEEN message_event_seq + 1 AND 9007199254740991),
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    UNIQUE (task_id, execution_epoch, authorization_version),
    UNIQUE (worker_session_id, failure_event_seq)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_document_recovery (
    evidence_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_document_failure (evidence_id),
    task_id TEXT NOT NULL,
    prior_session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    prior_execution_epoch INTEGER NOT NULL,
    prior_authorization_version INTEGER NOT NULL CHECK (prior_authorization_version BETWEEN 1 AND 9007199254740991),
    next_session_id TEXT NOT NULL REFERENCES managed_session_binding (session_id),
    next_execution_epoch INTEGER NOT NULL CHECK (next_execution_epoch = prior_execution_epoch + 1),
    next_authorization_version INTEGER NOT NULL CHECK (next_authorization_version BETWEEN 2 AND 9007199254740991
      AND next_authorization_version = prior_authorization_version + 1),
    command_id TEXT NOT NULL UNIQUE REFERENCES managed_audit (command_id),
    confirmation_id TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (task_id, prior_execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    FOREIGN KEY (task_id, next_execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    CHECK (prior_session_id <> next_session_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_append
    BEFORE INSERT ON studio_document_failure
    WHEN EXISTS (SELECT 1 FROM studio_document_failure WHERE evidence_id = NEW.evidence_id
      OR (task_id = NEW.task_id AND execution_epoch = NEW.execution_epoch AND authorization_version = NEW.authorization_version)
      OR (worker_session_id = NEW.worker_session_id AND failure_event_seq = NEW.failure_event_seq))
    BEGIN SELECT RAISE(ABORT, 'Studio document failures must append without replacing earlier evidence'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_recovery_append
    BEFORE INSERT ON studio_document_recovery
    WHEN EXISTS (SELECT 1 FROM studio_document_recovery WHERE evidence_id = NEW.evidence_id
      OR command_id = NEW.command_id OR confirmation_id = NEW.confirmation_id)
    BEGIN SELECT RAISE(ABORT, 'Studio document recovery receipts must append without replacing earlier receipts'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_no_update BEFORE UPDATE ON studio_document_failure
    BEGIN SELECT RAISE(ABORT, 'Studio document failures are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_failure_no_delete BEFORE DELETE ON studio_document_failure
    BEGIN SELECT RAISE(ABORT, 'Studio document failures are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_recovery_no_update BEFORE UPDATE ON studio_document_recovery
    BEGIN SELECT RAISE(ABORT, 'Studio document recovery receipts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_recovery_no_delete BEFORE DELETE ON studio_document_recovery
    BEGIN SELECT RAISE(ABORT, 'Studio document recovery receipts are immutable'); END;
`

interface RecoveryAccess {
  db(): DatabaseSync
  runId: string
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  task(taskId: string): ManagedTask | undefined
  hold(task: ManagedTask): string | undefined
  replacementHold(nextSessionId: string): string | undefined
  transfer(task: ManagedTask, nextSessionId: string, commandId: string): ManagedResult<ManagedTask>
}

type RecoveryPreview = { failure: DocumentFailure; task: ManagedTask }
type Row = Record<string, SQLOutputValue>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isEventSeq = (value: unknown): value is number => value === 0 || isVersion(value)
const inputKeys = ['taskId', 'workerSessionId', 'executionEpoch', 'authorizationVersion', 'turn', 'sourceMessageId',
  'messageEventSeq', 'failureEventSeq'] as const

/** Reject non-plain records, extra fields (including symbols), and accessors without running caller code. */
function readInput(value: unknown): DocumentFailureInput | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== inputKeys.length) return
  const fields = inputKeys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && Object.hasOwn(field, 'value') ? field.value as unknown : undefined
  })
  const [taskId, workerSessionId, executionEpoch, authorizationVersion, turn, sourceMessageId, messageEventSeq, failureEventSeq] = fields
  if (!isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch) || !isVersion(authorizationVersion)
    || !isVersion(turn) || !isId(sourceMessageId) || !isEventSeq(messageEventSeq) || !isEventSeq(failureEventSeq)
    || failureEventSeq <= messageEventSeq) return
  return { taskId, workerSessionId, executionEpoch, authorizationVersion, turn, sourceMessageId, messageEventSeq, failureEventSeq }
}

function readFailure(row: Row): DocumentFailure {
  const failure = readInput({ taskId: row.task_id, workerSessionId: row.worker_session_id, executionEpoch: row.execution_epoch,
    authorizationVersion: row.authorization_version, turn: row.turn, sourceMessageId: row.source_message_id,
    messageEventSeq: row.message_event_seq, failureEventSeq: row.failure_event_seq })
  if (!failure || !isId(row.evidence_id) || !isId(row.recorded_at)) throw new Error('Invalid Studio document failure evidence')
  return { ...failure, evidenceId: row.evidence_id, recordedAt: row.recorded_at, reason: 'TRANSPORT' }
}

export const DOCUMENT_CONTINUATION_PREFIX = 'studio-document-continue:'

/** Key used for both delivery and evidence validation, scoped to the exact approved continuation snapshot. */
export function documentContinuationKey(task: ManagedTask): string {
  return `${DOCUMENT_CONTINUATION_PREFIX}${task.taskId}:${task.executionEpoch}:${task.authorizationVersion}:${task.sharedDocument?.baseVersion ?? task.documentVersion}`
}

/** Manage immutable failure evidence and paused transfers inside the parent Store's Host-owned transactions. */
export class DocumentRecoveryStore {
  constructor(private readonly access: RecoveryAccess) {}

  /** Persist only evidence of this run's current continuation. An identical event is a read, not an evidence refresh. */
  record(value: DocumentFailureInput): ManagedResult<DocumentFailure> {
    const input = readInput(value)
    if (!input) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const { taskId, workerSessionId, executionEpoch, authorizationVersion, turn, sourceMessageId, messageEventSeq, failureEventSeq } = input
      const task = this.access.task(taskId)
      if (!task) return deny('TASK_NOT_FOUND')
      const invalid = this.failureHold(task, input)
      if (invalid) return deny(invalid)
      const db = this.access.db()
      const existing = this.failureFor(task)
      if (existing) {
        if (existing.run_id !== this.access.runId) return deny('STALE_RECOVERY_EVIDENCE')
        const failure = readFailure(existing)
        return inputKeys.every(key => input[key] === failure[key]) ? accept(failure) : deny('FAILURE_EVIDENCE_CONFLICT')
      }
      if (db.prepare('SELECT 1 FROM studio_document_failure WHERE worker_session_id = ? AND failure_event_seq = ?')
        .get(workerSessionId, failureEventSeq)) return deny('FAILURE_EVIDENCE_CONFLICT')
      const evidenceId = randomUUID()
      const recordedAt = new Date().toISOString()
      const { changes } = db.prepare(`INSERT INTO studio_document_failure (evidence_id, run_id, task_id, worker_session_id,
        execution_epoch, authorization_version, turn, source_message_id, message_event_seq, failure_event_seq, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(evidenceId, this.access.runId, taskId, workerSessionId, executionEpoch,
        authorizationVersion, turn, sourceMessageId, messageEventSeq, failureEventSeq, recordedAt)
      if (changes !== 1 && changes !== 1n) throw new Error('Studio document failure insert did not affect exactly one row')
      return accept({ ...input, evidenceId, recordedAt, reason: 'TRANSPORT' })
    })
  }

  /** Read the exact eligible evidence and task together for a native confirmation; this acquires no write lock. */
  preview(taskId: string, evidenceId: string, nextSessionId: string): ManagedResult<RecoveryPreview> {
    if (!isId(taskId) || !isId(evidenceId) || !isId(nextSessionId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => this.validate(taskId, evidenceId, nextSessionId))
  }

  /** Recheck the preview under the write lock and spend the native answer only alongside the actual, paused transfer. */
  recover(taskId: string, evidenceId: string, nextSessionId: string, commandId: string, confirmationId: string): ManagedResult<ManagedTask> {
    if (!isId(taskId) || !isId(evidenceId) || !isId(nextSessionId) || !isId(commandId) || !isId(confirmationId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const current = this.validate(taskId, evidenceId, nextSessionId)
      if (!current.ok) return current
      const db = this.access.db()
      if (db.prepare('SELECT 1 FROM studio_document_recovery WHERE confirmation_id = ?').get(confirmationId)) return deny('RECOVERY_CONFIRMATION_ALREADY_USED')
      const { failure, task } = current.value
      const moved = this.access.transfer(task, nextSessionId, commandId)
      if (!moved.ok) return moved
      const next = moved.value
      // Match the command's actual transfer audit and exact resulting coordinates, rather than recording a second authority.
      const { changes } = db.prepare(`INSERT INTO studio_document_recovery (evidence_id, task_id, prior_session_id,
        prior_execution_epoch, prior_authorization_version, next_session_id, next_execution_epoch, next_authorization_version,
        command_id, confirmation_id, recorded_at)
        SELECT ?, task_id, ?, ?, ?, session_id, execution_epoch, authorization_version, command_id, ?, at
          FROM managed_audit WHERE command_id = ? AND kind = 'transfer' AND task_id = ? AND session_id = ?
          AND execution_epoch = ? AND authorization_version = ? AND paused = 1 AND document_version = 1`)
        .run(evidenceId, failure.workerSessionId, failure.executionEpoch, failure.authorizationVersion, confirmationId, commandId,
          taskId, nextSessionId, next.executionEpoch, next.authorizationVersion)
      if (changes !== 1 && changes !== 1n) throw new Error('Studio document recovery requires an exact transfer audit')
      return moved
    })
  }

  /** Project only eligible, unspent evidence from the Watchdog caller's existing Host-owned snapshot. */
  watchdog(task: ManagedTask): DocumentFailure | undefined {
    if (task.documentVersion !== 1 || task.paused) return
    const row = this.failureFor(task)
    if (!row || row.run_id !== this.access.runId) return
    const failure = readFailure(row)
    if (!this.failureHold(task, failure) && !this.consumed(failure.evidenceId)) return failure
  }

  /** Check exact evidence in the caller's transaction, without selecting a replacement or spending the evidence. */
  eligible(evidenceId: string, taskId?: string): ManagedResult<RecoveryPreview> {
    const row = this.access.db().prepare('SELECT * FROM studio_document_failure WHERE evidence_id = ?').get(evidenceId)
    if (!row || (taskId !== undefined && row.task_id !== taskId)) return deny('RECOVERY_EVIDENCE_NOT_FOUND')
    // A spent receipt wins over later execution, Host run, or hold changes.
    if (this.consumed(evidenceId)) return deny('RECOVERY_ALREADY_USED')
    if (row.run_id !== this.access.runId) return deny('STALE_RECOVERY_EVIDENCE')
    const failure = readFailure(row)
    const task = this.access.task(failure.taskId)
    if (!task) return deny('TASK_NOT_FOUND')
    const invalid = this.failureHold(task, failure)
    return invalid ? deny(invalid) : accept({ task, failure })
  }

  private validate(taskId: string, evidenceId: string, nextSessionId: string): ManagedResult<RecoveryPreview> {
    const current = this.eligible(evidenceId, taskId)
    if (!current.ok) return current
    const replacement = this.access.replacementHold(nextSessionId)
    if (nextSessionId === current.value.task.workerSessionId || replacement) return deny(replacement ?? 'SESSION_ALREADY_BOUND')
    return current
  }

  private failureHold(task: ManagedTask, failure: DocumentFailureInput): string | undefined {
    if (task.workerSessionId !== failure.workerSessionId || task.executionEpoch !== failure.executionEpoch) return 'STALE_EXECUTION'
    const hold = this.access.hold(task)
    if (hold) return hold
    if (task.authorizationVersion !== failure.authorizationVersion) return 'STALE_AUTHORIZATION'
    if (failure.sourceMessageId !== messageId(documentContinuationKey(task))) return 'INVALID_CONTINUATION_SOURCE'
  }

  private failureFor(task: ManagedTask): Row | undefined {
    return this.access.db().prepare(`SELECT * FROM studio_document_failure
      WHERE task_id = ? AND execution_epoch = ? AND authorization_version = ?`)
      .get(task.taskId, task.executionEpoch, task.authorizationVersion)
  }

  private consumed(evidenceId: string): boolean {
    return !!this.access.db().prepare('SELECT 1 FROM studio_document_recovery WHERE evidence_id = ?').get(evidenceId)
  }
}
