/** Opt-in Studio roles independent of GitHub setup. Only a bound document Worker can request a managed write. */
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import s from '@deepseek-ai/schemastery'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { AgentDelivery } from '../app/delivery.ts'
import type { AdvisorRoute } from './advisor-store.ts'
import { AdvisorConfig, StudioAdvisor, advisorSelection, isAdvisorTool } from './advisor.ts'
import { ASSISTANT_PRESET, StudioAssistant, draftOutput, isAssistantTool, type RestrictedTextRole } from './assistant.ts'
import { documentStartArgs, sharedDocumentCommand, sharedDocumentCoordinates, sharedDocumentError } from './document-command.ts'
import { FeishuDocumentInboxConfig, FeishuTextInboxConfig, StudioFeishuInbox, feishuSourceScope, validateFeishuInbox } from './feishu-inbox.ts'
import { StudioFeishuText, feishuDraftOutput, validateFeishuTextRoute } from './feishu-text.ts'
import { captureDocumentInstructions, continueDocument, documentHoldError, instructionCommand, reviewDocumentIntent, validateDocumentRelays } from './instructions.ts'
import { PROPOSE_PROJECT, StudioProjectIntake } from './project-intake.ts'
import { StudioProjectJobMonitor } from './project-job-monitor.ts'
import { StudioProjectJobControl } from './project-job.ts'
import { LEADER_PRESET, StudioProjectControl, isLeaderTool } from './project.ts'
import { StudioQuotaNotices } from './quota-notices.ts'
import { QuotaPoolConfig, StudioQuotaControl, quotaProviderMap } from './quota.ts'
import { ManagedWorkerStore, type ManagedResult, type ManagedTask, type ManagedWritePermit } from './store.ts'
import { StudioStudy, isStudyTool, studyOutput } from './study.ts'

export const name = 'dsh-superagent-managed-worker'
export const inject = ['agents', 'agentPresets', 'commands', 'connection', 'permissionPresets', 'sandboxPolicy', 'sessionPersistence', 'systemPrompt', 'tools', 'webServer']
export const Config = s.object({
  stateDir: s.string().required().description('Absolute directory reserved for the Studio database.'),
  guiDocumentInbox: s.boolean().default(false).description('Hold pending document writes for owner review when a new chat message arrives in the bound document Worker.'),
  advisor: s.union([s.const(null), AdvisorConfig]).default(null)
    .description('Opt-in route for independent, tool-free Advisor consultations; null disables new consultations.'),
  feishuDocumentInbox: s.union([s.const(null), FeishuDocumentInboxConfig]).default(null)
    .description('Optional, separately configured single-owner Feishu inbox for a managed document.'),
  feishuTextInbox: s.union([s.const(null), FeishuTextInboxConfig]).default(null)
    .description('Optional single-owner Feishu inbox for explicit text tasks and opt-in document review. Do not enable a second inbox.'),
  quotaPools: s.array(QuotaPoolConfig).default([])
    .description('Explicit provider IDs that share each inference quota pool; empty disables the quota gate.'),
  quotaFeishuAlerts: s.boolean().default(false)
    .description('Send one system notice per confirmed quota incident to the configured Feishu owner as the verified bot.'),
  systemdJobInbox: s.boolean().default(false)
    .description('Allow the owner to attach and check existing local systemd user jobs in a Studio project.'),
  systemdJobPollSeconds: s.number().default(0)
    .description('Seconds between bounded checks of attached jobs, 5–300. Zero disables the watcher and automatic post-processing.'),
})
type Config = ReturnType<typeof Config>

const PRESET = 'dsh-superagent-managed-worker'
const TOOL = 'studio_write_document'
const TEXT_LIMIT = 32_000
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const writeSchema = z.strictObject({ expectedVersion: version.describe('The document revision approved for this task.'), text: z.string().max(TEXT_LIMIT) })

interface CommandResult { kind: 'success' | 'error'; text: string }
interface CommandInput { agent: Agent; commandId: string; rawInput: string; signal: AbortSignal }
type StudioRole = 'assistant' | 'leader' | 'document-worker' | RestrictedTextRole
interface StudioScope { role: StudioRole; dispose(): void }

