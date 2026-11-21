/** Append-only owner decisions to hold or clear standalone Studio text work. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { StudioProjectBinding } from './project-store.js'

/** Maximum length of each block or clear text, in UTF-16 code units. */
export const PROJECT_WORK_BLOCK_TEXT_LIMIT = 1000

/** The latest block and its exact clear, if any. Clear text records the owner's report, not verified evidence. */
export interface ProjectWorkBlockView {
  blockId: string
  leaderSessionId: string
  managementEpoch: number
  reason: string
  resumeWhen: string
  recordedAt: string
  cleared?: {
    leaderSessionId: string
    managementEpoch: number
    change: string
    recordedAt: string
  }
}

type Actor = Pick<StudioProjectBinding, 'projectId' | 'leaderSessionId' | 'managementEpoch'>
const blockTable = 'studio_project_work_block'
const clearTable = 'studio_project_work_block_clear'
const latestBlock = (workId: string) => `SELECT seq FROM ${blockTable} WHERE work_id = ${workId} ORDER BY seq DESC LIMIT 1`
const activeBlock = (workId: string) => `SELECT 1 FROM ${blockTable} b WHERE b.seq = (${latestBlock(workId)})
  AND NOT EXISTS (SELECT 1 FROM ${clearTable} x WHERE x.block_id = b.block_id)`

// A clear can only target an active record; a new block can only follow a clear. The latest-index probe
// therefore answers both status and uniqueness without scanning all preceding decisions.
export const PROJECT_WORK_BLOCK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${blockTable} (
    seq INTEGER PRIMARY KEY,
    block_id TEXT NOT NULL UNIQUE,
    work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    reason TEXT NOT NULL,
    resume_when TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0),
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_work_block_latest ON ${blockTable} (work_id, seq DESC);
  CREATE TABLE IF NOT EXISTS ${clearTable} (
    block_id TEXT NOT NULL PRIMARY KEY REFERENCES ${blockTable} (block_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    change TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0),
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
  ${[blockTable, clearTable].flatMap(table => ['UPDATE', 'DELETE'].map(operation => `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${table} BEGIN
      SELECT RAISE(ABORT, 'Studio project work block records are append-only');
    END;`)).join('')}
  CREATE TRIGGER IF NOT EXISTS studio_project_work_block_guard_record BEFORE INSERT ON ${blockTable} BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (SELECT 1 FROM ${clearTable} WHERE command_id = NEW.command_id)
      OR EXISTS (SELECT 1 FROM ${blockTable} WHERE block_id = NEW.block_id OR command_id = NEW.command_id OR seq = NEW.seq);
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      JOIN studio_project p USING (project_id)
      WHERE w.work_id = NEW.work_id AND p.project_id = NEW.project_id AND p.management_epoch = NEW.management_epoch
    );
    SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCK_ALREADY_ACTIVE') WHERE EXISTS (${activeBlock('NEW.work_id')});
    SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCK_TEXT_ONLY') WHERE EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.work_id)
      OR EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id);
    SELECT RAISE(ABORT, 'WORK_ALREADY_DISPATCHED') WHERE EXISTS (
      SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND state <> 'released' AND state <> 'reserved'
    );
  END;
  -- The append and release have one commit boundary. Releasing never changes a spend or a terminal outcome.
  CREATE TRIGGER IF NOT EXISTS studio_project_work_block_release AFTER INSERT ON ${blockTable} BEGIN
    SELECT RAISE(ABORT, 'Studio project work block decisions must be appended in order')
      WHERE NEW.seq <> (${latestBlock('NEW.work_id')});
    UPDATE studio_project_dispatch SET state = 'released', failure = 'PROJECT_WORK_BLOCKED'
      WHERE work_id = NEW.work_id AND state = 'reserved';
    SELECT RAISE(ABORT, 'Cannot release blocked Studio project reservation') WHERE EXISTS (
      SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND state = 'reserved'
    );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_block_guard_clear BEFORE INSERT ON ${clearTable} BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (SELECT 1 FROM ${blockTable} WHERE command_id = NEW.command_id)
      OR EXISTS (SELECT 1 FROM ${clearTable} WHERE command_id = NEW.command_id);
    SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCK_NOT_CURRENT') WHERE NOT EXISTS (
      SELECT 1 FROM ${blockTable} b JOIN studio_project p USING (project_id)
      WHERE b.block_id = NEW.block_id AND p.project_id = NEW.project_id AND p.management_epoch = NEW.management_epoch
        AND b.seq = (${latestBlock('b.work_id')})
        AND NOT EXISTS (SELECT 1 FROM ${clearTable} WHERE block_id = b.block_id)
    );
  END;
  ${['document', 'job'].flatMap(kind => [['insert', 'INSERT'], ['update', 'UPDATE OF work_id']].map(([name, operation]) => `
    CREATE TRIGGER IF NOT EXISTS studio_project_work_block_guard_${kind}_${name} BEFORE ${operation} ON studio_project_${kind}
      WHEN EXISTS (${activeBlock('NEW.work_id')}) BEGIN
      SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCKED');
    END;`)).join('')}
  CREATE TRIGGER IF NOT EXISTS studio_project_work_block_guard_dispatch BEFORE INSERT ON studio_project_dispatch
    WHEN EXISTS (${activeBlock('NEW.work_id')}) BEGIN
    SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCKED');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_work_block_guard_start BEFORE UPDATE OF state ON studio_project_dispatch
    WHEN NEW.state IN ('reserved', 'running') AND EXISTS (${activeBlock('NEW.work_id')}) BEGIN
    SELECT RAISE(ABORT, 'PROJECT_WORK_BLOCKED');
  END;
