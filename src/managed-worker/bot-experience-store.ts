/** Append-only methods and conditions owned by stable Studio Leader Bots. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { isPreferenceText } from './memory-store.js'
import { isProjectFactKey } from './project-archive-store.js'
import type { ProjectStore } from './project-store.js'
import type { ManagedResult } from './store.ts'

/** Maximum length of each experience text field in UTF-16 code units. */
export const EXPERIENCE_TEXT_LIMIT = 1200
const PAGE_SIZE = 8

/** Reject malformed text and recognizable credentials. Callers must still omit secrets and project-specific excerpts. */
export function isExperienceText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= EXPERIENCE_TEXT_LIMIT && isPreferenceText(value)
}

/** Metadata for one experience revision, including its exact source fact and the binding that saved it. */
export interface BotExperience {
  botId: string
  key: string
  revision: number
  projectId: string
  factKey: string
  factRevision: number
  leaderSessionId: string
  managementEpoch: number
  commandId: string
  at: string
}

interface SaveBotExperienceInput {
  key: string
  expectedEpoch: number
  expectedRevision: number
  method: string
  conditions: string
  factKey: string
  factRevision: number
}

// The source fact and historical management binding must belong to the same project as the save.
// Store only the general method and conditions; the original quote remains in the project archive.
export const BOT_EXPERIENCE_SCHEMA = `
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_binding_experience_origin
    ON studio_project_binding (project_id, management_epoch, leader_session_id, leader_bot_id);
  CREATE TABLE IF NOT EXISTS studio_bot_experience (
    bot_id TEXT NOT NULL REFERENCES studio_leader_bot (bot_id),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
      AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    project_id TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    fact_revision INTEGER NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    at TEXT NOT NULL,
    method TEXT NOT NULL CHECK (length(trim(method)) BETWEEN 1 AND ${EXPERIENCE_TEXT_LIMIT}
      AND length(method) <= ${EXPERIENCE_TEXT_LIMIT} AND instr(method, char(0)) = 0),
    conditions TEXT NOT NULL CHECK (length(trim(conditions)) BETWEEN 1 AND ${EXPERIENCE_TEXT_LIMIT}
      AND length(conditions) <= ${EXPERIENCE_TEXT_LIMIT} AND instr(conditions, char(0)) = 0),
    PRIMARY KEY (bot_id, key, revision),
    FOREIGN KEY (project_id, fact_key, fact_revision) REFERENCES studio_project_fact (project_id, key, revision),
    FOREIGN KEY (project_id, management_epoch, leader_session_id, bot_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id, leader_bot_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_bot_experience_no_update BEFORE UPDATE ON studio_bot_experience BEGIN
    SELECT RAISE(ABORT, 'Studio Bot experiences are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_bot_experience_no_delete BEFORE DELETE ON studio_bot_experience BEGIN
    SELECT RAISE(ABORT, 'Studio Bot experiences are append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_bot_experience_guard_insert BEFORE INSERT ON studio_bot_experience BEGIN
    SELECT RAISE(ABORT, 'STALE_MANAGEMENT') WHERE NOT EXISTS (
      SELECT 1 FROM studio_project WHERE project_id = NEW.project_id AND management_epoch = NEW.management_epoch);
    SELECT RAISE(ABORT, 'EXPERIENCE_REVISION_CONFLICT') WHERE NEW.revision <> 1 + COALESCE((
      SELECT MAX(revision) FROM studio_bot_experience WHERE bot_id = NEW.bot_id AND key = NEW.key), 0);
    SELECT RAISE(ABORT, 'DUPLICATE_COMMAND') WHERE EXISTS (
      SELECT 1 FROM studio_bot_experience WHERE command_id = NEW.command_id);
    SELECT RAISE(ABORT, 'EXPERIENCE_SOURCE_NOT_CURRENT') WHERE NEW.fact_revision IS NOT (
      SELECT MAX(revision) FROM studio_project_fact WHERE project_id = NEW.project_id AND key = NEW.fact_key);
  END;
`

interface BotExperienceAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  authority: ProjectStore['adviceAuthority']
  sourceCurrent(projectId: string, key: string, revision: number): boolean
}

