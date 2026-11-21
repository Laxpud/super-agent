/** Append metadata-only receipts for a review of the original document authorization refusal. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { isDocumentGuardToolCallId, readDocumentGuardNativeCall, type DocumentGuardNativeCall } from './document-guard-store.js'

/** The Host must resolve and authenticate the original native event before submitting its action for comparison. */
export interface DocumentGuardReviewSource extends DocumentGuardNativeCall {
  toolCallId: string
  action: unknown
}

/** A durable comparison result, not a write authorization or a copy of any text. */
export interface DocumentGuardReviewReceipt {
  reviewId: string
  evidenceId: string
  taskId: string
  workerSessionId: string
  executionEpoch: number
  authorizationVersion: number
  commandId: string
  at: string
  outcome: 'refusal-confirmed' | 'comparison-inconsistent'
}

type ReviewInput = Omit<DocumentGuardReviewReceipt, 'reviewId' | 'at'>
const GROUND = 'approved-text-comparison'

export const DOCUMENT_GUARD_REVIEW_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_document_guard_review (
    review_id TEXT PRIMARY KEY,
    evidence_id TEXT NOT NULL UNIQUE REFERENCES studio_document_guard_native_call (evidence_id),
    task_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    command_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    ground TEXT NOT NULL DEFAULT '${GROUND}' CHECK (ground = '${GROUND}'),
    outcome TEXT NOT NULL CHECK (outcome IN ('refusal-confirmed', 'comparison-inconsistent')),
    UNIQUE (task_id, authorization_version)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_review_append BEFORE INSERT ON studio_document_guard_review
    WHEN EXISTS (SELECT 1 FROM studio_document_guard_review WHERE review_id = NEW.review_id OR evidence_id = NEW.evidence_id
      OR command_id = NEW.command_id OR (task_id = NEW.task_id AND authorization_version = NEW.authorization_version))
      OR NOT EXISTS (SELECT 1 FROM studio_document_guard_evidence WHERE evidence_id = NEW.evidence_id
        AND task_id = NEW.task_id AND worker_session_id = NEW.worker_session_id AND execution_epoch = NEW.execution_epoch
        AND authorization_version = NEW.authorization_version AND phase = 'authorize' AND reason = 'ACTION_NOT_APPROVED')
    BEGIN SELECT RAISE(ABORT, 'Studio document guard reviews must match the original refusal and cannot replace a prior review'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_review_no_update BEFORE UPDATE ON studio_document_guard_review
    BEGIN SELECT RAISE(ABORT, 'Studio document guard reviews are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_review_no_delete BEFORE DELETE ON studio_document_guard_review
    BEGIN SELECT RAISE(ABORT, 'Studio document guard reviews are immutable'); END;
`

const fields = `review_id, evidence_id, task_id, worker_session_id, execution_epoch, authorization_version, command_id, at, outcome`
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Decode only own data properties. Document action validation remains with the Store's shared parser. */
export function readDocumentGuardReviewSource(value: unknown): DocumentGuardReviewSource | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const nativeCall = readDocumentGuardNativeCall(value)
  const toolCallId = Object.getOwnPropertyDescriptor(value, 'toolCallId')
  const action = Object.getOwnPropertyDescriptor(value, 'action')
  if (!nativeCall || !toolCallId || !Object.hasOwn(toolCallId, 'value') || !isDocumentGuardToolCallId(toolCallId.value)
    || !action || !Object.hasOwn(action, 'value')) return
  return { ...nativeCall, toolCallId: toolCallId.value, action: action.value }
}

/** Check the cap under the same snapshot or write transaction used for the eligibility check. */
export function documentGuardReviewUsed(db: DatabaseSync, taskId: string, authorizationVersion: number, evidenceId: string,
  commandId?: string): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_document_guard_review WHERE (task_id = ? AND authorization_version = ?)
    OR evidence_id = ? OR command_id = ? LIMIT 1`).get(taskId, authorizationVersion, evidenceId, commandId ?? null)
}

function readReceipt(row: Record<string, SQLOutputValue>): DocumentGuardReviewReceipt {
  const { review_id: reviewId, evidence_id: evidenceId, task_id: taskId, worker_session_id: workerSessionId,
    execution_epoch: executionEpoch, authorization_version: authorizationVersion, command_id: commandId, at, outcome, ground } = row
  if (!isId(reviewId) || !isId(evidenceId) || !isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch)
    || !isVersion(authorizationVersion) || !isId(commandId) || !isId(at) || ground !== GROUND
    || (outcome !== 'refusal-confirmed' && outcome !== 'comparison-inconsistent')) throw new Error('Invalid Studio document guard review')
  return { reviewId, evidenceId, taskId, workerSessionId, executionEpoch, authorizationVersion, commandId, at, outcome }
}

/** Look up a prior receipt by its evidence and task; it need not still be executable. */
export function readDocumentGuardReviewReceipt(db: DatabaseSync, taskId: string, evidenceId: string): DocumentGuardReviewReceipt | undefined {
  const row = db.prepare(`SELECT ${fields}, ground FROM studio_document_guard_review WHERE task_id = ? AND evidence_id = ?`).get(taskId, evidenceId)
  return row ? readReceipt(row) : undefined
}

/** Append and verify the only new row before the caller commits the review transaction. */
export function appendDocumentGuardReview(db: DatabaseSync, input: ReviewInput): DocumentGuardReviewReceipt {
  const { evidenceId, taskId, workerSessionId, executionEpoch, authorizationVersion, commandId, outcome } = input
  const reviewId = randomUUID()
  const at = new Date().toISOString()
  const { changes } = db.prepare(`INSERT INTO studio_document_guard_review (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reviewId, evidenceId, taskId, workerSessionId, executionEpoch, authorizationVersion, commandId, at, outcome)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio document guard review insert did not affect exactly one row')
  const saved = readDocumentGuardReviewReceipt(db, taskId, evidenceId)
  if (!saved || saved.reviewId !== reviewId || saved.at !== at || saved.workerSessionId !== workerSessionId
    || saved.executionEpoch !== executionEpoch || saved.authorizationVersion !== authorizationVersion
    || saved.commandId !== commandId || saved.outcome !== outcome) throw new Error('Studio document guard review did not match the comparison')
  return saved
}
