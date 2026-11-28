/** 单所有者 Agent Studio 宿主；不加载 GitHub Ticket、旧文档或外部作业子系统。 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { lockSync } from 'proper-lockfile'
import { currentPresetId } from '../infra/preset-names.ts'
import { StudioConfigurationControl } from '../studio/configuration.ts'
import { studioTaskText } from '../studio/domain.ts'
import { FeishuConversationConfig, feishuSourceScope, validateFeishuInbox, type FeishuBindingConfig } from '../studio/feishu-binding.ts'
import { StudioFeishuSdk } from '../studio/feishu-sdk.ts'
import { StudioFeishuConversation } from '../studio/feishu.ts'
import { StudioFeishuSetup } from '../studio/feishu-setup.ts'
import { registerStudioHttp } from '../studio/http.ts'
import { StudioError } from '../studio/pending.ts'
import { FORWARD_PROJECT, isStudioInternalSession, LIST_PROJECTS, PROPOSE_PROJECT, WORKER_DELEGATE, WORKER_READ, type FeishuState,
  type StudioModel, type StudioRole, type StudioWorkerPermission } from '../studio/protocol.ts'
import { StudioService } from '../studio/service.ts'
import { StudioCredentials } from '../studio/settings-credentials.ts'
import { confirmStudioDirectory, STUDIO_DB, verifyWorkspace, type StudioDirectorySwitch } from '../studio/settings-directory.ts'
import { ASSISTANT_PRESET, StudioAssistant, WORKER_PRESET } from './assistant.ts'
import { MEMORY_COMMAND, MEMORY_HINT, memoryCommand } from './memory.ts'
import { StudioProjectIntake } from './project-intake.ts'
import { LEADER_PRESET, PROJECT_COMMAND, PROJECT_HINT, StudioProjectControl } from './project.ts'
import { ManagedWorkerStore } from './store.ts'
import { LegacyWorkerDefaultsConfig, LegacyWorkerRouteConfig, migrateWorkerModels, WorkerModelDefaultsConfig, WorkerModelPolicy,
  WorkerModelRouteConfig } from './text-worker-model-policy.ts'
import { summarizeGuardAction } from './worker-evidence.ts'
import { evaluateWorkerToolCall, guardActionFingerprint, STUDIO_LIST_DIRECTORY, workerSandboxMatches, workerToolAllowlist, type WorkerSandboxPolicy } from './worker-guard.ts'
import { verifyWorkspaceIdentity } from './workspace.ts'

export const name = 'agent-studio-managed-worker'
export const inject = ['agents', 'agentPresets', 'commands', 'connection', 'permissionPresets', 'sandboxPolicy', 'sessionPersistence', 'systemPrompt', 'tools', 'webServer', 'llm']

export interface StudioHostConfig {
  stateDir: string
  studioCwd: string
  assistantModel?: StudioModel
  leaderModel?: StudioModel
  workerModelRoutes: WorkerModelRouteConfig[]
  workerModelDefaults: WorkerModelDefaultsConfig
  defaultWorkerPermission: StudioWorkerPermission
  feishuConversation?: FeishuBindingConfig | null
  studioFeishuCredentialId?: string
  studioDirectoryToken?: string
}

const roleModel: s<StudioModel> = s.object({ provider: s.string().required(), model: s.string().required(), reasoningEffort: s.string() })
const hostFields = s.object({
  stateDir: s.string().required().description('Absolute directory reserved for the Studio database.'),
  studioCwd: s.string().description('Absolute Studio working directory; defaults to the Host working directory.'),
  assistantModel: s.union([s.const(null), roleModel]),
  leaderModel: s.union([s.const(null), roleModel]),
  workerModelRoutes: s.union([s.const(null), s.array(WorkerModelRouteConfig).max(64)]),
  workerModelDefaults: s.union([s.const(null), WorkerModelDefaultsConfig]),
  defaultWorkerPermission: s.union(['read-only' as const, 'workspace-write' as const]).default('read-only')
    .description('Retained for settings compatibility. Dispatch is read-only by default and cannot skip owner approval.'),
  feishuConversation: s.union([s.const(null), FeishuConversationConfig]),
  studioFeishuCredentialId: s.string(),
  studioDirectoryToken: s.string(),
  textWorkerRoutes: s.array(LegacyWorkerRouteConfig).max(64).description('Legacy input alias; new writes use workerModelRoutes.'),
  textWorkerDefaults: LegacyWorkerDefaultsConfig.description('Legacy input alias; new writes use workerModelDefaults.'),
})

/** 旧模型配置仅作只读兼容。忽略已退役的飞书收件箱，使旧配置档仍能启动并由设置页清理旧键，不会沿用旧绑定。 */
export const Config: s<Record<string, unknown>, StudioHostConfig> = s.transform(hostFields, (value): StudioHostConfig => {
  if (!value.stateDir) throw new Error('Agent Studio stateDir is required')
  // 旧设置允许留空；非空路径保留原值，由宿主按绝对路径和现存目录校验。
  const studioCwd = value.studioCwd?.trim() ? value.studioCwd : process.cwd()
  return {
    stateDir: value.stateDir, studioCwd, defaultWorkerPermission: value.defaultWorkerPermission ?? 'read-only',
    ...migrateWorkerModels(value.workerModelRoutes ?? undefined, value.workerModelDefaults ?? undefined, value.textWorkerRoutes ?? undefined, value.textWorkerDefaults ?? undefined),
    ...(value.assistantModel ? { assistantModel: value.assistantModel } : {}),
    ...(value.leaderModel ? { leaderModel: value.leaderModel } : {}),
    ...(value.feishuConversation !== undefined ? { feishuConversation: value.feishuConversation } : {}),
    ...(value.studioFeishuCredentialId != null ? { studioFeishuCredentialId: value.studioFeishuCredentialId } : {}),
    ...(value.studioDirectoryToken != null ? { studioDirectoryToken: value.studioDirectoryToken } : {}),
  }
}, true)

