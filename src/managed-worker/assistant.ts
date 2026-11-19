/** Route one owner GUI request to a tool-free Worker and retain its actual final message for delivery. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { DRAFT_TEXT_LIMIT, type ManagedResult, type ManagedWorkerStore, type StudioDraftResult, type StudioDraftTask } from './store.ts'

export const ASSISTANT_PRESET = 'dsh-superagent-studio-assistant'
export const DRAFT_DELEGATE = 'studio_delegate_draft'
const DRAFT_READ = 'studio_read_draft'
const DRAFT_TIMEOUT_MS = 180_000
const delegateSchema = z.strictObject({})
const readSchema = z.strictObject({ taskId: z.uuid().optional() })
const outputSchema = z.strictObject({ title: z.string(), receipt: z.string(), text: z.string() })

const ASSISTANT_PROMPT = `You are the workspace Assistant. Your job is to understand the user's intent and send business or technical work to a Worker, even when it is simple. Do not write, analyze, or implement the requested work yourself.
For a new, self-contained text task, call studio_delegate_draft once without rewriting the request. The Worker cannot use tools, access files or external systems, or edit managed documents through this route. Clarify if a useful text task cannot be inferred. For an existing task, read the saved result instead of delegating it again. After a tool returns, communicate the status and where to find the result. Do not invent, extend, or claim authorship of the Worker's result.`
const WORKER_PROMPT = `You are the Worker for one task. The Assistant relays the user's self-contained text request. Return the requested text for direct delivery to the user. You have no tools, files, or external systems in this task. Do not claim to have modified or consulted them. If a necessary input is missing, report the specific limitation in your response.`

interface ModelRoute { provider: string; model: string; reasoningEffort?: string }
interface WorkerHandle { agent: Agent; dispose(): Promise<void> }
/** The installed rc.3 factory owns the Session and drains its persisted events on dispose. */
interface DraftRuntime {
  agents: { create(options: {
    sessionId: SessionId; meta: { cwd: string; agentPreset: string }; agentOptions: ModelRoute;
    signal: AbortSignal; setup(agentCtx: Context): Promise<void>;
  }): Promise<WorkerHandle> }
  agentPresets: { mount(ctx: Context, id: string): Promise<unknown> }
}

interface OwnerRequest { sourceMessageId: string; sourceRequestId: string; requestText: string }
interface DraftInput { messageId: string; turn?: number }

export function isAssistantTool(name: string): boolean { return name === DRAFT_DELEGATE || name === DRAFT_READ }

/** Use the latest admitted owner input in the open turn, not history, a model summary, or a tool argument. */
function ownerRequest(agent: Agent, callId: string): OwnerRequest | undefined {
  const session = agent.session
  let recordedCall = false
  for (let offset = session.seq - 1; offset >= session.firstLiveSeq; offset--) {
    const event = session.eventAt(SessionSeq(offset))
    if (event?.type === 'turn/start' || event?.type === 'turn/end') break
    if (event?.type === 'tool/call' && event.data.callId === callId && event.data.name === DRAFT_DELEGATE) recordedCall = true
    if (!recordedCall || event?.type !== 'user/message') continue
    const { source, content, id } = event.data
    const attribution: { kind: string; rpcId?: unknown; principal?: unknown } = source
    // The loop logs its runtime context next to the user message. Skip that context, but not another request or relay.
    if (attribution.kind === 'runtime-context') continue
    // The Web controller sets rpcId on submitted prompts and records a principal only for a non-owner caller.
    if (attribution.kind !== 'user' || typeof attribution.rpcId !== 'string' || attribution.principal !== undefined) return
    const requestText = textOnly(content)
    if (requestText === undefined) return
    return { sourceMessageId: id, sourceRequestId: attribution.rpcId, requestText }
  }
}

/** Preserve text block content verbatim, with only a separator between blocks. Reject non-text input. */
function textOnly(content: UserMessage['content']): string | undefined {
  if (!content.every(block => block.type === 'text')) return
  const text = content.map(block => block.text).join('\n\n')
  if (text.length <= DRAFT_TEXT_LIMIT && text.isWellFormed() && text.trim()) return text
}

