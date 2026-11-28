import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { studioArtifacts, studioBlockingItems, studioHiddenIds, studioPendingRecord, studioProject, studioProjects, studioSession, studioTask, studioTasks } from '../studio/domain.ts'
import { ASSISTANT_CONVERSATION, type StudioRecordRole, type StudioRole, type StudioTaskStatus, type StudioWorkerPermission } from '../studio/protocol.ts'
import { STUDIO_SCHEMA, StudioStore } from '../studio/store.ts'
import { MemoryStore } from './memory-store.ts'
import { ProjectArchiveStore } from './project-archive-store.ts'
import { ProjectStore } from './project-store.ts'

const SCHEMA = `
  CREATE TABLE studio_bot (
    bot_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('assistant', 'leader')), created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE studio_project (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, objective TEXT NOT NULL, workspace_path TEXT,
    state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
    management_epoch INTEGER NOT NULL CHECK (management_epoch > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE studio_project_leader (
    project_id TEXT NOT NULL REFERENCES studio_project(project_id), management_epoch INTEGER NOT NULL CHECK (management_epoch > 0),
    leader_bot_id TEXT NOT NULL REFERENCES studio_bot(bot_id), session_id TEXT NOT NULL, bound_at TEXT NOT NULL,
    PRIMARY KEY (project_id, management_epoch)
  ) STRICT;
  CREATE TABLE studio_session (
    session_id TEXT PRIMARY KEY, bot_id TEXT, project_id TEXT, role TEXT NOT NULL,
    readonly_legacy INTEGER NOT NULL DEFAULT 0 CHECK (readonly_legacy IN (0, 1)), created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE studio_task (
    task_id TEXT PRIMARY KEY, project_id TEXT REFERENCES studio_project(project_id), source_message_id TEXT, request_key TEXT UNIQUE,
    requester_bot_id TEXT, assignee_bot_id TEXT, workspace_path TEXT,
    permission TEXT NOT NULL DEFAULT 'read-only' CHECK (permission IN ('read-only', 'workspace-write')),
    authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version > 0),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'blocked', 'interrupted', 'cancelled', 'delivered')),
    title TEXT NOT NULL DEFAULT '', request_text TEXT NOT NULL DEFAULT '', result_summary TEXT, check_result TEXT,
    artifacts TEXT NOT NULL DEFAULT '[]', external_job TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX studio_task_source ON studio_task(source_message_id, project_id);
  CREATE TABLE studio_task_execution (
    task_id TEXT NOT NULL REFERENCES studio_task(task_id), execution_epoch INTEGER NOT NULL CHECK (execution_epoch > 0),
    session_id TEXT NOT NULL, bot_id TEXT, run_id TEXT NOT NULL, captured_management_epoch INTEGER, model_route TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, result_event_seq INTEGER, outcome TEXT,
    PRIMARY KEY (task_id, execution_epoch)
  ) STRICT;
  CREATE UNIQUE INDEX studio_task_active_execution ON studio_task_execution(task_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX studio_task_active_session ON studio_task_execution(session_id) WHERE ended_at IS NULL;
  CREATE TABLE studio_project_archive (
    project_id TEXT PRIMARY KEY REFERENCES studio_project(project_id), decisions TEXT NOT NULL DEFAULT '',
    progress TEXT NOT NULL DEFAULT '', open_issues TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE studio_preference (
    preference_id TEXT PRIMARY KEY, pref_key TEXT NOT NULL, project_id TEXT REFERENCES studio_project(project_id),
    text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'forgotten')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0), updated_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX studio_preference_global ON studio_preference(pref_key) WHERE project_id IS NULL;
  CREATE UNIQUE INDEX studio_preference_project ON studio_preference(project_id, pref_key) WHERE project_id IS NOT NULL;
  CREATE TABLE studio_host_run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), run_id TEXT NOT NULL, clean INTEGER NOT NULL CHECK (clean IN (0, 1))
  ) STRICT;
`