interface CommandInput { agent: Agent; commandId: string; rawInput: string; signal: AbortSignal }
interface CommandResult { kind: 'success' | 'error'; text: string }
interface StudioScope { role: StudioRole; dispose(): void }
const presets: Record<StudioRole, string> = { assistant: ASSISTANT_PRESET, leader: LEADER_PRESET, worker: WORKER_PRESET }
const roleForPreset = (preset: string | null) => (Object.keys(presets) as StudioRole[]).find(role => presets[role] === preset)
const studioTools = new Set([WORKER_DELEGATE, WORKER_READ, LIST_PROJECTS, PROPOSE_PROJECT, FORWARD_PROJECT, STUDIO_LIST_DIRECTORY])
const denied = 'Studio tool denied: INVALID_EXECUTION'
const revokedWorker = { code: 'STUDIO_EXECUTION_INACTIVE', reason: 'Studio tool denied (STUDIO_EXECUTION_INACTIVE): Worker authorization was revoked.',
  needsOwnerDecision: false } as const
const workerGuardResult = (refusal: { code: string; reason: string }) => ({ reason: refusal.reason, info: { name: 'StudioToolDenied', code: refusal.code } })

/** 仅适配仓库较旧声明缺少的运行时入口；使用前统一校验，绝不把未接入的身份服务当成降级路径。 */
type ManagedHost = Context & {
  agentPresets: { mount(ctx: Context, preset: string): Promise<unknown>; presetForSession(session: Agent['session']): string | null }
  connection: Parameters<typeof registerStudioHttp>[1] & { allowsRemoteAuthorities: boolean }
  commands: { register(command: { name: string; description: string; input: { hint: string }; recordInput: boolean;
    handler(input: CommandInput): CommandResult | Promise<CommandResult> }): () => void }
  sandboxPolicy: { resolve(request: { session: Agent['session'] }): WorkerSandboxPolicy }
  webServer: { host: string; getOrigin(): string }
}

function localOwnerComposition(ctx: ManagedHost): boolean {
  return ctx.connection.allowsRemoteAuthorities === false && ctx.connection.browserPeer?.principal?.kind === 'owner'
    && (ctx as unknown as { get(name: string): unknown }).get('liveshareShares') === undefined
}

function loopbackOrigin(origin: string): boolean {
  return isLoopbackHost(new URL(origin).hostname.replace(/^\[|\]$/gu, ''))
}

