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
import { BOT_EXPERIENCE_HINT } from './bot-experience.ts'
import { documentStartArgs, sharedDocumentCommand, sharedDocumentCoordinates, sharedDocumentError } from './document-command.ts'
import { StudioDocumentFailureNotices } from './document-failure-notices.ts'
import { documentContinuationIntent } from './document-continuation-intent.ts'
import { StudioDocumentContinuation } from './document-continuation.ts'
import { DOCUMENT_WRITE_TOOL as TOOL, GUARD_REVIEW_HINT, documentGuardReviewCommand, documentWriteActionSchema, observeDocumentGuardCall } from './document-guard-review.ts'
import type { DocumentGuardCapture } from './document-guard-store.ts'
import { DOCUMENT_GUARD_HINT, documentGuardCommand, documentGuardFeedback } from './document-guard.ts'
import { StudioDocumentRecovery } from './document-recovery.ts'
import { FeishuDocumentInboxConfig, FeishuTextInboxConfig, StudioFeishuInbox, feishuSourceScope, validateFeishuInbox } from './feishu-inbox.ts'
import { StudioFeishuText, feishuDraftOutput, validateFeishuTextRoute } from './feishu-text.ts'
import { captureDocumentInstructions, continueDocument, documentHoldError, instructionCommand, reviewDocumentIntent, validateDocumentRelays } from './instructions.ts'
import { MEMORY_COMMAND, MEMORY_HINT, memoryCommand } from './memory.ts'
import { currentOwnerInboxInput } from './owner-inbox-input.ts'
import { StudioPreferenceChange } from './preference-correction.ts'
import { PROPOSE_PREFERENCE, StudioPreferenceIntake } from './preference-intake.ts'
import { answerPreferenceQuery } from './preference-query.ts'
import { PROJECT_ARCHIVE_HINT } from './project-archive.ts'
import { StudioProjectFactIntake } from './project-fact-intake.ts'
import { parseProjectFactRequest } from './project-fact-request.ts'
import { PROJECT_HANDOFF_HINT } from './project-handoff.ts'
import { PROPOSE_PROJECT, StudioProjectIntake } from './project-intake.ts'
import { StudioProjectJobMonitor } from './project-job-monitor.ts'
import { STUDIO_JOB_HINT, StudioProjectJobControl } from './project-job.ts'
import { LEADER_PRESET, PROJECT_MODEL_CLEAR_HINT, PROJECT_MODEL_USE_HINT, PROJECT_RESULT_USE_HINT, PROJECT_WORK_BLOCK_HINT,
  StudioProjectControl, isLeaderTool } from './project.ts'
import { StudioQuotaNotices } from './quota-notices.ts'
import { QuotaPoolConfig, StudioQuotaControl, quotaProviderMap } from './quota.ts'
import { ManagedWorkerStore, type ManagedResult, type ManagedTask, type ManagedWritePermit } from './store.ts'
import { StudioStudy, isStudyTool, studyOutput } from './study.ts'
import { createTextWorkerModelPolicy, TextWorkerBoundsConfig, TextWorkerDefaultsConfig, TextWorkerRouteConfig } from './text-worker-model-policy.ts'
import { watchdogCommand } from './watchdog.ts'

