/** Assistant 和 Leader 从当前已认证的用户原文登记任务，Worker 只处理指定执行轮次。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session'
import type { ToolOutputDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { LIST_PROJECTS, STUDIO_TEXT_LIMIT, WORKER_DELEGATE, WORKER_READ, type StudioModel, type StudioRole, type StudioWorkerPermission } from '../studio/protocol.ts'
import { StudioError } from '../studio/pending.ts'
import type { StudioSessions } from '../studio/sessions.ts'
import { isStudioMessageContext, newStudioSessionId } from '../studio/source.ts'
import type { ManagedWorkerStore, StudioExecution } from './store.ts'
import { classifyProviderFailure, type WorkerModelPolicy } from './text-worker-model-policy.ts'

export const ASSISTANT_PRESET = 'agent-studio-assistant'
export const WORKER_PRESET = 'agent-studio-managed-worker'
const WORKER_TIMEOUT_MS = 180_000
const noArgs = z.strictObject({})
const taskArg = z.strictObject({ taskId: z.uuid() })

const prompts: Record<StudioRole, string> = {
  assistant: `You are the Agent Studio Assistant. Answer simple questions directly. For work requiring independent execution, use ${WORKER_DELEGATE} once for the exact current owner request. Confirm missing context in normal chat. A registered task is not a result. Use ${WORKER_READ} to retrieve a known result and ${LIST_PROJECTS} to inspect current projects. Suggest a project when appropriate; only propose it for owner confirmation when instructed. Never claim file or shell work was performed.`,
  leader: `You are the current Leader of this Agent Studio project. Use the project objective and assignment to guide your work. Answer normal questions directly. For work requiring independent execution, call ${WORKER_DELEGATE} once without rewriting the user's request, and use ${WORKER_READ} to read the project's saved results. Do not confuse task registration with completion.`,
  worker: 'You are an Agent Studio Worker for one controlled task. Return your result for the requesting conversation. This stage does not grant filesystem or shell access; report any missing inputs or unavailable capabilities instead of claiming actions you did not carry out.',
}

export interface StudioAgentHandle { agent: Agent; dispose(): Promise<void> }
interface NativeFactory {
  agents: { create(options: { sessionId: SessionId; meta: { cwd: string; agentPreset: string }; agentOptions: StudioModel;
    signal: AbortSignal; setup(agentCtx: Context): Promise<void> }): Promise<StudioAgentHandle> }
  agentPresets: { mount(ctx: Context, preset: string): Promise<unknown> }
}

/** 用已选预设创建隔离 Session；调用者负责关闭句柄并确认原生日志落盘。 */
export function createStudioSession(ctx: Context, id: SessionId, preset: string, route: { cwd: string; model: StudioModel },
  signal: AbortSignal): Promise<StudioAgentHandle> {
  const host = ctx as unknown as NativeFactory
  return host.agents.create({ sessionId: id, meta: { cwd: route.cwd, agentPreset: preset }, agentOptions: route.model, signal,
    setup: async agentCtx => { await host.agentPresets.mount(agentCtx, preset) } })
}

export interface OwnerRequest { sourceMessageId: string; sourceRequestId: string; requestText: string }

/** 当前轮必须恰好包含一次真实的所有者输入；历史、转述和模型上下文不能充当任务授权。 */
export function ownerRequest(agent: Agent, callId: string, toolName: string): OwnerRequest | undefined {
  const session = agent.session
  if (session.header.origin === 'subagent' || agent.inbox.nextStep.length || agent.inbox.nextTurn.length) return
  let callTurn: number | undefined
  let input: OwnerRequest | undefined
  const first = Math.max(session.inheritedEventCount, session.firstLiveSeq, session.seq - 256)
  for (let offset = session.seq - 1; offset >= first; offset--) {
    const event = session.eventAt(SessionSeq(offset))
    if (event?.type === 'turn/start') return event.data.turn === callTurn ? input : undefined
    if (event?.type === 'turn/end') return
    if (event?.type === 'tool/call' && event.data.callId === callId && event.data.name === toolName) {
      if (callTurn !== undefined) return
      callTurn = event.data.turn
    }
    if (event?.type !== 'user/message') continue
    const { source, content, id } = event.data
    const attribution: { kind: string; rpcId?: unknown; principal?: unknown } = source
    if (attribution.kind === 'runtime-context' || isStudioMessageContext(event.data)) continue
    if (callTurn === undefined || input || event.surfaceOp !== 'append' || attribution.kind !== 'user' || attribution.principal !== undefined
      || typeof attribution.rpcId !== 'string' || content.length !== 1 || content[0]?.type !== 'text') return
    const requestText = content[0].text
    if (!requestText.trim() || !requestText.isWellFormed() || requestText.includes('\0') || requestText.length > STUDIO_TEXT_LIMIT) return
    input = { sourceMessageId: id, sourceRequestId: attribution.rpcId, requestText }
  }
}