function localOwnerHost(ctx: Context): ManagedHost {
  const host = ctx as ManagedHost
  const required = [
    ['commands.register', host.commands?.register], ['agentPresets.mount', host.agentPresets?.mount],
    ['agentPresets.presetForSession', host.agentPresets?.presetForSession], ['agents.create', host.agents?.create],
    ['agents.resume', host.agents?.resume], ['agents.withoutInitiator', host.agents?.withoutInitiator],
    ['tools.guard', host.tools?.guard], ['webServer.getOrigin', host.webServer?.getOrigin], ['webServer.register', host.webServer?.register],
    ['connection.admit', host.connection?.admit], ['sandboxPolicy.resolve', host.sandboxPolicy?.resolve],
    ['sessionPersistence.flush', host.sessionPersistence?.flush], ['sessionPersistence.open', host.sessionPersistence?.open],
    ['permissionPresets.resolve', host.permissionPresets?.resolve], ['llm.resolveModelInfo', host.llm?.resolveModelInfo],
  ] as const
  const missing = required.filter(([, value]) => typeof value !== 'function').map(([entry]) => entry)
  if (missing.length) throw new Error(`Agent Studio requires DSH Web Host contracts: ${missing.join(', ')}`)
  if (!localOwnerComposition(host)) throw new Error('Agent Studio requires a non-shared, owner Web Host')
  // 宿主在端口绑定前 getOrigin 可能抛错；配置地址必须已是回环，真正提供服务前还会核验监听来源。
  if (!isLoopbackHost(host.webServer.host)) throw new Error('Agent Studio requires a loopback Web listener')
  if (host.permissionPresets.resolve('read-only').sandbox !== 'read-only') throw new Error('Agent Studio requires the read-only sandbox preset')
  return host
}

