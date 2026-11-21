/** Append-only Studio records of external job references that have not yet been confirmed. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { StudioProjectBinding } from './project-store.js'
import { validSystemdJob, type SystemdJobRef } from './systemd-job.js'

/** One recorded reference, not an observation or permission to dispatch. */
export interface StudioJobCandidate {
  candidateId: string
  workId: string
  ref: SystemdJobRef
  recordedAt: string
}

const candidateTable = 'studio_project_job_candidate'
const latestCandidate = (workId: string) => `SELECT seq FROM ${candidateTable} WHERE work_id = ${workId} ORDER BY seq DESC LIMIT 1`
// Confirmation leaves the history intact. Both the probes and the guards use the same definition of active.
const activeCandidate = (workId: string) => `c.seq = (${latestCandidate(workId)})
  AND NOT EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = c.work_id)`

/** Keep every candidate and its author without reserving the invocation for any work. */
export const PROJECT_JOB_CANDIDATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${candidateTable} (
    seq INTEGER PRIMARY KEY CHECK (seq > 0),
    candidate_id TEXT NOT NULL UNIQUE CHECK (length(candidate_id) = 36 AND instr(candidate_id, char(0)) = 0),
    work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0 AND instr(command_id, char(0)) = 0),
    unit TEXT NOT NULL CHECK (length(unit) > 0 AND instr(unit, char(0)) = 0),
    invocation_id TEXT NOT NULL CHECK (length(invocation_id) > 0 AND instr(invocation_id, char(0)) = 0),
    recorded_at TEXT NOT NULL CHECK (length(recorded_at) > 0 AND instr(recorded_at, char(0)) = 0),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_job_candidate_latest ON ${candidateTable} (work_id, seq DESC);
  ${['UPDATE', 'DELETE'].map(operation => `
    CREATE TRIGGER IF NOT EXISTS ${candidateTable}_no_${operation.toLowerCase()} BEFORE ${operation} ON ${candidateTable} BEGIN
      SELECT RAISE(ABORT, 'Studio project job candidate records are append-only');
    END;`).join('')}
  CREATE TRIGGER IF NOT EXISTS studio_project_job_candidate_guard_record BEFORE INSERT ON ${candidateTable} BEGIN
    -- Guard against INSERT OR REPLACE even on connections without recursive triggers.
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (
      SELECT 1 FROM ${candidateTable} WHERE candidate_id = NEW.candidate_id OR command_id = NEW.command_id OR seq = NEW.seq
    );
    -- Work can retain an earlier Leader as its origin; only the current Leader may append a candidate.
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_work w JOIN studio_project_binding origin ON origin.leader_session_id = w.leader_session_id
      JOIN studio_project p ON p.project_id = origin.project_id
      JOIN studio_project_binding author ON author.project_id = p.project_id AND author.management_epoch = p.management_epoch
      WHERE w.work_id = NEW.work_id AND p.project_id = NEW.project_id AND p.management_epoch = NEW.management_epoch
        AND author.leader_session_id = NEW.leader_session_id
    );
    SELECT RAISE(ABORT, 'EXTERNAL_JOB_ALREADY_ATTACHED') WHERE EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id);
    SELECT RAISE(ABORT, 'WORK_HAS_DOCUMENT_TASK') WHERE EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.work_id);
    SELECT RAISE(ABORT, 'WORK_ALREADY_DISPATCHED') WHERE EXISTS (
      SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND state <> 'released'
    );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_candidate_append_order AFTER INSERT ON ${candidateTable} BEGIN
    SELECT RAISE(ABORT, 'Studio project job candidates must be appended in order')
      WHERE NEW.seq <> (${latestCandidate('NEW.work_id')});
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_candidate_guard_dispatch BEFORE INSERT ON studio_project_dispatch
    WHEN EXISTS (SELECT 1 FROM ${candidateTable} c WHERE ${activeCandidate('NEW.work_id')}) BEGIN
    SELECT RAISE(ABORT, 'EXTERNAL_JOB_NOT_CONFIRMED');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_candidate_guard_start BEFORE UPDATE OF state, work_id ON studio_project_dispatch
    WHEN NEW.state IN ('reserved', 'running') AND EXISTS (SELECT 1 FROM ${candidateTable} c WHERE ${activeCandidate('NEW.work_id')}) BEGIN
    SELECT RAISE(ABORT, 'EXTERNAL_JOB_NOT_CONFIRMED');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_candidate_guard_confirm BEFORE INSERT ON studio_project_job
    WHEN EXISTS (SELECT 1 FROM ${candidateTable} c WHERE ${activeCandidate('NEW.work_id')}
      AND (c.unit IS NOT NEW.unit OR c.invocation_id IS NOT NEW.invocation_id)) BEGIN
    SELECT RAISE(ABORT, 'STALE_JOB_REFERENCE');
  END;
