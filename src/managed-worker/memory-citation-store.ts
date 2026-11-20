import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { PreferenceCitation } from './memory-store.js'

// A citation binds the original revision to the context where it was used, not the preference's original scope.
// Check collisions before INSERT so OR REPLACE cannot erase evidence even with recursive triggers disabled.
export const MEMORY_CITATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_memory_citation (
    citation_id TEXT NOT NULL PRIMARY KEY,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    project_id TEXT REFERENCES studio_project (project_id),
    source_session_id TEXT NOT NULL REFERENCES studio_assistant_binding (session_id),
    command_id TEXT NOT NULL UNIQUE,
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    at TEXT NOT NULL,
    FOREIGN KEY (key, revision) REFERENCES studio_memory_revision (key, revision),
    UNIQUE (source_session_id, source_event_seq)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_memory_citation_no_update BEFORE UPDATE ON studio_memory_citation BEGIN
    SELECT RAISE(ABORT, 'Studio memory citations are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_citation_no_delete BEFORE DELETE ON studio_memory_citation BEGIN
    SELECT RAISE(ABORT, 'Studio memory citations are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_citation_guard_insert BEFORE INSERT ON studio_memory_citation BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory citation or source')
      WHERE EXISTS (SELECT 1 FROM studio_memory_citation WHERE citation_id = NEW.citation_id)
        OR EXISTS (SELECT 1 FROM studio_memory_citation WHERE command_id = NEW.command_id)
        OR EXISTS (SELECT 1 FROM studio_memory_citation
          WHERE source_session_id = NEW.source_session_id AND source_event_seq = NEW.source_event_seq)
        OR EXISTS (SELECT 1 FROM studio_memory_revision WHERE command_id = NEW.command_id)
        OR EXISTS (SELECT 1 FROM studio_memory_revision
          WHERE source_session_id = NEW.source_session_id AND source_event_seq = NEW.source_event_seq);
  END;
  -- Install a separate guard so databases with the original journal trigger also get cross-table protection.
  CREATE TRIGGER IF NOT EXISTS studio_memory_revision_guard_citation_source BEFORE INSERT ON studio_memory_revision BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory source')
      WHERE EXISTS (SELECT 1 FROM studio_memory_citation WHERE command_id = NEW.command_id)
        OR EXISTS (SELECT 1 FROM studio_memory_citation
          WHERE source_session_id = NEW.source_session_id AND source_event_seq = NEW.source_event_seq);
  END;
`

const COLUMNS = 'citation_id, key, revision, project_id, source_session_id, command_id, source_event_seq, at'

/** Read metadata only. Null requires the unprojected scope; undefined leaves scope unchecked for history. */
export function citationRow(db: DatabaseSync, citationId: string, scope?: string | null): Record<string, SQLOutputValue> | undefined {
  const sql = `SELECT ${COLUMNS} FROM studio_memory_citation WHERE citation_id = ?`
  return scope === undefined ? db.prepare(sql).get(citationId) : db.prepare(`${sql} AND project_id IS ?`).get(citationId, scope)
}

/** Persist and verify the exact coordinates inside the caller's write transaction. */
export function appendCitation(db: DatabaseSync, citation: PreferenceCitation): void {
  const { citationId, key, revision, projectId, source: { sessionId, commandId, eventSeq }, at } = citation
  const { changes } = db.prepare(`INSERT INTO studio_memory_citation (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(citationId, key, revision, projectId ?? null, sessionId, commandId, eventSeq, at)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio memory citation append did not affect exactly one row')
  const row = citationRow(db, citationId, projectId ?? null)
  if (!row || row.key !== key || row.revision !== revision || row.source_session_id !== sessionId
    || row.command_id !== commandId || row.source_event_seq !== eventSeq || row.at !== at) {
    throw new Error('Studio memory citation append did not retain exact metadata')
  }
}
