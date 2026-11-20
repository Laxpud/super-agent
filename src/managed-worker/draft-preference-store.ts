import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { isMemoryKey, isPreferenceText } from './memory-store.js'

// Store only the citation pointer. A citation can be reused by another task, but a task's pointer cannot change.
export const DRAFT_PREFERENCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_draft_preference (
    task_id TEXT NOT NULL PRIMARY KEY REFERENCES studio_draft_task (task_id),
    citation_id TEXT NOT NULL REFERENCES studio_memory_citation (citation_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_draft_preference_no_update BEFORE UPDATE ON studio_draft_preference BEGIN
    SELECT RAISE(ABORT, 'Studio draft preferences are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_draft_preference_no_delete BEFORE DELETE ON studio_draft_preference BEGIN
    SELECT RAISE(ABORT, 'Studio draft preferences are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_draft_preference_guard_insert BEFORE INSERT ON studio_draft_preference BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio draft preference')
      WHERE EXISTS (SELECT 1 FROM studio_draft_preference WHERE task_id = NEW.task_id);
  END;
`

/** Metadata for the pinned revision, even after it stops being eligible for this unprojected task. */
export interface StudioDraftPreference {
  citationId: string
  key: string
  revision: number
  current: boolean
}

// Both the citation's original use context and the exact journal/head revision must still be global.
const CURRENT = `c.project_id IS NULL AND EXISTS (
  SELECT 1 FROM studio_memory_head h JOIN studio_memory_revision r ON r.key = h.key AND r.revision = h.revision
  WHERE h.key = c.key AND h.revision = c.revision AND h.state = 'active' AND h.project_id IS NULL
    AND r.state = h.state AND r.project_id IS h.project_id
)`

function readPreference(row: Record<string, SQLOutputValue>): StudioDraftPreference {
  const { citation_id: citationId, key, revision, current } = row
  if (typeof citationId !== 'string' || !citationId.length || !isMemoryKey(key)
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || (current !== 0 && current !== 1)) {
    throw new Error('Invalid Studio draft preference')
  }
  return { citationId, key, revision, current: current === 1 }
}

/** Validate an unprojected citation in the caller's write transaction, without reading preference text. */
export function currentDraftCitation(db: DatabaseSync, citationId: string): StudioDraftPreference | undefined {
  const row = db.prepare(`SELECT c.citation_id, c.key, c.revision, 1 AS current
    FROM studio_memory_citation c WHERE c.citation_id = ? AND ${CURRENT}`).get(citationId)
  return row && readPreference(row)
}

/** Read only metadata. A broken foreign key must not make a pinned task look uncited. */
export function pinnedDraftPreference(db: DatabaseSync, taskId: string): StudioDraftPreference | undefined {
  const row = db.prepare(`SELECT p.citation_id, c.key, c.revision, (${CURRENT}) AS current
    FROM studio_draft_preference p LEFT JOIN studio_memory_citation c ON c.citation_id = p.citation_id
    WHERE p.task_id = ?`).get(taskId)
  return row && readPreference(row)
}

/** Pin the citation and verify the exact pointer in the same write transaction as the task reservation. */
export function appendDraftPreference(db: DatabaseSync, taskId: string, preference: StudioDraftPreference): void {
  const { changes } = db.prepare('INSERT INTO studio_draft_preference (task_id, citation_id) VALUES (?, ?)')
    .run(taskId, preference.citationId)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio draft preference append did not affect exactly one row')
  const pinned = pinnedDraftPreference(db, taskId)
  if (!pinned?.current || pinned.citationId !== preference.citationId || pinned.key !== preference.key || pinned.revision !== preference.revision) {
    throw new Error('Studio draft preference append did not retain the exact current citation')
  }
}

/** Read the pinned body only after a metadata check in the same fenced snapshot. */
export function draftPreferenceText(db: DatabaseSync, preference: StudioDraftPreference): string {
  if (!preference.current) throw new Error('Studio draft preference is not current')
  const text = db.prepare('SELECT text FROM studio_memory_revision WHERE key = ? AND revision = ?')
    .get(preference.key, preference.revision)?.text
  if (!isPreferenceText(text)) throw new Error('Invalid Studio draft preference text')
  return text
}
