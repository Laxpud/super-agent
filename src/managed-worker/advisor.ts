/** Run a scoped consultation through a separate tool-free Advisor, without granting any project or document action. */
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { Advice, AdvisorRoute } from './advisor-store.ts'
import { DRAFT_TIMEOUT_MS, ownerRequest, type StudioAssistant } from './assistant.ts'
import { DRAFT_TEXT_LIMIT, type ManagedResult, type ManagedWorkerStore } from './store.ts'

export const AdvisorConfig: s<Required<AdvisorRoute>> = s.object({
  provider: s.string().required().description('Registered DSH provider route for Advisor consultations.'),
  model: s.string().required().description('Exact model ID on the Advisor provider route.'),
  reasoningEffort: s.string().default('').description('Supported explicit effort; empty uses the adapter default.'),
})
type AdvisorConfig = Required<AdvisorRoute>
type Requester = Advice['role']
const CONSULT = 'studio_consult_advisor'
const READ = 'studio_read_advice'
const id = z.uuid()
const quote = z.string().min(1).max(DRAFT_TEXT_LIMIT)
const consultArgs = z.strictObject({
  question: quote.describe('Exact, unique excerpt of the owner’s current technical question.'),
  evidenceQuote: quote.optional().describe('Exact, unique excerpt of evidence in the same message, separate from the question.'),
  workId: id.optional().describe('For a project Leader only: completed text work in this project, named by exact ID in the owner’s message.'),
})
const readArgs = z.strictObject({ adviceId: id })
const presentation = z.strictObject({ title: z.string(), text: z.string() })
const viewValue = presentation.extend({ receipt: z.string() })

export function isAdvisorTool(name: string): boolean { return name === CONSULT || name === READ }

