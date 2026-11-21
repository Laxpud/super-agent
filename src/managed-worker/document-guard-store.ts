/** Retain bounded metadata about actual document guard outcomes, never an approval or a document body. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'

const categories = {
  ACTION_NOT_APPROVED: 'denied',
  TASK_PAUSED: 'state',
  INSTRUCTION_PENDING: 'state',
  STALE_EXECUTION: 'state',
  STALE_AUTHORIZATION: 'state',
  VERSION_CONFLICT: 'state',
  SHARED_DOCUMENT_CONFLICT: 'state',
  DUPLICATE_ACTION: 'state',
  STORAGE_ERROR: 'unconfirmed',
  INSTRUCTION_UNCONFIRMED: 'unconfirmed',
  PAUSE_UNCONFIRMED: 'unconfirmed',
  STALE_HOST_RUN: 'unconfirmed',
} as const

type DocumentGuardReason = keyof typeof categories
type DocumentGuardCategory = typeof categories[DocumentGuardReason]
type DocumentGuardPhase = 'authorize' | 'commit'

function isGuardReason(value: unknown): value is DocumentGuardReason {
  return typeof value === 'string' && Object.hasOwn(categories, value)
}

/** Classify only outcomes from the document checks; malformed actions and unrelated failures are not evidence. */
export function documentGuardCategory(reason: string): 'denied' | 'state' | 'unconfirmed' | undefined {
  return isGuardReason(reason) ? categories[reason] : undefined
}

type DocumentGuardRetention = { kind: 'retained'; evidenceId: string }
  | { kind: 'not-retained'; reason: 'limit' | 'unavailable' | 'origin-unconfirmed' }

/** Optional Host-owned output for a single guard call. It does not affect the guard result. */
export interface DocumentGuardCapture {
  retention?: DocumentGuardRetention
}

/** Coordinates from the original execution; authorization and target may not have been observed. */
export interface DocumentGuardScope {
  taskId: string
  executionEpoch: number
  authorizationVersion?: number
  documentId?: string
  expectedVersion?: number
}

type DocumentGuardObservation = DocumentGuardScope & {
  workerSessionId: string
  toolCallId: string
  phase: DocumentGuardPhase
  reason: string
}

/** History for one native tool call and phase, without any input text, approved text, or hashes. */
export type DocumentGuardEvidence = DocumentGuardObservation & {
  evidenceId: string
  category: DocumentGuardCategory
  reason: DocumentGuardReason
  at: string
}

// The cap spans all execution epochs of a task. Reject new inserts rather than deleting old evidence.
const TASK_LIMIT = 64
const PAGE_LIMIT = 12
const TOOL_CALL_ID_LIMIT = 256
const REASON_CHECK = Object.entries(categories).map(([reason, category]) => `(reason = '${reason}' AND category = '${category}')`).join(' OR ')
export const DOCUMENT_GUARD_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS managed_session_binding_guard_fk
    ON managed_session_binding (task_id, execution_epoch, session_id);
  CREATE TABLE IF NOT EXISTS studio_document_guard_evidence (
    seq INTEGER PRIMARY KEY,
    evidence_id TEXT NOT NULL UNIQUE CHECK (length(evidence_id) = 36 AND substr(evidence_id, 9, 1) = '-'
      AND substr(evidence_id, 14, 2) = '-4' AND substr(evidence_id, 19, 1) = '-'
      AND substr(evidence_id, 20, 1) GLOB '[89ab]' AND substr(evidence_id, 24, 1) = '-'
      AND length(replace(evidence_id, '-', '')) = 32 AND replace(evidence_id, '-', '') NOT GLOB '*[^0-9a-f]*'),
    task_id TEXT NOT NULL,
    worker_session_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    authorization_version INTEGER CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    document_id TEXT,
    expected_version INTEGER CHECK (expected_version BETWEEN 1 AND 9007199254740991),
    tool_call_id TEXT NOT NULL CHECK (length(tool_call_id) BETWEEN 1 AND ${TOOL_CALL_ID_LIMIT}
      AND instr(tool_call_id, char(0)) = 0
      AND tool_call_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || '-' || char(159) || ']*')),
    phase TEXT NOT NULL CHECK (phase IN ('authorize', 'commit')),
    category TEXT NOT NULL,
    reason TEXT NOT NULL,
    at TEXT NOT NULL,
    FOREIGN KEY (task_id, execution_epoch, worker_session_id) REFERENCES managed_session_binding (task_id, execution_epoch, session_id),
    UNIQUE (worker_session_id, tool_call_id, phase),
    CHECK (${REASON_CHECK})
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_document_guard_recent ON studio_document_guard_evidence (task_id, seq DESC);
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_append BEFORE INSERT ON studio_document_guard_evidence
    WHEN EXISTS (SELECT 1 FROM studio_document_guard_evidence WHERE seq = NEW.seq OR evidence_id = NEW.evidence_id
      OR (worker_session_id = NEW.worker_session_id AND tool_call_id = NEW.tool_call_id AND phase = NEW.phase))
      OR (SELECT COUNT(*) FROM studio_document_guard_evidence WHERE task_id = NEW.task_id) >= ${TASK_LIMIT}
    BEGIN SELECT RAISE(ABORT, 'Studio document guard evidence cannot be replaced or exceed the task limit'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_no_update BEFORE UPDATE ON studio_document_guard_evidence
    BEGIN SELECT RAISE(ABORT, 'Studio document guard evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_no_delete BEFORE DELETE ON studio_document_guard_evidence
    BEGIN SELECT RAISE(ABORT, 'Studio document guard evidence is immutable'); END;
`

type Row = Record<string, SQLOutputValue>
const fields = `evidence_id, task_id, worker_session_id, execution_epoch, authorization_version, document_id,
  expected_version, tool_call_id, phase, category, reason, at`
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Verify the opaque native ID without truncating it or allowing controls into a displayed evidence record. */
export function isDocumentGuardToolCallId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TOOL_CALL_ID_LIMIT && isId(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

/** Decode only the metadata columns; a damaged record is an unavailable read, not partial evidence. */
function readEvidence(row: Row): DocumentGuardEvidence {
  const { evidence_id: evidenceId, task_id: taskId, worker_session_id: workerSessionId, execution_epoch: executionEpoch,
    authorization_version: authorizationVersion, document_id: documentId, expected_version: expectedVersion,
    tool_call_id: toolCallId, phase, category, reason, at } = row
  if (!isId(evidenceId) || !isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch) || !isDocumentGuardToolCallId(toolCallId) || !isId(at)
    || (authorizationVersion !== null && !isVersion(authorizationVersion)) || (documentId !== null && !isId(documentId))
    || (expectedVersion !== null && !isVersion(expectedVersion)) || (phase !== 'authorize' && phase !== 'commit')
    || !isGuardReason(reason) || categories[reason] !== category) throw new Error('Invalid Studio document guard evidence')
  return { evidenceId, taskId, workerSessionId, executionEpoch, toolCallId, phase, category, reason, at,
    ...(authorizationVersion === null ? {} : { authorizationVersion }), ...(documentId === null ? {} : { documentId }),
    ...(expectedVersion === null ? {} : { expectedVersion }) }
}

/** The native call key identifies the input. Compare retained coordinates, not a copy or hash of that input. */
function matchesObservation(prior: DocumentGuardEvidence, current: DocumentGuardObservation): boolean {
  return prior.taskId === current.taskId && prior.workerSessionId === current.workerSessionId
    && prior.executionEpoch === current.executionEpoch && prior.authorizationVersion === current.authorizationVersion
    && prior.documentId === current.documentId && prior.expectedVersion === current.expectedVersion
    && prior.toolCallId === current.toolCallId && prior.phase === current.phase && prior.reason === current.reason
}

function atLimit(db: DatabaseSync, taskId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_document_guard_evidence WHERE task_id = ? LIMIT 1 OFFSET ?`).get(taskId, TASK_LIMIT - 1)
}

