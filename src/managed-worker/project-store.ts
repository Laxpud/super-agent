/** Durable Studio project identity, management history, and pending work. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ManagedResult } from './store.ts'

/** Maximum project name length in UTF-16 code units. */
export const PROJECT_NAME_LIMIT = 160
/** Maximum project objective or work request length in UTF-16 code units. */
export const PROJECT_TEXT_LIMIT = 32_000

/** A permanent Session role, not proof that the Session still manages the project. */
export interface StudioProjectBinding {
  projectId: string
  leaderBotId: string
  leaderSessionId: string
  managementEpoch: number
}

/** Project snapshot with the current Leader and the total number of registered work items. */
export interface StudioProject extends StudioProjectBinding {
  name: string
  objective: string
  originTaskId?: string
  pendingCount: number
}

/** Work retains the original Leader binding and source coordinates across handoffs. */
export interface StudioProjectWork extends StudioProjectBinding {
  workId: string
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
}

// The current epoch points to an immutable binding. Each binding also records the native command that created it.
// Work references the historical binding rather than the current project assignment, so a handoff never rewrites provenance.
export const PROJECT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_leader_bot (
    bot_id TEXT NOT NULL PRIMARY KEY
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    origin_task_id TEXT UNIQUE REFERENCES studio_draft_task (task_id),
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (project_id, management_epoch) REFERENCES studio_project_binding (project_id, management_epoch)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project_binding (
    leader_session_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES studio_project (project_id),
    leader_bot_id TEXT NOT NULL REFERENCES studio_leader_bot (bot_id),
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    command_id TEXT NOT NULL UNIQUE,
    bound_at TEXT NOT NULL,
    UNIQUE (project_id, management_epoch)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project_work (
    work_id TEXT NOT NULL PRIMARY KEY,
    leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
    source_message_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    UNIQUE (leader_session_id, source_request_id)
  ) STRICT;
`

interface ProjectStoreAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  ownsRun(): boolean
  nonProjectSessionBound(sessionId: string): boolean
}

interface CreateInput {
  leaderSessionId: string
  commandId: string
  name: string
  objective: string
  leaderBotId?: string
  originTaskId?: string
}

interface HandoffInput {
  projectId: string
  expectedEpoch: number
  nextSessionId: string
  commandId: string
  leaderBotId?: string
}

interface WorkInput {
  leaderSessionId: string
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
}

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isText = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length <= limit && value.isWellFormed() && !value.includes('\0') && value.trim().length > 0
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/** An ignored insert or update is not a successful write, even if SQLite did not raise an error. */
function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project write did not affect exactly one row')
}

/** Decode a permanent binding before using it to classify a Session or check its authority. */
function readBinding(row: Record<string, SQLOutputValue>): StudioProjectBinding {
  const { project_id: projectId, leader_bot_id: leaderBotId, leader_session_id: leaderSessionId, management_epoch: managementEpoch } = row
  if (!isId(projectId) || !isId(leaderBotId) || !isId(leaderSessionId) || !isEpoch(managementEpoch)) {
    throw new Error('Invalid Studio project binding')
  }
  return { projectId, leaderBotId, leaderSessionId, managementEpoch }
}

/** Internal facet of ManagedWorkerStore. All writes use its transaction and run fence. */
export class ProjectStore {
  constructor(private readonly access: ProjectStoreAccess) {}

  private get db(): DatabaseSync { return this.access.db() }

  /** Read the durable role, including former Leaders. Invalid input or storage errors throw. */
  binding(sessionId: string): StudioProjectBinding | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Studio project Leader session ID')
    const row = this.db.prepare('SELECT * FROM studio_project_binding WHERE leader_session_id = ?').get(sessionId)
    return row && readBinding(row)
  }

  /** Read the current project only for its active Leader in the active host run. Writes still need their own check. */
  current(sessionId: string): ManagedResult<StudioProject> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    try {
      if (!this.access.ownsRun()) return deny('STALE_HOST_RUN')
      const result = this.currentProject(sessionId)
      return this.access.ownsRun() ? result : deny('STALE_HOST_RUN')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Show current project state by ID or by the caller's durable Leader role. The Host authorizes this read. */
  status(sessionId: string, projectId?: string): ManagedResult<StudioProject> {
    if (!isId(sessionId) || (projectId !== undefined && !isId(projectId))) return deny('INVALID_INPUT')
    try {
      if (projectId !== undefined) {
        const project = this.project(projectId)
        return project ? accept(project) : deny('PROJECT_NOT_FOUND')
      }
      const binding = this.binding(sessionId)
      return binding ? accept(this.boundProject(binding)) : deny('SESSION_NOT_BOUND')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Start a project and reserve its first Leader Session with a single native user command. */
  create(input: CreateInput): ManagedResult<StudioProject> {
    if (!input) return deny('INVALID_INPUT')
    const { leaderSessionId, commandId, name, objective, leaderBotId, originTaskId } = input
    if (!isId(leaderSessionId) || !isId(commandId) || !isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT)
      || (leaderBotId !== undefined && !isId(leaderBotId)) || (originTaskId !== undefined && !isId(originTaskId))) {
      return deny('INVALID_INPUT')
    }
    return this.access.write(() => {
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      if (this.sessionBound(leaderSessionId)) return deny('SESSION_ALREADY_BOUND')
      // Link the existing completed draft without taking ownership of its Session or creating a new execution.
      if (originTaskId !== undefined) {
        const draft = this.db.prepare('SELECT state FROM studio_draft_task WHERE task_id = ?').get(originTaskId)
        if (!draft || draft.state !== 'completed') return deny('ORIGIN_TASK_NOT_COMPLETED')
        if (this.db.prepare('SELECT 1 FROM studio_project WHERE origin_task_id = ?').get(originTaskId)) return deny('ORIGIN_TASK_ALREADY_LINKED')
      }
      const bot = this.resolveBot(leaderBotId)
      if (!bot.ok) return bot
      const projectId = randomUUID()
      requireWrite(this.db.prepare(`INSERT INTO studio_project (project_id, name, objective, origin_task_id, management_epoch)
        VALUES (?, ?, ?, ?, 1)`).run(projectId, name, objective, originTaskId ?? null).changes)
      const binding = { projectId, leaderBotId: bot.value, leaderSessionId, managementEpoch: 1 }
      this.insertBinding(binding, commandId)
      return accept({ ...binding, name, objective, ...(originTaskId === undefined ? {} : { originTaskId }), pendingCount: 0 })
    })
  }

  /** Transfer management to a never-bound Session; keep the prior binding and advance exactly one epoch. */
  handoff(input: HandoffInput): ManagedResult<StudioProject> {
    if (!input) return deny('INVALID_INPUT')
    const { projectId, expectedEpoch, nextSessionId, commandId, leaderBotId } = input
    if (!isId(projectId) || !isEpoch(expectedEpoch) || !isId(nextSessionId) || !isId(commandId)
      || (leaderBotId !== undefined && !isId(leaderBotId))) return deny('INVALID_INPUT')
    return this.access.write(() => {
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const project = this.project(projectId)
      if (!project) return deny('PROJECT_NOT_FOUND')
      if (project.managementEpoch !== expectedEpoch) return deny('STALE_MANAGEMENT')
      const managementEpoch = expectedEpoch + 1
      if (!isEpoch(managementEpoch)) return deny('INVALID_INPUT')
      if (this.sessionBound(nextSessionId)) return deny('SESSION_ALREADY_BOUND')
      const bot = this.resolveBot(leaderBotId === 'new' ? undefined : leaderBotId ?? project.leaderBotId)
      if (!bot.ok) return bot
      const next = { ...project, leaderBotId: bot.value, leaderSessionId: nextSessionId, managementEpoch }
      this.insertBinding(next, commandId)
      requireWrite(this.db.prepare('UPDATE studio_project SET management_epoch = ? WHERE project_id = ? AND management_epoch = ?')
        .run(managementEpoch, projectId, expectedEpoch).changes)
      return accept(next)
    })
  }

  /** Register work only for the current Leader. A repeated source request returns its original row without launching anything. */
  recordWork(input: WorkInput): ManagedResult<{ work: StudioProjectWork; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { leaderSessionId, sourceMessageId, sourceRequestId, requestText } = input
    if (!isId(leaderSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId) || !isText(requestText, PROJECT_TEXT_LIMIT)) {
      return deny('INVALID_INPUT')
    }
    return this.access.write<{ work: StudioProjectWork; created: boolean }>(() => {
      // Check authority before deduplication, so replaying old work cannot succeed after a handoff.
      const current = this.currentProject(leaderSessionId)
      if (!current.ok) return current
      const { projectId, leaderBotId, managementEpoch } = current.value
      const binding = { projectId, leaderBotId, leaderSessionId, managementEpoch }
      const existing = this.db.prepare(`SELECT work_id, source_message_id, request_text FROM studio_project_work
        WHERE leader_session_id = ? AND source_request_id = ?`).get(leaderSessionId, sourceRequestId)
      if (existing) {
        const { work_id: workId, source_message_id: messageId, request_text: text } = existing
        if (!isId(workId) || !isId(messageId) || !isText(text, PROJECT_TEXT_LIMIT)) throw new Error('Invalid Studio project work')
        return accept({ work: { ...binding, workId, sourceMessageId: messageId, sourceRequestId, requestText: text }, created: false })
      }
      const workId = randomUUID()
      requireWrite(this.db.prepare(`INSERT INTO studio_project_work (work_id, leader_session_id, source_message_id, source_request_id, request_text)
        VALUES (?, ?, ?, ?, ?)`).run(workId, leaderSessionId, sourceMessageId, sourceRequestId, requestText).changes)
      return accept({ work: { ...binding, workId, sourceMessageId, sourceRequestId, requestText }, created: true })
    })
  }

  private currentProject(sessionId: string): ManagedResult<StudioProject> {
    const binding = this.binding(sessionId)
    if (!binding) return deny('SESSION_NOT_BOUND')
    const project = this.boundProject(binding)
    if (project.leaderSessionId !== sessionId || project.managementEpoch !== binding.managementEpoch) return deny('STALE_MANAGEMENT')
    if (this.access.nonProjectSessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
    return accept(project)
  }

  private boundProject(binding: StudioProjectBinding): StudioProject {
    const project = this.project(binding.projectId)
    if (!project) throw new Error('Missing project for Studio Leader binding')
    return project
  }

  /** Read the current binding and count work across every management epoch in the same snapshot. */
  private project(projectId: string): StudioProject | undefined {
    const row = this.db.prepare(`SELECT p.project_id, p.name, p.objective, p.origin_task_id, p.management_epoch,
      b.leader_bot_id, b.leader_session_id,
      (SELECT count(*) FROM studio_project_binding h JOIN studio_project_work w USING (leader_session_id)
        WHERE h.project_id = p.project_id) AS pending_count
      FROM studio_project p LEFT JOIN studio_project_binding b USING (project_id, management_epoch)
      WHERE p.project_id = ?`).get(projectId)
    if (!row) return
    const binding = readBinding(row)
    const { name, objective, origin_task_id: originTaskId, pending_count: pendingCount } = row
    if (!isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT) || (originTaskId !== null && !isId(originTaskId))
      || typeof pendingCount !== 'number' || !Number.isSafeInteger(pendingCount) || pendingCount < 0) {
      throw new Error('Invalid Studio project state')
    }
    return { ...binding, name, objective, ...(originTaskId === null ? {} : { originTaskId }), pendingCount }
  }

  private sessionBound(sessionId: string): boolean {
    return !!this.binding(sessionId) || this.access.nonProjectSessionBound(sessionId)
  }

  private commandUsed(commandId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM studio_project_binding WHERE command_id = ?').get(commandId)
  }

  /** An explicit ID must already belong to a Leader Bot; only the allocation path inserts a Bot. */
  private resolveBot(botId?: string): ManagedResult<string> {
    if (botId !== undefined) {
      return this.db.prepare('SELECT 1 FROM studio_leader_bot WHERE bot_id = ?').get(botId)
        ? accept(botId) : deny('LEADER_BOT_NOT_FOUND')
    }
    const created = randomUUID()
    requireWrite(this.db.prepare('INSERT INTO studio_leader_bot (bot_id) VALUES (?)').run(created).changes)
    return accept(created)
  }

  private insertBinding(binding: StudioProjectBinding, commandId: string): void {
    const { leaderSessionId, projectId, leaderBotId, managementEpoch } = binding
    requireWrite(this.db.prepare(`INSERT INTO studio_project_binding
      (leader_session_id, project_id, leader_bot_id, management_epoch, command_id, bound_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(leaderSessionId, projectId, leaderBotId, managementEpoch, commandId, new Date().toISOString()).changes)
  }
}