`

export function isProjectWorkBlockText(value: unknown): value is string {
  // Trimming is only a blank check. The original text is bound verbatim to SQLite.
  return typeof value === 'string' && value.length <= PROJECT_WORK_BLOCK_TEXT_LIMIT && value.isWellFormed()
    && !value.includes('\0') && value.trim().length > 0
}

const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Dispatch and non-owner views read only the state, never the decision text. */
export function latestWorkBlockState(db: DatabaseSync, workId: string): 'active' | 'cleared' | undefined {
  const row = db.prepare(`SELECT EXISTS (SELECT 1 FROM ${clearTable} WHERE block_id = b.block_id) AS cleared
    FROM ${blockTable} b WHERE b.seq = (${latestBlock('?')})`).get(workId)
  return row && (row.cleared === 1 ? 'cleared' : 'active')
}

/** The caller has checked current owner authority and exact work membership under its snapshot or write lock. */
export function latestWorkBlock(db: DatabaseSync, workId: string): ProjectWorkBlockView | undefined {
  const row = db.prepare(`SELECT b.block_id, b.leader_session_id, b.management_epoch, b.reason, b.resume_when, b.recorded_at,
    x.leader_session_id AS cleared_by, x.management_epoch AS cleared_epoch, x.change, x.recorded_at AS cleared_at
    FROM ${blockTable} b LEFT JOIN ${clearTable} x USING (block_id) WHERE b.seq = (${latestBlock('?')})`).get(workId)
  if (!row) return
  const { block_id: blockId, leader_session_id: leaderSessionId, management_epoch: managementEpoch, reason,
    resume_when: resumeWhen, recorded_at: recordedAt, cleared_by: clearedBy, cleared_epoch: clearedEpoch, change, cleared_at: clearedAt } = row
  if (!isId(blockId) || !isId(leaderSessionId) || !isEpoch(managementEpoch) || !isProjectWorkBlockText(reason)
    || !isProjectWorkBlockText(resumeWhen) || !isId(recordedAt)) throw new Error('Invalid Studio project work block record')
  const block: ProjectWorkBlockView = { blockId, leaderSessionId, managementEpoch, reason, resumeWhen, recordedAt }
  if (clearedBy !== null) {
    if (!isId(clearedBy) || !isEpoch(clearedEpoch) || !isProjectWorkBlockText(change) || !isId(clearedAt)) {
      throw new Error('Invalid Studio project work block clear record')
    }
    block.cleared = { leaderSessionId: clearedBy, managementEpoch: clearedEpoch, change, recordedAt: clearedAt }
  }
  return block
}

export function projectWorkBlockCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${blockTable} WHERE command_id = ? UNION ALL
    SELECT 1 FROM ${clearTable} WHERE command_id = ? LIMIT 1`).get(commandId, commandId)
}

function requireAppend(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project work block append did not affect exactly one row')
}

/** Append the hold and release any reservation in the caller's run-fenced write transaction. */
export function appendWorkBlock(db: DatabaseSync, actor: Actor, workId: string, reason: string, resumeWhen: string,
  commandId: string): ProjectWorkBlockView {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const blockId = randomUUID()
  const recordedAt = new Date().toISOString()
  requireAppend(db.prepare(`INSERT INTO ${blockTable} (block_id, work_id, project_id, leader_session_id, management_epoch,
    reason, resume_when, command_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(blockId, workId, projectId, leaderSessionId, managementEpoch, reason, resumeWhen, commandId, recordedAt).changes)
  return { blockId, leaderSessionId, managementEpoch, reason, resumeWhen, recordedAt }
}

/** Append only the clear receipt; no dispatch authority is granted or restored. */
export function appendWorkBlockClear(db: DatabaseSync, actor: Actor, block: ProjectWorkBlockView, change: string,
  commandId: string): ProjectWorkBlockView {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const recordedAt = new Date().toISOString()
  requireAppend(db.prepare(`INSERT INTO ${clearTable} (block_id, project_id, leader_session_id, management_epoch,
    change, command_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(block.blockId, projectId, leaderSessionId, managementEpoch, change, commandId, recordedAt).changes)
  return { ...block, cleared: { leaderSessionId, managementEpoch, change, recordedAt } }
}
