import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { PROPOSE_PROJECT } from '../studio/protocol.ts'
import type { StudioSessions } from '../studio/sessions.ts'
import { ownerRequest } from './assistant.ts'
import { PROJECT_NAME_LIMIT } from './project-store.ts'
import { projectText } from './project.ts'
import type { ManagedWorkerStore } from './store.ts'
import { verifyWorkspaceIdentity } from './workspace.ts'

const TIMEOUT_MS = 120_000
const plain = (limit: number) => z.string().min(1).max(limit).refine(value => value.isWellFormed() && !value.includes('\0') && !!value.trim())
const proposal = z.strictObject({ name: plain(PROJECT_NAME_LIMIT), objective: plain(2_000),
  intentQuote: plain(500).describe('Exact excerpt in the current user message asking to establish a project.'),
  workspacePath: plain(4_096).exactOptional().describe('Optional exact workspace path stated by the owner.'), leaderBotId: z.uuid().exactOptional() })

/** 自然语言只生成提议，由 Studio pending broker 在 Web 或飞书取得同一项确认。 */
export class StudioProjectIntake {
  constructor(private readonly store: ManagedWorkerStore, private readonly sessions: StudioSessions) {}

  install(agent: Agent): () => void {
    return agent.ctx.tools.register({ name: PROPOSE_PROJECT,
      description: 'Ask the owner to confirm an explicit request to start an ongoing project. No task is submitted.',
      parameters: z.toJSONSchema(proposal), timeoutMs: TIMEOUT_MS + 10_000,
      output: { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        render: (_args, value: { text: string }) => [{ type: 'text', text: value.text }] },
      execute: async (args, exec) => {
        const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(TIMEOUT_MS)])
        signal.throwIfAborted()
        const source = ownerRequest(agent, exec.callId, PROPOSE_PROJECT)
        const fields = proposal.parse(args)
        if (exec.agent !== agent || exec.parent !== undefined || !source || !this.sessions.matchesOwnerRequest(agent, source)
          || this.sessions.isExistingTaskReply(agent) || !source.requestText.includes(fields.intentQuote)
          || (fields.workspacePath && !source.requestText.includes(fields.workspacePath))
          || (fields.leaderBotId && !source.requestText.includes(fields.leaderBotId))) throw new Error('Project proposal requires the exact current owner input')
        const workspace = fields.workspacePath === undefined ? null : this.store.projects.workspaceBinding(fields.workspacePath)
        const approved = await this.sessions.confirmWithOwner(agent, { title: `Create the ongoing project “${fields.name}”?`, approve: 'Create project',
          detail: `Owner's words: ${fields.intentQuote}\n\nObjective: ${fields.objective}\nWorkspace: ${workspace?.root ?? 'not set'}\nLeader Bot: ${fields.leaderBotId ?? 'new'}\nNo work is dispatched.` }, signal)
        if (!approved) return { text: 'Project not created: the owner declined.' }
        signal.throwIfAborted()
        if (!this.sessions.matchesOwnerRequest(agent, source)) throw new Error('Project proposal is no longer current')
        const leaderSessionId = await this.sessions.prepareLeader(signal)
        signal.throwIfAborted()
        if (!this.sessions.matchesOwnerRequest(agent, source)) throw new Error('Project proposal is no longer current')
        if (workspace && !verifyWorkspaceIdentity(workspace.root, workspace)) throw new Error('The approved workspace changed while preparing the project.')
        const project = this.store.projects.create({ ...fields, workspacePath: workspace?.root ?? null, leaderSessionId })
        return { text: `Project created. No Worker started.\n${projectText(project)}` }
      },
    })
  }
}
