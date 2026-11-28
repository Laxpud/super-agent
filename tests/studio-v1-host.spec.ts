import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ASSISTANT_PRESET, WORKER_PRESET } from '../src/managed-worker/assistant.ts'
import { apply, Config } from '../src/managed-worker/index.ts'
import { classifyProviderFailure, WorkerModelPolicy } from '../src/managed-worker/text-worker-model-policy.ts'
import { StudioConfigurationControl, studioConfiguration } from '../src/studio/configuration.ts'
import { ASSISTANT_CONVERSATION, STUDIO_HEADER, WORKER_DELEGATE } from '../src/studio/protocol.ts'
import { StudioCredentials } from '../src/studio/settings-credentials.ts'
import { STUDIO_DB } from '../src/studio/settings-directory.ts'
import { configurationChange } from '../src/studio/settings-schema.ts'
import { StudioFeishuSetup } from '../src/studio/feishu-setup.ts'

const model = { provider: 'fixture', model: 'quick' }
const deep = { provider: 'fixture', model: 'deliberate', reasoningEffort: 'high' }
const binding = { appId: 'cli_0123456789abcdef', botOpenId: 'ou_bot', ownerOpenId: 'ou_owner', chatId: 'oc_private' }
const signal = new AbortController().signal
const noop = () => {}
const disposer = () => noop

function modelCatalog() {
  return {
    listProviders: () => [{ id: 'fixture' }],
    listModels: async () => ['quick', 'deliberate', 'image-only', 'alias'].map(id => ({ id })),
    resolveModelInfo: vi.fn(async (provider: string, name: string, check: AbortSignal) => {
      check.throwIfAborted()
      return { provider, id: name === 'alias' ? 'quick' : name, inputModalities: [name === 'image-only' ? 'image' : 'text'],
        ...(name === 'deliberate' && { reasoning: { efforts: [{ id: 'high' }] } }) }
    }),
  }
}

function configurationFixture(initial: Record<string, unknown>) {
  const entry = { options: { config: initial } }
  const edit = vi.fn(async (target: typeof entry, change: (raw: typeof initial, inherited: object) => typeof initial) => {
    expect(target).toBe(entry)
    target.options.config = change(target.options.config, {})
  })
  const llm = modelCatalog()
  const host = { get: (name: string) => name === 'configEditor' ? { entries: () => [entry], edit } : undefined,
    root: {}, fiber: { entry }, llm } as unknown as Context
  const initialConfig = Config(initial)
  const resume = vi.fn(), quiesce = vi.fn(() => resume)
  const runtime = { credentials: new StudioCredentials(host), credential: { state: 'none' as const },
    setup: new StudioFeishuSetup(), feishuState: () => 'disabled' as const, quiesce }
  const control = new StudioConfigurationControl(host, initialConfig, runtime)
  const read = () => control.operations.configuration({}, signal)
  return { read, entry, edit, llm, resume, quiesce, save: async (config: unknown) => control.operations.saveConfiguration(
    configurationChange.parse({ config, revision: (await read()).revision, allowReload: true }), signal) }
}