interface WorkerTurn {
  execution: StudioExecution
  message: UserMessage
  signal: AbortSignal
  turn?: number
}
const receipt: ToolOutputDefinition = { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  render: (_args, value) => [{ type: 'text', text: z.object({ text: z.string() }).parse(value).text }] }

/** Studio 前台只登记工作；单独的执行句柄和统一账本负责最终交付。 */
export class StudioAssistant {
  readonly #workers = new Map<Agent, WorkerTurn>()

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly sessions: StudioSessions,
    private readonly models: WorkerModelPolicy, private readonly defaultPermission: StudioWorkerPermission,
    private readonly ready: (agent: Agent, role: StudioRole) => boolean, private readonly cwd: string) {}

  install(agent: Agent, role: StudioRole): () => void {
    const disposers: Array<() => void> = []
    try {
      disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
      disposers.push(agent.ctx.systemPrompt.section({ name: 'agent-studio-role', order: 10, complete: true, interpolate: false, text: prompts[role] }))
      if (role === 'worker') return () => { for (const dispose of disposers.reverse()) dispose() }
      if (role === 'assistant') disposers.push(agent.ctx.tools.register({ name: LIST_PROJECTS, description: 'List active Studio projects.',
        parameters: z.toJSONSchema(noArgs), output: receipt,
        execute: async (args, exec) => {
          if (!noArgs.safeParse(args).success || exec.agent !== agent || !this.ready(agent, role)) throw new Error('Studio project list denied')
          return { text: this.store.projects.list().map(project => `${project.name} (${project.id}): ${project.objective}`).join('\n') || 'No active Studio projects.' }
        },
      }))
      disposers.push(agent.ctx.tools.register({ name: WORKER_DELEGATE, description: 'Register background work using the exact current user request. Registration does not mean delivery.',
        parameters: z.toJSONSchema(noArgs), output: receipt,
        execute: async (args, exec) => {
          exec.signal.throwIfAborted()
          const source = ownerRequest(agent, exec.callId, WORKER_DELEGATE)
          if (!noArgs.safeParse(args).success || exec.agent !== agent || exec.parent !== undefined || !this.ready(agent, role)
            || !source || !this.sessions.matchesOwnerRequest(agent, source) || this.sessions.isExistingTaskReply(agent)) {
            throw new Error('Studio dispatch denied: EXPECTED_EXACT_OWNER_REQUEST')
          }
          const leader = role === 'leader' ? this.store.projects.currentLeader(agent.id) : undefined
          if (role === 'leader' && !leader) throw new Error('Studio dispatch denied: STALE_LEADER')
          const model = this.sessions.modelFor(role)
          const task = this.sessions.scheduleTask(agent, {
            projectId: leader?.id ?? null, sourceMessageId: source.sourceMessageId, requestId: source.sourceRequestId,
            requesterBotId: leader?.leaderBotId ?? this.store.assistantBotId, workspacePath: leader?.workspacePath ?? null,
            permission: this.defaultPermission, requestText: source.requestText,
            ...(leader ? { leader: { sessionId: agent.id, managementEpoch: leader.managementEpoch } } : {}),
          }, (taskId, signal) => this.runWorker(taskId, role, leader?.managementEpoch ?? null, model, signal))
          const native = exec as typeof exec & { concludeTurn?(): void }
          native.concludeTurn?.()
          return { text: `Studio task ${task.taskId} ${task.created ? 'registered' : 'already registered'}.` }
        },
      }))
      disposers.push(agent.ctx.tools.register({ name: WORKER_READ, description: 'Read the exact saved status or delivered result of a task in your conversation.',
        parameters: z.toJSONSchema(taskArg), output: receipt,
        execute: async (args, exec) => {
          const input = taskArg.safeParse(args)
          if (!input.success || exec.agent !== agent || !this.ready(agent, role)) throw new Error('Studio result read denied')
          const task = this.store.task(input.data.taskId)
          const projectId = role === 'leader' ? this.store.projects.currentLeader(agent.id)?.id : null
          if (!task || task.projectId !== projectId) throw new Error('No Studio task in this conversation')
          return { text: `${task.taskId}: ${task.status}${task.resultSummary ? `\n\n${task.resultSummary}` : ''}` }
        },
      }))
      return () => { for (const dispose of disposers.reverse()) dispose() }
    } catch (error) { for (const dispose of disposers.reverse()) dispose(); throw error }
  }

  /** 预检必须识别未受修改的入站消息及同一轮次，来历不明的原生输入一律拒绝。 */
  admit(agent: Agent, messages: readonly UserMessage[], turn: number): boolean {
    const live = this.#workers.get(agent)
    if (!live || !this.executionCurrent(agent)) return false
    if (live.turn !== undefined) return live.turn === turn && messages.length === 0
    const message = messages[0]
    if (messages.length !== 1 || !message || message.id !== live.message.id || message.source.kind !== 'agent-studio'
      || message.content.length !== 1 || message.content[0]?.type !== 'text' || live.message.content[0]?.type !== 'text'
      || message.content[0].text !== live.message.content[0].text) return false
    live.turn = turn
    return true
  }

  executionCurrent(agent: Agent): boolean {
    const live = this.#workers.get(agent)
    return !!live && !live.signal.aborted && this.store.executionCurrent(live.execution)
  }

  private async runWorker(taskId: string, role: Exclude<StudioRole, 'worker'>, epoch: number | null, fallback: StudioModel,
    caller: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([caller, AbortSignal.timeout(WORKER_TIMEOUT_MS)])
    let handle: StudioAgentHandle | undefined
    let execution: StudioExecution | undefined
    let outcome = 'worker-interrupted'
    let result: { text: string; eventSeq: number } | undefined
    let taskVersion: number | undefined
    try {
      const task = this.store.task(taskId)
      if (!task || task.status !== 'queued') return
      taskVersion = task.authorizationVersion
      const model = await this.models.pin(this.models.selectModel(role, { task, fallback }), signal)
      signal.throwIfAborted()
      const id = newStudioSessionId()
      execution = this.store.beginExecution(taskId, id, epoch, model)
      if (!execution) return
      // V1 先记录工作区授权；当前阶段使用独立宿主目录且不挂载任何作业工具。
      handle = await createStudioSession(this.ctx, id, WORKER_PRESET, { cwd: this.cwd, model }, signal)
      if (!this.ready(handle.agent, 'worker') || !this.store.executionCurrent(execution)) throw new Error('Studio Worker authority changed')
      this.store.studio.registerSession({ id, role: 'worker', conversationId: task.projectId ?? 'assistant', createdAt: Date.now() })
      result = await this.capture(handle.agent, execution, task.requestText, signal)
      if (result && this.ready(handle.agent, 'worker')) outcome = 'delivered'
      else result = undefined
    } catch (error) {
      result = undefined
      outcome = classifyProviderFailure(error)
      if (!execution && !signal.aborted && taskVersion !== undefined && error instanceof StudioError && error.code === 'MODEL_UNAVAILABLE') {
        this.store.markTaskBlocked(taskId, taskVersion, 'Check the Worker model settings. Clearing this block does not rerun the task.')
      }
    }
    finally {
      // 原生取消之前先撤销任务授权；正常完成则等待日志落盘后再公开结果来源。
      const mustFence = !!execution && (!result || signal.aborted)
      try { if (execution && mustFence) this.store.finishExecution(execution, undefined, outcome) }
      finally {
        try { if (handle && signal.aborted) handle.agent.cancel({ kind: 'hook', reason: 'Studio task stopped.' }) }
        finally {
          try { await handle?.dispose() }
          catch { result = undefined; outcome = 'session-close-unconfirmed' }
        }
      }
      if (execution && !mustFence) this.store.finishExecution(execution, signal.aborted ? undefined : result, outcome)
      else if (!execution && this.store.task(taskId)?.status === 'queued') this.store.invalidateTask(taskId, 'interrupted')
    }
  }

  private async capture(agent: Agent, execution: StudioExecution, request: string, signal: AbortSignal) {
    const result = Promise.withResolvers<{ text: string; eventSeq: number } | undefined>()
    const message = freezeMessage<UserMessage>({ id: MessageId(`agent-studio-work:${execution.taskId}`), role: 'user',
      content: [{ type: 'text', text: request }], source: { kind: 'agent-studio', form: 'relay' } })
    const live: WorkerTurn = { execution, message, signal }
    let last: { text: string; eventSeq: number } | undefined
    const remove = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'assistant/message' && event.data.turn === live.turn && !event.data.interrupted) {
        const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n')
        if (text.trim()) last = { text: text.slice(0, STUDIO_TEXT_LIMIT).toWellFormed(), eventSeq: event.seq }
      } else if (event.type === 'turn/end' && (live.turn === undefined || event.data.turn === live.turn)) {
        if (live.turn !== undefined && event.data.reason.kind === 'completed') result.resolve(last)
        else if (event.data.reason.kind === 'error') result.reject(event.data.reason.error)
        else result.resolve(undefined)
      }
    })
    const abort = () => result.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    this.#workers.set(agent, live)
    try {
      signal.throwIfAborted()
      agent.followup(message)
      agent.whenIdle().then(() => result.resolve(undefined), result.reject)
      return await result.promise
    } finally { this.#workers.delete(agent); signal.removeEventListener('abort', abort); remove() }
  }
}
