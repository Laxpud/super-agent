import { randomUUID } from 'node:crypto'
import { studioProject, studioProjects, type StudioProjectRoute } from '../studio/domain.ts'
import { studioNow, type StudioStoreAccess } from './store.ts'
import { StudioError } from '../studio/pending.ts'
import { canonicalizeWorkspaceRoot } from './workspace.ts'

export const PROJECT_NAME_LIMIT = 120
export interface ProjectCreate {
  name: string; objective: string; workspacePath?: string | null; leaderSessionId: string; leaderBotId?: string
}
export interface ProjectUpdate { name?: string; objective?: string; workspacePath?: string | null }
export interface ProjectChange { project: StudioProjectRoute; invalidatedTaskIds: string[]; previous?: StudioProjectRoute }

/** 每个管理 epoch 只绑定一个 Leader；归档、换任与工作区变更会在同一事务撤销旧任务。 */
export class ProjectStore {
  constructor(private readonly access: StudioStoreAccess, private readonly protectedRoots: readonly string[]) {}
  private get db() { return this.access.db }

  /** 在分配 Leader 或征询所有者之前也使用与存储层相同的绑定校验。 */
  workspaceBinding(path: string) { return canonicalizeWorkspaceRoot(path, this.protectedRoots) }

  list() { this.access.assertActive(); return studioProjects(this.db) }
  get(id: string) { this.access.assertActive(); return studioProject(this.db, id) }

  currentLeader(sessionId: string): (StudioProjectRoute & { leaderBotId: string }) | undefined {
    this.access.assertActive()
    const row = this.db.prepare(`SELECT p.project_id, b.leader_bot_id FROM studio_project p JOIN studio_project_leader b USING(project_id, management_epoch)
      JOIN studio_session s ON s.session_id = b.session_id AND s.project_id = p.project_id AND s.bot_id = b.leader_bot_id
      JOIN studio_bot bot ON bot.bot_id = b.leader_bot_id AND bot.role = 'leader'
      WHERE b.session_id = ? AND p.state = 'active' AND s.role = 'leader' AND s.readonly_legacy = 0`).get(sessionId)
    if (row && typeof row.leader_bot_id === 'string') return { ...studioProject(this.db, String(row.project_id))!, leaderBotId: row.leader_bot_id }
  }

  create(input: ProjectCreate): StudioProjectRoute {
    const name = projectField(input.name, PROJECT_NAME_LIMIT)
    const objective = projectField(input.objective, 2_000)
    const workspace = input.workspacePath == null ? null : this.workspaceBinding(input.workspacePath).root
    return this.access.write(() => {
      const id = randomUUID(), at = studioNow()
      this.db.prepare(`INSERT INTO studio_project (project_id, name, objective, workspace_path, management_epoch, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`).run(id, name, objective, workspace, at, at)
      this.#bind(id, 1, input.leaderSessionId, input.leaderBotId, at)
      return studioProject(this.db, id)!
    })
  }

  update(id: string, expectedEpoch: number, changes: ProjectUpdate): ProjectChange {
    return this.access.write(() => {
      const current = this.#require(id, expectedEpoch, 'active')
      const workspace = changes.workspacePath === undefined ? current.workspacePath
        : changes.workspacePath === null ? null : this.workspaceBinding(changes.workspacePath).root
      const changedScope = workspace !== current.workspacePath
      const now = studioNow()
      const epoch = expectedEpoch + Number(changedScope)
      const invalidatedTaskIds = changedScope ? this.#invalidate(current, now) : []
      if (changedScope && current.leaderSessionId && current.leaderBotId) {
        this.db.prepare('INSERT INTO studio_project_leader VALUES (?, ?, ?, ?, ?)')
          .run(id, epoch, current.leaderBotId, current.leaderSessionId, now)
      }
      this.db.prepare('UPDATE studio_project SET name = ?, objective = ?, workspace_path = ?, management_epoch = ?, updated_at = ? WHERE project_id = ?')
        .run(changes.name === undefined ? current.name : projectField(changes.name, PROJECT_NAME_LIMIT),
          changes.objective === undefined ? current.objective : projectField(changes.objective, 2_000), workspace, epoch, now, id)
      return { project: studioProject(this.db, id)!, invalidatedTaskIds, ...(changedScope && { previous: current }) }
    })
  }