/** Append under a separate run-fenced write. Exact replays reuse their ID even after the task reaches the cap. */
export function retainDocumentGuard(db: DatabaseSync, observation: DocumentGuardObservation): DocumentGuardRetention {
  const { taskId, workerSessionId, executionEpoch, authorizationVersion, documentId, expectedVersion, toolCallId, phase, reason } = observation
  const category = documentGuardCategory(reason)
  if (!category || !isDocumentGuardToolCallId(toolCallId)) return { kind: 'not-retained', reason: 'origin-unconfirmed' }
  const existing = db.prepare(`SELECT ${fields} FROM studio_document_guard_evidence
    WHERE worker_session_id = ? AND tool_call_id = ? AND phase = ?`).get(workerSessionId, toolCallId, phase)
  if (existing) {
    const prior = readEvidence(existing)
    return matchesObservation(prior, observation) ? { kind: 'retained', evidenceId: prior.evidenceId }
      : { kind: 'not-retained', reason: 'origin-unconfirmed' }
  }
  if (atLimit(db, taskId)) return { kind: 'not-retained', reason: 'limit' }
  const evidenceId = randomUUID()
  const at = new Date().toISOString()
  const { changes } = db.prepare(`INSERT INTO studio_document_guard_evidence (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(evidenceId, taskId, workerSessionId, executionEpoch, authorizationVersion ?? null, documentId ?? null, expectedVersion ?? null,
      toolCallId, phase, category, reason, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio document guard evidence insert did not affect exactly one row')
  // Confirm the exact row before the audit transaction commits; a trigger cannot substitute another observation.
  const row = db.prepare(`SELECT ${fields} FROM studio_document_guard_evidence WHERE evidence_id = ?`).get(evidenceId)
  if (!row) throw new Error('Studio document guard evidence could not be verified')
  const saved = readEvidence(row)
  if (saved.at !== at || !matchesObservation(saved, observation)) throw new Error('Studio document guard evidence did not match the observation')
  return { kind: 'retained', evidenceId }
}

/** Read at most twelve observations in retention order, or one exact ID scoped to the caller's task snapshot. */
export function readDocumentGuardEvidence(db: DatabaseSync, taskId: string, evidenceId?: string):
{ items: DocumentGuardEvidence[]; limited: boolean; more?: boolean } | undefined {
  if (evidenceId !== undefined) {
    const row = db.prepare(`SELECT ${fields} FROM studio_document_guard_evidence WHERE task_id = ? AND evidence_id = ?`).get(taskId, evidenceId)
    return row ? { items: [readEvidence(row)], limited: atLimit(db, taskId) } : undefined
  }
  const rows = db.prepare(`SELECT ${fields} FROM studio_document_guard_evidence WHERE task_id = ? ORDER BY seq DESC LIMIT ?`)
    .all(taskId, PAGE_LIMIT + 1)
  return { items: rows.slice(0, PAGE_LIMIT).map(readEvidence), limited: atLimit(db, taskId),
    ...(rows.length > PAGE_LIMIT ? { more: true } : {}) }
}