type Row = Record<string, SQLOutputValue>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const EXPERIENCE_METADATA = `bot_id, key, revision, project_id, fact_key, fact_revision, leader_session_id,
  management_epoch, command_id, at`

/** Copy only the exact own data fields. The caller cannot supply identity or project scope through this object. */
function saveInput(value: unknown): SaveBotExperienceInput | undefined {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  const fields = ['key', 'expectedEpoch', 'expectedRevision', 'method', 'conditions', 'factKey', 'factRevision']
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== fields.length) return
  const data: Record<string, unknown> = Object.create(null)
  for (const key of fields) {
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return
    data[key] = field.value
  }
  const { key, expectedEpoch, expectedRevision, method, conditions, factKey, factRevision } = data
  if (isProjectFactKey(key) && isRevision(expectedEpoch) && (expectedRevision === 0 || isRevision(expectedRevision))
    && isExperienceText(method) && isExperienceText(conditions) && isProjectFactKey(factKey) && isRevision(factRevision)) {
    return { key, expectedEpoch, expectedRevision, method, conditions, factKey, factRevision }
  }
}

/** Decode only provenance. Neither experience text nor the source result enters this metadata object. */
function readExperience(row: Row): BotExperience {
  const { bot_id: botId, key, revision, project_id: projectId, fact_key: factKey, fact_revision: factRevision,
    leader_session_id: leaderSessionId, management_epoch: managementEpoch, command_id: commandId, at } = row
  if (!isId(botId) || !isProjectFactKey(key) || !isRevision(revision) || !isId(projectId) || !isProjectFactKey(factKey)
    || !isRevision(factRevision) || !isId(leaderSessionId) || !isRevision(managementEpoch) || !isId(commandId) || !isId(at)) {
    throw new Error('Invalid Studio Bot experience')
  }
  return { botId, key, revision, projectId, factKey, factRevision, leaderSessionId, managementEpoch, commandId, at }
}

/** Internal facet. Every operation derives the Bot from the current Leader Session in the parent transaction. */
export class BotExperienceStore {
  constructor(private readonly access: BotExperienceAccess) {}

  private get db(): DatabaseSync { return this.access.db() }

