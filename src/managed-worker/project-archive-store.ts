/** Append-only project facts backed by excerpts of saved standalone Worker results. */
import { createHash } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { isPreferenceText } from './memory-store.js'
import type { ProjectStore } from './project-store.js'
import type { ManagedResult } from './store.ts'

/** Maximum exact quote length in UTF-16 code units. */
export const PROJECT_FACT_QUOTE_LIMIT = 1200
const PAGE_SIZE = 8

/** A fact key is a project-local, lowercase ASCII identifier. */
export function isProjectFactKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

/** Check the quote without changing it. Recognizable credentials are rejected, but arbitrary secrets cannot be detected. */
export function isProjectFactQuote(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PROJECT_FACT_QUOTE_LIMIT && isPreferenceText(value)
}

/** Metadata for one revision: the Leader's save receipt and the original Worker's result coordinates. */
export interface ProjectFact {
  projectId: string
  key: string
  revision: number
  leaderSessionId: string
  managementEpoch: number
  commandId: string
  at: string
  workId: string
  executionEpoch: number
  workerSessionId: string
  workerBotId: string
  messageId: string
  turn: number
  eventSeq: number
}

interface SaveProjectFactInput {
  key: string
  expectedEpoch: number
  expectedRevision: number
  workId: string
  quote: string
}