export const name = 'dsh-superagent-managed-worker'
export const inject = ['agents', 'agentPresets', 'commands', 'connection', 'permissionPresets', 'sandboxPolicy', 'sessionPersistence', 'systemPrompt', 'tools', 'webServer']
export const Config = s.object({
  stateDir: s.string().required().description('Absolute directory reserved for the Studio database.'),
  guiDocumentInbox: s.boolean().default(false).description('Hold pending document writes for owner review when a new chat message arrives in the bound document Worker.'),
  documentContinuations: s.boolean().default(false)
    .description('Route standalone owner continuation requests in Studio Assistant and the linked Feishu document inbox to the current document Worker without changing authorization.'),
  advisor: s.union([s.const(null), AdvisorConfig]).default(null)
    .description('Opt-in route for independent, tool-free Advisor consultations; null disables new consultations.'),
  memory: s.boolean().default(false)
    .description('Enable owner preferences, explicit references in text work, project archives and Bot experiences. Saved preferences and project facts are never applied automatically.'),
  textWorkerRoutes: s.array(TextWorkerRouteConfig).max(64).default([])
    .description('Allowed provider/model/effort combinations for ordinary text dispatch. Order from lower to higher when using textWorkerBounds.'),
  textWorkerDefaults: TextWorkerDefaultsConfig
    .description('Optional Worker-only defaults for Assistant delegation and manual Leader text dispatch. Each must match an allowed tuple within that role’s bounds.'),
  textWorkerBounds: TextWorkerBoundsConfig
    .description('Optional inclusive bounds per dispatch role. Each endpoint must match one textWorkerRoutes row in all three fields. Omit or use null for an open side. Bounds never pick a model.'),
  feishuDocumentInbox: s.union([s.const(null), FeishuDocumentInboxConfig]).default(null)
    .description('Optional, separately configured single-owner Feishu inbox for a managed document.'),
  feishuTextInbox: s.union([s.const(null), FeishuTextInboxConfig]).default(null)
    .description('Optional single-owner Feishu inbox for explicit text tasks and opt-in document review. Do not enable a second inbox.'),
  quotaPools: s.array(QuotaPoolConfig).default([])
    .description('Explicit provider IDs that share each inference quota pool; empty disables the quota gate.'),
  quotaFeishuAlerts: s.boolean().default(false)
    .description('Send one system notice per confirmed quota incident to the configured Feishu owner as the verified bot.'),
  watchdog: s.boolean().default(false)
    .description('Expose an owner-only read-only health snapshot of recorded Studio state; no background recovery.'),
  documentRecovery: s.boolean().default(false)
    .description('With watchdog, record qualifying document turn failures and allow one owner-confirmed paused replacement.'),
  documentFailureFeishuAlerts: s.boolean().default(false)
    .description('With document recovery and a Feishu inbox, notify the configured owner once per eligible failure.'),
  systemdJobInbox: s.boolean().default(false)
    .description('Allow the owner to attach and check existing local systemd user jobs in a Studio project.'),
  systemdJobPollSeconds: s.number().default(0)
    .description('Seconds between bounded checks of attached jobs, 5–300. Zero disables the watcher and automatic post-processing.'),
})
type Config = ReturnType<typeof Config>