  replaceLeader(id: string, expectedEpoch: number, sessionId: string, leaderBotId?: string): ProjectChange {
    return this.#changeLeader(id, expectedEpoch, 'active', sessionId, leaderBotId)
  }

  archive(id: string, expectedEpoch: number): ProjectChange {
    return this.access.write(() => {
      const previous = this.#require(id, expectedEpoch, 'active')
      const now = studioNow(), invalidatedTaskIds = this.#invalidate(previous, now)
      this.db.prepare("UPDATE studio_project SET state = 'archived', management_epoch = management_epoch + 1, updated_at = ? WHERE project_id = ?")
        .run(now, id)
      return { project: studioProject(this.db, id)!, invalidatedTaskIds, previous }
    })
  }

  reopen(id: string, expectedEpoch: number, sessionId: string, leaderBotId?: string): ProjectChange {
    return this.#changeLeader(id, expectedEpoch, 'archived', sessionId, leaderBotId ?? this.get(id)?.leaderBotId)
  }

  #changeLeader(id: string, expectedEpoch: number, from: StudioProjectRoute['state'], sessionId: string, leaderBotId?: string): ProjectChange {
    return this.access.write(() => {
      const previous = this.#require(id, expectedEpoch, from)
      const now = studioNow(), epoch = expectedEpoch + 1
      this.#bind(id, epoch, sessionId, leaderBotId, now)
      const invalidatedTaskIds = this.#invalidate(previous, now)
      this.db.prepare("UPDATE studio_project SET state = 'active', management_epoch = ?, updated_at = ? WHERE project_id = ?").run(epoch, now, id)
      return { project: studioProject(this.db, id)!, invalidatedTaskIds, previous }
    })
  }

  #require(id: string, expectedEpoch: number, state: StudioProjectRoute['state']): StudioProjectRoute {
    const current = studioProject(this.db, id)
    if (!current) throw new StudioError('PROJECT_NOT_FOUND', 'This Studio project does not exist.', 404)
    if (current.managementEpoch !== expectedEpoch) throw new StudioError('PROJECT_EPOCH_CONFLICT', 'Studio project state changed. Reload its management epoch.', 409)
    if (current.state !== state) throw current.state === 'archived'
      ? new StudioError('PROJECT_ARCHIVED', 'Studio project state changed: this project is archived. Reopen it before making changes.', 409)
      : new StudioError('PROJECT_NOT_ARCHIVED', 'This Studio project is already active.', 409)
    return current
  }

  #bind(id: string, epoch: number, sessionId: string, botId: string | undefined, at: string): void {
    if (botId) {
      if (!this.db.prepare("SELECT 1 FROM studio_bot WHERE bot_id = ? AND role = 'leader'").get(botId)) throw new Error('Studio Leader Bot not found')
    } else {
      botId = randomUUID()
      this.db.prepare("INSERT INTO studio_bot VALUES (?, 'leader', ?)").run(botId, at)
    }
    // 原生 Session 不可跨项目重用，也不允许把迁移的只读记录升级为现役。
    this.db.prepare("INSERT INTO studio_session VALUES (?, ?, ?, 'leader', 0, ?)").run(sessionId, botId, id, at)
    this.db.prepare('INSERT INTO studio_project_leader VALUES (?, ?, ?, ?, ?)').run(id, epoch, botId, sessionId, at)
  }

  #invalidate(previous: StudioProjectRoute, at: string): string[] {
    const id = previous.id
    const rows = this.db.prepare(`UPDATE studio_task SET status = 'interrupted', authorization_version = authorization_version + 1, updated_at = ?
      WHERE project_id = ? AND status IN ('queued', 'running', 'waiting_approval', 'blocked') RETURNING task_id`).all(at, id)
    this.db.prepare(`UPDATE studio_task_execution SET ended_at = ?, outcome = 'project-authority-changed' WHERE ended_at IS NULL
      AND task_id IN (SELECT task_id FROM studio_task WHERE project_id = ?)`).run(at, id)
    const ids = rows.map(row => String(row.task_id))
    for (const taskId of ids) this.access.expireTaskConfirmationsInTx(taskId)
    this.access.interruptProjectInTx(id, previous.managementEpoch)
    return ids
  }
}

function projectField(value: string, limit: number): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || !value.trim() || value.length > limit) {
    throw new Error('Invalid Studio project title or objective')
  }
  return value.trim()
}