`

const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isCandidateId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const isTimestamp = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

/** Read only the latest unconfirmed reference. The caller is responsible for authorizing access to the detail. */
export function readJobCandidate(db: DatabaseSync, projectId: string, workId: string): StudioJobCandidate | undefined {
  // Find the latest row before checking its project, so a mismatched row cannot fall back to an older reference.
  const row = db.prepare(`SELECT c.candidate_id, c.work_id, c.unit, c.invocation_id, c.recorded_at, c.command_id,
    c.leader_session_id, c.management_epoch, (c.project_id = ? AND c.project_id = origin.project_id) AS in_project,
    author.leader_session_id IS NOT NULL AS has_author
    FROM ${candidateTable} c LEFT JOIN studio_project_work w ON w.work_id = c.work_id
    LEFT JOIN studio_project_binding origin ON origin.leader_session_id = w.leader_session_id
    LEFT JOIN studio_project_binding author ON author.project_id = c.project_id AND author.management_epoch = c.management_epoch
      AND author.leader_session_id = c.leader_session_id
    WHERE ${activeCandidate('?')}`).get(projectId, workId)
  if (!row) return
  const { candidate_id: candidateId, work_id: storedWorkId, unit, invocation_id: invocationId, recorded_at: recordedAt } = row
  if (row.in_project !== 1 || row.has_author !== 1 || !isId(projectId) || !isId(storedWorkId) || storedWorkId !== workId
    || !isId(row.leader_session_id) || !isEpoch(row.management_epoch) || !isId(row.command_id) || !isCandidateId(candidateId)
    || typeof unit !== 'string' || typeof invocationId !== 'string' || !validSystemdJob({ unit, invocationId }) || !isTimestamp(recordedAt)) {
    throw new Error('Invalid Studio project job candidate')
  }
  return { candidateId, workId, ref: { unit, invocationId }, recordedAt }
}

/** Non-detail reads and dispatch checks need only know whether an unconfirmed candidate is active. */
export function hasJobCandidate(db: DatabaseSync, workId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${candidateTable} c WHERE ${activeCandidate('?')}`).get(workId)
}

/** Command IDs remain spent after replacement or confirmation. */
export function jobCandidateCommandUsed(db: DatabaseSync, commandId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${candidateTable} WHERE command_id = ?`).get(commandId)
}

/** Append without confirming the job or changing dispatch state. The caller checks the expected candidate and command under its write fence. */
export function appendJobCandidate(db: DatabaseSync, actor: StudioProjectBinding, workId: string, commandId: string,
  ref: SystemdJobRef): StudioJobCandidate {
  const { projectId, leaderSessionId, managementEpoch } = actor
  const { unit, invocationId } = ref
  if (!isId(projectId) || !isId(leaderSessionId) || !isEpoch(managementEpoch) || !isId(workId) || !isId(commandId)
    || !validSystemdJob({ unit, invocationId })) throw new Error('Invalid Studio project job candidate input')
  const candidateId = randomUUID()
  const recordedAt = new Date().toISOString()
  const { changes } = db.prepare(`INSERT INTO ${candidateTable} (candidate_id, work_id, project_id, leader_session_id,
    management_epoch, command_id, unit, invocation_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(candidateId, workId, projectId, leaderSessionId, managementEpoch, commandId, unit, invocationId, recordedAt)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project job candidate append did not affect exactly one row')
  return { candidateId, workId, ref: { unit, invocationId }, recordedAt }
}