/** 打开持久状态、注册宿主授权和跨渠道入口，关闭时先排空再封存。 */
export async function apply(context: Context, config: StudioHostConfig): Promise<void> {
  const ctx = localOwnerHost(context)
  const { stateDir, studioCwd: cwd } = config
  if (!isAbsolute(stateDir)) throw new Error('Agent Studio stateDir must be absolute')
  verifyWorkspace(cwd)
  if (config.defaultWorkerPermission !== 'read-only' && config.defaultWorkerPermission !== 'workspace-write') throw new Error('Invalid default Worker permission')
  const models = new WorkerModelPolicy(ctx, config.workerModelRoutes, config.workerModelDefaults)
  const binding = config.feishuConversation ?? undefined
  if (binding) validateFeishuInbox(binding)
  const credentials = new StudioCredentials(ctx)
  const credential = await credentials.load(binding, config.studioFeishuCredentialId ?? '')
  const setup = new StudioFeishuSetup()
  const feishuSdk = binding && credential.secret ? new StudioFeishuSdk(binding.appId, credential.secret) : undefined
  confirmStudioDirectory(stateDir, config.studioDirectoryToken ?? '')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  let available = true
  let applyingSettings = false
  let directorySwitch: StudioDirectorySwitch | undefined
  const stopping = new AbortController()
  const unlock = lockSync(stateDir, { stale: 30_000, onCompromised(error) {
    available = false
    stopping.abort()
    ctx.logger.error('Agent Studio lost its state directory lock: %s', String(error))
  } })
  const profile = credentials.profile
  const hostRoots = [profile?.home, profile?.dir, profile?.patchPath].filter((path): path is string => typeof path === 'string' && isAbsolute(path))
  let store: ManagedWorkerStore
  try { store = new ManagedWorkerStore(join(stateDir, STUDIO_DB), stateDir, hostRoots) }
  catch (error) { unlock(); throw error }

  let channel: StudioFeishuConversation | undefined
  let channelRun: Promise<void> | undefined
  let studio: StudioService | undefined
  const scopes = new Map<Agent, StudioScope>()
  // 每个执行创建新的原生 Agent 对象。按对象同步吊销可覆盖同批派发，且不会让已销毁的执行长期留在内存。
  const revokedExecutions = new WeakSet<Agent>()
  ctx.effect(() => async () => {
    const held = available
    available = false
    try {
      try { if (held) store.interruptActiveTasks() } finally {
        stopping.abort()
        try { await channelRun } finally { try { await setup.stop() } finally { await studio?.sessions.drain() } }
      }
      for (const scope of scopes.values()) scope.dispose()
      scopes.clear()
      if (held) { store.finishRun(); await directorySwitch?.prepare(store) }
    } finally { try { store.close() } finally { unlock() } }
  })

  const presetOf = (agent: Agent) => currentPresetId(ctx.agentPresets.presetForSession(agent.session))
  const current = (agent: Agent) => ctx.agents.get(agent.id) === agent
  const inferred = (agent: Agent) => roleForPreset(presetOf(agent))
  const channelReady = () => {
    if (!available || applyingSettings || !localOwnerComposition(ctx)) return false
    try { return loopbackOrigin(ctx.webServer.getOrigin()) } catch { return false }
  }
  const roleReady = (agent: Agent, role: StudioRole): boolean => {
    if (!channelReady() || !current(agent) || scopes.get(agent)?.role !== role || presetOf(agent) !== presets[role]) return false
    const record = store.studioSession(agent.id)
    if (record?.readonlyLegacy || (record && record.role !== role)) return false
    return role === 'leader' ? !!store.projects.currentLeader(agent.id) : role === 'worker' ? record?.role === 'worker' : true
  }
  const sessionDirectoryMatches = (agent: Agent, workspacePath: string | null): boolean => {
    if (workspacePath === null) return true
    try {
      const directories = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as
        { get?(session: Agent['session']): string } | undefined
      return typeof directories?.get !== 'function' || directories.get(agent.session) === workspacePath
    } catch { return false }
  }
  const ready = (agent: Agent, role: StudioRole): boolean => {
    if (revokedExecutions.has(agent) || !roleReady(agent, role)) return false
    const sandbox = assistant.workerSandbox(agent)
    if (role !== 'worker') return sandbox?.mode === 'read-only'
    const authority = assistant.workerAuthority(agent)
    return !!authority && workerSandboxMatches(sandbox, authority) && sessionDirectoryMatches(agent, authority.workspacePath)
      && (authority.workspacePath === null || verifyWorkspaceIdentity(authority.workspacePath, authority.workspaceIdentity))
  }

  const feishuState = (): FeishuState => channel?.state ?? (binding ? 'credential-missing' : 'disabled')
  const wake = () => channel?.wake()
  const defaults = { assistant: config.assistantModel ?? null, leader: config.leaderModel ?? null }
  const settingsScope = createHash('sha256').update(JSON.stringify([stateDir, config.studioDirectoryToken, defaults])).digest('hex')
  const service = new StudioService(ctx, store, cwd, defaults, ready, stopping.signal, feishuState, wake, settingsScope)
  studio = service
  const sessions = service.sessions
  const assistant = new StudioAssistant(ctx, store, sessions, models, ready, cwd)
  const intake = new StudioProjectIntake(store, sessions)
  const projects = new StudioProjectControl(store, sessions, ready)
  if (binding && feishuSdk) channel = new StudioFeishuConversation(feishuSdk, binding, service.feishu, channelReady,
    message => ctx.logger.warn('%s', message), value => setup.receive(value))
  if (channel) service.bindFeishuLookup(channel)
  // 仅密钥不可用不代表用户解绑，保留同一已发布 binding 的切换边界。
  store.studio.deactivateFeishu(binding ? feishuSourceScope(binding) : undefined)

  const configuration = new StudioConfigurationControl(ctx, config, { credentials, credential, setup, feishuState,
    quiesce(_next, directory) {
      if (!channelReady() || sessions.busy || [...scopes.keys()].some(agent => agent.status !== 'idle')) {
        throw new StudioError('STUDIO_CONFIG_WORK_ACTIVE', 'Wait until current Studio work ends before applying settings.', 409)
      }
      applyingSettings = true
      directorySwitch = directory
      return () => { applyingSettings = false; directorySwitch = undefined }
    },
  })
  ctx.effect(() => registerStudioHttp(ctx, ctx.connection, channelReady, { ...service.operations, ...configuration.operations }))

  function configure(agent: Agent): void {
    const record = store.studioSession(agent.id)
    const role = inferred(agent)
    const prior = scopes.get(agent)
    if (!role || record?.readonlyLegacy || (record && record.role !== role)) return
    if (prior?.role === role) return
    prior?.dispose()
    scopes.delete(agent)
    if (role !== 'worker') ctx.permissionPresets.set?.(agent.session, 'read-only')
    const authority = role === 'worker' ? assistant.workerAuthority(agent) : undefined
    const allow = authority ? workerToolAllowlist(authority.workspacePath, authority.permission) : []
    // rc.5 限制的是继承工具，原生 API 会拒绝传入 Agent 自己注册的工具名。
    const inherited = allow.filter(name => name !== STUDIO_LIST_DIRECTORY && (name !== 'bash' || process.platform !== 'win32'))
    const dispose: Array<() => void> = [agent.ctx.tools.restrict({ allow: inherited })]
    try {
      dispose.push(assistant.install(agent, role))
      if (role === 'assistant') dispose.push(intake.install(agent))
      scopes.set(agent, { role, dispose() { for (const cleanup of dispose.reverse()) cleanup() } })
    } catch (error) { for (const cleanup of dispose.reverse()) cleanup(); throw error }
  }

  function workerRefusal(agent: Agent, exec: Readonly<ToolExecution>) {
    if (revokedExecutions.has(agent)) return revokedWorker
    const execution = roleReady(agent, 'worker') ? assistant.workerExecution(agent) : undefined
    const refusal = evaluateWorkerToolCall({ name: exec.name, arguments: exec.arguments, parent: exec.parent, signal: exec.signal,
      execution, sandbox: assistant.workerSandbox(agent), protectedRoots: store.protectedRoots,
      sessionDirectoryMatches: !execution || sessionDirectoryMatches(agent, execution.workspacePath) })
    if (refusal?.needsOwnerDecision && execution?.active) {
      // 先吊销当前 Agent，再安排取消；之后的数据库、通知或取消失败都不能重新开放工具。
      revokedExecutions.add(agent)
      queueMicrotask(() => {
        try { if (current(agent)) agent.cancel({ kind: 'hook', reason: 'Studio Worker authorization ended after a guard interception.' }) }
        catch { ctx.logger.warn('Studio could not cancel the intercepted Worker') }
        finally { wake() }
      })
      try {
        const result = store.recordGuardInterception(execution.execution, refusal,
          guardActionFingerprint(exec.name, exec.arguments, refusal.code), summarizeGuardAction(exec.name),
          sessions.taskOrigin(execution.execution.taskId), execution.evidence.result())
        if (result.recorded) sessions.notifyForwardTask(execution.execution.taskId, !!result.pendingId)
      } catch { ctx.logger.warn('Studio could not persist the full Worker guard interception') }
    }
    return refusal
  }

  // rc.5 支持结构化拒绝；仓库保留上游 Ticket 的旧版依赖声明，只在此适配 Studio 入口。
  const guards = ctx.tools as unknown as { guard(fn: (exec: Readonly<ToolExecution>) => string
    | { reason: string; info: { name: string; code: string } } | undefined): () => void }
  // Studio 工具只存在于确切角色。普通 Ticket Agent 的工具不受 Studio 策略影响。
  ctx.effect(() => guards.guard(exec => {
    const { agent } = exec
    if (!agent) return studioTools.has(exec.name) ? denied : undefined
    if (revokedExecutions.has(agent)) return workerGuardResult(revokedWorker)
    try {
      const record = store.studioSession(agent.id)
      const role = record?.role === 'worker' ? 'worker' : scopes.get(agent)?.role ?? inferred(agent)
      if (!role && !record && !isStudioInternalSession(agent.id)) return studioTools.has(exec.name) ? denied : undefined
      if (role === 'worker') {
        const refusal = workerRefusal(agent, exec)
        return refusal ? workerGuardResult(refusal) : undefined
      }
      if (!role || exec.parent !== undefined || !ready(agent, role) || !sessions.canAsk(agent)) return denied
      if (exec.name === WORKER_READ || (role === 'assistant' && exec.name === LIST_PROJECTS)) return undefined
      if (!sessions.isExistingTaskReply(agent) && (exec.name === WORKER_DELEGATE || (role === 'assistant' && (exec.name === PROPOSE_PROJECT || exec.name === FORWARD_PROJECT)))) return undefined
      return denied
    } catch { return 'Studio tool denied: could not verify role or authorization' }
  }))
  // 只在 Studio 适配 rc.5 的原生派发和结果事件；上游 Ticket 的依赖声明不随此功能改变。
  const toolEvents = ctx as unknown as {
    on(event: 'tools/execute', listener: (exec: ToolExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>): () => void
    on(event: 'tools/result', listener: (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined): () => void
  }
  toolEvents.on('tools/execute', async (exec, next) => {
    const { agent } = exec
    if (exec.name === FORWARD_PROJECT && (!agent || exec.parent !== undefined || !ready(agent, 'assistant') || !sessions.canAsk(agent)
      || sessions.isExistingTaskReply(agent))) throw new StudioError('EXPECTED_EXACT_OWNER_REQUEST', 'Studio forwarding requires the exact current Assistant owner request.')
    if (agent && revokedExecutions.has(agent)) throw new StudioError(revokedWorker.code, revokedWorker.reason)
    if (agent && (scopes.get(agent)?.role === 'worker' || inferred(agent) === 'worker' || assistant.workerAuthority(agent))) {
      const refusal = workerRefusal(agent, exec)
      if (refusal) throw new StudioError(refusal.code, refusal.reason)
      assistant.observeDispatch(exec)
    } else if (agent && (scopes.get(agent)?.role === 'leader' || inferred(agent) === 'leader') && !sessions.activeLeader(agent)) {
      throw new StudioError('STALE_LEADER', 'The current Leader binding changed.')
    }
    return next()
  })
  toolEvents.on('tools/result', (exec, result) => { if (available) assistant.observeToolResult(exec, result); return undefined })
  ctx.on('agent/created', ({ agent }) => { if (available && !applyingSettings) configure(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { scopes.get(agent)?.dispose(); scopes.delete(agent) })
  ctx.on('agent-preset/selected', (id, selected) => {
    if (!roleForPreset(currentPresetId(selected))) return
    const agent = ctx.agents.get(id as SessionId)
    if (!agent) return
    queueMicrotask(() => {
      if (!available || applyingSettings || !current(agent) || presetOf(agent) !== currentPresetId(selected)) return
      try {
        if (agent.status === 'running') agent.cancel({ kind: 'hook', reason: 'Studio preset changed while the turn was starting.' }, { keepInbox: true })
        configure(agent)
      } catch { ctx.logger.warn('Studio could not configure a native role') }
    })
  })
  ctx.on('agent/pre-step', async (step, next) => {
    const { agent } = step
    const role = scopes.get(agent)?.role
    if (!role) {
      if (inferred(agent) || isStudioInternalSession(agent.id) || store.studioSession(agent.id)) return { kind: 'reject' }
      return next()
    }
    // 保存中间件收到的原始收件箱，防止下游过滤后把外部输入伪装成空续步。
    const claimed = role === 'worker' ? [...step.messages] : []
    if (!ready(agent, role) || (role === 'worker' ? !assistant.executionCurrent(agent) : !sessions.canAsk(agent))) return { kind: 'reject' }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!ready(agent, role)) return { kind: 'reject' }
    if (role === 'worker') {
      // DSH 预检追加的必需运行时快照不算任务输入；收件箱里的同类输入仍须通过 Worker 的原文检查。
      const inputs = decision.messages.filter(message => {
        const source: { kind: string; form?: string } = message.source
        return source.kind !== 'runtime-context' || source.form !== 'snapshot' || claimed.some(input => input.id === message.id)
      })
      return assistant.admit(agent, inputs, step.turn, claimed) ? decision : { kind: 'reject' }
    }
    if (!sessions.canAsk(agent)) return { kind: 'reject' }
    const extra = sessions.contextFor(agent, decision.messages, step.step)
    return extra ? { ...decision, messages: [extra, ...decision.messages] } : decision
  })
  for (const agent of ctx.agents.list()) configure(agent)

  ctx.effect(() => ctx.commands.register({ name: PROJECT_COMMAND, description: 'Inspect or manage Studio projects and their task results.',
    input: { hint: PROJECT_HINT }, recordInput: false, handler: ({ agent, rawInput, signal }) => projects.command(agent, rawInput, signal) }))
  ctx.effect(() => ctx.commands.register({ name: MEMORY_COMMAND, description: 'View, save, edit or forget explicit Studio preferences.',
    input: { hint: MEMORY_HINT }, recordInput: false, handler: ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      if (!ready(agent, 'assistant') && !ready(agent, 'leader')) return { kind: 'error', text: 'Use a current Studio Assistant or Leader Session.' }
      return memoryCommand(store.memory, rawInput, id => ready(agent, 'assistant') || store.projects.currentLeader(agent.id)?.id === id)
    },
  }))
  ctx.effect(() => ctx.commands.register({ name: 'studio-result', description: 'Read a saved Studio task and its status without running a model.',
    input: { hint: '<task-id>' }, recordInput: false, handler: ({ agent, rawInput, signal }) => {
      signal.throwIfAborted()
      if (!ready(agent, 'assistant') && !ready(agent, 'leader')) return { kind: 'error', text: 'Use a current Studio Assistant or Leader Session.' }
      const task = store.task(rawInput.trim())
      if (!task || (!ready(agent, 'assistant') && store.projects.currentLeader(agent.id)?.id !== task.projectId)) return { kind: 'error', text: 'Studio task not found.' }
      return { kind: 'success', text: studioTaskText(task) }
    },
  }))
  if (channel) channelRun = ctx.agents.withoutInitiator(() => channel!.run(stopping.signal))
  if (store.recoveredTasks) ctx.logger.warn('Agent Studio interrupted %d unfinished tasks from a previous run', store.recoveredTasks)
  ctx.logger.info('Agent Studio ready (no GitHub source)')
}