/** Only the rc.3 additions used here are declared. The running host provides the services; no second Cordis or DSH runtime is loaded. */
type ManagedHost = Context & {
  agentPresets: { presetForSession(session: Agent['session']): string | null }
  connection: { allowsRemoteAuthorities: boolean; browserPeer: { principal: { kind: string } } }
  commands: { register(command: { name: string; description: string; input: { hint: string }; recordInput: boolean;
    handler(input: CommandInput): CommandResult | Promise<CommandResult> }): () => void }
  sandboxPolicy: { resolve(request: { session: Agent['session'] }): { mode: string } }
  webServer: { getOrigin(): string }
}

/** Check that the Web host runs in single-owner mode; native command handlers do not receive the requesting Peer. */
function localOwnerComposition(ctx: ManagedHost): boolean {
  return ctx.connection.allowsRemoteAuthorities === false && ctx.connection.browserPeer.principal.kind === 'owner'
    && (ctx as unknown as { get(name: string): unknown }).get('liveshareShares') === undefined
}

/** Accept control commands and issue write permits only after verifying the bound Web listener address. */
function controlReady(ctx: ManagedHost): boolean {
  try { return localOwnerComposition(ctx) && ['127.0.0.1', '[::1]'].includes(new URL(ctx.webServer.getOrigin()).hostname) }
  catch { return false }
}

function localOwnerHost(ctx: Context): ManagedHost {
  const host = ctx as ManagedHost
  if (typeof host.commands.register !== 'function' || typeof host.agentPresets.presetForSession !== 'function'
    || typeof host.tools.guard !== 'function' || typeof host.webServer.getOrigin !== 'function') {
    throw new Error('Managed Worker requires the DSH 0.2.2-rc.3 Web host contracts')
  }
  if (!localOwnerComposition(host)) throw new Error('Managed Worker requires a non-shared, owner Web host')
  if (host.permissionPresets.resolve('read-only').sandbox !== 'read-only') throw new Error('Managed Worker requires a read-only sandbox preset')
  return host
}

const rejected = (reason: string): CommandResult => ({ kind: 'error', text: `Managed document control rejected: ${reason}` })

/** Report success only after the Store confirms a durable commit. Keep document text out of Session command history. */
function receipt(operation: string, result: ManagedResult<ManagedTask>, showResume = true): CommandResult {
  if (!result.ok) return documentHoldError(result.reason) ?? sharedDocumentError(result.reason) ?? rejected(result.reason)
  const task = result.value
  const shared = task.sharedDocument
  const resumable = !shared || shared.baseVersion === shared.headVersion
  const resume = task.paused && showResume && resumable ? ` To allow writes again when ready, run /studio-doc resume ${task.authorizationVersion} in the current Worker.` : ''
  const snapshot = shared ? 'task snapshot version' : 'document version'
  return { kind: 'success', text: `${operation}: task ${task.taskId}; execution epoch ${task.executionEpoch}; authorization version ${task.authorizationVersion}; ${snapshot} ${task.documentVersion}; ${task.paused ? 'paused' : 'active'}.${sharedDocumentCoordinates(task)}${resume}` }
}

