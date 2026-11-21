/** Immutable project result references with native provenance, UTF-16 slice coordinates, and a full-source fingerprint. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/** Maximum excerpt length in UTF-16 code units. */
export const PROJECT_RESULT_QUOTE_LIMIT = 1_000

interface ResultCoordinates {
  messageId: string
  turn: number
  eventSeq: number
}

/** Public provenance, source validity, and coordinates of any saved derived result. */
export interface ProjectWorkResultUse extends ResultCoordinates {
  projectId: string
  sourceWorkId: string
  workerSessionId: string
  workerBotId: string
  executionEpoch: number
  current: boolean
  resultSource?: ResultCoordinates
}

export interface WorkResultSource extends Omit<ProjectWorkResultUse, 'current' | 'resultSource'> {
  leaderSessionId: string
  commandId: string
  offset: number
  length: number
  fingerprint: string
}

export const PROJECT_RESULT_USE_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_result_origin
    ON studio_project_dispatch (work_id, execution_epoch, project_id, worker_session_id, worker_bot_id);
  CREATE TABLE IF NOT EXISTS studio_project_work_result_use (
    work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
    project_id TEXT NOT NULL REFERENCES studio_project (project_id),
    leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
    command_id TEXT NOT NULL UNIQUE,
    source_work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    worker_session_id TEXT NOT NULL,
    worker_bot_id TEXT NOT NULL,
    message_id TEXT NOT NULL CHECK (length(message_id) > 0),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 0 AND 9007199254740991),
    quote_offset INTEGER NOT NULL CHECK (quote_offset BETWEEN 0 AND 9007199254740991),
    quote_length INTEGER NOT NULL CHECK (quote_length BETWEEN 1 AND ${PROJECT_RESULT_QUOTE_LIMIT}
      AND quote_offset + quote_length <= 9007199254740991),
    source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
    FOREIGN KEY (source_work_id, execution_epoch, project_id, worker_session_id, worker_bot_id)
      REFERENCES studio_project_dispatch (work_id, execution_epoch, project_id, worker_session_id, worker_bot_id),
    CHECK (work_id <> source_work_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_work_result_use_origin
    ON studio_project_work_result_use (source_work_id, execution_epoch, project_id, worker_session_id, worker_bot_id);
  CREATE INDEX IF NOT EXISTS studio_project_work_result_use_project ON studio_project_work_result_use (project_id);
  CREATE INDEX IF NOT EXISTS studio_project_work_result_use_leader ON studio_project_work_result_use (leader_session_id);
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_no_update BEFORE UPDATE ON studio_project_work_result_use BEGIN
    SELECT RAISE(ABORT, 'Studio project work result bindings are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_no_delete BEFORE DELETE ON studio_project_work_result_use BEGIN
    SELECT RAISE(ABORT, 'Studio project work result bindings are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_insert BEFORE INSERT ON studio_project_work_result_use BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (
      SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id OR command_id = NEW.command_id
    );
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project p JOIN studio_project_binding b USING (project_id, management_epoch)
      WHERE p.project_id = NEW.project_id AND b.leader_session_id = NEW.leader_session_id
    );
    SELECT RAISE(ABORT, 'WORK_NOT_FOUND') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      WHERE w.work_id = NEW.work_id AND b.project_id = NEW.project_id
    );
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY') WHERE
      EXISTS (SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id)
      OR EXISTS (SELECT 1 FROM studio_project_work_fact WHERE work_id = NEW.work_id)
      OR EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.work_id)
      OR EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id);
    SELECT RAISE(ABORT, 'RESULT_SOURCE_UNAVAILABLE') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_dispatch d JOIN studio_project_work w USING (work_id)
      JOIN studio_project_binding b ON b.leader_session_id = w.leader_session_id
      WHERE d.work_id = NEW.source_work_id AND d.execution_epoch = NEW.execution_epoch
        AND d.state = 'completed' AND b.project_id = NEW.project_id AND d.project_id = b.project_id
    ) OR EXISTS (SELECT 1 FROM studio_project_work_fact WHERE work_id = NEW.source_work_id)
      OR EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.source_work_id)
      OR EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.source_work_id)
      OR EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.source_work_id);
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_fact BEFORE INSERT ON studio_project_work_fact
    WHEN EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id) BEGIN
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_doc BEFORE INSERT ON studio_project_document
    WHEN EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id) BEGIN
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_doc_update BEFORE UPDATE OF work_id ON studio_project_document
    WHEN EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id) BEGIN
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_job BEFORE INSERT ON studio_project_job
    WHEN EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id) BEGIN
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_result_use_guard_job_update BEFORE UPDATE OF work_id ON studio_project_job
    WHEN EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = NEW.work_id) BEGIN
    SELECT RAISE(ABORT, 'RESULT_TEXT_WORK_ONLY');
  END;
