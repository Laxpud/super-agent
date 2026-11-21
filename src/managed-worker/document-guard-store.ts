/** Retain bounded metadata about actual document guard outcomes, never an approval or a document body. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'

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

/** Coordinates of the native call in the exact Worker's own Session log. */
export interface DocumentGuardNativeCall {
  eventSeq: number
  turn: number
  step: number
}

/** Host-owned holder for a single guard call. Supply coordinates only after matching the original call and arguments. */
export interface DocumentGuardCapture {
  nativeCall?: DocumentGuardNativeCall
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
  nativeCall?: DocumentGuardNativeCall
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
  CREATE TABLE IF NOT EXISTS studio_document_guard_native_call (
    evidence_id TEXT PRIMARY KEY REFERENCES studio_document_guard_evidence (evidence_id) DEFERRABLE INITIALLY DEFERRED,
    event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 0 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    step INTEGER NOT NULL CHECK (step BETWEEN 1 AND 9007199254740991)
  ) STRICT;
  -- Insert the link first and fulfill its deferred foreign key with a new refusal in the same transaction.
  -- An existing refusal, including a legacy row, can never acquire a link.
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_native_call_append BEFORE INSERT ON studio_document_guard_native_call
    WHEN EXISTS (SELECT 1 FROM studio_document_guard_evidence WHERE evidence_id = NEW.evidence_id)
      OR EXISTS (SELECT 1 FROM studio_document_guard_native_call WHERE evidence_id = NEW.evidence_id)
    BEGIN SELECT RAISE(ABORT, 'Studio document guard native calls must accompany new evidence'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_native_call_eligible BEFORE INSERT ON studio_document_guard_evidence
    WHEN (NEW.phase <> 'authorize' OR NEW.reason <> 'ACTION_NOT_APPROVED'
      OR NEW.authorization_version IS NULL OR NEW.expected_version IS NULL)
      AND EXISTS (SELECT 1 FROM studio_document_guard_native_call WHERE evidence_id = NEW.evidence_id)
    BEGIN SELECT RAISE(ABORT, 'Only an observed authorization refusal may include a native call'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_native_call_no_update BEFORE UPDATE ON studio_document_guard_native_call
    BEGIN SELECT RAISE(ABORT, 'Studio document guard native calls are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_guard_native_call_no_delete BEFORE DELETE ON studio_document_guard_native_call
    BEGIN SELECT RAISE(ABORT, 'Studio document guard native calls are immutable'); END;
`

type Row = Record<string, SQLOutputValue>
const fields = `evidence_id, task_id, worker_session_id, execution_epoch, authorization_version, document_id,
  expected_version, tool_call_id, phase, category, reason, at`
const selectEvidence = `SELECT ${fields}, native.event_seq, native.turn, native.step FROM studio_document_guard_evidence
  LEFT JOIN studio_document_guard_native_call native USING (evidence_id)`
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

function nativeCoordinates(eventSeq: unknown, turn: unknown, step: unknown): DocumentGuardNativeCall | undefined {
  if ((eventSeq === 0 || isVersion(eventSeq)) && isVersion(turn) && isVersion(step)) return { eventSeq, turn, step }
}

/** Copy the Host's own data properties without invoking accessors. No other source fields are retained. */
export function readDocumentGuardNativeCall(value: unknown): DocumentGuardNativeCall | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const [eventSeq, turn, step] = ['eventSeq', 'turn', 'step'].map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && Object.hasOwn(field, 'value') ? field.value as unknown : undefined
  })
  return nativeCoordinates(eventSeq, turn, step)
}

/** An absent link only matches another absent link; the tool call ID alone does not confirm a replayed event. */
export function matchesDocumentGuardNativeCall(left: DocumentGuardNativeCall | undefined, right: DocumentGuardNativeCall | undefined): boolean {
  return left?.eventSeq === right?.eventSeq && left?.turn === right?.turn && left?.step === right?.step
}

/** Verify the opaque native ID without truncating it or allowing controls into a displayed evidence record. */
export function isDocumentGuardToolCallId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= TOOL_CALL_ID_LIMIT && isId(value) && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

/** Decode only the metadata columns; a damaged record is an unavailable read, not partial evidence. */
function readEvidence(row: Row): DocumentGuardEvidence {
  const { evidence_id: evidenceId, task_id: taskId, worker_session_id: workerSessionId, execution_epoch: executionEpoch,
    authorization_version: authorizationVersion, document_id: documentId, expected_version: expectedVersion,
    tool_call_id: toolCallId, phase, category, reason, at, event_seq: eventSeq, turn, step } = row
  if (!isId(evidenceId) || !isId(taskId) || !isId(workerSessionId) || !isVersion(executionEpoch) || !isDocumentGuardToolCallId(toolCallId) || !isId(at)
    || (authorizationVersion !== null && !isVersion(authorizationVersion)) || (documentId !== null && !isId(documentId))
    || (expectedVersion !== null && !isVersion(expectedVersion)) || (phase !== 'authorize' && phase !== 'commit')
    || !isGuardReason(reason) || categories[reason] !== category) throw new Error('Invalid Studio document guard evidence')
  const nativeCall = nativeCoordinates(eventSeq, turn, step)
  if (nativeCall ? phase !== 'authorize' || reason !== 'ACTION_NOT_APPROVED' || authorizationVersion === null || expectedVersion === null
    : eventSeq !== null || turn !== null || step !== null) throw new Error('Invalid Studio document guard native call')
  return { evidenceId, taskId, workerSessionId, executionEpoch, toolCallId, phase, category, reason, at,
    ...(authorizationVersion === null ? {} : { authorizationVersion }), ...(documentId === null ? {} : { documentId }),
    ...(expectedVersion === null ? {} : { expectedVersion }), ...(nativeCall ? { nativeCall } : {}) }
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
export function retainDocumentGuard(db: DatabaseSync, observation: DocumentGuardObservation, nativeCall?: DocumentGuardNativeCall): DocumentGuardRetention {
  const { taskId, workerSessionId, executionEpoch, authorizationVersion, documentId, expectedVersion, toolCallId, phase, reason } = observation
  const category = documentGuardCategory(reason)
  if (!category || !isDocumentGuardToolCallId(toolCallId)) return { kind: 'not-retained', reason: 'origin-unconfirmed' }
  const existing = db.prepare(`${selectEvidence} WHERE worker_session_id = ? AND tool_call_id = ? AND phase = ?`)
    .get(workerSessionId, toolCallId, phase)
  if (existing) {
    const prior = readEvidence(existing)
    return matchesObservation(prior, observation) && matchesDocumentGuardNativeCall(prior.nativeCall, nativeCall)
      ? { kind: 'retained', evidenceId: prior.evidenceId } : { kind: 'not-retained', reason: 'origin-unconfirmed' }
  }
  if (atLimit(db, taskId)) return { kind: 'not-retained', reason: 'limit' }
  const evidenceId = randomUUID()
  const at = new Date().toISOString()
  if (nativeCall) {
    const { eventSeq, turn, step } = nativeCall
    const link = db.prepare('INSERT INTO studio_document_guard_native_call (evidence_id, event_seq, turn, step) VALUES (?, ?, ?, ?)')
      .run(evidenceId, eventSeq, turn, step)
    if (link.changes !== 1 && link.changes !== 1n) throw new Error('Studio document guard native call insert did not affect exactly one row')
  }
  const { changes } = db.prepare(`INSERT INTO studio_document_guard_evidence (${fields}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(evidenceId, taskId, workerSessionId, executionEpoch, authorizationVersion ?? null, documentId ?? null, expectedVersion ?? null,
      toolCallId, phase, category, reason, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio document guard evidence insert did not affect exactly one row')
  // Confirm both pieces before the audit transaction commits; no partial or substituted observation may survive.
  const row = db.prepare(`${selectEvidence} WHERE evidence_id = ?`).get(evidenceId)
  if (!row) throw new Error('Studio document guard evidence could not be verified')
  const saved = readEvidence(row)
  if (saved.at !== at || !matchesObservation(saved, observation) || !matchesDocumentGuardNativeCall(saved.nativeCall, nativeCall)) {
    throw new Error('Studio document guard evidence did not match the observation')
  }
  return { kind: 'retained', evidenceId }
}

/** Read one exact observation and its optional link within the caller's task snapshot. */
export function readDocumentGuardEvidenceById(db: DatabaseSync, taskId: string, evidenceId: string): DocumentGuardEvidence | undefined {
  const row = db.prepare(`${selectEvidence} WHERE task_id = ? AND evidence_id = ?`).get(taskId, evidenceId)
  return row ? readEvidence(row) : undefined
}

/** Read at most twelve observations in retention order, or one exact ID scoped to the caller's task snapshot. */
export function readDocumentGuardEvidence(db: DatabaseSync, taskId: string, evidenceId?: string):
{ items: DocumentGuardEvidence[]; limited: boolean; more?: boolean } | undefined {
  if (evidenceId !== undefined) {
    const evidence = readDocumentGuardEvidenceById(db, taskId, evidenceId)
    return evidence ? { items: [evidence], limited: atLimit(db, taskId) } : undefined
  }
  const rows = db.prepare(`${selectEvidence} WHERE task_id = ? ORDER BY seq DESC LIMIT ?`)
    .all(taskId, PAGE_LIMIT + 1)
  return { items: rows.slice(0, PAGE_LIMIT).map(readEvidence), limited: atLimit(db, taskId),
    ...(rows.length > PAGE_LIMIT ? { more: true } : {}) }
}