/** Start without using the prototype Runtime, Sources, GitHub credentials, or work directories. */
export function apply(context: Context, config: Config): void {
  const { stateDir, guiDocumentInbox, advisor, feishuDocumentInbox, feishuTextInbox, quotaPools, quotaFeishuAlerts,
    systemdJobInbox, systemdJobPollSeconds } = config
  const ctx = localOwnerHost(context)
  if (!isAbsolute(stateDir)) throw new Error('Managed Worker stateDir must be absolute')
  const advisoryModel = advisor ? advisorSelection(advisor) : undefined
  if (systemdJobPollSeconds !== 0 && (!systemdJobInbox || !Number.isInteger(systemdJobPollSeconds) || systemdJobPollSeconds < 5 || systemdJobPollSeconds > 300)) {
    throw new Error('Studio job watcher requires systemdJobInbox and a polling interval of 5–300 seconds')
  }
  const providerPool = quotaProviderMap(quotaPools)
  if (feishuDocumentInbox && feishuTextInbox) throw new Error('Choose one Studio Feishu inbox; use feishuTextInbox.documentCorrections for both routes')
  const feishuConfig = feishuDocumentInbox ?? feishuTextInbox
  if (feishuConfig) validateFeishuInbox(feishuConfig)
  if (feishuTextInbox) validateFeishuTextRoute(feishuTextInbox)
  const combinedFeishu = feishuTextInbox?.documentCorrections === true
  const combinedFeishuScope = feishuTextInbox && combinedFeishu ? feishuSourceScope(feishuTextInbox) : undefined
  if (quotaFeishuAlerts && (!feishuConfig || !quotaPools.length)) throw new Error('Studio quota notices require a dedicated Feishu inbox and quota pools')
  const quotaNoticeScope = quotaFeishuAlerts && feishuConfig ? feishuSourceScope(feishuConfig) : undefined
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  let available = true
  const channelStop = new AbortController()
  let channelRun: Promise<void> | undefined
  let projectJobRun: Promise<void> | undefined
  let quotaNoticeRun: Promise<void> | undefined
  // Reserve the directory for one host. The SQLite run fence also rejects commits from a prior holder of the lock.
  const unlock = lockSync(stateDir, { stale: 30_000, onCompromised(error) {
    available = false
    channelStop.abort()
    ctx.logger.error('Managed Worker lost its state directory lock: %s', String(error))
  } })
  let store: ManagedWorkerStore
  try { store = new ManagedWorkerStore(join(stateDir, 'managed-worker.sqlite'), quotaPools.map(pool => pool.id), quotaNoticeScope, combinedFeishuScope) }
  catch (error) { unlock(); throw error }
  if (feishuTextInbox && !store.feishuDraftScopeAvailable(feishuSourceScope(feishuTextInbox))) {
    // Only the explicit combined configuration can share an existing document chat.
    try { store.finishRun() } finally { try { store.close() } finally { unlock() } }
    throw new Error('Studio Feishu text requires an unbound chat or an available combined inbox')
  }
  if (store.recoveredTasks) ctx.logger.warn('Managed Worker paused %d unfinished tasks after an unconfirmed run', store.recoveredTasks)

  const scopes = new Map<Agent, StudioScope>()
  const permits = new Map<ToolExecutionToken, ManagedWritePermit>()
  const presetOf = (agent: Agent) => ctx.agentPresets.presetForSession(agent.session)
  const presetFor = (role: StudioRole) => role === 'assistant' ? ASSISTANT_PRESET : role === 'leader' ? LEADER_PRESET : PRESET
  const currentSession = (agent: Agent): boolean => ctx.agents.get(agent.id) === agent
  const restricted = (agent: Agent): boolean => ctx.permissionPresets.current(agent.session) === 'read-only'
    && ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only'
  const ready = (agent: Agent, role: StudioRole): boolean => available && controlReady(ctx) && currentSession(agent)
    && scopes.get(agent)?.role === role && presetOf(agent) === presetFor(role) && restricted(agent)
  const channelReady = () => available && controlReady(ctx)
  const quota = new StudioQuotaControl(ctx, store, quotaPools, providerPool, quotaFeishuAlerts)
  const drafts = new StudioAssistant(ctx, store, PRESET, agent => ready(agent, 'assistant'), ready, provider => quota.denial(provider))
  const advisors = new StudioAdvisor(ctx, store, drafts, advisoryModel, ready, channelStop.signal)
  const studies = new StudioStudy(store, drafts, agent => ready(agent, 'assistant'), channelStop.signal)
  const projects = new StudioProjectControl(store, agent => ready(agent, 'leader'), drafts, provider => providerPool.get(provider))
  const jobMonitor = systemdJobPollSeconds ? new StudioProjectJobMonitor(store, systemdJobPollSeconds * 1000, channelReady, (permit, signal) => {
    const leader = ctx.agents.get(permit.leaderSessionId as SessionId)
    return leader ? projects.continueJob(leader, permit, signal) : undefined
  }, () => ctx.logger.warn('Studio external job watcher could not confirm an operation; check /studio-job status')) : undefined
  const projectJobs = systemdJobInbox ? new StudioProjectJobControl(store, agent => ready(agent, 'leader'), channelStop.signal,
    jobMonitor ? agent => projects.jobRoute(agent) : undefined) : undefined
  const intake = new StudioProjectIntake(ctx, store, agent => ready(agent, 'assistant'), channelStop.signal)
  const delivery = new AgentDelivery(ctx)
  const feishuText = feishuTextInbox ? new StudioFeishuText(store, drafts, feishuTextInbox, channelStop.signal, channelReady, combinedFeishu) : undefined
  const feishu = feishuConfig && new StudioFeishuInbox(ctx, store, stateDir, feishuConfig, channelReady, feishuText, !!feishuDocumentInbox || combinedFeishu)
  const quotaNotices = quotaFeishuAlerts && feishu ? new StudioQuotaNotices(store, quotaPools, () => feishu.noticeDestination(),
    () => ctx.logger.warn('Studio Feishu quota notice delivery was not confirmed; check /studio-quota status')) : undefined

  /** A persisted binding wins over the picker, so a retired or finished Worker cannot become a different role on resume. */
  function roleOf(agent: Agent): StudioRole | undefined {
    if (store.advice.binding(agent.id)) return 'advisor'
    if (store.draftBinding(agent.id) || store.studies.binding(agent.id) || store.feishuDraftBinding(agent.id) || store.projects.workerBound(agent.id)) {
      return 'draft-worker'
    }
    if (store.binding(agent.id)) return 'document-worker'
    if (store.assistantBinding(agent.id)) return 'assistant'
    if (store.projects.binding(agent.id)) return 'leader'
    const preset = presetOf(agent)
    if (preset === ASSISTANT_PRESET) return 'assistant'
    if (preset === LEADER_PRESET) return 'leader'
    if (preset === PRESET) return 'document-worker'
  }

  ctx.effect(() => async () => {
    const heldLock = available
    available = false
    channelStop.abort()
    drafts.stop()
    permits.clear()
    try {
      // Drain channel attempts, lookups, and text work before closing the Store. External jobs are not owned by this Host.
      if (channelRun) await channelRun
      if (quotaNoticeRun) await quotaNoticeRun
      await feishuText?.drain()
      await advisors.drain()
      await studies.drain()
      await projectJobs?.drain()
      if (projectJobRun) await projectJobRun
      for (const scope of scopes.values()) scope.dispose()
      scopes.clear()
      // Admit no work after marking the run clean. A lost lock or failed shutdown leaves recovery to the next run.
      if (heldLock) store.finishRun()
    } finally {
      try { store.close() } finally { unlock() }
    }
  })

  /** Configure the persisted role before admitting any Agent work, including work on a cold resume. */
  function configure(agent: Agent): void {
    const role = roleOf(agent)
    const prior = scopes.get(agent)
    if (!role || prior?.role === role) return
    prior?.dispose()
    scopes.delete(agent)
    ctx.permissionPresets.set(agent.session, 'read-only')
    // Hide inherited tools. The host guard also denies other Agent-local tools even if another plugin registers one.
    const unmask = agent.ctx.tools.restrict({ allow: [] })
    try {
      if (role === 'assistant') {
        const bound = store.bindAssistant(agent.id)
        if (!bound.ok) throw new Error(`Cannot bind Studio Assistant: ${bound.reason}`)
      }
      const unregister = role === 'leader' ? projects.install(agent, () => advisors.install(agent, role))
        : role === 'assistant' ? drafts.install(agent, role, () => intake.install(agent), () => studies.install(agent), () => advisors.install(agent, role))
          : role !== 'document-worker' ? drafts.install(agent, role) : agent.ctx.tools.register({
        name: TOOL,
        description: 'Replace the text of the managed document bound to this worker, using its approved text and version.',
        parameters: z.toJSONSchema(writeSchema),
        output: {
          schema: { type: 'object', properties: { documentVersion: { type: 'integer' }, documentId: { type: 'string' } }, required: ['documentVersion'] },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(action, exec) {
          exec.signal.throwIfAborted()
          const permit = permits.get(exec.token)
          permits.delete(exec.token)
          // Use only the permit issued through the tool pipeline. Even after the Guard allows a call, the write transaction checks the current execution epoch.
          if (!permit || exec.agent !== agent || !ready(agent, 'document-worker')
            || permit.workerSessionId !== agent.id || permit.toolCallId !== exec.callId) throw new Error('Managed write denied: INVALID_EXECUTION')
          const result = store.commit(permit, action)
          if (!result.ok) throw new Error(`Managed write denied: ${sharedDocumentError(result.reason)?.text ?? result.reason}`)
          return result.value
        },
      })
      scopes.set(agent, { role, dispose() { try { unregister() } finally { unmask() } } })
    } catch (error) { unmask(); throw error }
  }

  ctx.effect(() => ctx.tools.guard((exec: Readonly<ToolExecution>) => {
    const { agent } = exec
    let role: StudioRole | undefined
    try { role = agent && (scopes.get(agent)?.role ?? roleOf(agent)) }
    catch { return 'Studio tool denied: STORAGE_ERROR' }
    if (!role || !agent) return exec.name === TOOL || exec.name === PROPOSE_PROJECT || isAssistantTool(exec.name)
      || isStudyTool(exec.name) || isLeaderTool(exec.name) || isAdvisorTool(exec.name) ? 'Studio tool denied: INVALID_EXECUTION' : undefined
    if (!ready(agent, role) || exec.parent !== undefined) return 'Studio tool denied: INVALID_EXECUTION'
    if (isAdvisorTool(exec.name)) return advisors.guard(agent, exec.name, role)
    if (role === 'assistant' && (isAssistantTool(exec.name) || isStudyTool(exec.name)
      || (exec.name === PROPOSE_PROJECT && intake.available(agent)))) return undefined
    if (role === 'leader') return projects.guard(agent, exec.name)
    if (role !== 'document-worker' || exec.name !== TOOL) return 'Studio tool denied: INVALID_EXECUTION'
    const result = store.authorize(agent.id, exec.arguments, exec.callId)
    if (!result.ok) return `Managed write denied: ${sharedDocumentError(result.reason)?.text ?? result.reason}`
    permits.set(exec.token, result.value)
    return undefined
  }))
  ctx.on('tools/result', exec => { permits.delete(exec.token); return undefined })
  ctx.on('agent/created', ({ agent }) => { configure(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { scopes.get(agent)?.dispose(); scopes.delete(agent) })
  ctx.on('agent-preset/selected', (id, preset) => {
    if (preset !== PRESET && preset !== ASSISTANT_PRESET && preset !== LEADER_PRESET) return
    const agent = ctx.agents.get(id as SessionId)
    if (agent) configure(agent)
  })
  ctx.on('agent/pre-step', async (step, next) => {
    const { agent, turn, messages } = step
    const role = scopes.get(agent)?.role
    if ((role === 'assistant' || role === 'leader') && !ready(agent, role)) return { kind: 'reject' }
    if (role === 'draft-worker' || role === 'advisor') {
      // The installed Host captures the exact selection for this step, including later native retries.
      const selection = (step as typeof step & { modelSelection?: AdvisorRoute }).modelSelection
      if (!drafts.admit(agent, messages, turn, selection)) return { kind: 'reject' }
    }
    if (!validateDocumentRelays(store, agent, messages, () => ready(agent, 'document-worker'))) return { kind: 'reject' }
    return next()
  })
  for (const agent of ctx.agents.list()) configure(agent)

  if (guiDocumentInbox) captureDocumentInstructions(ctx, store, session => {
    if (!available || !controlReady(ctx)) return false
    const agent = ctx.agents.get(session.id)
    // Restrictions on the role's tools do not turn a message to its exact live Session into an untracked input.
    return agent?.session === session && scopes.get(agent)?.role === 'document-worker'
  })

  // DSH Web authorizes commands.execute through its native remote access checks. Document authorization stays user-only.
  ctx.effect(() => ctx.commands.register({
    name: 'studio-doc',
    description: 'Manage a document task in this managed worker Session.',
    input: { hint: 'doc-new <JSON> | doc-read <document-id> [revision] | doc-save <JSON> | start <JSON> | status | pause | transfer <task-id> <epoch> | resume <authorization-version> | inbox | review [<instruction-id> <authorization-version> <unchanged|pause>] | narrow <JSON> | continue <authorization-version> | feishu-status | bind-feishu' },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      signal.throwIfAborted()
      if (!available || !controlReady(ctx)) return rejected('CONTROL_UNAVAILABLE')
      if (!ready(agent, 'document-worker')) return rejected('MANAGED_SESSION_REQUIRED')
      if (rawInput.length > TEXT_LIMIT * 12 + 128) return rejected('INPUT_TOO_LARGE')
      const [, verb, argument = ''] = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(rawInput.trim()) ?? []
      // Only explicit continuation wakes the Worker. Review and other control commands commit without cancelling the active turn.
      if (verb === 'continue') return continueDocument(delivery, store, agent, argument, signal, () => ready(agent, 'document-worker'))
      if (verb === 'review' && !argument) return reviewDocumentIntent(store, agent, commandId, signal, channelStop.signal, () => ready(agent, 'document-worker'))
      // Keep review available even after capture is disabled; toggling the listener must not clear a durable pending hold.
      const control = instructionCommand(store, agent.id, commandId, verb, argument)
        ?? sharedDocumentCommand(store, agent.id, commandId, verb, argument)
      if (control) return control
      if ((verb === 'feishu-status' || verb === 'bind-feishu') && !argument) {
        if (!feishu) return rejected('FEISHU_INBOX_DISABLED')
        if (verb === 'feishu-status') return { kind: 'success', text: feishu.status() }
        const result = feishu.bind(agent.id, commandId)
        if (!result.ok) return documentHoldError(result.reason) ?? rejected(result.reason)
        return { kind: 'success', text: `The configured Feishu private chat is linked to task ${result.value.taskId}. Incoming messages require review; no write scope or pause changed.` }
      }
      if (verb === 'start') {
        let json: unknown
        try { json = JSON.parse(argument) } catch { return rejected('INVALID_START_JSON') }
        const fields = documentStartArgs.safeParse(json)
        if (!fields.success) return rejected('INVALID_START_JSON')
        const input = fields.data
        const result = 'documentId' in input ? store.createSharedTask(agent.id, input.documentId, input.expectedVersion, input.replacement, commandId)
          : store.create(agent.id, input.initial, input.replacement, commandId)
        return receipt('Managed task created', result)
      }
      if (verb === 'status' && argument === '') return receipt('Managed task status', store.status(agent.id))
      if (verb === 'pause' && argument === '') return receipt('Pause effective', store.pause(agent.id, commandId), false)
      if (verb === 'transfer') {
        const fields = /^([a-f0-9-]{36})\s+([1-9]\d*)$/.exec(argument)
        const epoch = version.safeParse(Number(fields?.[2]))
        return fields?.[1] && epoch.success
          ? receipt('Execution transferred', store.transfer(fields[1], epoch.data, agent.id, commandId))
          : rejected('INVALID_TRANSFER')
      }
      if (verb === 'resume' && /^[1-9]\d*$/.test(argument)) {
        const revision = version.safeParse(Number(argument))
        if (revision.success) return receipt('Execution resumed', store.resume(agent.id, revision.data, commandId))
      }
      return rejected('INVALID_CONTROL_COMMAND')
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'studio-result',
    description: 'Read a Studio Worker result without running a model.',
    input: { hint: '[task-id]' },
    recordInput: false,
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted()
      if (!ready(agent, 'assistant')) return { kind: 'error', text: 'Open a Studio Assistant Session to read Studio results.' }
      const id = rawInput.trim()
      if (id && !z.uuid().safeParse(id).success) return { kind: 'error', text: 'Expected one Studio task ID, or no ID for the latest task in this Session.' }
      const result = store.readDraft(agent.id, id || undefined)
      if (result.ok) return { kind: 'success', text: draftOutput(result.value).text }
      // The no-ID lookup still selects only an ordinary draft in this Session. Studies and Feishu require their durable IDs.
      if (id && result.reason === 'TASK_NOT_FOUND') {
        const study = store.studies.read(agent.id, id)
        if (study.ok) return { kind: 'success', text: studyOutput(study.value).text }
        if (study.reason !== 'TASK_NOT_FOUND') return { kind: 'error', text: `Cannot read Studio result: ${study.reason}.` }
        const external = store.readFeishuDraft(id)
        if (external.ok) return { kind: 'success', text: feishuDraftOutput(external.value) }
        return { kind: 'error', text: `Cannot read Studio result: ${external.reason}.` }
      }
      return { kind: 'error', text: `Cannot read Studio result: ${result.reason}.` }
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'studio-advice',
    description: 'Read the recorded opinion and the Advisor’s provenance without running a model.',
    input: { hint: '<advice-id>' },
    recordInput: false,
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted()
      return advisors.command(agent, rawInput)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'studio-study',
    description: 'Read the saved synthesis or an individual Worker contribution without running a model.',
    input: { hint: '<task-id> [step-number]' },
    recordInput: false,
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted()
      return studies.command(agent, rawInput)
    },
  }))
  ctx.effect(() => ctx.commands.register({
    name: 'studio-project',
    description: 'Read project work, or create, transfer, or link an approved document task as the owner.',
    input: { hint: 'create <JSON> | status [project-id] | take <project-id> <epoch> [leader-bot-id|new] | work [work-id] | attach-document <work-id> <task-id> <authorization-version> | proposal [proposal-id]' },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      signal.throwIfAborted()
      const assistant = ready(agent, 'assistant')
      const proposal = /^proposal(?:\s+(\S+))?$/.exec(rawInput.trim())
      if (proposal) {
        if (!assistant || (proposal[1] && !z.uuid().safeParse(proposal[1]).success)) {
          return { kind: 'error', text: 'Use /studio-project proposal [proposal-id] in the original Studio Assistant Session.' }
        }
        const result = store.projects.readProposal(agent.id, proposal[1])
        return result.ok ? { kind: 'success', text: intake.describe(agent, result.value) }
          : { kind: 'error', text: `Cannot read project proposal: ${result.reason}.` }
      }
      return projects.command(agent, commandId, rawInput, assistant || ready(agent, 'leader'))
    },
  }))
  if (projectJobs) ctx.effect(() => ctx.commands.register({
    name: 'studio-job',
    description: 'Attach or observe an existing external job, or pause its project work without stopping the job.',
    input: { hint: 'attach <work-id> <unit> <invocation-id> | status/check <work-id> | pause/resume/auto <work-id> <authorization-version>' },
    recordInput: false,
    handler: ({ agent, commandId, rawInput, signal }) => projectJobs.command(agent, commandId, rawInput, signal),
  }))
  quota.install()
  if (quotaPools.length) ctx.effect(() => ctx.commands.register({
    name: 'studio-quota',
    description: 'Read Studio quota stops or confirm recovery with independent evidence, without calling a model.',
    input: { hint: 'status | restore <pool-id> <incident-id> <independent-evidence>' },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      signal.throwIfAborted()
      if (!channelReady() || !currentSession(agent)) return { kind: 'error', text: 'Studio quota control unavailable.' }
      if (rawInput.length > 1_280) return { kind: 'error', text: 'Studio quota controls accept at most 1000 characters of recovery evidence.' }
      return quota.command(agent.id, commandId, rawInput)
    },
  }))
  if (feishu) channelRun = feishu.run(channelStop.signal)
  if (quotaNotices) quotaNoticeRun = ctx.agents.withoutInitiator(() => quotaNotices.run(channelStop.signal))
  if (jobMonitor) projectJobRun = ctx.agents.withoutInitiator(() => jobMonitor.run(channelStop.signal))
  ctx.logger.info('SuperAgent Studio ready (no GitHub source)')
}
