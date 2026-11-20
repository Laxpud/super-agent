/** Immutable bindings from native owner work to one exact project fact revision. */
import type { DatabaseSync } from 'node:sqlite'
import { isProjectFactKey } from './project-archive-store.js'

export interface WorkFactSource {
  projectId: string
  key: string
  revision: number
  sourceEventSeq: number
  turn: number
}

/** Public provenance for fact-linked work. Neither the fact quote nor a result body belongs here. */
export interface ProjectWorkFactUse extends WorkFactSource {
  current: boolean
  resultSource?: { messageId: string; turn: number; eventSeq: number }
}

// Work owns the original owner Session, request, message, and exact task body. The join keeps one source of truth
// for those fields. Claims are checked in the database as well so even INSERT OR REPLACE cannot rewrite a binding.
export const PROJECT_FACT_USE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_work_fact (
    work_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_project_work (work_id),
    project_id TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (project_id, key, revision) REFERENCES studio_project_fact (project_id, key, revision)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_work_source_message
    ON studio_project_work (leader_session_id, source_message_id);
  CREATE INDEX IF NOT EXISTS studio_project_work_fact_source_event
    ON studio_project_work_fact (source_event_seq);
  CREATE TRIGGER IF NOT EXISTS studio_project_work_fact_no_update BEFORE UPDATE ON studio_project_work_fact BEGIN
    SELECT RAISE(ABORT, 'Studio project work fact bindings are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_fact_no_delete BEFORE DELETE ON studio_project_work_fact BEGIN
    SELECT RAISE(ABORT, 'Studio project work fact bindings are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_fact_guard_insert BEFORE INSERT ON studio_project_work_fact BEGIN
    SELECT RAISE(ABORT, 'FACT_PROJECT_MISMATCH') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      WHERE w.work_id = NEW.work_id AND b.project_id = NEW.project_id);
    SELECT RAISE(ABORT, 'SOURCE_ALREADY_USED') WHERE EXISTS (
      SELECT 1 FROM studio_project_work_fact WHERE work_id = NEW.work_id
    ) OR EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_work other USING (leader_session_id)
      WHERE w.work_id = NEW.work_id AND other.work_id <> w.work_id
        AND (other.source_request_id = w.source_request_id OR other.source_message_id = w.source_message_id)
    ) OR EXISTS (
      SELECT 1 FROM studio_project_work_fact f JOIN studio_project_work other ON other.work_id = f.work_id
      JOIN studio_project_work w USING (leader_session_id)
      WHERE w.work_id = NEW.work_id AND f.source_event_seq = NEW.source_event_seq
    );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_fact_guard_source_insert BEFORE INSERT ON studio_project_work
    WHEN EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_work_fact f USING (work_id)
      WHERE w.work_id = NEW.work_id OR (w.leader_session_id = NEW.leader_session_id
        AND (w.source_request_id = NEW.source_request_id OR w.source_message_id = NEW.source_message_id))
    ) BEGIN
    SELECT RAISE(ABORT, 'SOURCE_ALREADY_USED');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_fact_guard_source_update BEFORE UPDATE ON studio_project_work
    WHEN EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_work_fact f USING (work_id)
      WHERE w.work_id IN (OLD.work_id, NEW.work_id) OR (w.leader_session_id = NEW.leader_session_id
        AND (w.source_request_id = NEW.source_request_id OR w.source_message_id = NEW.source_message_id))
    ) BEGIN
    SELECT RAISE(ABORT, 'SOURCE_ALREADY_USED');
  END;
`

/** Read only the pinned coordinates; the caller checks scope and current evidence in the same transaction. */
export function readWorkFact(db: DatabaseSync, workId: string): WorkFactSource | undefined {
  const row = db.prepare(`SELECT project_id, key, revision, source_event_seq, turn
    FROM studio_project_work_fact WHERE work_id = ?`).get(workId)
  if (!row) return
  const { project_id: projectId, key, revision, source_event_seq: sourceEventSeq, turn } = row
  if (typeof projectId !== 'string' || !projectId || !projectId.isWellFormed() || projectId.includes('\0')
    || !isProjectFactKey(key) || !positiveInteger(revision) || (sourceEventSeq !== 0 && !positiveInteger(sourceEventSeq))
    || !positiveInteger(turn)) throw new Error('Invalid Studio project work fact binding')
  return { projectId, key, revision, sourceEventSeq, turn }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Pin the fact in the same write transaction as the new work row, or abort both writes. */
export function appendWorkFact(db: DatabaseSync, workId: string, source: WorkFactSource): void {
  const { projectId, key, revision, sourceEventSeq, turn } = source
  const { changes } = db.prepare(`INSERT INTO studio_project_work_fact (work_id, project_id, key, revision, source_event_seq, turn)
    VALUES (?, ?, ?, ?, ?, ?)`).run(workId, projectId, key, revision, sourceEventSeq, turn)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project work fact insert did not affect one row')
}