describe('Studio V1 configuration', () => {
  it('projects the supported fields and saves only valid route IDs and permission levels', async () => {
    const f = configurationFixture({ stateDir: '/studio-state', studioCwd: '/studio-workspace',
      workerModelRoutes: [{ id: 'quick', ...model }], workerModelDefaults: { assistant: 'quick' }, defaultWorkerPermission: 'read-only' })
    const { config, revision, writable } = await f.read()
    expect(writable).toBe(true)
    expect(config).toEqual({ stateDir: '/studio-state', studioCwd: '/studio-workspace', assistantModel: null, leaderModel: null,
      workerModelRoutes: [{ id: 'quick', ...model }], workerModelDefaults: { assistant: 'quick' }, defaultWorkerPermission: 'read-only', feishu: { mode: 'disabled' } })
    const next = { ...config, workerModelRoutes: [...config.workerModelRoutes, { id: 'deep', ...deep }],
      workerModelDefaults: { assistant: 'quick', leader: 'deep' }, defaultWorkerPermission: 'workspace-write' as const }
    const draft = (changes: object) => configurationChange.safeParse({ revision, allowReload: true, config: { ...next, ...changes } })
    expect(draft({ defaultWorkerPermission: 'danger-full-access' }).success).toBe(false)
    expect(draft({ workerModelRoutes: [{ id: 'space in id', ...model }] }).success).toBe(false)
    expect(draft({ workerModelDefaults: { worker: 'quick' } }).success).toBe(false)
    expect(draft({ textWorkerRoutes: [] }).success).toBe(false)
    await expect(f.save({ ...next, workerModelDefaults: { leader: 'missing' } })).rejects.toMatchObject({ code: 'STUDIO_WORKER_POLICY_INVALID' })
    await expect(f.save({ ...next, workerModelRoutes: [...next.workerModelRoutes, { id: 'quick', ...deep }] }))
      .rejects.toMatchObject({ code: 'STUDIO_WORKER_POLICY_INVALID' })
    await expect(f.save({ ...next, workerModelRoutes: [{ id: 'deep', ...deep, reasoningEffort: 'unsupported' }], workerModelDefaults: { leader: 'deep' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    expect(f.edit).not.toHaveBeenCalled()
    expect(f.quiesce).not.toHaveBeenCalled()
    f.llm.resolveModelInfo.mockClear()
    expect((await f.save(next)).revision).not.toBe(revision)
    expect(f.llm.resolveModelInfo.mock.calls.map(([provider, name]) => [provider, name])).toEqual([['fixture', 'deliberate']])
    expect(f.quiesce).toHaveBeenCalledOnce()
    expect(f.resume).toHaveBeenCalledOnce()
    expect(studioConfiguration(Config(f.entry.options.config))).toEqual(next)
  })

  it('reads legacy model tuples once, gives canonical keys priority and removes retired profile keys on save', async () => {
    const raw = { stateDir: '/studio-state', textWorkerRoutes: [deep], textWorkerDefaults: { assistant: deep, leader: null },
      textWorkerBounds: { assistant: {} }, advisor: { enabled: true }, quotaPools: ['retired'], watchdog: { enabled: true } }
    const f = configurationFixture(raw)
    const { config } = await f.read()
    const [legacy] = config.workerModelRoutes
    expect(legacy).toMatchObject({ id: expect.stringMatching(/^legacy-[0-9a-f]{24}$/u), ...deep })
    expect(config.workerModelDefaults).toEqual({ assistant: legacy!.id })
    expect(config.defaultWorkerPermission).toBe('read-only')
    expect(studioConfiguration(Config(raw))).toEqual(config)
    const canonical = { workerModelRoutes: [{ id: 'quick', ...model }], workerModelDefaults: {} }
    expect(Config({ ...raw, ...canonical })).toMatchObject(canonical)
    expect(() => Config({ ...raw, textWorkerDefaults: { leader: { ...deep, model: 'missing' } } })).toThrow('does not match a configured Worker model route')
    await f.save(config)
    const saved = f.entry.options.config
    expect(saved).toEqual({ stateDir: raw.stateDir, workerModelRoutes: config.workerModelRoutes, workerModelDefaults: config.workerModelDefaults,
      defaultWorkerPermission: 'read-only', feishuConversation: null })
    expect(studioConfiguration(Config(saved))).toEqual(config)
  })

  it('never maps a legacy Feishu Inbox to a conversation binding and rejects old UI modes', async () => {
    const raw = { stateDir: '/studio-state', feishuDocumentInbox: binding, feishuTextInbox: { ...binding, cwd: '/old-workspace', ...model } }
    const f = configurationFixture(raw)
    const { config, revision } = await f.read()
    expect(config.feishu).toEqual({ mode: 'disabled' })
    const draft = (feishu: object) => configurationChange.safeParse({ revision, allowReload: true, config: { ...config, feishu } })
    expect(draft({ mode: 'disabled' }).success).toBe(true)
    expect(draft({ mode: 'conversation', binding }).success).toBe(true)
    expect(draft({ mode: 'conversation', binding: { ...binding, secret: 'not-a-profile-field' } }).success).toBe(false)
    expect(draft({ mode: 'document', binding }).success).toBe(false)
    expect(draft({ mode: 'text', binding }).success).toBe(false)
    const conversation = { mode: 'conversation', binding } as const
    const host = Config({ ...raw, feishuConversation: binding, studioFeishuCredentialId: 'private-vault-reference' })
    expect(studioConfiguration(host).feishu).toEqual(conversation)
    expect(studioConfiguration(host)).not.toHaveProperty('studioFeishuCredentialId')
    await expect(f.save({ ...config, feishu: conversation })).rejects.toMatchObject({ code: 'FEISHU_VERIFICATION_REQUIRED' })
    expect(f.edit).not.toHaveBeenCalled()
    await f.save(config)
    expect(f.entry.options.config).toMatchObject({ feishuConversation: null })
    expect(f.entry.options.config).not.toHaveProperty('feishuDocumentInbox')
    expect(f.entry.options.config).not.toHaveProperty('feishuTextInbox')
  })
})

it.each(['', ' \t\n'])('boots with legacy blank studioCwd %j but still rejects invalid nonblank paths', async studioCwd => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'studio-v1-legacy-cwd-'))
  const effects: Array<() => void | Promise<void>> = []
  onTestFinished(async () => {
    try { for (const dispose of effects.reverse()) await dispose() }
    finally {
      if (realpathSync(dir) !== dir) throw new Error('Refusing to clean up a different fixture path')
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const browserPeer = { principal: { kind: 'owner' } }
  const register = vi.fn(disposer)
  const host = { root: {}, fiber: {}, get: noop, on: disposer,
    agents: { create: vi.fn(), resume: vi.fn(), withoutInitiator: vi.fn(), list: () => [] },
    agentPresets: { mount: vi.fn(), presetForSession: vi.fn() },
    connection: { allowsRemoteAuthorities: false, browserPeer, admit: () => ({ peer: browserPeer }) },
    commands: { register: disposer }, tools: { guard: disposer }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    permissionPresets: { resolve: () => ({ sandbox: 'read-only' }), current: () => 'read-only', set: vi.fn() },
    sessionPersistence: { flush: vi.fn(), open: vi.fn() }, llm: modelCatalog(),
    webServer: { host: '127.0.0.1', getOrigin: () => 'http://127.0.0.1:8080', register },
    effect(start: () => () => void | Promise<void>) { effects.push(start()) }, logger: { info: noop, warn: noop, error: noop },
  } as unknown as Context
  for (const invalid of ['.', join(dir, 'missing')]) {
    await expect(apply(host, Config({ stateDir: dir, studioCwd: invalid }))).rejects.toMatchObject({ code: 'STUDIO_WORKSPACE_INVALID' })
  }
  expect(register).not.toHaveBeenCalled()
  const config = Config({ stateDir: dir, studioCwd })
  expect(config.studioCwd).toBe(process.cwd())
  await apply(host, config)
  expect(register).toHaveBeenCalledOnce()
  using db = new DatabaseSync(join(dir, STUDIO_DB), { readOnly: true })
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
})

describe('Studio V1 Worker models', () => {
  it('resolves explicit, role default and fallback models in order without mutating the routes', () => {
    const ctx = { llm: modelCatalog() } as unknown as Context
    const entries = [{ id: 'quick', ...model }, { id: 'deep', ...deep }]
    const defaults = { assistant: 'deep' }
    const policy = new WorkerModelPolicy(ctx, entries, defaults)
    const request = { task: { permission: 'read-only' as const, workspacePath: null, projectId: null }, fallback: model }
    expect(policy.defaultFor('assistant')).toEqual({ id: 'deep', ...deep })
    expect(policy.defaultFor('leader')).toBeUndefined()
    expect(policy.explicitRoute('quick')).toEqual({ id: 'quick', ...model })
    expect(Object.isFrozen(policy.explicitRoute('quick'))).toBe(true)
    expect(policy.selectModel('assistant', request)).toEqual(deep)
    expect(policy.selectModel('assistant', { ...request, routeId: 'quick' })).toEqual(model)
    expect(policy.selectModel('leader', { ...request, fallback: deep })).toEqual(deep)
    const unlisted = { provider: 'other', model: 'unlisted' }
    expect(policy.selectModel('leader', { ...request, fallback: unlisted })).toEqual(model)
    expect(new WorkerModelPolicy(ctx, [], {}).selectModel('leader', { ...request, fallback: unlisted })).toEqual(unlisted)
    expect(() => policy.selectModel('assistant', { ...request, routeId: 'missing' })).toThrow('route ID does not exist')
    expect(() => new WorkerModelPolicy(ctx, entries, { leader: 'missing' })).toThrow('route ID does not exist')
    expect(() => new WorkerModelPolicy(ctx, [entries[0]!, entries[0]!], {})).toThrow('distinct IDs')
    expect(() => new WorkerModelPolicy(ctx, [{ ...entries[0]!, provider: 'invalid id' }], {})).toThrow('valid model selections')
    entries[0]!.model = 'mutated'; defaults.assistant = 'quick'
    expect(policy.explicitRoute('quick').model).toBe(model.model)
    expect(policy.defaultFor('assistant')?.id).toBe('deep')
  })

  it('pins only the exact installed text model and advertised effort, preserving cancellation', async () => {
    const llm = modelCatalog()
    const policy = new WorkerModelPolicy({ llm } as unknown as Context, [], {})
    const selection = { ...deep }
    const pinned = await policy.pin(selection, signal)
    expect(pinned).toEqual(deep)
    expect(pinned).not.toBe(selection)
    expect(Object.isFrozen(pinned)).toBe(true)
    expect(llm.resolveModelInfo).toHaveBeenCalledWith(deep.provider, deep.model, expect.any(AbortSignal))
    for (const invalid of [{ ...deep, provider: 'missing' }, { ...deep, model: 'missing' }, { ...model, model: 'alias' },
      { ...model, model: 'image-only' }, { ...deep, reasoningEffort: 'unsupported' }]) {
      await expect(policy.pin(invalid, signal)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
    }
    const cancelled = new DOMException('Stop checking', 'AbortError')
    await expect(policy.pin(deep, AbortSignal.abort(cancelled))).rejects.toBe(cancelled)
  })

  it('pins the same snapshot it verified even if the caller edits their selection during metadata lookup', async () => {
    const llm = modelCatalog()
    const verifying = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    llm.resolveModelInfo.mockImplementationOnce(async (provider, id) => {
      verifying.resolve()
      await release.promise
      return { provider, id, inputModalities: ['text'], reasoning: { efforts: [{ id: 'high' }] } }
    })
    const policy = new WorkerModelPolicy({ llm } as unknown as Context, [], {})
    const selection = { ...deep }
    const pin = policy.pin(selection, signal)
    await verifying.promise
    selection.model = 'unconfirmed'
    selection.reasoningEffort = 'unconfirmed'
    release.resolve()
    await expect(pin).resolves.toEqual(deep)
  })

  it('classifies only concrete Provider failures; generic throttling is not quota', () => {
    const policy = new WorkerModelPolicy({} as Context, [], {})
    for (const [error, classification] of [
      [undefined, 'unknown'], [new Error('quota in the message alone'), 'unknown'], [{ status: 402 }, 'unknown'], [{ status: '503' }, 'unknown'],
      [new DOMException('Cancelled', 'AbortError'), 'cancelled'], [{ code: 'ABORT_ERR', status: 503 }, 'cancelled'], [{ code: 'CANCELLED' }, 'cancelled'],
      [{ status: 408 }, 'transient'], [{ status: 429 }, 'transient'], [{ status: 503 }, 'transient'], [{ name: 'TimeoutError' }, 'transient'],
      [{ code: 'TRANSPORT' }, 'transient'], [{ code: 'ECONNRESET' }, 'transient'], [{ code: 'ETIMEDOUT' }, 'transient'],
      [{ status: 429, code: 'insufficient_quota' }, 'quota'], [{ code: 'QUOTA_EXHAUSTED' }, 'quota'], [{ code: 'billing_hard_limit_reached' }, 'quota'],
    ] as const) {
      expect(classifyProviderFailure(error)).toBe(classification)
      expect(policy.classifyProviderFailure(error)).toBe(classification)
    }
  })
})

it('denies file and shell tools even inside an authorized workspace-write Worker', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'studio-v1-guard-'))
  const effects: Array<() => void | Promise<void>> = []
  onTestFinished(async () => {
    try { for (const dispose of effects.reverse()) await dispose() }
    finally {
      if (realpathSync(dir) !== dir) throw new Error('Refusing to clean up a different fixture path')
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const llm = modelCatalog()
  const registered = new Map<string, Agent>()
  const browserPeer = { id: 'local-owner', principal: { kind: 'owner' } }
  const reachedWorker = Promise.withResolvers<{ agent: Agent; verdicts: Array<string | void>; recorded: object | undefined }>()
  let configure: (event: { agent: Agent }) => void
  let guard: (exec: Readonly<ToolExecution>) => string | void
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const tools = ['write', 'edit', 'bash', 'pwsh', 'subagent', WORKER_DELEGATE]

  // 只模拟 DSH 提供的原生会话、模型和 Web 接线；实际 Host 注册守卫，实际 Studio 服务登记并启动 Worker。
  const host = { root: {}, fiber: {}, get: (name: string) => name === 'agentDefaultModel' ? { currentSelection: () => model } : undefined,
    agents: { get: (id: string) => registered.get(id), list: () => [...registered.values()], resume: vi.fn(),
      withoutInitiator: (fn: () => unknown) => fn(), async create(options: { sessionId: string; meta: { agentPreset: string } }) {
        const { sessionId: id, meta: { agentPreset: preset } } = options
        const session = { preset, header: { origin: 'native' }, inheritedEventCount: 0, firstLiveSeq: 0,
          events: [] as unknown[], get seq() { return this.events.length }, eventAt(seq: number) { return this.events[seq] } }
        const nativeTools = new Map<string, (params: object, exec: object) => Promise<unknown>>()
        let idle: Promise<unknown> = Promise.resolve()
        const agent = { id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, model: { select: noop }, cancel: noop,
          whenIdle: () => idle, ctx: { systemPrompt: { suppressRuntimeContext: disposer, section: disposer }, tools: {
            restrict: disposer, register: (tool: { name: string; execute(params: object, exec: object): Promise<unknown> }) => {
              nativeTools.set(tool.name, tool.execute)
              return () => nativeTools.delete(tool.name)
            },
          } }, followup(input: UserMessage) {
            if (preset === ASSISTANT_PRESET) {
              session.events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', surfaceOp: 'append', data: input },
                { type: 'tool/call', data: { callId: 'delegate', name: WORKER_DELEGATE, turn: 1 } })
              const exec = { agent, name: WORKER_DELEGATE, callId: 'delegate', signal }
              if (guard(exec as unknown as ToolExecution) !== undefined) throw new Error('Configured Assistant could not delegate')
              idle = nativeTools.get(WORKER_DELEGATE)!({}, exec).catch(error => { reachedWorker.reject(error); throw error })
            } else if (preset === WORKER_PRESET) {
              const db = new DatabaseSync(join(dir, STUDIO_DB), { readOnly: true })
              try {
                const recorded = db.prepare(`SELECT permission, status, session_id FROM studio_task JOIN studio_task_execution USING (task_id)
                  WHERE session_id = ? AND ended_at IS NULL`).get(id)
                reachedWorker.resolve({ agent, recorded, verdicts: tools.map(name => guard({ agent, name } as ToolExecution)) })
              } finally { db.close() }
            }
          },
        } as unknown as Agent
        registered.set(id, agent)
        configure({ agent })
        return { agent, dispose: async () => {} }
      },
    }, agentPresets: { presetForSession: (session: { preset: string }) => session.preset, mount: async () => {} },
    connection: { allowsRemoteAuthorities: false, browserPeer, admit: () => ({ peer: browserPeer }) },
    tools: { guard: (fn: typeof guard) => { guard = fn; return noop } },
    commands: { register: disposer }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    permissionPresets: { resolve: () => ({ sandbox: 'read-only' }), current: () => 'read-only', set: vi.fn() },
    sessionPersistence: { flush: async () => {}, open: vi.fn() }, llm,
    webServer: { host: '127.0.0.1', getOrigin: () => 'http://127.0.0.1:8080', register: (route: { handler: typeof handler }) => { handler = route.handler; return noop } },
    on(name: string, fn: typeof configure) { if (name === 'agent/created') configure = fn; return noop },
    effect(start: () => () => void | Promise<void>) { effects.push(start()) }, logger: { info: noop, warn: noop, error: noop },
  }
  await apply(host as unknown as Context, Config({ stateDir: dir, studioCwd: dir, defaultWorkerPermission: 'workspace-write' }))
  const request = Object.assign(Readable.from([JSON.stringify({ op: 'send', input: {
    conversationId: ASSISTANT_CONVERSATION, requestId: 'guard-probe', text: 'Summarize this one-line input.',
  } })]), { method: 'POST', headers: { [STUDIO_HEADER]: '1' } })
  const response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), end: vi.fn() })
  await handler!(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  const { agent, recorded, verdicts } = await reachedWorker.promise
  expect(recorded).toEqual({ permission: 'workspace-write', status: 'running', session_id: agent.id })
  expect(host.permissionPresets.set).toHaveBeenCalledWith(agent.session, 'read-only')
  // 只有当前执行才会到达这个拒绝分支；不是因为 Session 未登记或已经过期才拒绝。
  expect(verdicts).toEqual(tools.map(() => 'Studio tool denied: no Worker tools are enabled in this stage'))
  const outside = { id: 'ordinary-session', session: { preset: 'standard' } } as unknown as Agent
  expect(guard!({ agent: outside, name: 'bash' } as ToolExecution)).toBeUndefined()
})
