/** 项目生命周期由已认证的所有者控制；模型工具不能换任、归档或改变工作范围。 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { StudioProjectRoute } from '../studio/domain.ts'
import type { StudioSessions } from '../studio/sessions.ts'
import { verifyWorkspace } from '../studio/settings-directory.ts'
import { projectArchiveCommand, PROJECT_ARCHIVE_HINT } from './project-archive.ts'
import { PROJECT_NAME_LIMIT } from './project-store.ts'
import type { ManagedWorkerStore } from './store.ts'

export const LEADER_PRESET = 'agent-studio-leader'
export const PROJECT_COMMAND = 'studio-project'
export const PROJECT_HINT = `list | status <project-id> | create <JSON> | update <JSON> | replace-leader <JSON> | archive <JSON> | reopen <JSON> | work [task-id] | ${PROJECT_ARCHIVE_HINT}`
const id = z.uuid()
const coordinate = { projectId: id, epoch: z.int().positive() }
const projectFields = { name: z.string().trim().min(1).max(PROJECT_NAME_LIMIT), objective: z.string().trim().min(1).max(2_000),
  workspacePath: z.string().min(1).max(4_096).nullable().exactOptional() }

export function projectText(project: StudioProjectRoute): string {
  return `${project.name} (${project.id}) · ${project.state} · management epoch ${project.managementEpoch}\nObjective: ${project.objective}`
    + `\nWorkspace: ${project.workspacePath ?? 'not set'}\nLeader Bot: ${project.leaderBotId ?? 'not assigned'}`
}

/** 项目命令和统一任务查询不唤醒模型。需要新 Leader 时先创建被动原生会话，再提交管理权。 */
export class StudioProjectControl {
  constructor(private readonly store: ManagedWorkerStore, private readonly sessions: StudioSessions,
    private readonly ready: (agent: Agent, role: 'assistant' | 'leader') => boolean) {}

  async command(agent: Agent, rawInput: string, signal: AbortSignal) {
    const role = this.ready(agent, 'assistant') ? 'assistant' : this.ready(agent, 'leader') ? 'leader' : undefined
    const ok = (text: string) => ({ kind: 'success' as const, text })
    const reject = (text: string) => ({ kind: 'error' as const, text })
    if (!role) return reject('Use a current Studio Assistant or Leader Session.')
    if (rawInput.length > 30_000) return reject('The Studio project command is too long.')
    const [, verb = '', value = ''] = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(rawInput.trim()) ?? []
    const allowed = (id: string) => role === 'assistant' ? this.ready(agent, role) : this.store.projects.currentLeader(agent.id)?.id === id
    try {
      signal.throwIfAborted()
      if (verb === 'list' && role === 'assistant') return ok(this.store.projects.list().map(project => `${project.name} (${project.id})`).join('\n') || 'No active Studio projects.')
      if (verb === 'status') {
        const project = this.store.studioProject(id.parse(value))
        return project && allowed(project.id) ? ok(projectText(project)) : reject('No accessible Studio project.')
      }
      if (verb === 'work') {
        const room = this.store.projects.currentLeader(agent.id)?.id
        if (!value) return ok(this.store.tasks(room).items.map(task => `${task.taskId}: ${task.status} · ${task.title}`).join('\n') || 'No Studio tasks.')
        const task = this.store.task(id.parse(value))
        return task && (role === 'assistant' || task.projectId === room) ? ok(`${task.taskId}: ${task.status}${task.resultSummary ? `\n\n${task.resultSummary}` : ''}`) : reject('No accessible Studio task.')
      }
      const archived = projectArchiveCommand(this.store.projectArchive, verb, value, allowed)
      if (archived !== undefined) return ok(archived)
      if (verb === 'create' && role === 'assistant') {
        const fields = z.strictObject({ ...projectFields, leaderBotId: id.exactOptional() }).parse(JSON.parse(value))
        if (fields.workspacePath) verifyWorkspace(fields.workspacePath)
        const leaderSessionId = await this.sessions.prepareLeader(signal)
        if (!this.ready(agent, role)) return reject('Studio role changed; no project was created.')
        return ok(projectText(this.store.projects.create({ ...fields, leaderSessionId })))
      }
      if (verb === 'update') {
        const { projectId, epoch, ...changes } = z.strictObject({ ...coordinate, ...projectFields,
          name: projectFields.name.exactOptional(), objective: projectFields.objective.exactOptional() }).parse(JSON.parse(value))
        if (!allowed(projectId)) return reject('This project is not managed by the current Leader.')
        const result = this.store.projects.update(projectId, epoch, changes)
        this.sessions.terminateInvalidated(result.invalidatedTaskIds)
        return ok(projectText(result.project))
      }
      if ((verb === 'archive' || verb === 'reopen' || verb === 'replace-leader') && role === 'assistant') {
        const { projectId, epoch, leaderBotId } = z.strictObject({ ...coordinate, leaderBotId: id.exactOptional() }).parse(JSON.parse(value))
        if (verb === 'archive') {
          const result = this.store.projects.archive(projectId, epoch)
          this.sessions.terminateInvalidated(result.invalidatedTaskIds)
          return ok(projectText(result.project))
        }
        const current = this.store.projects.get(projectId)
        if (!current || current.managementEpoch !== epoch) return reject('Studio project changed; reread the current epoch.')
        const session = await this.sessions.prepareLeader(signal)
        if (!this.ready(agent, role)) return reject('Studio role changed; the project was not changed.')
        const result = verb === 'reopen' ? this.store.projects.reopen(projectId, epoch, session, leaderBotId)
          : this.store.projects.replaceLeader(projectId, epoch, session, leaderBotId)
        this.sessions.terminateInvalidated(result.invalidatedTaskIds)
        return ok(projectText(result.project))
      }
      return reject(`Use /${PROJECT_COMMAND} ${PROJECT_HINT}.`)
    } catch { return reject('The Studio project operation was not confirmed. Check the project, current management epoch, and command fields.') }
  }
}
