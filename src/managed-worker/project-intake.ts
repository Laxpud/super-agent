/** Prepare a project from an exact owner message; only the live native answer can turn it into a project. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { newStudioSessionId } from '../studio/source.ts'
import { draftWorkerRoute, ownerRequest, createStudioSession } from './assistant.ts'
import { LEADER_PRESET, projectText } from './project.ts'
import { confirmWithOwner, ownerConfirmationAvailable } from './owner-confirmation.ts'
import { PROJECT_NAME_LIMIT, type StudioProjectProposal } from './project-store.ts'
import type { ManagedWorkerStore } from './store.ts'

export const PROPOSE_PROJECT = 'studio_propose_project'
const TIMEOUT_MS = 120_000
const plain = (limit: number) => z.string().min(1).max(limit)
  .refine(value => value.isWellFormed() && !value.includes('\0') && value.trim().length > 0)
const proposalArgs = z.strictObject({
  name: plain(PROJECT_NAME_LIMIT).describe('A concise name for the requested ongoing project.'),
  objective: plain(2_000).describe('The ongoing objective for the owner to confirm, not a new task or grant of authority.'),
  intentQuote: plain(500).describe('An exact, unedited excerpt of the current owner message explicitly asking to establish an ongoing project.'),
  originTaskId: z.uuid().optional().describe('Only the existing completed Studio draft the owner explicitly wants to carry forward.'),
  leaderBotId: z.uuid().optional().describe('Only an existing Leader Bot the owner explicitly named; omit for a new Leader.'),
})
const outputSchema = z.strictObject({ text: z.string() })

/** Bind an Assistant's proposed project to one owner request and present a native confirmation without delegating authority to the model. */
export class StudioProjectIntake {
  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly ready: (agent: Agent) => boolean, private readonly stopping: AbortSignal) {}

  available(agent: Agent): boolean { return this.ready(agent) && ownerConfirmationAvailable(agent) }

  install(agent: Agent): () => void {
    if (!ownerConfirmationAvailable(agent)) return () => {}
    return agent.ctx.tools.register({ name: PROPOSE_PROJECT,
      description: 'Show an owner-only confirmation for an explicit new project request. A proposal alone does not create a project or start work.',
      parameters: z.toJSONSchema(proposalArgs), timeoutMs: TIMEOUT_MS + 10_000,
      presentCall: () => ({ card: 'generic', title: 'Confirm project creation' }),
      output: { schema: { type: 'object', required: ['text'], additionalProperties: false, properties: { text: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: outputSchema.parse(value).text }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const fields = proposalArgs.safeParse(args)
        if (!fields.success || exec.agent !== agent || exec.parent !== undefined || !this.available(agent)) {
          throw new Error('Project proposal denied: INVALID_EXECUTION')
        }
        const source = ownerRequest(agent, exec.callId, PROPOSE_PROJECT)
        if (!source || !source.requestText.includes(fields.data.intentQuote)) {
          throw new Error('Project proposal denied: EXPECTED_EXACT_OWNER_EXCERPT')
        }
        const route = draftWorkerRoute(agent)
        const pending = this.store.projects.proposeProject({ ...source, ...fields.data, assistantSessionId: agent.id })
        if (!pending.ok) throw new Error(`Project proposal denied: ${pending.reason}`)
        const { proposal, created } = pending.value
        if (!created) return { text: this.describe(agent, proposal) }
        const signal = AbortSignal.any([exec.signal, this.stopping, AbortSignal.timeout(TIMEOUT_MS)])
        let committed = false
        try {
          if (!this.available(agent)) throw new Error('PROJECT_CONFIRMATION_UNAVAILABLE')
          const confirmed = await confirmWithOwner(agent, signal, { id: proposal.proposalId, approve: 'Create project', allowMobile: true,
            question: `Create the ongoing project “${proposal.name}”?`,
            detail: `Owner's words: ${proposal.intentQuote}\n\nObjective: ${proposal.objective}\n\n${proposal.originTaskId
              ? `Carry forward completed task ${proposal.originTaskId} without rerunning it.` : 'No earlier task is linked.'}\n${proposal.leaderBotId
              ? `Use existing Leader Bot ${proposal.leaderBotId}.` : 'Create a separate Leader Bot.'}\nThis creates a project record and a Leader Session, not a work assignment.`,
          })
          if (!confirmed) return { text: 'Project not created. The owner did not confirm this proposal.' }
          if (!this.available(agent)) throw new Error('PROJECT_CONFIRMATION_UNAVAILABLE')

          // A passive Leader Session must exist durably before its ID becomes the current management binding.
          // No model is invoked here. A failed confirmation write leaves at most an unbound Session, not a second project.
          const leaderSessionId = newStudioSessionId()
          const leader = await createStudioSession(this.ctx, leaderSessionId, LEADER_PRESET, route, signal)
          await leader.dispose()
          signal.throwIfAborted()
          if (!this.available(agent)) throw new Error('PROJECT_CONFIRMATION_UNAVAILABLE')
          const result = this.store.projects.confirmProposal(agent.id, proposal.proposalId, leaderSessionId)
          if (!result.ok) throw new Error(`Project creation could not be confirmed: ${result.reason}`)
          committed = true
          this.store.studio.registerSession({ id: leaderSessionId, conversationId: result.value.projectId, role: 'leader', createdAt: Date.now() })
          return { text: `Project created from the owner's confirmation. No Worker was started.\n${projectText(result.value)}` }
        } finally {
          if (!committed) {
            const closed = this.store.projects.closeProposal(agent.id, proposal.proposalId)
            if (!closed.ok) this.ctx.logger.warn('Could not close Studio project proposal %s: %s', proposal.proposalId, closed.reason)
          }
        }
      },
    })
  }

  /** Retrieve a saved decision without repeating the question or claiming the project was created before confirmation. */
  describe(agent: Agent, proposal: StudioProjectProposal): string {
    if (proposal.projectId !== undefined) {
      const status = this.store.projects.status(agent.id, proposal.projectId)
      if (status.ok) return `Proposal ${proposal.proposalId}: created.\n${projectText(status.value)}`
      return `Proposal ${proposal.proposalId}: created project ${proposal.projectId}; current project status is unavailable.`
    }
    return `Proposal ${proposal.proposalId}: ${proposal.state === 'closed' ? 'closed; no project created' : 'awaiting owner confirmation'}. ${proposal.name}\nObjective: ${proposal.objective}`
  }
}
