/** Append-only Studio document revisions on the managed Worker Store connection. */
import type { DatabaseSync } from 'node:sqlite'

export interface SharedDocumentRevision {
  documentId: string
  version: number
  text: string
}

export interface SharedDocumentTask {
  documentId: string
  baseVersion: number
  headVersion: number
  committedVersion?: number
}

// Tool revisions precede the local write and audit insert. The deferred foreign key requires the audit before commit.
export const SHARED_DOCUMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_shared_document_revision (
    document_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
    text TEXT NOT NULL,
    session_id TEXT NOT NULL,
    command_id TEXT UNIQUE,
    task_id TEXT REFERENCES studio_shared_document_task (task_id),
    tool_call_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (document_id, version),
    UNIQUE (session_id, tool_call_id),
    FOREIGN KEY (session_id, tool_call_id) REFERENCES managed_audit (session_id, tool_call_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK ((command_id IS NOT NULL AND task_id IS NULL AND tool_call_id IS NULL)
      OR (command_id IS NULL AND task_id IS NOT NULL AND tool_call_id IS NOT NULL AND version > 1))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_shared_document_task (
    task_id TEXT PRIMARY KEY REFERENCES managed_task (task_id),
    document_id TEXT NOT NULL,
    base_version INTEGER NOT NULL,
    committed_version INTEGER CHECK (committed_version = base_version + 1),
    FOREIGN KEY (document_id, base_version) REFERENCES studio_shared_document_revision (document_id, version),
    FOREIGN KEY (document_id, committed_version) REFERENCES studio_shared_document_revision (document_id, version)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_shared_document_revision_append
    BEFORE INSERT ON studio_shared_document_revision
    WHEN NEW.version <> COALESCE((SELECT MAX(version) FROM studio_shared_document_revision
      WHERE document_id = NEW.document_id), 0) + 1
      OR EXISTS (SELECT 1 FROM studio_shared_document_revision
        WHERE command_id = NEW.command_id OR (session_id = NEW.session_id AND tool_call_id = NEW.tool_call_id))
    BEGIN SELECT RAISE(ABORT, 'Shared document revisions must append without replacing an earlier revision'); END;
  CREATE TRIGGER IF NOT EXISTS studio_shared_document_revision_no_update
    BEFORE UPDATE ON studio_shared_document_revision
    BEGIN SELECT RAISE(ABORT, 'Shared document revisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_shared_document_revision_no_delete
    BEFORE DELETE ON studio_shared_document_revision
    BEGIN SELECT RAISE(ABORT, 'Shared document revisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS studio_shared_document_local_commit
    BEFORE UPDATE OF document_version, text ON managed_document
    WHEN EXISTS (SELECT 1 FROM studio_shared_document_task WHERE task_id = OLD.task_id)
      AND (OLD.document_version <> 1 OR NEW.document_version <> 2 OR NEW.task_id <> OLD.task_id OR NOT EXISTS (
        SELECT 1 FROM studio_shared_document_task AS link
        JOIN studio_shared_document_revision AS revision ON revision.document_id = link.document_id
          AND revision.version = link.committed_version AND revision.task_id = link.task_id
        JOIN managed_task AS task ON task.task_id = link.task_id
        JOIN managed_session_binding AS binding ON binding.task_id = task.task_id
          AND binding.execution_epoch = task.execution_epoch AND binding.session_id = revision.session_id
        WHERE link.task_id = OLD.task_id AND revision.tool_call_id IS NOT NULL AND task.paused = 0
          AND revision.text = NEW.text COLLATE BINARY AND task.approved_text = NEW.text COLLATE BINARY
          AND revision.version = (SELECT MAX(version) FROM studio_shared_document_revision WHERE document_id = link.document_id)
      ))
    BEGIN SELECT RAISE(ABORT, 'Shared document commit requires a matching shared revision'); END;
`

/** An owner command or a specific Worker tool call owns the provenance of each revision. */
type RevisionSource = { sessionId: string; commandId: string } | { sessionId: string; taskId: string; toolCallId: string }

/** Read the exact immutable revision, or the highest version when reading the head. */
export function readSharedRevision(db: DatabaseSync, documentId: string, version?: number): SharedDocumentRevision | undefined {
  const row = version === undefined
    ? db.prepare(`SELECT version, text FROM studio_shared_document_revision WHERE document_id = ? ORDER BY version DESC LIMIT 1`).get(documentId)
    : db.prepare('SELECT version, text FROM studio_shared_document_revision WHERE document_id = ? AND version = ?').get(documentId, version)
  if (!row) return
  if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.text !== 'string') {
    throw new Error('Invalid Studio shared document revision')
  }
  return { documentId, version: row.version, text: row.text }
}

/** Append under the Store write lock. The expected next version must still follow the SQLite head. */
export function appendSharedRevision(db: DatabaseSync, revision: SharedDocumentRevision, source: RevisionSource): number | bigint {
  const owner = 'commandId' in source
  return db.prepare(`INSERT INTO studio_shared_document_revision
    (document_id, version, text, session_id, command_id, task_id, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(revision.documentId, revision.version, revision.text, source.sessionId, owner ? source.commandId : null,
      owner ? null : source.taskId, owner ? null : source.toolCallId, new Date().toISOString()).changes
}