/** Store route identifiers, never credentials or an endpoint selected by the requester. */
export function advisorSelection(config: AdvisorConfig): AdvisorRoute {
  const { provider, model, reasoningEffort } = config
  const valid = (value: string) => typeof value === 'string' && value.isWellFormed() && value.length <= 256
    && value.trim() === value && !/[\p{Cc}]/u.test(value)
  if (!provider || !model || ![provider, model, reasoningEffort].every(valid)) {
    throw new Error('Studio Advisor requires a provider and model and an optional exact reasoning effort')
  }
  return Object.freeze({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
}

/** Only query the installed Host's adapter metadata, never discover models through a new account or call. */
interface AdvisorModelRegistry {
  listProviders(): readonly { id: string }[]
  resolveCallConfig(config: AdvisorRoute, signal: AbortSignal): Promise<AdvisorRoute>
}
function modelRegistry(ctx: Context): AdvisorModelRegistry | undefined {
  const service = (ctx as unknown as { get(name: string): unknown }).get('llm') as Partial<AdvisorModelRegistry> | undefined
  if (typeof service?.listProviders === 'function' && typeof service.resolveCallConfig === 'function') return service as AdvisorModelRegistry
}

/** Keep advisory opinions separate from work results and label the native source of every saved message. */
function adviceOutput(advice: Advice): z.infer<typeof viewValue> {
  const { adviceId, advisorBotId, advisorSessionId, requesterSessionId, managementEpoch, projectId, route, result } = advice
  const status = `Advice ${adviceId}: ${advice.state}.${advice.failure ? ` Reason: ${advice.failure}.` : ''}`
  const hint = `Read the recorded opinion with /studio-advice ${adviceId}. Consultation does not assign work or authorize actions.`
  const scope = projectId === undefined ? 'Unprojected consultation.' : `Project ${projectId}; Leader Session ${requesterSessionId}; management epoch ${managementEpoch}.`
  const origin = `Advisor Bot ${advisorBotId}; Advisor Session ${advisorSessionId}; execution epoch ${advice.executionEpoch}; ${route.provider}/${route.model}; effort ${route.reasoningEffort ?? 'adapter default'}.`
  const source = `Owner message ${advice.sourceMessageId} in ${advice.role === 'assistant' ? 'Assistant' : 'Leader'} Session ${requesterSessionId}.`
  const evidence = (advice.workId ? `\nSaved text work referenced: ${advice.workId}.` : '')
    + (advice.evidenceQuote ? `\n\nOwner evidence:\n${advice.evidenceQuote}` : '')
  const opinion = result ? `\n\nAdvisor opinion (message ${result.messageId}, turn ${result.turn}, event ${result.eventSeq}):\n${result.text}` : ''
  return { title: result ? 'Advisor opinion' : `Advice ${advice.state}`, receipt: `${status}\n${hint}`,
    text: `${status}\n${scope}\n${origin}\n${source}\n${hint}\n\nQuestion:\n${advice.question}${evidence}${opinion}` }
}

function unwrap<T>(result: ManagedResult<T>): T {
  if (!result.ok) throw new Error(`Studio advice rejected: ${result.reason}`)
  return result.value
}

/** The coordinator chooses a question; the Host alone chooses the model, evidence snapshot, and admission. */
export class StudioAdvisor {
  private readonly active = new Set<Promise<Advice>>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly workers: StudioAssistant,
    private readonly selected: AdvisorRoute | undefined, private readonly ready: (agent: Agent, role: Requester) => boolean,
    private readonly stopping: AbortSignal) {}

  async drain(): Promise<void> { await Promise.allSettled(this.active) }

  guard(agent: Agent, name: string, role: string): string | undefined {
    if ((role !== 'assistant' && role !== 'leader') || !this.ready(agent, role)) return 'Studio advice denied: INVALID_EXECUTION'
    if (name === READ) return
    if (!this.selected || this.stopping.aborted) return 'Studio advice denied: ADVISOR_DISABLED'
    if (role === 'leader') {
      const current = this.store.projects.current(agent.id)
      if (!current.ok) return `Studio advice denied: ${current.reason}`
    }
  }

  install(agent: Agent, role: Requester): () => void {
    // Consultations deliver the original body in the card. A later explicit read can also supply it to the coordinator as evidence.
    const view = (includeOpinion: boolean): Pick<ToolDefinition, 'output' | 'presentResult'> => ({
      output: { schema: { type: 'object', additionalProperties: false, required: ['title', 'text', 'receipt'],
        properties: { title: { type: 'string' }, text: { type: 'string' }, receipt: { type: 'string' } } },
      render: (_args, value) => { const saved = viewValue.parse(value); return [{ type: 'text', text: includeOpinion ? saved.text : saved.receipt }] },
      presentationMeta: (_args, value) => { const { title, text } = viewValue.parse(value); return { title, text } },
      },
      presentResult: (_args, outcome) => {
        const parsed = presentation.safeParse(outcome.meta)
        if (parsed.success) return { card: 'generic', title: parsed.data.title, content: [{ type: 'text', text: parsed.data.text }] }
      },
    })
    const tools: { register(definition: ToolDefinition, options?: { when(): boolean }): () => void } = agent.ctx.tools
    const removeRead = tools.register({ ...view(role === 'leader'), name: READ,
      description: 'Read one saved Advisor opinion by ID, without starting a consultation or work.', parameters: z.toJSONSchema(readArgs),
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const parsed = readArgs.safeParse(args)
        if (!parsed.success || exec.agent !== agent || exec.parent !== undefined || !this.ready(agent, role)) {
          throw new Error('Studio advice rejected: INVALID_EXECUTION')
        }
        return adviceOutput(unwrap(this.store.advice.read(agent.id, parsed.data.adviceId)))
      },
    })
    const selected = this.selected
    if (!selected) return removeRead
    try {
      const removeConsult = tools.register({ ...view(false), name: CONSULT,
        description: 'Request an independent opinion on a current owner question; no project or work is created or executed.',
        parameters: z.toJSONSchema(consultArgs), timeoutMs: DRAFT_TIMEOUT_MS + 15_000,
        presentCall: () => ({ card: 'generic', title: 'Consult Advisor' }),
        execute: async (args, exec) => {
          const signal = AbortSignal.any([exec.signal, this.stopping])
          signal.throwIfAborted()
          const parsed = consultArgs.safeParse(args)
          if (!parsed.success || exec.agent !== agent || exec.parent !== undefined) throw new Error('Studio advice rejected: INVALID_EXECUTION')
          const denied = this.guard(agent, CONSULT, role)
          if (denied) throw new Error(denied)
          const source = ownerRequest(agent, exec.callId, CONSULT)
          if (!source) throw new Error('Studio advice rejected: EXPECTED_CURRENT_OWNER_TEXT_REQUEST')
          const cwd = agent.session.header.cwd
          if (!cwd || !isAbsolute(cwd)) throw new Error('Studio advice rejected: WORKSPACE_MISSING')
          const route = await this.resolveRoute(selected, signal)
          if (!this.ready(agent, role)) throw new Error('Studio advice rejected: REQUESTER_UNAVAILABLE')
          const { advice, created } = unwrap(this.store.advice.reserve({ ...source, ...parsed.data, requesterSessionId: agent.id,
            role, route, toolCallId: exec.callId }))
          if (!created) return adviceOutput(advice)
          const running = this.run(agent, advice, cwd, signal)
          this.active.add(running)
          try { return adviceOutput(await running) } finally { this.active.delete(running) }
        },
      }, { when: () => this.guard(agent, CONSULT, role) === undefined })
      return () => { try { removeConsult() } finally { removeRead() } }
    } catch (error) { removeRead(); throw error }
  }

  command(agent: Agent, argument: string): { kind: 'success' | 'error'; text: string } {
    if (!this.ready(agent, 'assistant') && !this.ready(agent, 'leader')) {
      return { kind: 'error', text: 'Open a Studio Assistant or Leader Session to read a saved opinion.' }
    }
    const parsed = id.safeParse(argument.trim())
    if (!parsed.success) return { kind: 'error', text: 'Use /studio-advice <advice-id>.' }
    const advice = this.store.advice.read(agent.id, parsed.data)
    return advice.ok ? { kind: 'success', text: adviceOutput(advice.value).text }
      : { kind: 'error', text: `Cannot read Studio advice: ${advice.reason}.` }
  }

  private async resolveRoute(selected: AdvisorRoute, signal: AbortSignal): Promise<AdvisorRoute> {
    const denial = this.workers.providerDenial(selected.provider)
    if (denial) throw new Error(denial)
    const registry = modelRegistry(this.ctx)
    if (!registry?.listProviders().some(entry => entry.id === selected.provider)) throw new Error('Studio advice rejected: ADVISOR_PROVIDER_UNAVAILABLE')
    let verified: AdvisorRoute
    try { verified = await registry.resolveCallConfig({ ...selected }, signal) }
    catch { throw new Error('Studio advice rejected: ADVISOR_MODEL_OR_EFFORT_UNSUPPORTED') }
    signal.throwIfAborted()
    if (verified.provider !== selected.provider || verified.model !== selected.model
      || (selected.reasoningEffort !== undefined && verified.reasoningEffort !== selected.reasoningEffort)) {
      throw new Error('Studio advice rejected: ADVISOR_ROUTE_CHANGED')
    }
    const { provider, model, reasoningEffort } = verified
    return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
  }

  private async run(agent: Agent, advice: Advice, cwd: string, signal: AbortSignal): Promise<Advice> {
    const check = (operation: () => ManagedResult<Advice>) => {
      if (!this.ready(agent, advice.role)) return 'REQUESTER_UNAVAILABLE'
      const current = operation()
      return current.ok ? undefined : current.reason
    }
    const { result, failure } = await this.workers.runTextWorker(agent, SessionId(advice.advisorSessionId),
      { cwd, model: advice.route }, advice.inputText, signal, {
        beforeRelay: () => check(() => this.store.advice.canStart(advice)),
        beforeEnter: () => check(() => this.store.advice.begin(advice)),
      }, 'advisor')
    // Preserve the original started consultation after a Leader change without reviving the prior Leader's authority.
    const saved = this.store.advice.settle(advice, result, result ? '' : failure)
    if (!saved.ok) throw new Error(`Studio advice ${advice.adviceId} could not be confirmed: ${saved.reason}. Check /studio-advice; do not resubmit.`)
    return saved.value
  }
}
