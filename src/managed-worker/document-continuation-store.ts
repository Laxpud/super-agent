/** Append-only ownership receipts for Host-verified document continuation requests. */
import type { DatabaseSync } from 'node:sqlite'
import { types } from 'node:util'
import type { ManagedTask } from './store.js'

/** GUI coordinates refer to the Assistant Session's own event; only Feishu supplies a source timestamp in milliseconds. */
export interface DocumentContinuationSource {
  channel: 'gui' | 'feishu'
  sourceScope: string
  requestId: string
  messageId: string
  eventSeq: number | null
  sourceTimeMs: number | null
}

export type DocumentContinuationSelection =
  | { kind: 'duplicate' }
  | { kind: 'blocked'; reason: string; task?: ManagedTask }
  | { kind: 'ambiguous'; candidates: ManagedTask[]; more: boolean }
  | { kind: 'selected'; task: ManagedTask }

type ClaimOutcome = Exclude<DocumentContinuationSelection, { kind: 'duplicate' }>

export const DOCUMENT_CONTINUATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_document_continuation_claim (
    channel TEXT NOT NULL CHECK (channel IN ('gui', 'feishu')),
    source_scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    event_seq INTEGER CHECK (event_seq BETWEEN 0 AND 9007199254740991),
    source_time_ms INTEGER CHECK (source_time_ms BETWEEN 0 AND 9007199254740991),
    run_id TEXT NOT NULL,
    requested_task_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'ambiguous', 'selected')),
    reason TEXT,
    task_id TEXT REFERENCES managed_task (task_id),
    worker_session_id TEXT REFERENCES managed_session_binding (session_id),
    execution_epoch INTEGER CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    authorization_version INTEGER CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    document_version INTEGER CHECK (document_version IN (1, 2)),
    shared_document_id TEXT,
    shared_base_version INTEGER CHECK (shared_base_version BETWEEN 1 AND 9007199254740991),
    shared_head_version INTEGER CHECK (shared_head_version BETWEEN shared_base_version AND 9007199254740991),
    PRIMARY KEY (channel, source_scope, request_id),
    UNIQUE (channel, source_scope, message_id),
    UNIQUE (channel, source_scope, event_seq),
    FOREIGN KEY (task_id, execution_epoch) REFERENCES managed_session_binding (task_id, execution_epoch),
    CHECK ((channel = 'gui' AND event_seq IS NOT NULL AND source_time_ms IS NULL)
      OR (channel = 'feishu' AND request_id = message_id AND event_seq IS NULL AND source_time_ms IS NOT NULL)),
    CHECK ((reason IS NOT NULL) = (outcome = 'blocked')),
    CHECK (outcome <> 'selected' OR (task_id IS NOT NULL AND document_version IS 1)),
    CHECK (outcome <> 'ambiguous' OR task_id IS NULL),
    CHECK ((task_id IS NULL) = (worker_session_id IS NULL) AND (task_id IS NULL) = (execution_epoch IS NULL)
      AND (task_id IS NULL) = (authorization_version IS NULL) AND (task_id IS NULL) = (document_version IS NULL)),
    CHECK ((shared_document_id IS NULL) = (shared_base_version IS NULL)
      AND (shared_document_id IS NULL) = (shared_head_version IS NULL)
      AND (shared_document_id IS NULL OR task_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_document_continuation_feishu_time
    ON studio_document_continuation_claim (source_scope, source_time_ms) WHERE channel = 'feishu';
  CREATE TRIGGER IF NOT EXISTS studio_document_continuation_claim_append
    BEFORE INSERT ON studio_document_continuation_claim
    WHEN EXISTS (SELECT 1 FROM studio_document_continuation_claim WHERE channel = NEW.channel AND source_scope = NEW.source_scope
      AND (request_id = NEW.request_id OR message_id = NEW.message_id OR event_seq = NEW.event_seq))
    BEGIN SELECT RAISE(ABORT, 'Studio document continuation claims cannot replace prior claims'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_continuation_claim_no_update BEFORE UPDATE ON studio_document_continuation_claim
    BEGIN SELECT RAISE(ABORT, 'Studio document continuation claims are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_document_continuation_claim_no_delete BEFORE DELETE ON studio_document_continuation_claim
    BEGIN SELECT RAISE(ABORT, 'Studio document continuation claims are immutable'); END;
`

const sourceKeys = ['channel', 'sourceScope', 'requestId', 'messageId', 'eventSeq', 'sourceTimeMs'] as const
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Copy only own data properties before entering the fence. The Host is responsible for authenticating the input. */
export function readDocumentContinuationSource(value: unknown): DocumentContinuationSource | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== sourceKeys.length) return
  const [channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs] = sourceKeys.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && Object.hasOwn(field, 'value') ? field.value as unknown : undefined
  })
  if (!isId(sourceScope) || !isId(requestId) || !isId(messageId)) return
  if (channel === 'gui' && isCoordinate(eventSeq) && sourceTimeMs === null) {
    return { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs }
  }
  if (channel === 'feishu' && requestId === messageId && eventSeq === null && isCoordinate(sourceTimeMs)) {
    return { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs }
  }
}

/** Match either native ID or the confirmed own event for routes that have that coordinate. */
export function guiDocumentContinuationSeen(db: DatabaseSync, sessionId: string, messageId: string, requestId: string,
  eventSeq: number | null = null): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_document_continuation_claim WHERE channel = 'gui' AND source_scope = ?
    AND (message_id = ? OR request_id = ? OR event_seq = ?) LIMIT 1`).get(sessionId, messageId, requestId, eventSeq)
}

export function feishuDocumentContinuationSeen(db: DatabaseSync, scope: string, requestId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_document_continuation_claim WHERE channel = 'feishu' AND source_scope = ? AND request_id = ?`)
    .get(scope, requestId)
}

/** Compare only Feishu timestamps from the exact same scope; equal times provide no ordering evidence. */
export function feishuDocumentContinuationLate(db: DatabaseSync, scope: string, timeMs: number): boolean {
  return !!db.prepare(`SELECT 1 FROM studio_document_continuation_claim WHERE channel = 'feishu' AND source_scope = ?
    AND source_time_ms > ? LIMIT 1`).get(scope, timeMs)
}

/** Seal the route after selection, without storing either the input or approved text. The caller owns the write fence. */
export function appendDocumentContinuationClaim(db: DatabaseSync, runId: string, source: DocumentContinuationSource,
  requestedTaskId: string | undefined, outcome: ClaimOutcome): void {
  const task = outcome.kind === 'ambiguous' ? undefined : outcome.task
  const shared = task?.sharedDocument
  const { changes } = db.prepare(`INSERT INTO studio_document_continuation_claim (channel, source_scope, request_id, message_id,
    event_seq, source_time_ms, run_id, requested_task_id, outcome, reason, task_id, worker_session_id, execution_epoch,
    authorization_version, document_version, shared_document_id, shared_base_version, shared_head_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(source.channel, source.sourceScope, source.requestId, source.messageId, source.eventSeq, source.sourceTimeMs, runId,
      requestedTaskId ?? null, outcome.kind, outcome.kind === 'blocked' ? outcome.reason : null, task?.taskId ?? null,
      task?.workerSessionId ?? null, task?.executionEpoch ?? null, task?.authorizationVersion ?? null, task?.documentVersion ?? null,
      shared?.documentId ?? null, shared?.baseVersion ?? null, shared?.headVersion ?? null)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio document continuation claim did not affect exactly one row')
}
