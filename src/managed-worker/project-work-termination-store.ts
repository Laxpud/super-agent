/** Append-only Host observations of native transport terminations for standalone project Workers. */
import type { DatabaseSync } from 'node:sqlite'
import { types } from 'node:util'
import type { StudioProjectRun } from './project-store.js'

/** The Host relays the coordinates of the input message and native terminal event, never their bodies. */
export interface ProjectWorkTerminationInput {
  workerSessionId: string
  turn: number
  messageId: string
  messageEventSeq: number
  endEventSeq: number
  code: 'TRANSPORT'
}

/** Dispatch provenance safe to expose without a message ID, result, or error details. */
export interface ProjectWorkTermination {
  turn: number
  endEventSeq: number
  code: 'TRANSPORT'
}

type TerminationTarget = Pick<StudioProjectRun, 'workId' | 'projectId' | 'executionEpoch' | 'workerSessionId'>
type TerminationDispatch = TerminationTarget & Pick<StudioProjectRun, 'leaderSessionId' | 'managementEpoch' | 'workerBotId'>
const TABLE = 'studio_project_work_termination'
const DISPATCH_KEY = ['work_id', 'execution_epoch', 'project_id', 'leader_session_id', 'management_epoch',
  'worker_session_id', 'worker_bot_id', 'run_id'] as const
const matchDispatch = (record: string) => DISPATCH_KEY.map(column => `d.${column} = ${record}.${column}`).join(' AND ')

// Keep the complete dispatch identity immutable without constraining later changes to its business state.
export const PROJECT_WORK_TERMINATION_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_termination_identity
    ON studio_project_dispatch (${DISPATCH_KEY.join(', ')});
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    work_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    worker_session_id TEXT NOT NULL,
    worker_bot_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    message_id TEXT NOT NULL CHECK (length(message_id) > 0 AND instr(message_id, char(0)) = 0),
    message_event_seq INTEGER NOT NULL CHECK (message_event_seq BETWEEN 0 AND 9007199254740991),
    end_event_seq INTEGER NOT NULL CHECK (end_event_seq BETWEEN 1 AND 9007199254740991 AND end_event_seq > message_event_seq),
    code TEXT NOT NULL CHECK (code = 'TRANSPORT'),
    PRIMARY KEY (work_id, execution_epoch),
    UNIQUE (worker_session_id, end_event_seq),
    FOREIGN KEY (${DISPATCH_KEY.join(', ')}) REFERENCES studio_project_dispatch (${DISPATCH_KEY.join(', ')})
  ) STRICT, WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_update BEFORE UPDATE ON ${TABLE} BEGIN
    SELECT RAISE(ABORT, 'Studio project work terminations are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_delete BEFORE DELETE ON ${TABLE} BEGIN
    SELECT RAISE(ABORT, 'Studio project work terminations are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS ${TABLE}_guard_insert BEFORE INSERT ON ${TABLE} BEGIN
    SELECT RAISE(ABORT, 'DUPLICATE_WORK_TERMINATION') WHERE EXISTS (
      SELECT 1 FROM ${TABLE} WHERE (work_id = NEW.work_id AND execution_epoch = NEW.execution_epoch)
        OR (worker_session_id = NEW.worker_session_id AND end_event_seq = NEW.end_event_seq)
    );
    SELECT RAISE(ABORT, 'WORK_NOT_RUNNING') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_dispatch d JOIN managed_host_run h ON h.singleton = 1 AND h.run_id = d.run_id AND h.clean = 0
      JOIN studio_project_work w ON w.work_id = d.work_id
      JOIN studio_project_binding b ON b.leader_session_id = w.leader_session_id AND b.project_id = d.project_id
      WHERE ${matchDispatch('NEW')} AND d.state = 'running'
    );
    SELECT RAISE(ABORT, 'WORK_TERMINATION_TEXT_ONLY')
      WHERE EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = NEW.work_id)
         OR EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = NEW.work_id);
  END;
`

const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const INPUT_KEYS = ['workerSessionId', 'turn', 'messageId', 'messageEventSeq', 'endEventSeq', 'code'] as const

/** Copy exact native coordinates without invoking accessors or accepting extra payload fields. */
export function readWorkTerminationInput(value: unknown): ProjectWorkTerminationInput | undefined {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== INPUT_KEYS.length) return
  const [workerSessionId, turn, messageId, messageEventSeq, endEventSeq, code] = INPUT_KEYS.map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key)
    return field && Object.hasOwn(field, 'value') ? field.value as unknown : undefined
  })
  if (!isId(workerSessionId) || !isPositiveInteger(turn) || !isId(messageId)
    || (messageEventSeq !== 0 && !isPositiveInteger(messageEventSeq)) || !isPositiveInteger(endEventSeq)
    || endEventSeq <= messageEventSeq || code !== 'TRANSPORT') return
  return { workerSessionId, turn, messageId, messageEventSeq, endEventSeq, code }
}

/** Read only the safe fields from the exact dispatch, whether it is running or historical. */
export function readWorkTermination(db: DatabaseSync, { workId, projectId, executionEpoch, workerSessionId }: TerminationTarget):
  ProjectWorkTermination | undefined {
  if (!isId(workId) || !isId(projectId) || !isPositiveInteger(executionEpoch) || !isId(workerSessionId)) return
  const row = db.prepare(`SELECT t.turn, t.end_event_seq AS endEventSeq, t.code
    FROM ${TABLE} t JOIN studio_project_dispatch d ON ${matchDispatch('t')}
    JOIN studio_project_work w ON w.work_id = d.work_id
    JOIN studio_project_binding b ON b.leader_session_id = w.leader_session_id AND b.project_id = d.project_id
    WHERE t.work_id = ? AND t.execution_epoch = ? AND t.project_id = ? AND t.worker_session_id = ?`)
    .get(workId, executionEpoch, projectId, workerSessionId)
  if (!row) return
  const { turn, endEventSeq, code } = row
  if (!isPositiveInteger(turn) || !isPositiveInteger(endEventSeq) || code !== 'TRANSPORT') {
    throw new Error('Invalid Studio project work termination')
  }
  return { turn, endEventSeq, code }
}

/** Append evidence inside the caller's Host-fenced write transaction; do not settle or release the Worker. */
export function appendWorkTermination(db: DatabaseSync, dispatch: TerminationDispatch, runId: string, input: ProjectWorkTerminationInput): void {
  const { workId, executionEpoch, projectId, leaderSessionId, managementEpoch, workerSessionId, workerBotId } = dispatch
  const { turn, messageId, messageEventSeq, endEventSeq, code } = input
  const { changes } = db.prepare(`INSERT INTO ${TABLE} (${DISPATCH_KEY.join(', ')}, turn, message_id, message_event_seq, end_event_seq, code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workId, executionEpoch, projectId, leaderSessionId, managementEpoch,
    workerSessionId, workerBotId, runId, turn, messageId, messageEventSeq, endEventSeq, code)
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project work termination insert did not affect one row')
}