`

const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isInteger = (value: unknown, minimum: number): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= minimum

/** Read the pinned provenance without loading the excerpt or result body. */
export function readWorkResultUse(db: DatabaseSync, workId: string): WorkResultSource | undefined {
  const row = db.prepare(`SELECT project_id, source_work_id, leader_session_id, command_id, execution_epoch,
    worker_session_id, worker_bot_id, message_id, turn, event_seq, quote_offset, quote_length, source_fingerprint
    FROM studio_project_work_result_use WHERE work_id = ?`).get(workId)
  if (!row) return
  const { project_id: projectId, source_work_id: sourceWorkId, leader_session_id: leaderSessionId, command_id: commandId,
    execution_epoch: executionEpoch, worker_session_id: workerSessionId, worker_bot_id: workerBotId, message_id: messageId,
    turn, event_seq: eventSeq, quote_offset: offset, quote_length: length, source_fingerprint: fingerprint } = row
  if (!isId(projectId) || !isId(sourceWorkId) || sourceWorkId === workId || !isId(leaderSessionId) || !isId(commandId)
    || !isId(workerSessionId) || !isId(workerBotId) || !isInteger(executionEpoch, 1) || !isId(messageId) || !isInteger(turn, 1)
    || !isInteger(eventSeq, 0) || !isInteger(offset, 0) || !isInteger(length, 1) || length > PROJECT_RESULT_QUOTE_LIMIT
    || !Number.isSafeInteger(offset + length) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Invalid Studio project work result binding')
  }
  return { projectId, sourceWorkId, leaderSessionId, commandId, workerSessionId, workerBotId, executionEpoch, messageId, turn,
    eventSeq, offset, length, fingerprint }
}

/** Pin an existing source in the caller's transaction without copying the original or excerpt. */
export function appendWorkResultUse(db: DatabaseSync, workId: string, source: WorkResultSource): void {
  const { projectId, sourceWorkId, leaderSessionId, commandId, workerSessionId, workerBotId, executionEpoch, messageId, turn,
    eventSeq, offset, length, fingerprint } = source
  const { changes } = db.prepare(`INSERT INTO studio_project_work_result_use (work_id, project_id, source_work_id, leader_session_id,
    command_id, worker_session_id, worker_bot_id, execution_epoch, message_id, turn, event_seq, quote_offset, quote_length,
    source_fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workId, projectId, sourceWorkId, leaderSessionId,
    commandId, workerSessionId, workerBotId, executionEpoch, messageId, turn, eventSeq, offset, length, fingerprint)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project work result insert did not affect one row')
}

export function projectResultCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare('SELECT 1 FROM studio_project_work_result_use WHERE command_id = ?').get(commandId)
}

/** Project only public fields; keep the fingerprint and slice coordinates internal. */
export function workResultUseView(source: WorkResultSource, current: boolean): ProjectWorkResultUse {
  const { projectId, sourceWorkId, workerSessionId, workerBotId, executionEpoch, messageId, turn, eventSeq } = source
  return { projectId, sourceWorkId, workerSessionId, workerBotId, executionEpoch, messageId, turn, eventSeq, current }
}

/** Hash the full UTF-8 bytes of the validated Unicode text without normalization. */
export function workResultFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