const MIGRATED_AT = new Date(0).toISOString()
export const studioNow = () => new Date().toISOString()
type Row = Record<string, SQLOutputValue>
const string = (row: Row | undefined, ...keys: string[]): string | null => {
  for (const key of keys) if (typeof row?.[key] === 'string' && row[key] !== '') return row[key] as string
  return null
}
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 1
const timestamp = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15
  ? new Date(value).toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : MIGRATED_AT
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/** 将旧表留作快照，只把显式白名单中的身份、索引和无保护结果复制到现役表。 */
function migrateV1(db: DatabaseSync): void {
  const old = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => String(row.name)))
  if (old.delete('studio_project')) {
    db.exec('ALTER TABLE studio_project RENAME TO legacy_studio_project')
    old.add('legacy_studio_project')
  }
  db.exec(SCHEMA)
  db.exec(STUDIO_SCHEMA)
  const rows = (table: string): Row[] => old.has(table) ? db.prepare(`SELECT * FROM ${quote(table)}`).all() : []
  const botInsert = db.prepare('INSERT INTO studio_bot VALUES (?, ?, ?) ON CONFLICT(bot_id) DO NOTHING')
  const ensureBot = (id: string, role: 'assistant' | 'leader', at: string) => {
    const existing = db.prepare('SELECT role FROM studio_bot WHERE bot_id = ?').get(id)
    const target = existing && existing.role !== role ? `${role}:${id}` : id
    botInsert.run(target, role, at)
    return target
  }
  for (const [table, role] of [['studio_assistant_bot', 'assistant'], ['studio_leader_bot', 'leader']] as const) {
    for (const row of rows(table)) {
      const id = string(row, 'bot_id', 'id')
      if (id) ensureBot(id, role, timestamp(row.created_at))
    }
  }
  const bindings = rows('studio_project_binding')
  const projectIds = new Set<string>()
  const projectInsert = db.prepare('INSERT INTO studio_project VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const row of rows('legacy_studio_project')) {
    const id = string(row, 'project_id', 'id')
    if (!id) continue
    const related = bindings.filter(binding => binding.project_id === id)
    const epoch = row.management_epoch == null ? Math.max(1, ...related.map(item => positive(item.management_epoch))) : positive(row.management_epoch)
    const bound = related.find(item => positive(item.management_epoch) === epoch)
    projectInsert.run(id, string(row, 'name', 'title') ?? id, string(row, 'objective', 'goal') ?? '',
      string(row, 'workspace_path', 'workspace', 'cwd'), row.state === 'archived' ? 'archived' : 'active', epoch,
      timestamp(row.created_at ?? bound?.bound_at), timestamp(row.updated_at ?? bound?.bound_at))
    projectIds.add(id)
  }
  const register = db.prepare(`INSERT INTO studio_session VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(session_id) DO UPDATE SET
    created_at = CASE WHEN studio_session.created_at = ? THEN excluded.created_at ELSE studio_session.created_at END`)
  const addSession = (id: string | null, role: StudioRecordRole | 'legacy-protected', bot: string | null, project: string | null, time: unknown) => {
    if (!id) return
    register.run(id, bot, project === ASSISTANT_CONVERSATION ? null : project, role, timestamp(time), MIGRATED_AT)
    if (role === 'legacy-protected') db.prepare("UPDATE studio_session SET role = 'legacy-protected' WHERE session_id = ?").run(id)
  }
  const byLeader = new Map<string, { project: string; bot: string }>()
  for (const row of bindings) {
    const project = string(row, 'project_id'), session = string(row, 'leader_session_id', 'session_id'), leader = string(row, 'leader_bot_id', 'bot_id')
    const boundAt = timestamp(row.bound_at ?? row.created_at)
    const bot = leader && ensureBot(leader, 'leader', boundAt)
    addSession(session, 'leader', bot, project, boundAt)
    if (!project || !projectIds.has(project) || !session || !bot) continue
    db.prepare('INSERT INTO studio_project_leader VALUES (?, ?, ?, ?, ?)').run(project, positive(row.management_epoch), bot, session, boundAt)
    byLeader.set(session, { project, bot })
  }
  for (const row of rows('studio_assistant_binding')) {
    const bot = string(row, 'bot_id', 'assistant_bot_id')
    addSession(string(row, 'session_id', 'assistant_session_id'), 'assistant', bot && ensureBot(bot, 'assistant', timestamp(row.created_at)), null, row.created_at)
  }
  const protectedDrafts = new Set(rows('studio_draft_preference').map(row => string(row, 'task_id')))
  const protectedWork = new Set(['studio_project_work_fact', 'studio_project_work_result_use', 'studio_project_document']
    .flatMap(table => rows(table).map(row => string(row, 'work_id', 'task_id'))))
  const protectedSessions = new Set<string>()
  const dispatches = rows('studio_project_dispatch')
  const byWork = new Map<string, Row[]>()
  for (const row of dispatches) {
    const workId = string(row, 'work_id', 'task_id')
    if (workId) byWork.set(workId, [...(byWork.get(workId) ?? []), row])
  }
  const addTask = db.prepare(`INSERT INTO studio_task (task_id, project_id, source_message_id, request_key, requester_bot_id,
    assignee_bot_id, status, title, request_text, result_summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const addExecution = db.prepare(`INSERT INTO studio_task_execution (task_id, execution_epoch, session_id, bot_id, run_id,
    captured_management_epoch, started_at, ended_at, result_event_seq, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const usedKeys = new Set<string>()
  for (const [table, draft] of [['studio_draft_task', true], ['studio_project_work', false]] as const) {
    for (const row of rows(table)) {
      const id = string(row, 'task_id', 'work_id')
      if (!id) continue
      const leader = byLeader.get(string(row, 'leader_session_id') ?? '')
      const configuredProject = leader?.project ?? string(row, 'project_id')
      const project = configuredProject && projectIds.has(configuredProject) ? configuredProject : null
      const executions = draft ? [row] : byWork.get(id) ?? []
      const protectedResult = (draft ? protectedDrafts : protectedWork).has(id)
      for (const exec of executions) {
        const session = string(exec, 'worker_session_id', 'session_id')
        if (protectedResult && session) protectedSessions.add(session)
        addSession(session, protectedResult ? 'legacy-protected' : 'draft-worker', string(exec, 'worker_bot_id'), project, exec.created_at)
      }
      // 受保护的工作连请求和执行坐标也不进入任务视图，避免通过新结果入口重新取回旧证据。
      if (protectedResult || (!draft && !project) || db.prepare('SELECT 1 FROM studio_task WHERE task_id = ?').get(id)) continue
      const completed = executions.filter(exec => (exec.state ?? exec.status) === 'completed')
        .sort((a, b) => positive(b.execution_epoch) - positive(a.execution_epoch))[0]
      let text = string(completed, 'result_text'), seq: unknown = completed?.result_event_seq
      if (completed && !draft && !text) {
        const json = string(completed, 'result_json')
        if (json && json.length <= 208_384) try {
          const result = JSON.parse(json) as { text?: unknown; eventSeq?: unknown } | null
          text = typeof result?.text === 'string' ? result.text : null
          seq = result?.eventSeq
        } catch { /* 无法验证旧结果时只保留中断记录。 */ }
      }
      const resultSession = string(completed, 'worker_session_id', 'session_id')
      const delivered = !!(text?.trim() && resultSession && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0)
      const request = string(row, 'request_text') ?? ''
      const source = string(row, 'source_message_id')
      const requestId = string(row, 'source_request_id', 'request_key')
      const key = requestId && studioRequestKey(project, requestId)
      const uniqueKey = key && !usedKeys.has(key) ? key : null
      if (key) usedKeys.add(key)
      const time = timestamp(row.created_at)
      addTask.run(id, project, source, uniqueKey, leader?.bot ?? string(row, 'assistant_bot_id', 'requester_bot_id'),
        string(completed ?? executions.at(-1), 'worker_bot_id'), delivered ? 'delivered' : 'interrupted', request.slice(0, 120).toWellFormed(),
        request, delivered ? text : null, time, timestamp(row.updated_at ?? row.created_at))
      for (const exec of executions) {
        const session = string(exec, 'worker_session_id', 'session_id')
        if (!session) continue
        const success = exec === completed && delivered
        const started = timestamp(exec.started_at ?? row.created_at)
        addExecution.run(id, positive(exec.execution_epoch), session, string(exec, 'worker_bot_id'), string(exec, 'run_id') ?? 'legacy',
          draft ? null : positive(exec.management_epoch), started, timestamp(exec.ended_at ?? exec.started_at ?? row.created_at),
          success ? seq as number : null, success ? 'delivered' : 'interrupted')
      }
    }
  }
  const sessionColumns: ReadonlyArray<[string, StudioRecordRole, ...string[]]> = [
    ['managed_session_binding', 'document-worker', 'session_id', 'worker_session_id'],
    ['studio_assistant_binding', 'assistant', 'session_id', 'assistant_session_id'],
    ['studio_project_binding', 'leader', 'leader_session_id', 'session_id'],
    ['studio_draft_task', 'assistant', 'assistant_session_id'], ['studio_draft_task', 'draft-worker', 'worker_session_id', 'session_id'],
    ['studio_project_work', 'leader', 'leader_session_id'], ['studio_project_dispatch', 'leader', 'leader_session_id'], ['studio_project_dispatch', 'draft-worker', 'worker_session_id', 'session_id'],
    ['studio_study_task', 'assistant', 'assistant_session_id', 'owner_session_id'],
    ['studio_study_task', 'study-worker', 'session_id', 'worker_session_id', 'study_session_id'], ['studio_study', 'assistant', 'assistant_session_id'],
    ['studio_study_step', 'study-worker', 'worker_session_id', 'session_id'], ['studio_feishu_draft', 'draft-worker', 'worker_session_id', 'session_id'],
    ['studio_advisor_run', 'advisor', 'advisor_session_id', 'worker_session_id', 'session_id'],
    ['studio_advisor_run', 'legacy', 'owner_session_id', 'requester_session_id'],
    ['studio_advice', 'advisor', 'advisor_session_id', 'session_id'], ['studio_advice', 'legacy', 'requester_session_id'],
    ['agent_studio_revision', 'draft-worker', 'worker_session_id', 'session_id'], ['agent_studio_revision', 'legacy', 'owner_session_id'],
    ['agent_studio_assistant', 'assistant', 'session_id'], ['agent_studio_parallel_turn', 'assistant', 'session_id'],
    ['agent_studio_session', 'legacy', 'id', 'session_id'], ['agent_studio_message', 'legacy', 'run_session_id', 'source_session_id'],
  ]
  for (const [table, fallback, ...columns] of sessionColumns) {
    for (const row of rows(table)) {
      const project = string(row, 'project_id', 'conversation_id')
      const role = table === 'agent_studio_session' ? String(row.role ?? fallback) as StudioRecordRole : fallback
      for (const column of columns) addSession(string(row, column), role, string(row, 'bot_id'), project, row.created_at ?? row.bound_at)
      if (table === 'agent_studio_revision' && ((row.work_type === 'draft' && protectedDrafts.has(string(row, 'work_id')))
        || (row.work_type === 'work' && protectedWork.has(string(row, 'work_id'))))) {
        const session = string(row, 'worker_session_id')
        if (session) protectedSessions.add(session)
      }
    }
  }
  for (const id of protectedSessions) addSession(id, 'legacy-protected', null, null, undefined)
  const revisionByKey = new Map<string, Row>()
  for (const row of rows('studio_memory_revision')) {
    const key = string(row, 'key', 'pref_key')
    if (key && (!revisionByKey.has(key) || positive(row.revision) > positive(revisionByKey.get(key)?.revision))) revisionByKey.set(key, row)
  }
  for (const head of rows('studio_memory_head')) {
    const key = string(head, 'key', 'pref_key')
    if (!key) continue
    const journal = revisionByKey.get(key)
    const project = string(head, 'project_id')
    const { state } = head
    const text = string(journal ?? head, 'text')
    if (journal && (journal.revision !== head.revision || journal.state !== state || string(journal, 'project_id') !== project)) continue
    if (project && !projectIds.has(project) || (state !== 'active' && state !== 'forgotten') || (state === 'active' && !text?.trim())) continue
    const version = head.revision ?? head.version
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) continue
    db.prepare('INSERT INTO studio_preference VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(string(head, 'preference_id') ?? randomUUID(), key, project, state === 'forgotten' ? '' : text!, state,
        version, timestamp(journal?.at ?? head.updated_at))
  }
  // 禁止 V1 写回旧账本，同时保留旧表、外键和历史查询；已发布的对话、设置和通道表仍可正常写入。
  for (const table of old) {
    if (!/^(?:studio_|managed_|legacy_studio_)/u.test(table) && table !== 'agent_studio_revision') continue
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER ${quote(`legacy_readonly_${table}_${op}`)} BEFORE ${op} ON ${quote(table)}
        BEGIN SELECT RAISE(ABORT, 'Legacy Studio snapshot is read-only'); END`)
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Studio V1 migration failed foreign key validation')
  db.exec('PRAGMA user_version=1')
}

function privateFile(path: string, create: boolean): void {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isFile()) throw new Error('Studio database requires regular files')
    if ((existing.mode & 0o7777) !== 0o600) chmodSync(path, 0o600)
  } else if (create) closeSync(openSync(path, 'wx', 0o600))
}

export const studioRequestKey = (projectId: string | null, requestId: string) => JSON.stringify([projectId, requestId])
export interface StudioTaskInput {
  projectId: string | null; sourceMessageId: string; requestId: string; requesterBotId: string;
  workspacePath: string | null; permission: StudioWorkerPermission; requestText: string; title?: string
  /** 项目派工必须在登记事务内再次核验当时的 Leader。 */
  leader?: { sessionId: string; managementEpoch: number }
}
export interface StudioExecution {
  taskId: string; executionEpoch: number; authorizationVersion: number; sessionId: string; runId: string; managementEpoch: number | null
}

/** 统一任务、项目和对话账本共用连接和运行栅栏。所有状态更新必须属于当前宿主。 */
export class ManagedWorkerStore {
  readonly #db: DatabaseSync
  readonly #runId = randomUUID()
  #closed = false
  readonly studio: StudioStore
  readonly projects: ProjectStore
  readonly memory: MemoryStore
  readonly projectArchive: ProjectArchiveStore
  readonly recoveredTasks: number
  readonly assistantBotId: string

  constructor(path: string) {
    if (!path || path === ':memory:') throw new Error('Studio requires a persistent SQLite path')
    const file = resolve(path)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    privateFile(file, true)
    const dbPath = realpathSync(file)
    for (const suffix of ['-wal', '-shm', '-journal']) privateFile(dbPath + suffix, false)
    this.#db = new DatabaseSync(dbPath)
    const db = this.#db
    try {
      // 未知版本在写入数据库前即拒绝；锁内再检查一次，避免并发打开重复执行迁移。
      const checkVersion = () => {
        const version = db.prepare('PRAGMA user_version').get()?.user_version
        if (version !== 0 && version !== 1) throw new Error(`Unsupported Studio SQLite user_version: ${String(version)}`)
        return version
      }
      checkVersion()
      if (db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal') throw new Error('Cannot enable Studio WAL')
      db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON')
      const started = this.#transaction(() => {
        if (checkVersion() === 0) migrateV1(db)
        const now = studioNow()
        const recovered = this.#interruptAll(now, 'host-restarted')
        db.prepare(`INSERT INTO studio_host_run VALUES (1, ?, 0)
          ON CONFLICT(singleton) DO UPDATE SET run_id = excluded.run_id, clean = 0`).run(this.#runId)
        const existing = db.prepare("SELECT bot_id FROM studio_bot WHERE role = 'assistant' ORDER BY created_at, bot_id LIMIT 1").get()
        const bot = string(existing, 'bot_id') ?? randomUUID()
        if (!existing) db.prepare("INSERT INTO studio_bot VALUES (?, 'assistant', ?)").run(bot, now)
        return { recovered, bot }
      })
      this.assistantBotId = started.bot
      this.recoveredTasks = started.recovered
      const access = { db, write: <T>(fn: () => T) => this.write(fn), assertActive: () => this.assertActive() }
      this.projects = new ProjectStore(access)
      this.memory = new MemoryStore(access)
      this.projectArchive = new ProjectArchiveStore(access)
      this.studio = new StudioStore(db, access.assertActive, true)
      this.studio.recover()
    } catch (error) {
      try { this.close() } catch { /* 保留启动错误。 */ }
      throw error
    }
  }

  #transaction<T>(fn: () => T): T {
    const db = this.#db
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error }
  }

  assertActive(): void {
    if (this.#closed || !this.#db.prepare('SELECT 1 FROM studio_host_run WHERE singleton = 1 AND run_id = ? AND clean = 0').get(this.#runId)) {
      throw new Error('Studio host run is no longer active')
    }
  }

  write<T>(operation: () => T): T {
    return this.#transaction(() => { this.assertActive(); return operation() })
  }

  #interruptAll(at: string, reason: string): number {
    const db = this.#db
    const { changes } = db.prepare(`UPDATE studio_task SET status = 'interrupted', authorization_version = authorization_version + 1,
      updated_at = ? WHERE status IN ('queued', 'running', 'waiting_approval')`).run(at)
    db.prepare('UPDATE studio_task_execution SET ended_at = ?, outcome = ? WHERE ended_at IS NULL').run(at, reason)
    return Number(changes)
  }

  /** 宿主先撤销活动执行，再通知原生执行结束。 */
  interruptActiveTasks(): number { return this.write(() => this.#interruptAll(studioNow(), 'host-stopped')) }

  /** 在停止接收新操作、排空所有运行句柄后关闭本次写栅栏。 */
  finishRun(): void {
    if (this.#closed || this.#db.prepare('SELECT clean FROM studio_host_run WHERE singleton = 1 AND run_id = ?').get(this.#runId)?.clean === 1) return
    this.write(() => {
      this.#interruptAll(studioNow(), 'host-stopped')
      this.#db.prepare('UPDATE studio_host_run SET clean = 1 WHERE singleton = 1 AND run_id = ?').run(this.#runId)
    })
  }

  assertStateSealed(): void {
    if (this.#db.prepare('SELECT clean FROM studio_host_run WHERE singleton = 1 AND run_id = ?').get(this.#runId)?.clean !== 1) {
      throw new Error('Cannot switch Studio state before a confirmed clean stop')
    }
  }

  async copySettingsState(target: string): Promise<void> { this.assertStateSealed(); await backup(this.#db, target, { rate: 256 }) }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close() } }

  registerSession(id: string, role: StudioRole, botId: string | null, projectId: string | null): void {
    this.write(() => {
      this.#db.prepare('INSERT INTO studio_session VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(session_id) DO NOTHING')
        .run(id, botId, projectId, role, studioNow())
      const row = this.#db.prepare('SELECT * FROM studio_session WHERE session_id = ?').get(id)
      if (row?.readonly_legacy !== 0 || row.role !== role || row.project_id !== projectId || row.bot_id !== botId) {
        throw new Error('Studio Session already belongs to a different binding')
      }
    })
  }

  isProtectedLog(id: string): boolean {
    return this.#db.prepare('SELECT role FROM studio_session WHERE session_id = ?').get(id)?.role === 'legacy-protected'
  }

  studioProjects() { return studioProjects(this.#db) }
  studioProject(id: string) { return studioProject(this.#db, id) }
  studioHiddenIds() { return studioHiddenIds(this.#db) }
  studioSession(id: string) { return studioSession(this.#db, id) }
  studioArtifacts(room: string, messageId: string) { return studioArtifacts(this.#db, room, messageId) }
  studioBlockingItems() { return studioBlockingItems(this.#db) }
  studioPendingRecord(id: string) { return studioPendingRecord(this.#db, id) }
  task(taskId: string) { return studioTask(this.#db, taskId) }
  tasks(room?: string, before?: number) { return studioTasks(this.#db, room, before) }
  taskFromMessage(room: string, requestId: string, sourceMessageId: string) {
    const project = room === ASSISTANT_CONVERSATION ? null : room
    const row = this.#db.prepare('SELECT task_id FROM studio_task WHERE project_id IS ? AND request_key = ? AND source_message_id = ?')
      .get(project, studioRequestKey(project, requestId), sourceMessageId)
    return typeof row?.task_id === 'string' ? this.task(row.task_id) : undefined
  }

  registerTask(input: StudioTaskInput): { taskId: string; created: boolean } {
    return this.write(() => {
      if (input.projectId !== null) {
        const current = this.projects.currentLeader(input.leader?.sessionId ?? '')
        if (!current || current.id !== input.projectId || current.managementEpoch !== input.leader?.managementEpoch
          || current.leaderBotId !== input.requesterBotId || current.workspacePath !== input.workspacePath) throw new Error('Studio project authority changed')
      } else if (input.requesterBotId !== this.assistantBotId || input.leader) throw new Error('Invalid Studio Assistant identity')
      const key = studioRequestKey(input.projectId, input.requestId)
      const existing = this.#db.prepare('SELECT task_id, source_message_id, request_text FROM studio_task WHERE request_key = ?').get(key)
      if (existing) {
        if (existing.source_message_id !== input.sourceMessageId || existing.request_text !== input.requestText) throw new Error('Studio task source conflict')
        return { taskId: String(existing.task_id), created: false }
      }
      const taskId = randomUUID(), at = studioNow()
      this.#db.prepare(`INSERT INTO studio_task (task_id, project_id, source_message_id, request_key, requester_bot_id, workspace_path,
        permission, status, title, request_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(taskId, input.projectId, input.sourceMessageId, key, input.requesterBotId, input.workspacePath,
          input.permission, input.title ?? input.requestText.slice(0, 120).toWellFormed(), input.requestText, at, at)
      return { taskId, created: true }
    })
  }

  beginExecution(taskId: string, sessionId: string, managementEpoch: number | null, modelRoute: object): StudioExecution | undefined {
    return this.write(() => {
      const db = this.#db
      const task = this.task(taskId)
      if (!task || task.status !== 'queued') return
      if (task.projectId === null ? managementEpoch !== null :
        !db.prepare("SELECT 1 FROM studio_project WHERE project_id = ? AND state = 'active' AND management_epoch = ?")
          .get(task.projectId, managementEpoch)) return
      const executionEpoch = Number(db.prepare('SELECT coalesce(max(execution_epoch), 0) + 1 AS epoch FROM studio_task_execution WHERE task_id = ?')
        .get(taskId)?.epoch)
      const at = studioNow()
      db.prepare('INSERT INTO studio_session VALUES (?, NULL, ?, ?, 0, ?)').run(sessionId, task.projectId, 'worker', at)
      db.prepare(`INSERT INTO studio_task_execution (task_id, execution_epoch, session_id, run_id, captured_management_epoch, model_route, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(taskId, executionEpoch, sessionId, this.#runId, managementEpoch, JSON.stringify(modelRoute), at)
      db.prepare("UPDATE studio_task SET status = 'running', updated_at = ? WHERE task_id = ?").run(at, taskId)
      return { taskId, executionEpoch, authorizationVersion: task.authorizationVersion, sessionId, runId: this.#runId, managementEpoch }
    })
  }

  executionCurrent(execution: StudioExecution): boolean {
    this.assertActive()
    return !!this.#db.prepare(`SELECT 1 FROM studio_task t JOIN studio_task_execution e USING (task_id)
      JOIN studio_session s ON s.session_id = e.session_id LEFT JOIN studio_project p ON p.project_id = t.project_id
      WHERE t.task_id = ? AND t.authorization_version = ? AND t.status = 'running' AND e.execution_epoch = ?
      AND e.session_id = ? AND e.run_id = ? AND e.ended_at IS NULL AND e.captured_management_epoch IS ?
      AND s.readonly_legacy = 0 AND s.role = 'worker'
      AND (t.project_id IS NULL OR (p.state = 'active' AND p.management_epoch = e.captured_management_epoch))`)
      .get(execution.taskId, execution.authorizationVersion, execution.executionEpoch, execution.sessionId, this.#runId, execution.managementEpoch)
      && execution.runId === this.#runId
  }

  finishExecution(execution: StudioExecution, result: { text: string; eventSeq: number } | undefined, outcome: string): boolean {
    return this.write(() => {
      if (!this.executionCurrent(execution)) return false
      const db = this.#db, at = studioNow()
      db.prepare(`UPDATE studio_task SET status = ?, authorization_version = authorization_version + 1, result_summary = ?, updated_at = ?
        WHERE task_id = ?`).run(result ? 'delivered' : 'interrupted', result?.text ?? null, at, execution.taskId)
      db.prepare(`UPDATE studio_task_execution SET ended_at = ?, result_event_seq = ?, outcome = ? WHERE task_id = ? AND execution_epoch = ?`)
        .run(at, result?.eventSeq ?? null, outcome, execution.taskId, execution.executionEpoch)
      return true
    })
  }

  /** 标记需要人工核实的条件，先结束旧执行，解除后也不自动重派。 */
  markTaskBlocked(taskId: string, expectedVersion: number, detail: string): boolean {
    return this.write(() => {
      const at = studioNow()
      const { changes } = this.#db.prepare(`UPDATE studio_task SET status = 'blocked', check_result = ?,
        authorization_version = authorization_version + 1, updated_at = ? WHERE task_id = ? AND authorization_version = ?
        AND status IN ('queued', 'running', 'waiting_approval')`).run(detail, at, taskId, expectedVersion)
      if (!changes) return false
      this.#db.prepare("UPDATE studio_task_execution SET ended_at = ?, outcome = 'blocked' WHERE task_id = ? AND ended_at IS NULL").run(at, taskId)
      return true
    })
  }

  /** 停止或解除阻塞先作废旧授权与执行，再由调用方通知底层 Agent；解除不自动重派。 */
  invalidateTask(taskId: string, status: Extract<StudioTaskStatus, 'cancelled' | 'interrupted'>, expectedVersion?: number): boolean {
    return this.write(() => {
      const at = studioNow(), db = this.#db
      const changed = db.prepare(`UPDATE studio_task SET status = ?, authorization_version = authorization_version + 1, updated_at = ?
        WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'blocked')
        AND (? IS NULL OR (authorization_version = ? AND status = 'blocked'))`)
        .run(status, at, taskId, expectedVersion ?? null, expectedVersion ?? null)
      if (!changed.changes) return false
      db.prepare('UPDATE studio_task_execution SET ended_at = ?, outcome = ? WHERE task_id = ? AND ended_at IS NULL').run(at, status, taskId)
      return true
    })
  }
}

export interface StudioStoreAccess {
  db: DatabaseSync
  write<T>(operation: () => T): T
  assertActive(): void
}