  /** Append a revision against this Bot's current head (zero for a new key) and an exact fact in the Leader's current project. */
  save(sessionId: string, commandId: string, input: SaveBotExperienceInput): ManagedResult<BotExperience> {
    const exact = saveInput(input)
    if (!isId(sessionId) || !isId(commandId) || !exact) return deny('INVALID_INPUT')
    const { key, expectedEpoch, expectedRevision, method, conditions, factKey, factRevision } = exact
    return this.access.write(() => {
      const current = this.access.authority(sessionId)
      if (!current.ok) return current
      const { leaderBotId: botId, projectId, leaderSessionId, managementEpoch } = current.value
      if (managementEpoch !== expectedEpoch) return deny('STALE_MANAGEMENT')
      const head = this.db.prepare('SELECT MAX(revision) AS revision FROM studio_bot_experience WHERE bot_id = ? AND key = ?')
        .get(botId, key)?.revision ?? 0
      if (head !== expectedRevision || head === Number.MAX_SAFE_INTEGER) return deny('EXPERIENCE_REVISION_CONFLICT')
      if (this.db.prepare('SELECT 1 FROM studio_bot_experience WHERE command_id = ?').get(commandId)) return deny('DUPLICATE_COMMAND')
      // Digest validation and the append share the write lock so neither the source head nor the actor can change between them.
      if (!this.access.sourceCurrent(projectId, factKey, factRevision)) return deny('EXPERIENCE_SOURCE_NOT_CURRENT')
      const revision = expectedRevision + 1
      const at = new Date().toISOString()
      const { changes } = this.db.prepare(`INSERT INTO studio_bot_experience (${EXPERIENCE_METADATA}, method, conditions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(botId, key, revision, projectId, factKey, factRevision, leaderSessionId, managementEpoch, commandId, at, method, conditions)
      if (changes !== 1 && changes !== 1n) throw new Error('Studio Bot experience insert did not affect one row')
      return accept({ botId, key, revision, projectId, factKey, factRevision, leaderSessionId, managementEpoch, commandId, at })
    })
  }

  /** Page through up to eight Bot-owned heads in binary key order, marking invalid sources without returning experience text. */
  list(sessionId: string, after?: string): ManagedResult<{ items: (BotExperience & { sourceCurrent: boolean })[]; next?: string }> {
    if (!isId(sessionId) || (after !== undefined && !isProjectFactKey(after))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(sessionId)
      if (!current.ok) return current
      // Seek to each distinct key and its latest revision by primary key without scanning the Bot's revision history.
      const rows = this.db.prepare(`WITH RECURSIVE keys(experience_key) AS (
        VALUES ((SELECT key FROM studio_bot_experience WHERE bot_id = :bot AND key > :after ORDER BY key LIMIT 1))
        UNION ALL
        SELECT (SELECT key FROM studio_bot_experience WHERE bot_id = :bot AND key > keys.experience_key ORDER BY key LIMIT 1)
        FROM keys WHERE experience_key IS NOT NULL LIMIT ${PAGE_SIZE + 1}
      )
      SELECT ${EXPERIENCE_METADATA} FROM keys CROSS JOIN studio_bot_experience e
      WHERE e.bot_id = :bot AND e.key = keys.experience_key AND e.revision = (
        SELECT MAX(h.revision) FROM studio_bot_experience h WHERE h.bot_id = :bot AND h.key = keys.experience_key)
      ORDER BY e.key`).all({ bot: current.value.leaderBotId, after: after ?? '' })
      const items = rows.slice(0, PAGE_SIZE).map(row => {
        const experience = readExperience(row)
        return { ...experience, sourceCurrent: this.sourceCurrent(experience) }
      })
      return accept({ items, ...(rows.length > PAGE_SIZE ? { next: items[PAGE_SIZE - 1]!.key } : {}) })
    })
  }

  /** Resolve the Bot's latest method and conditions only while the pinned source is still valid in its original project. */
  read(sessionId: string, key: string): ManagedResult<BotExperience & { method: string; conditions: string }> {
    if (!isId(sessionId) || !isProjectFactKey(key)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(sessionId)
      if (!current.ok) return current
      const row = this.db.prepare(`SELECT ${EXPERIENCE_METADATA} FROM studio_bot_experience
        WHERE bot_id = ? AND key = ? ORDER BY revision DESC LIMIT 1`).get(current.value.leaderBotId, key)
      if (!row) return deny('EXPERIENCE_NOT_FOUND')
      const experience = readExperience(row)
      if (!this.sourceCurrent(experience)) return deny('EXPERIENCE_SOURCE_NOT_CURRENT')
      // Fetch general text only after checking the exact head and source together in this snapshot.
      const text = this.db.prepare('SELECT method, conditions FROM studio_bot_experience WHERE bot_id = ? AND key = ? AND revision = ?')
        .get(experience.botId, key, experience.revision)
      if (!isExperienceText(text?.method) || !isExperienceText(text?.conditions)) throw new Error('Invalid Studio Bot experience text')
      return accept({ ...experience, method: text.method, conditions: text.conditions })
    })
  }

  /** Return this Bot's exact historical metadata even if the fact is invalid; never open the experience text or source result. */
  trace(sessionId: string, key: string, revision: number): ManagedResult<BotExperience> {
    if (!isId(sessionId) || !isProjectFactKey(key) || !isRevision(revision)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.access.authority(sessionId)
      if (!current.ok) return current
      const row = this.db.prepare(`SELECT ${EXPERIENCE_METADATA} FROM studio_bot_experience WHERE bot_id = ? AND key = ? AND revision = ?`)
        .get(current.value.leaderBotId, key, revision)
      return row ? accept(readExperience(row)) : deny('EXPERIENCE_NOT_FOUND')
    })
  }

  private sourceCurrent(experience: BotExperience): boolean {
    return this.access.sourceCurrent(experience.projectId, experience.factKey, experience.factRevision)
  }
}
