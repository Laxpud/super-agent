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
import { ASSISTANT_PRESET, StudioAssistant, draftOutput, isAssistantTool } from './assistant.ts'
import { ManagedWorkerStore, type ManagedResult, type ManagedTask, type ManagedWritePermit } from './store.ts'

export const name = 'dsh-superagent-managed-worker'
export const inject = ['agents', 'agentPresets', 'commands', 'connection', 'permissionPresets', 'sandboxPolicy', 'systemPrompt', 'tools', 'webServer']
export const Config = s.object({
  stateDir: s.string().required().description('Absolute directory reserved for the managed document worker database.'),
})
type Config = ReturnType<typeof Config>

const PRESET = 'dsh-superagent-managed-worker'
const TOOL = 'studio_write_document'
const TEXT_LIMIT = 32_000
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const startSchema = z.strictObject({ initial: z.string().max(TEXT_LIMIT), replacement: z.string().max(TEXT_LIMIT) })
const writeSchema = z.strictObject({ expectedVersion: z.literal(1), text: z.string().max(TEXT_LIMIT) })

interface CommandResult { kind: 'success' | 'error'; text: string }
interface CommandInput { agent: Agent; commandId: string; rawInput: string; signal: AbortSignal }
type StudioRole = 'assistant' | 'draft-worker' | 'document-worker'
interface StudioScope { role: StudioRole; dispose(): void }