/** The command and the tool card use the same provenance and unmodified output. */
export function draftOutput(task: StudioDraftTask): z.infer<typeof outputSchema> {
  const receipt = `Task ${task.taskId}: ${task.state}. Worker Bot ${task.workerBotId}; Worker Session ${task.workerSessionId}; execution epoch ${task.executionEpoch}.`
  const hint = `Retrieve this task with /studio-result ${task.taskId} in a Studio Assistant Session.`
  if (!task.result) {
    const status = `${receipt}${task.failure ? ` Reason: ${task.failure}.` : ''}\n${hint}`
    return { title: `Worker task ${task.state}`, receipt: status, text: status }
  }
  const source = `Worker message ${task.result.messageId} (turn ${task.result.turn}, event ${task.result.eventSeq}).`
  return { title: 'Worker result', receipt: `${receipt} ${source}\n${hint}`, text: `${receipt}\n${source}\n\n${task.result.text}` }
}

function unwrap<T>(result: ManagedResult<T>): T {
  if (!result.ok) throw new Error(`Studio draft rejected: ${result.reason}`)
  return result.value
}

/** Own the Assistant's delegation and the temporary admission for each independently created draft Worker. */
export class StudioAssistant {
  private readonly runtime: DraftRuntime
  private readonly stopping = new AbortController()
  /** Exact Agents under this host's custody. A cold-reopened Worker never receives a new admission here. */
  private readonly drafts = new WeakMap<Agent, DraftInput>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly workerPreset: string,
    private readonly assistantReady: (agent: Agent) => boolean, private readonly workerReady: (agent: Agent) => boolean) {
    this.runtime = ctx as unknown as DraftRuntime
  }

  stop(): void { this.stopping.abort() }

  /** Admit only the relayed task, once and in the exact live Agent. A later GUI or replayed input is not a new assignment. */
  admit(agent: Agent, messages: readonly UserMessage[], turn: number): boolean {
    const input = this.drafts.get(agent)
    if (!input || input.turn !== undefined || !this.workerReady(agent)
      || messages.length !== 1 || messages[0]?.id !== input.messageId) return false
    input.turn = turn
    return true
  }

  /** Install only role prompt text and the two application tools; the caller hides inherited tools first. */
  install(agent: Agent, role: 'assistant' | 'draft-worker'): () => void {
    const disposers: (() => void)[] = []
    const dispose = () => { for (const remove of disposers.reverse()) remove(); disposers.length = 0 }
    try {
      disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
      disposers.push(agent.ctx.systemPrompt.section({ name: 'superagent-studio-role', order: 10, complete: true, interpolate: false,
        text: role === 'assistant' ? ASSISTANT_PROMPT : WORKER_PROMPT }))
      if (role === 'draft-worker') return dispose
      // Pass a receipt to the Assistant after delegating. The exact draft belongs to the user-facing result card, not to the next prompt by default.
      const output = (includeText: boolean) => ({
        schema: { type: 'object' as const, additionalProperties: false, required: ['title', 'receipt', 'text'],
          properties: { title: { type: 'string' as const }, receipt: { type: 'string' as const }, text: { type: 'string' as const } } },
        render: (_args: unknown, value: unknown) => {
          const draft = outputSchema.parse(value)
          return [{ type: 'text' as const, text: includeText ? draft.text : draft.receipt }]
        },
        presentationMeta: (_args: unknown, value: unknown) => {
          const { title, text } = outputSchema.parse(value)
          return { title, text }
        },
      })
      disposers.push(agent.ctx.tools.register({ name: DRAFT_DELEGATE,
        description: 'Send the current owner text request to a Worker and return the saved task receipt.',
        parameters: z.toJSONSchema(delegateSchema), output: output(false), timeoutMs: DRAFT_TIMEOUT_MS + 10_000,
        presentCall: () => ({ card: 'generic', title: 'Delegate to a Worker' }),
        presentResult: (_args, result) => card(result.meta),
        execute: async (args, exec) => {
          if (!delegateSchema.safeParse(args).success || exec.agent !== agent || exec.parent !== undefined || !this.assistantReady(agent)) {
            throw new Error('Studio draft rejected: INVALID_EXECUTION')
          }
          const source = ownerRequest(agent, exec.callId)
          if (!source) throw new Error('Studio draft rejected: EXPECTED_CURRENT_OWNER_TEXT_REQUEST')
          return draftOutput(await this.delegate(agent, source, exec.signal))
        },
      }))
      disposers.push(agent.ctx.tools.register({ name: DRAFT_READ,
        description: 'Read a saved Worker result by task ID, or the latest task in this Assistant Session when omitted.',
        parameters: z.toJSONSchema(readSchema), output: output(true),
        presentCall: () => ({ card: 'generic', title: 'Retrieve a Worker result' }),
        presentResult: (_args, result) => card(result.meta),
        execute: async (args, exec) => {
          const parsed = readSchema.safeParse(args)
          exec.signal.throwIfAborted()
          if (!parsed.success || exec.agent !== agent || exec.parent !== undefined || !this.assistantReady(agent)) {
            throw new Error('Studio draft rejected: INVALID_EXECUTION')
          }
          return draftOutput(unwrap(this.store.readDraft(agent.id, parsed.data.taskId)))
        },
      }))
      return dispose
    } catch (error) { dispose(); throw error }
  }

  /** Reserve the task and Worker ID before any model input, then dispatch using the Assistant's current model route. */
  private async delegate(agent: Agent, source: OwnerRequest, caller: AbortSignal): Promise<StudioDraftTask> {
    const cwd = agent.session.header.cwd
    const model = (agent as Agent & { model?: { current(): ModelRoute | undefined } }).model?.current()
    if (!cwd || !isAbsolute(cwd) || !model?.provider || !model.model) throw new Error('Studio draft rejected: WORKSPACE_OR_MODEL_MISSING')
    const timeout = AbortSignal.timeout(DRAFT_TIMEOUT_MS)
    const signal = AbortSignal.any([caller, this.stopping.signal, timeout])
    signal.throwIfAborted()
    const workerId = SessionId(randomUUID())
    const { task, created } = unwrap(this.store.startDraft({ ...source, assistantSessionId: agent.id, workerSessionId: workerId }))
    if (!created) return task

    let handle: WorkerHandle | undefined
    let result: StudioDraftResult | undefined
    let failure = 'WORKER_FAILED'
    try {
      // Creation mounts the preset and applies the persisted role binding. It must not wait on a model turn while the factory holds maintenance.
      handle = await this.runtime.agents.create({ sessionId: workerId, meta: { cwd, agentPreset: this.workerPreset },
        agentOptions: model, signal, setup: async workerCtx => { await this.runtime.agentPresets.mount(workerCtx, this.workerPreset) } })
      signal.throwIfAborted()
      if (!this.assistantReady(agent) || !this.workerReady(handle.agent)) throw new Error('Worker admission changed')
      // The rc.3 relay source identifies the sending Assistant without attributing the message to the receiving Worker or to another owner request.
      const message = freezeMessage<UserMessage>({ id: MessageId(randomUUID()), role: 'user', content: [{ type: 'text', text: source.requestText }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: agent.id } as unknown as UserMessage['source'] })
      result = await this.capture(handle.agent, message, signal)
      if (!result) failure = 'NO_COMPLETE_WORKER_TEXT'
    } catch {
      failure = 'WORKER_FAILED'
    } finally {
      // The Worker is explicitly released; its Session log is kept. Do not announce a correct-looking result if closing its source log failed.
      try { await handle?.dispose() }
      catch { result = undefined; failure = 'WORKER_SESSION_CLOSE_FAILED' }
    }
    if (signal.aborted) { result = undefined; failure = timeout.aborted ? 'WORKER_TIMEOUT' : 'WORKER_ABORTED' }
    if (!this.assistantReady(agent)) { result = undefined; failure = 'ASSISTANT_UNAVAILABLE' }
    return unwrap(result ? this.store.completeDraft(task, result) : this.store.failDraft(task, failure))
  }

  /** Capture by exact Session and admitted turn. A stream delta, failed turn, or unrelated follow-up cannot become a saved result. */
  private async capture(agent: Agent, message: UserMessage, signal: AbortSignal): Promise<StudioDraftResult | undefined> {
    const settled = Promise.withResolvers<StudioDraftResult | undefined>()
    const input: DraftInput = { messageId: message.id }
    let final: StudioDraftResult | undefined
    const remove = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || input.turn === undefined) return
      if (event.type === 'assistant/message' && event.data.turn === input.turn) {
        const text = !event.data.interrupted && textOnly(event.data.message.content.filter(block => block.type !== 'reasoning'))
        final = text ? { text, messageId: event.data.message.id, eventSeq: event.seq, turn: input.turn } : undefined
      } else if (event.type === 'turn/end' && event.data.turn === input.turn) {
        settled.resolve(event.data.reason.kind === 'completed' ? final : undefined)
      }
    })
    const abort = () => settled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    this.drafts.set(agent, input)
    try {
      signal.throwIfAborted()
      agent.followup(message)
      return await settled.promise
    } finally {
      this.drafts.delete(agent)
      signal.removeEventListener('abort', abort)
      remove()
    }
  }
}

/** Read only the saved presentation data; replay does not call the model or touch storage. */
function card(meta: unknown) {
  const value = outputSchema.pick({ title: true, text: true }).safeParse(meta)
  if (value.success) return { card: 'generic' as const, title: value.data.title, content: [{ type: 'text' as const, text: value.data.text }] }
}