// The primary key serves both key-ordered pages and exact head/history lookups. No quote or result text is copied here.
export const PROJECT_ARCHIVE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_project_fact (
    project_id TEXT NOT NULL,
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
      AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    command_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    work_id TEXT NOT NULL,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    worker_session_id TEXT NOT NULL,
    worker_bot_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn INTEGER NOT NULL CHECK (turn BETWEEN 1 AND 9007199254740991),
    event_seq INTEGER NOT NULL CHECK (event_seq BETWEEN 0 AND 9007199254740991),
    quote_offset INTEGER NOT NULL CHECK (quote_offset BETWEEN 0 AND 9007199254740991),
    quote_length INTEGER NOT NULL CHECK (quote_length BETWEEN 1 AND ${PROJECT_FACT_QUOTE_LIMIT}),
    result_digest TEXT NOT NULL CHECK (length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (project_id, key, revision),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
    FOREIGN KEY (work_id, execution_epoch) REFERENCES studio_project_dispatch (work_id, execution_epoch)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_project_fact_no_update BEFORE UPDATE ON studio_project_fact BEGIN
    SELECT RAISE(ABORT, 'Studio project facts are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_fact_no_delete BEFORE DELETE ON studio_project_fact BEGIN
    SELECT RAISE(ABORT, 'Studio project facts are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_project_fact_guard_insert BEFORE INSERT ON studio_project_fact BEGIN
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project WHERE project_id = NEW.project_id AND management_epoch = NEW.management_epoch);
    SELECT RAISE(ABORT, 'FACT_REVISION_CONFLICT') WHERE NEW.revision <> 1 + COALESCE((
      SELECT MAX(revision) FROM studio_project_fact WHERE project_id = NEW.project_id AND key = NEW.key), 0);
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (
      SELECT 1 FROM studio_project_fact WHERE command_id = NEW.command_id);
    SELECT RAISE(ABORT, 'FACT_EVIDENCE_UNAVAILABLE') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project_dispatch WHERE work_id = NEW.work_id AND execution_epoch = NEW.execution_epoch
        AND project_id = NEW.project_id AND worker_session_id = NEW.worker_session_id
        AND worker_bot_id = NEW.worker_bot_id AND state = 'completed');
  END;
`

interface ProjectArchiveAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  authority: ProjectStore['adviceAuthority']
  workEvidence: ProjectStore['workEvidence']
}

type Row = Record<string, SQLOutputValue>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isNonnegativeInteger = (value: unknown): value is number => value === 0 || isPositiveInteger(value)
const resultDigest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const FACT_METADATA = `project_id, key, revision, leader_session_id, management_epoch, command_id, at,
  work_id, execution_epoch, worker_session_id, worker_bot_id, message_id, turn, event_seq`

/** Copy only the five supplied own data fields before entering the write transaction. */
function saveInput(value: unknown): SaveProjectFactInput | undefined {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== 5) return
  const data: Record<string, unknown> = Object.create(null)
  for (const key of ['key', 'expectedEpoch', 'expectedRevision', 'workId', 'quote']) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return
    data[key] = field.value
  }
  const { key, expectedEpoch, expectedRevision, workId, quote } = data
  if (isProjectFactKey(key) && isPositiveInteger(expectedEpoch) && isNonnegativeInteger(expectedRevision)
    && isId(workId) && isProjectFactQuote(quote)) return { key, expectedEpoch, expectedRevision, workId, quote }
}

/** Decode only public metadata. Offset, length, and digest are private to head reads. */
function readFact(row: Row): ProjectFact {
  const { project_id: projectId, key, revision, leader_session_id: leaderSessionId, management_epoch: managementEpoch,
    command_id: commandId, at, work_id: workId, execution_epoch: executionEpoch, worker_session_id: workerSessionId,
    worker_bot_id: workerBotId, message_id: messageId, turn, event_seq: eventSeq } = row
  if (!isId(projectId) || !isProjectFactKey(key) || !isPositiveInteger(revision) || !isId(leaderSessionId)
    || !isPositiveInteger(managementEpoch) || !isId(commandId) || !isId(at) || !isId(workId)
    || !isPositiveInteger(executionEpoch) || !isId(workerSessionId) || !isId(workerBotId) || !isId(messageId)
    || !isPositiveInteger(turn) || !isNonnegativeInteger(eventSeq)) throw new Error('Invalid Studio project fact')
  return { projectId, key, revision, leaderSessionId, managementEpoch, commandId, at, workId, executionEpoch,
    workerSessionId, workerBotId, messageId, turn, eventSeq }
}

/** Internal facet. Scope comes from the current Leader Session in the parent Store's transaction. */
export class ProjectArchiveStore {
  constructor(private readonly access: ProjectArchiveAccess) {}

  private get db(): DatabaseSync { return this.access.db() }

  /** Append a revision only if the Leader's management epoch and the current head still match. Use revision zero for a new key. */
  save(leaderSessionId: string, commandId: string, input: SaveProjectFactInput): ManagedResult<ProjectFact> {
    const exact = saveInput(input)
    if (!isId(leaderSessionId) || !isId(commandId) || !exact) return deny('INVALID_INPUT')
    const { key, expectedEpoch, expectedRevision, workId, quote } = exact
    return this.access.write(() => {
      const current = this.access.authority(leaderSessionId)
      if (!current.ok) return current
      const { projectId, managementEpoch } = current.value
      if (expectedEpoch !== managementEpoch) return deny('STALE_MANAGEMENT')
      const head = this.db.prepare(`SELECT MAX(revision) AS revision FROM studio_project_fact WHERE project_id = ? AND key = ?`)
        .get(projectId, key)?.revision ?? 0
      if (head !== expectedRevision || head === Number.MAX_SAFE_INTEGER) return deny('FACT_REVISION_CONFLICT')
      if (this.db.prepare('SELECT 1 FROM studio_project_fact WHERE command_id = ?').get(commandId)) return deny('DUPLICATE_COMMAND')

      // Resolve evidence under the same write lock. The first literal match gives one reproducible UTF-16 range.
      const evidence = this.access.workEvidence(projectId, workId)
      if (!evidence) return deny('FACT_EVIDENCE_UNAVAILABLE')
      const { workerSessionId, workerBotId, executionEpoch, result: { text, messageId, turn, eventSeq } } = evidence
      const offset = text.indexOf(quote)
      if (offset === -1) return deny('FACT_QUOTE_MISMATCH')
      const revision = expectedRevision + 1
      const at = new Date().toISOString()
      const { changes } = this.db.prepare(`INSERT INTO studio_project_fact (${FACT_METADATA}, quote_offset, quote_length, result_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, key, revision, leaderSessionId, managementEpoch, commandId, at, workId, executionEpoch,
          workerSessionId, workerBotId, messageId, turn, eventSeq, offset, quote.length, resultDigest(text))
      if (changes !== 1 && changes !== 1n) throw new Error('Studio project fact insert did not affect one row')
      return accept({ projectId, key, revision, leaderSessionId, managementEpoch, commandId, at, workId, executionEpoch,
        workerSessionId, workerBotId, messageId, turn, eventSeq })
    })
  }

  /** Page through up to eight current fact headers in binary key order; no Worker result is opened. */
  list(leaderSessionId: string, after?: string): ManagedResult<{ items: ProjectFact[]; next?: string }> {
    if (!isId(leaderSessionId) || (after !== undefined && !isProjectFactKey(after))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(leaderSessionId)
      if (!current.ok) return current
      // Seek to each next distinct key using the primary key. Keep the bounded key page on the outer side of the join
      // so SQLite seeks to each head instead of scanning the project's revisions in key order.
      const rows = this.db.prepare(`WITH RECURSIVE keys(fact_key) AS (
        VALUES ((SELECT key FROM studio_project_fact WHERE project_id = :project AND key > :after ORDER BY key LIMIT 1))
        UNION ALL
        SELECT (SELECT key FROM studio_project_fact WHERE project_id = :project AND key > keys.fact_key ORDER BY key LIMIT 1)
        FROM keys WHERE fact_key IS NOT NULL LIMIT ${PAGE_SIZE + 1}
      )
      SELECT ${FACT_METADATA} FROM keys CROSS JOIN studio_project_fact f
      WHERE f.project_id = :project AND f.key = keys.fact_key AND f.revision = (
        SELECT MAX(h.revision) FROM studio_project_fact h WHERE h.project_id = :project AND h.key = keys.fact_key)
      ORDER BY f.key`).all({ project: current.value.projectId, after: after ?? '' })
      const items = rows.slice(0, PAGE_SIZE).map(readFact)
      return accept({ items, ...(rows.length > PAGE_SIZE ? { next: items[PAGE_SIZE - 1]!.key } : {}) })
    })
  }

  /** Open only the active head's exact excerpt. A changed or missing original result makes it unavailable. */
  read(leaderSessionId: string, key: string): ManagedResult<ProjectFact & { quote: string }> {
    if (!isId(leaderSessionId) || !isProjectFactKey(key)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(leaderSessionId)
      if (!current.ok) return current
      const row = this.factHead(current.value.projectId, key)
      if (!row) return deny('FACT_NOT_FOUND')
      const fact = readFact(row)
      const quote = this.verifiedQuote(row, fact)
      return quote === undefined ? deny('FACT_EVIDENCE_UNAVAILABLE') : accept({ ...fact, quote })
    })
  }

  /** Check a pinned revision in the caller's transaction. Return only validity, never the Worker excerpt. */
  sourceCurrent(projectId: string, key: string, revision: number): boolean {
    const row = this.factHead(projectId, key)
    if (!row || row.revision !== revision) return false
    return this.verifiedQuote(row, readFact(row)) !== undefined
  }

  private factHead(projectId: string, key: string): Row | undefined {
    return this.db.prepare(`SELECT ${FACT_METADATA}, quote_offset, quote_length, result_digest FROM studio_project_fact
      WHERE project_id = ? AND key = ? ORDER BY revision DESC LIMIT 1`).get(projectId, key)
  }

  /** Check the original result coordinates, digest, and quote range before using any excerpt. */
  private verifiedQuote(row: Row, fact: ProjectFact): string | undefined {
    const evidence = this.access.workEvidence(fact.projectId, fact.workId)
    if (!evidence || evidence.executionEpoch !== fact.executionEpoch || evidence.workerSessionId !== fact.workerSessionId
      || evidence.workerBotId !== fact.workerBotId) return
    const { text, messageId, turn, eventSeq } = evidence.result
    // Check the entire exact result, not just the range: a changed prefix or suffix must invalidate the reference too.
    if (messageId !== fact.messageId || turn !== fact.turn || eventSeq !== fact.eventSeq || resultDigest(text) !== row.result_digest) return
    const { quote_offset: offset, quote_length: length } = row
    if (!isNonnegativeInteger(offset) || !isPositiveInteger(length) || length > PROJECT_FACT_QUOTE_LIMIT
      || offset > text.length - length) return
    const quote = text.slice(offset, offset + length)
    return isProjectFactQuote(quote) ? quote : undefined
  }

  /** Return one exact revision's provenance, without opening or exposing the Worker result. */
  trace(leaderSessionId: string, key: string, revision: number): ManagedResult<ProjectFact> {
    if (!isId(leaderSessionId) || !isProjectFactKey(key) || !isPositiveInteger(revision)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(leaderSessionId)
      if (!current.ok) return current
      const row = this.db.prepare(`SELECT ${FACT_METADATA} FROM studio_project_fact WHERE project_id = ? AND key = ? AND revision = ?`)
        .get(current.value.projectId, key, revision)
      return row ? accept(readFact(row)) : deny('FACT_NOT_FOUND')
    })
  }
}
