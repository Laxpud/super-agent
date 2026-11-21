/** Immutable start evidence for post-processing a pinned external job. */
import type { DatabaseSync } from 'node:sqlite'

/** Pause ordering confirmed from stored authorization versions, never from timestamps. */
export type ProjectJobStartEvidence =
  | { kind: 'before-pause'; startAuthorizationVersion: number; pauseAuthorizationVersion: number }
  | { kind: 'during-pause'; authorizationVersion: number }
  | { kind: 'unconfirmed' }

interface ProjectJobStartCoordinates {
  workId: string
  projectId: string
  invocationId: string
  executionEpoch: number
  authorizationVersion: number
  paused: boolean
}

// The dispatch's existing Host write transaction owns the transition and this append. Installing the schema does not backfill history.
export const PROJECT_JOB_START_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_job_start_origin
    ON studio_project_dispatch (work_id, execution_epoch, project_id);
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_job_start_origin
    ON studio_project_job (work_id, attached_project_id, invocation_id);
  CREATE TABLE IF NOT EXISTS studio_project_job_start (
    work_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    project_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL CHECK (length(invocation_id) = 32 AND invocation_id NOT GLOB '*[^0-9a-f]*'
      AND instr(invocation_id, char(0)) = 0 AND invocation_id <> '00000000000000000000000000000000'),
    authorization_version INTEGER NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
    paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
    PRIMARY KEY (work_id, execution_epoch),
    FOREIGN KEY (work_id, execution_epoch, project_id) REFERENCES studio_project_dispatch (work_id, execution_epoch, project_id),
    FOREIGN KEY (work_id, project_id, invocation_id) REFERENCES studio_project_job (work_id, attached_project_id, invocation_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_start_no_update BEFORE UPDATE ON studio_project_job_start BEGIN
    SELECT RAISE(ABORT, 'Studio project job starts are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_start_no_delete BEFORE DELETE ON studio_project_job_start BEGIN
    SELECT RAISE(ABORT, 'Studio project job starts are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_start_guard_insert BEFORE INSERT ON studio_project_job_start BEGIN
    -- REPLACE can skip delete triggers when recursive triggers are off.
    SELECT RAISE(ABORT, 'Studio project job start is already recorded') WHERE EXISTS (
      SELECT 1 FROM studio_project_job_start WHERE work_id = NEW.work_id AND execution_epoch = NEW.execution_epoch
    );
    SELECT RAISE(ABORT, 'Invalid Studio project job start origin') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_dispatch d JOIN managed_host_run h ON h.run_id = d.run_id AND h.singleton = 1 AND h.clean = 0
      JOIN studio_project_job j ON j.work_id = d.work_id AND j.attached_project_id = d.project_id
      WHERE d.work_id = NEW.work_id AND d.execution_epoch = NEW.execution_epoch AND d.project_id = NEW.project_id
        AND d.state = 'running' AND j.state = 'completed' AND j.invocation_id = NEW.invocation_id
        AND j.authorization_version = NEW.authorization_version AND j.paused = NEW.paused
        AND NOT EXISTS (SELECT 1 FROM studio_project_dispatch later WHERE later.work_id = d.work_id
          AND later.execution_epoch > d.execution_epoch)
    );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_job_start_capture AFTER UPDATE OF state ON studio_project_dispatch
    WHEN OLD.state = 'reserved' AND NEW.state = 'running'
      AND EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id) BEGIN
    INSERT INTO studio_project_job_start (work_id, execution_epoch, project_id, invocation_id, authorization_version, paused)
      SELECT j.work_id, NEW.execution_epoch, j.attached_project_id, j.invocation_id, j.authorization_version, j.paused
      FROM studio_project_job j WHERE j.work_id = NEW.work_id AND j.attached_project_id = NEW.project_id;
    -- An inconsistent attachment or ignored insert must abort the state transition, not leave an unaudited start.
    SELECT RAISE(ABORT, 'Cannot record Studio project job start') WHERE changes() <> 1;
  END;
`

const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** Project evidence for the exact latest started or terminal attempt inside the caller's read snapshot. */
export function projectJobStartEvidence(db: DatabaseSync, coordinates: ProjectJobStartCoordinates): ProjectJobStartEvidence | undefined {
  const { workId, projectId, invocationId, executionEpoch, authorizationVersion, paused } = coordinates
  const unconfirmed = { kind: 'unconfirmed' } as const
  if (!isId(workId) || !isId(projectId) || !isId(invocationId) || !/^[0-9a-f]{32}$/.test(invocationId)
    || invocationId === '00000000000000000000000000000000' || !isVersion(executionEpoch) || !isVersion(authorizationVersion)
    || typeof paused !== 'boolean') return unconfirmed

  // Join by the attempt key, not by all evidence fields: a mismatched row is different from a missing legacy row.
  const row = db.prepare(`SELECT d.execution_epoch, d.project_id, d.state, j.attached_project_id, j.invocation_id,
    j.authorization_version, j.paused, s.work_id AS start_work_id, s.project_id AS start_project_id,
    s.invocation_id AS start_invocation_id, s.authorization_version AS start_authorization_version, s.paused AS start_paused
    FROM studio_project_dispatch d JOIN studio_project_job j USING (work_id)
    LEFT JOIN studio_project_job_start s USING (work_id, execution_epoch)
    WHERE d.work_id = ? ORDER BY d.execution_epoch DESC LIMIT 1`).get(workId)
  if (!row || row.execution_epoch !== executionEpoch || row.project_id !== projectId || row.attached_project_id !== projectId
    || row.invocation_id !== invocationId || row.authorization_version !== authorizationVersion || row.paused !== Number(paused)
    || (row.state !== 'running' && row.state !== 'completed' && row.state !== 'failed' && row.state !== 'interrupted')) return unconfirmed
  if (row.start_work_id === null) return paused ? unconfirmed : undefined

  const { start_authorization_version: startVersion, start_paused: startPaused } = row
  if (row.start_work_id !== workId || row.start_project_id !== projectId || row.start_invocation_id !== invocationId
    || !isVersion(startVersion) || startVersion > authorizationVersion || (startPaused !== 0 && startPaused !== 1)
    || (startVersion === authorizationVersion && startPaused !== Number(paused))) return unconfirmed

  // A captured paused flag is not enough on its own. Match the owner's saved pause, including after a later clear.
  const pauseRecord = db.prepare(`SELECT 1 FROM studio_project_job_control
    WHERE work_id = ? AND project_id = ? AND authorization_version = ? AND paused = 1`)
  if (paused && (authorizationVersion < 2 || !pauseRecord.get(workId, projectId, authorizationVersion))) return unconfirmed
  if (startPaused === 1) {
    return startVersion >= 2 && (startVersion === authorizationVersion || pauseRecord.get(workId, projectId, startVersion))
      ? { kind: 'during-pause', authorizationVersion: startVersion } : unconfirmed
  }
  if (paused) return { kind: 'before-pause', startAuthorizationVersion: startVersion, pauseAuthorizationVersion: authorizationVersion }
}