/** Only the rc.3 additions used here are declared. The running host provides the services; no second Cordis or DSH runtime is loaded. */
type ManagedHost = Context & {
  agentPresets: { presetForSession(session: Agent['session']): string | null }
  connection: { allowsRemoteAuthorities: boolean; browserPeer: { principal: { kind: string } } }
  commands: { register(command: { name: string; description: string; input: { hint: string }; recordInput: boolean;
    handler(input: CommandInput): CommandResult }): () => void }
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
function receipt(operation: string, result: ManagedResult<ManagedTask>): CommandResult {
  if (!result.ok) return result.reason === 'PAUSE_UNCONFIRMED'
    ? { kind: 'error', text: 'Pause not saved; affected writes remain blocked in this host. Retry /studio-doc pause in the current Worker, or run /studio-doc status there after restart.' }
    : rejected(result.reason)
  const task = result.value
  const resume = task.paused ? ` To allow writes again when ready, run /studio-doc resume ${task.authorizationVersion} in the current Worker.` : ''
  return { kind: 'success', text: `${operation}: task ${task.taskId}; execution epoch ${task.executionEpoch}; authorization version ${task.authorizationVersion}; document version ${task.documentVersion}; ${task.paused ? 'paused' : 'active'}.${resume}` }
}

/** Start without using the prototype Runtime, Sources, GitHub credentials, or work directories. */
export function apply(context: Context, { stateDir }: Config): void {
  const ctx = localOwnerHost(context)
  if (!isAbsolute(stateDir)) throw new Error('Managed Worker stateDir must be absolute')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  let available = true
  // Reserve the directory for one host. The SQLite run fence also rejects commits from a prior holder of the lock.
  const unlock = lockSync(stateDir, { stale: 30_000, onCompromised(error) {
    available = false
    ctx.logger.error('Managed Worker lost its state directory lock: %s', String(error))
  } })
  let store: ManagedWorkerStore
  try { store = new ManagedWorkerStore(join(stateDir, 'managed-worker.sqlite')) }
  catch (error) { unlock(); throw error }
  if (store.recoveredTasks) ctx.logger.warn('Managed Worker paused %d unfinished tasks after an unconfirmed run', store.recoveredTasks)

  const scopes = new Map<Agent, StudioScope>()
  const permits = new Map<ToolExecutionToken, ManagedWritePermit>()
  const presetOf = (agent: Agent) => ctx.agentPresets.presetForSession(agent.session)
  const presetFor = (role: StudioRole) => role === 'assistant' ? ASSISTANT_PRESET : PRESET
  const currentSession = (agent: Agent): boolean => ctx.agents.get(agent.id) === agent
  const restricted = (agent: Agent): boolean => ctx.permissionPresets.current(agent.session) === 'read-only'
    && ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only'
  const ready = (agent: Agent, role: StudioRole): boolean => available && controlReady(ctx) && currentSession(agent)
    && scopes.get(agent)?.role === role && presetOf(agent) === presetFor(role) && restricted(agent)
  const drafts = new StudioAssistant(ctx, store, PRESET, agent => ready(agent, 'assistant'), agent => ready(agent, 'draft-worker'))

  /** A persisted binding wins over the picker, so a retired or finished Worker cannot become a different role on resume. */
  function roleOf(agent: Agent): StudioRole | undefined {
    if (store.draftBinding(agent.id)) return 'draft-worker'
    if (store.binding(agent.id)) return 'document-worker'
    if (store.assistantBinding(agent.id)) return 'assistant'
    const preset = presetOf(agent)
    if (preset === ASSISTANT_PRESET) return 'assistant'
    if (preset === PRESET) return 'document-worker'
  }

  ctx.effect(() => () => {
    const heldLock = available
    available = false
    drafts.stop()
    permits.clear()
    try {
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
      const unregister = role !== 'document-worker' ? drafts.install(agent, role) : agent.ctx.tools.register({
        name: TOOL,
        description: 'Replace the text of the managed document bound to this worker, using its approved text and version.',
        parameters: z.toJSONSchema(writeSchema),
        output: {
          schema: { type: 'object', properties: { documentVersion: { type: 'integer' } }, required: ['documentVersion'] },
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
          if (!result.ok) throw new Error(`Managed write denied: ${result.reason}`)
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
    if (!role || !agent) return exec.name === TOOL || isAssistantTool(exec.name) ? 'Studio tool denied: INVALID_EXECUTION' : undefined
    if (!ready(agent, role) || exec.parent !== undefined) return 'Studio tool denied: INVALID_EXECUTION'
    if (role === 'assistant' && isAssistantTool(exec.name)) return undefined
    if (role !== 'document-worker' || exec.name !== TOOL) return 'Studio tool denied: INVALID_EXECUTION'
    const result = store.authorize(agent.id, exec.arguments, exec.callId)
    if (!result.ok) return `Managed write denied: ${result.reason}`
    permits.set(exec.token, result.value)
    return undefined
  }))
  ctx.on('tools/result', exec => { permits.delete(exec.token); return undefined })
  ctx.on('agent/created', ({ agent }) => { configure(agent); return undefined })
  ctx.on('agent/disposed', ({ agent }) => { scopes.get(agent)?.dispose(); scopes.delete(agent) })
  ctx.on('agent-preset/selected', (id, preset) => {
    if (preset !== PRESET && preset !== ASSISTANT_PRESET) return
    const agent = ctx.agents.get(id as SessionId)
    if (agent) configure(agent)
  })
  ctx.on('agent/pre-step', async ({ agent, turn, messages }, next) => {
    const role = scopes.get(agent)?.role
    if (role === 'assistant' && !ready(agent, role)) return { kind: 'reject' }
    if (role === 'draft-worker' && !drafts.admit(agent, messages, turn)) return { kind: 'reject' }
    return next()
  })
  for (const agent of ctx.agents.list()) configure(agent)

  // DSH Web authorizes commands.execute through its native remote access checks. Document authorization stays user-only.
  ctx.effect(() => ctx.commands.register({
    name: 'studio-doc',
    description: 'Manage a document task in this managed worker Session.',
    input: { hint: 'start <JSON> | status | pause | transfer <task-id> <epoch> | resume <authorization-version>' },
    recordInput: false,
    handler({ agent, commandId, rawInput, signal }) {
      signal.throwIfAborted()
      if (!available || !controlReady(ctx)) return rejected('CONTROL_UNAVAILABLE')
      if (!ready(agent, 'document-worker')) return rejected('MANAGED_SESSION_REQUIRED')
      // This command commits control state without queuing a Worker message or cancelling the turn. The action checks that state before committing.
      if (rawInput.length > TEXT_LIMIT * 12 + 128) return rejected('INPUT_TOO_LARGE')
      const [, verb, argument = ''] = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(rawInput.trim()) ?? []
      if (verb === 'start') {
        let json: unknown
        try { json = JSON.parse(argument) } catch { return rejected('INVALID_START_JSON') }
        const fields = startSchema.safeParse(json)
        return fields.success
          ? receipt('Managed task created', store.create(agent.id, fields.data.initial, fields.data.replacement, commandId))
          : rejected('INVALID_START_JSON')
      }
      if (verb === 'status' && argument === '') return receipt('Managed task status', store.status(agent.id))
      if (verb === 'pause' && argument === '') return receipt('Pause effective', store.pause(agent.id, commandId))
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
      if (!result.ok) return { kind: 'error', text: `Cannot read Studio result: ${result.reason}.` }
      return { kind: 'success', text: draftOutput(result.value).text }
    },
  }))
  ctx.logger.info('SuperAgent Studio ready (no GitHub source)')
}