const PRESET = 'dsh-superagent-managed-worker'
const TEXT_LIMIT = 32_000
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

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
  const { stateDir, guiDocumentInbox, documentContinuations, advisor, memory, feishuDocumentInbox, feishuTextInbox, quotaPools,
    quotaFeishuAlerts, watchdog, documentRecovery, documentFailureFeishuAlerts, systemdJobInbox, systemdJobPollSeconds } = config
  const ctx = localOwnerHost(context)
  if (!isAbsolute(stateDir)) throw new Error('Managed Worker stateDir must be absolute')
  if (documentRecovery && !watchdog) throw new Error('Studio document recovery requires watchdog for evidence lookup')
  const advisoryModel = advisor ? advisorSelection(advisor) : undefined
  const textWorkerModels = createTextWorkerModelPolicy(ctx, config.textWorkerRoutes, config.textWorkerDefaults, config.textWorkerBounds)
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
  if (documentFailureFeishuAlerts && (!documentRecovery || !feishuConfig)) {
    throw new Error('Studio document failure notices require document recovery and a dedicated Feishu inbox')
  }
  const feishuScope = feishuConfig ? feishuSourceScope(feishuConfig) : undefined
  const quotaNoticeScope = quotaFeishuAlerts ? feishuScope : undefined
  const documentFailureNoticeScope = documentFailureFeishuAlerts ? feishuScope : undefined
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
  try {
    store = new ManagedWorkerStore(join(stateDir, 'managed-worker.sqlite'), quotaPools.map(pool => pool.id),
      quotaNoticeScope, combinedFeishuScope, documentFailureNoticeScope)
  }
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
  let failureNotices: StudioDocumentFailureNotices | undefined
  const failureNoticeReady = () => failureNotices?.wake()
  const recovery = documentRecovery ? new StudioDocumentRecovery(ctx, store, agent => ready(agent, 'document-worker'),
    channelReady, channelStop.signal, failureNoticeReady) : undefined
  const quota = new StudioQuotaControl(ctx, store, quotaPools, providerPool, quotaFeishuAlerts)
  const drafts = new StudioAssistant(ctx, store, PRESET, agent => ready(agent, 'assistant'), ready, provider => quota.denial(provider),
    memory, channelStop.signal, textWorkerModels)
  ctx.on('llm/stream', (options, next) => drafts.stream(options, next))
  // On hosts with this optional extension, native command receipts and the exact Worker relay stay out of supplemental log uploads.
  ctx.inject(['sessionLogDeepSeek'], scope => {
    const service = (scope as unknown as { sessionLogDeepSeek: { registerExclusion(exclude: (request: { sessionId: SessionId }) => boolean): () => Promise<void> } }).sessionLogDeepSeek
    scope.effect(() => service.registerExclusion(({ sessionId }) => drafts.excludeHistoryUpload(sessionId)))
  })
  const advisors = new StudioAdvisor(ctx, store, drafts, advisoryModel, ready, channelStop.signal)
  const studies = new StudioStudy(store, drafts, agent => ready(agent, 'assistant'), channelStop.signal)
  const projects = new StudioProjectControl(store, agent => ready(agent, 'leader'), drafts, provider => providerPool.get(provider), memory)
  const projectFactIntake = new StudioProjectFactIntake(ctx, store, ready, memory, channelStop.signal)
  const jobMonitor = systemdJobPollSeconds ? new StudioProjectJobMonitor(store, systemdJobPollSeconds * 1000, channelReady, (permit, signal) => {
    const leader = ctx.agents.get(permit.leaderSessionId as SessionId)
    return leader ? projects.continueJob(leader, permit, signal) : undefined
  }, () => ctx.logger.warn('Studio external job watcher could not confirm an operation; check /studio-job status')) : undefined
  const projectJobs = systemdJobInbox ? new StudioProjectJobControl(store, agent => ready(agent, 'leader'), channelStop.signal,
    jobMonitor ? agent => projects.jobRoute(agent) : undefined) : undefined
  const intake = new StudioProjectIntake(ctx, store, agent => ready(agent, 'assistant'), channelStop.signal)
  const preferenceIntake = memory ? new StudioPreferenceIntake(ctx, store, agent => ready(agent, 'assistant'), channelStop.signal) : undefined
  const preferenceChanges = memory ? new StudioPreferenceChange(ctx, store, agent => ready(agent, 'assistant'), channelStop.signal) : undefined
  const delivery = new AgentDelivery(ctx)
  const continuations = documentContinuations ? new StudioDocumentContinuation(ctx, store, delivery, ready, channelStop.signal) : undefined
  const feishuText = feishuTextInbox ? new StudioFeishuText(store, drafts, feishuTextInbox, channelStop.signal, channelReady, combinedFeishu) : undefined
  const feishu = feishuConfig && new StudioFeishuInbox(ctx, store, stateDir, feishuConfig, channelReady, feishuText,
    !!feishuDocumentInbox || combinedFeishu, failureNoticeReady,
    continuations && ((source, intent, signal) => continuations.receiveFeishu(source, intent, signal)))
  if (documentFailureNoticeScope && feishu) {
    failureNotices = new StudioDocumentFailureNotices(ctx, store, () => feishu.noticeDestination(), channelStop.signal,
      () => ctx.logger.warn('Studio Feishu document failure notice was not confirmed; check /studio-health document <task-id>'))
  }
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
      await continuations?.drain()
      await preferenceChanges?.drain()
      await projectFactIntake.drain()
      await recovery?.drain()
      await failureNotices?.drain()
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
        : role === 'assistant' ? drafts.install(agent, role, () => intake.install(agent), () => studies.install(agent), () => advisors.install(agent, role),
          () => preferenceIntake?.install(agent) ?? (() => {})) : role !== 'document-worker' ? drafts.install(agent, role) : agent.ctx.tools.register({
        name: TOOL,
        description: 'Replace the text of the managed document bound to this worker, using its approved text and version.',
        parameters: z.toJSONSchema(documentWriteActionSchema),
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
          const capture: DocumentGuardCapture = {}
          const result = store.commit(permit, action, capture)
          if (!result.ok) throw new Error(documentGuardFeedback(result.reason, capture))
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
    catch {
      // Role storage can fail before seeing a document binding; never invent provenance for that check.
      return exec.name === TOOL ? documentGuardFeedback('STORAGE_ERROR', {}) : 'Studio tool denied: STORAGE_ERROR'
    }
    if (!role || !agent) return exec.name === TOOL || exec.name === PROPOSE_PROJECT || exec.name === PROPOSE_PREFERENCE || isAssistantTool(exec.name)
      || isStudyTool(exec.name) || isLeaderTool(exec.name) || isAdvisorTool(exec.name) ? 'Studio tool denied: INVALID_EXECUTION' : undefined
    if (!ready(agent, role) || exec.parent !== undefined) return 'Studio tool denied: INVALID_EXECUTION'
    if (role === 'assistant') {
      const denial = drafts.preferenceRouteDenial(agent, exec.callId, exec.name)
      if (denial) return denial
    }
    if (isAdvisorTool(exec.name)) return advisors.guard(agent, exec.name, role)
    if (role === 'assistant' && (isAssistantTool(exec.name) || isStudyTool(exec.name)
      || (exec.name === PROPOSE_PROJECT && intake.available(agent))
      || (exec.name === PROPOSE_PREFERENCE && preferenceIntake?.available(agent)))) return undefined
    if (role === 'leader') return projects.guard(agent, exec.name)
    if (role !== 'document-worker' || exec.name !== TOOL) return 'Studio tool denied: INVALID_EXECUTION'
    // Only the call that actually reached this Guard can be cited in a corrective review.
    const nativeCall = observeDocumentGuardCall(agent, exec.callId, exec.arguments)
    const capture: DocumentGuardCapture = nativeCall ? { nativeCall } : {}
    const result = store.authorize(agent.id, exec.arguments, exec.callId, capture)
    if (!result.ok) return documentGuardFeedback(result.reason, capture)
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
    if (!validateDocumentRelays(store, agent, messages, () => ready(agent, 'document-worker'))) return { kind: 'reject' }
    if (role === 'assistant' || role === 'leader') {
      const input = currentOwnerInboxInput(step)
      if (input) {
        step.signal.throwIfAborted()
        const continuation = role === 'assistant' && continuations?.reviewWeb(step, input)
        if (continuation) {
          await continuation
          return { kind: 'enter', messages: [] }
        }
        const registration = projectFactIntake.review(step, input, role)
        if (registration) {
          await registration
          return { kind: 'enter', messages: [] }
        }
        if (memory && role === 'assistant') {
          if (answerPreferenceQuery(store, agent, input)) return { kind: 'enter', messages: [] }
          const change = preferenceChanges?.review(step, input)
          if (change) {
            await change
            return { kind: 'enter', messages: [] }
          }
        }
      } else if (messages.some(message => message.content.some(block => block.type === 'text'
        && (parseProjectFactRequest(block.text).kind !== 'plain'
          || (role === 'assistant' && continuations && documentContinuationIntent(block.text)))))) {
        // An edited, batched, or non-owner control request must not silently enter a different work route.
        return { kind: 'reject' }
      }
    }
    const decision = await next()
    if (decision.kind === 'enter' && (role === 'draft-worker' || role === 'advisor')) {
      // Verify the messages the native loop will actually admit, after any downstream pre-step transforms.
      const selection = (step as typeof step & { modelSelection?: AdvisorRoute }).modelSelection
      if (!drafts.admit(agent, decision.messages, turn, selection, step.signal)) return { kind: 'reject' }
    }
    return decision
  })
  for (const agent of ctx.agents.list()) configure(agent)
  recovery?.install()

  if (guiDocumentInbox) captureDocumentInstructions(ctx, store, session => {
    if (!available || !controlReady(ctx)) return false
    const agent = ctx.agents.get(session.id)
    // Restrictions on the role's tools do not turn a message to its exact live Session into an untracked input.
    return agent?.session === session && scopes.get(agent)?.role === 'document-worker'
  })

  // DSH Web authorizes commands.execute through its native remote access checks. Document authorization stays user-only.
  ctx.effect(() => ctx.commands.register({
    name: 'studio-doc',
    description: 'Manage a document task in its Worker Session. Use /studio-doc guard to read past checks, including how to request a bounded review without retrying the write.',
    input: { hint: `status | ${DOCUMENT_GUARD_HINT} | ${GUARD_REVIEW_HINT} | doc-new <JSON> | doc-read <document-id> [revision] | doc-save <JSON> | start <JSON> | pause | transfer <task-id> <epoch> | resume <authorization-version> | inbox | review [<instruction-id> <authorization-version> <unchanged|pause>] | narrow <JSON> | continue <authorization-version> | feishu-status | bind-feishu`
      + (recovery ? ' | recover <task-id> <evidence-id>' : '') },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      signal.throwIfAborted()
      if (!available || !controlReady(ctx)) return rejected('CONTROL_UNAVAILABLE')
      if (rawInput.length > TEXT_LIMIT * 12 + 128) return rejected('INPUT_TOO_LARGE')
      const [, verb, argument = ''] = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(rawInput.trim()) ?? []
      if (!ready(agent, 'document-worker')) return verb === 'guard' || verb === 'guard-review'
        ? { kind: 'error', text: 'MANAGED_SESSION_REQUIRED. Open the document Worker currently bound to this task in Studio Web.' }
        : rejected('MANAGED_SESSION_REQUIRED')
      if (verb === 'guard') return documentGuardCommand(store, agent.id, argument)
      if (verb === 'guard-review') return documentGuardReviewCommand(ctx, store, agent, commandId, argument,
        AbortSignal.any([signal, channelStop.signal]), () => ready(agent, 'document-worker'))
      // Only explicit continuation wakes the Worker. Review, replacement, and other controls do not cancel the old turn.
      if (verb === 'recover') return recovery ? recovery.command(agent, argument, commandId, signal) : rejected('DOCUMENT_RECOVERY_DISABLED')
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
        const linked = `The configured Feishu private chat is linked to task ${result.value.taskId}.`
        return { kind: 'success', text: continuations
          ? `${linked} No write scope or pause changed. To continue this task, send a separate message in that chat:\nContinue that task\nOther ordinary messages still go to document review.`
          : `${linked} Incoming messages require review; no write scope or pause changed.` }
      }
      if (verb === 'start') {
        let json: unknown
        try { json = JSON.parse(argument) } catch { return rejected('INVALID_START_JSON') }
        const fields = documentStartArgs.safeParse(json)
        if (!fields.success) return rejected('INVALID_START_JSON')
        const input = fields.data
        const result = 'documentId' in input ? store.createSharedTask(agent.id, input.documentId, input.expectedVersion, input.replacement, commandId)
          : store.create(agent.id, input.initial, input.replacement, commandId)
        const created = receipt('Managed task created', result)
        return continuations && result.ok ? { ...created, text: `${created.text}\n\nTo continue from a Studio Assistant Session, send a separate message:\nContinue document task ${result.value.taskId}` } : created
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
      const result = store.readDraft(agent.id, id || undefined, memory)
      if (result.ok) return { kind: 'success', text: draftOutput(result.value, memory).text }
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
  if (memory) ctx.effect(() => ctx.commands.register({
    name: MEMORY_COMMAND,
    description: 'Record, inspect, correct, or forget explicit owner preferences without starting a model.',
    input: { hint: MEMORY_HINT },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      return memoryCommand(ctx, store, agent, commandId, rawInput, AbortSignal.any([signal, channelStop.signal]),
        () => ready(agent, 'assistant') && agent.session.header.origin !== 'subagent')
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
    description: 'Read or manage project work. Open work <work-id> in the current Leader Session for templates to block or clear unstarted text work, or to choose a model when routes are configured.',
    input: { hint: 'create <JSON> | status [project-id] | take <project-id> <epoch> [leader-bot-id|new] | work [work-id] | attach-document <work-id> <task-id> <authorization-version> | proposal [proposal-id]'
      + ` | ${PROJECT_WORK_BLOCK_HINT}` + (textWorkerModels ? ` | ${PROJECT_MODEL_USE_HINT}` : '') + ` | ${PROJECT_MODEL_CLEAR_HINT}`
      + (memory ? ` | ${PROJECT_RESULT_USE_HINT} | ${PROJECT_HANDOFF_HINT} | ${PROJECT_ARCHIVE_HINT} | ${BOT_EXPERIENCE_HINT}` : '') },
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
    description: 'Check or link an external job, keep an unconfirmed reference, or pause project work without stopping its job.',
    input: { hint: STUDIO_JOB_HINT },
    recordInput: false,
    handler: ({ agent, commandId, rawInput, signal }) => projectJobs.command(agent, commandId, rawInput, signal),
  }))
  if (watchdog) ctx.effect(() => ctx.commands.register({
    name: 'studio-health',
    description: 'Inspect saved Studio state without calling a model, querying a job, or recovering work.',
    input: { hint: '[document|job|draft|feishu|project|study|advice <id>]' },
    recordInput: false,
    handler({ agent, rawInput, signal }) {
      signal.throwIfAborted()
      if (!channelReady() || !currentSession(agent)) return { kind: 'error', text: 'Studio Watchdog unavailable.' }
      return watchdogCommand(store, rawInput, sessionId => {
        const observed = ctx.agents.get(sessionId as SessionId)
        if (!observed) return 'not-attached'
        return observed.id === sessionId ? observed.status : 'unknown'
      }, documentFailureFeishuAlerts)
    },
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
