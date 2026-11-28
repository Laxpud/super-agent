import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ASSISTANT_PRESET, StudioAssistant, WORKER_PRESET } from '../src/managed-worker/assistant.ts'
import { LEADER_PRESET } from '../src/managed-worker/project.ts'
import { ManagedWorkerStore } from '../src/managed-worker/store.ts'
import { WorkerModelPolicy } from '../src/managed-worker/text-worker-model-policy.ts'
import { StudioFeishuConversation } from '../src/studio/feishu.ts'
import type { StudioFeishuSdk } from '../src/studio/feishu-sdk.ts'
import { ASSISTANT_CONVERSATION as assistant, FORWARD_PROJECT, WORKER_DELEGATE, type StudioInput, type StudioOp } from '../src/studio/protocol.ts'
import { StudioService } from '../src/studio/service.ts'
import { confirmStudioDirectory, STUDIO_DB, StudioDirectorySwitch } from '../src/studio/settings-directory.ts'
import { studioOwnerMessageId } from '../src/studio/source.ts'

const route = { provider: 'phase3-fixture', model: 'offline' }
const cutover = Date.now() - 1_000
const binding = { appId: 'cli_0123456789abcdef', botOpenId: 'ou_bot', ownerOpenId: 'ou_owner', chatId: 'oc_private' }
const noop = () => {}
const dispose = () => noop

function directory() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'studio-phase3-'))
  const cleanup = () => {
    if (realpathSync(dir) !== dir) throw new Error('Refusing to clean up a different fixture path')
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, path: join(dir, 'studio.sqlite'), cleanup }
}

/** 只模拟原生 Host 的会话事件、模型和调度边界；工具、受理、派工、回传和账本均使用产品实现。 */
function fixture() {
  const { dir, path, cleanup } = directory()
  const workspace = join(dir, 'workspace'), nextWorkspace = join(dir, 'next-workspace')
  mkdirSync(workspace); mkdirSync(nextWorkspace)
  const domain = new ManagedWorkerStore(path)
  const stop = new AbortController(), { signal } = stop
  const events = new EventEmitter()
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  const modes = new WeakMap<object, string>()
  const drivers = new Map<string, (turn: ReturnType<typeof makeTurn>) => void | Promise<void>>()
  const turns = new Map<string, ReturnType<typeof makeTurn>>()
  const errors: unknown[] = []
  const notify = vi.fn()
  const native = {
    on(name: string, listener: (...args: unknown[]) => void) {
      events.on(name, listener); return () => events.off(name, listener)
    },
    get: (name: string) => name === 'agentDefaultModel' ? { currentSelection: () => route } : undefined,
    agents: { get: () => undefined, withoutInitiator: <T>(run: () => T) => run(),
      create: async ({ sessionId, meta }: { sessionId: string; meta: { agentPreset: string } }) => makeSession(sessionId, meta.agentPreset).handle,
      resume: async ({ resumeSessionId }: { resumeSessionId: string }) => sessions.get(resumeSessionId)!.handle },
    llm: { listProviders: () => [{ id: route.provider }], listModels: async () => [{ id: route.model }],
      resolveModelInfo: async () => ({ provider: route.provider, id: route.model, inputModalities: ['text'] }) },
    permissionPresets: { set: (session: object, mode: string) => { modes.set(session, mode) } },
    sandboxPolicy: { resolve: ({ session }: { session: object }) => ({ mode: modes.get(session) ?? 'read-only' }) },
    sessionPersistence: { flush: async () => {} }, logger: { warn: vi.fn() },
  }
  const host = native as unknown as Context
  const ready = (agent: Agent, role: 'assistant' | 'leader' | 'worker') => sessions.get(agent.id)?.role === role
    && (role !== 'leader' || !!domain.projects.currentLeader(agent.id))
  const service = new StudioService(host, domain, workspace, { assistant: null, leader: null }, ready, signal, () => 'online', notify)
  const runtime = new StudioAssistant(host, domain, service.sessions, new WorkerModelPolicy(host, [], {}), ready, workspace)

  function makeSession(id: string, preset: string) {
    const role = preset === WORKER_PRESET ? 'worker' : preset === LEADER_PRESET ? 'leader' : 'assistant'
    if (role === 'assistant') expect(preset).toBe(ASSISTANT_PRESET)
    const session = { id, header: {}, inheritedEventCount: 0, firstLiveSeq: 0,
      events: [] as unknown[], get seq() { return this.events.length }, eventAt(seq: number) { return this.events[seq] } }
    const tools = new Map<string, (args: object, exec: ToolExecution) => Promise<unknown>>()
    let prompt = () => ''
    let turnNumber = 0
    let idle = Promise.resolve()
    let abort: AbortController | undefined
    const emit = (type: string, data: object, surfaceOp?: string) => {
      const event = { type, data, seq: session.seq, surfaceOp }
      session.events.push(event); events.emit('session/event', session, event)
    }
    const agent = { id, session, status: 'idle', inbox: { nextStep: [], nextTurn: [] }, model: { select: noop }, whenIdle: () => idle,
      cancel: () => abort?.abort(), ctx: { tools: { register: (tool: { name: string; execute: (typeof tools extends Map<string, infer T> ? T : never) }) => {
        tools.set(tool.name, tool.execute); return () => tools.delete(tool.name)
      } }, systemPrompt: { suppressRuntimeContext: dispose, section(section: { text: () => string }) { prompt = section.text; return noop } } },
      followup(input: UserMessage) {
        const text = input.content[0]?.type === 'text' ? input.content[0].text : ''
        const turn = ++turnNumber
        abort = new AbortController()
        const local = abort.signal
        emit('turn/start', { turn }); emit('user/message', input, 'append')
        if (role === 'worker') expect(runtime.admit(agent, [input], turn, [input])).toBe(true)
        const control = makeTurn(agent, turn, local, prompt, tools, emit)
        turns.set(`${role}:${text}`, control)
        idle = Promise.resolve().then(() => {
          if (drivers.has(`${role}:${text}`)) return drivers.get(`${role}:${text}`)!(control)
          control.say(`Offline ${role} result: ${text}`)
        }).then(() => emit('turn/end', { turn, reason: { kind: local.aborted ? 'aborted' : 'completed' } }), error => {
          errors.push(error); emit('turn/end', { turn, reason: { kind: 'error' } })
        })
      },
    } as unknown as Agent
    const state = { role, handle: { agent, dispose: async () => { abort?.abort(); await idle } } }
    sessions.set(id, state)
    runtime.install(agent, role)
    return state
  }

  function makeTurn(agent: Agent, turn: number, local: AbortSignal, prompt: () => string,
    tools: Map<string, (args: object, exec: ToolExecution) => Promise<unknown>>, emit: (type: string, data: object) => void) {
    let calls = 0
    return { agent, signal: local, prompt, say(text: string, withTool = false) {
      emit('assistant/message', { turn, message: { content: [{ type: 'text', text }, ...(withTool ? [{ type: 'tool-call' }] : [])] } })
    }, async tool(name: string, args: object) {
      const callId = `${agent.id}-${turn}-${++calls}`
      emit('tool/call', { name, callId, turn })
      return tools.get(name)!(args, { agent, name, callId, signal } as ToolExecution)
    } }
  }

  onTestFinished(async () => {
    stop.abort(); domain.interruptActiveTasks()
    try { await service.sessions.drain(); domain.finishRun(); expect(errors).toEqual([]) }
    finally { domain.close(); cleanup() }
  })
  const call = <K extends keyof typeof service.operations & StudioOp>(op: K, input: StudioInput<K>) =>
    Promise.resolve().then(() => service.operations[op](input, signal))
  const send = (text: string, conversationId = assistant, requestId = text) => call('send', { conversationId, requestId, text })
  const status = (id: string, conversationId = assistant) => call('messageStatus', { conversationId, id })
  const replies = async (replyTo: string, conversationId = assistant, topicId?: string) =>
    (await call('timeline', { conversationId, ...(topicId ? { topicId } : {}) })).items.filter(item => item.replyTo === replyTo)
  const project = (name = 'Phase 3 project', workspacePath?: string) => call('createProject', { name, objective: `Objective for ${name}`,
    ...(workspacePath ? { workspacePath } : {}) })
  const drive = (role: string, text: string, fn: (turn: ReturnType<typeof makeTurn>) => void | Promise<void>) => drivers.set(`${role}:${text}`, fn)
  const turn = (role: string, text: string) => turns.get(`${role}:${text}`)
  const wait = (predicate: () => unknown) => vi.waitFor(async () => expect(await predicate()).toBeTruthy(), { timeout: 1_500, interval: 5 })
  const currentTask = async (id: string, conversationId = assistant) => (await status(id, conversationId)).tasks[0]
  const readSql = (sql: string) => { using db = new DatabaseSync(path, { readOnly: true }); return db.prepare(sql).all() }
  return { domain, service, signal, call, project, send, status, replies, workspace, nextWorkspace, drive, turn, wait, currentTask, readSql, native }
}

const projectCoord = (projectId: string, expectedEpoch: number) => ({ projectId, expectedEpoch })
function expectError(code: string, status?: number) { return { code, ...(status === undefined ? {} : { status }) } }

/** V1 表与 V2 的区别只有转发表和来源列；从写入后的快照撤回这些 DDL，避免空表伪迁移。 */
function seedV1(path: string) {
  const store = new ManagedWorkerStore(path)
  try {
    const project = store.projects.create({ name: 'Preserved project', objective: 'Preserved objective', leaderSessionId: 'old-leader' })
    store.studio.saveSettings({ revision: 0, assistant: route, leader: null })
    store.studio.activateFeishu('prior-scope', cutover)
    const feishu = store.studio.addUser({ conversationId: assistant, requestId: 'om_prior', text: 'Preserved Feishu input', channel: 'feishu',
      createdAt: cutover + 1, feishu: { scope: 'prior-scope', id: 'om_prior' } }).message
    store.studio.addReply(feishu.id, 'Preserved Feishu reply')
    store.studio.finishMessage(feishu.id, 'completed')
    const outgoing = store.studio.nextFeishu('prior-scope')!
    expect(outgoing.parentId).toBe('om_prior')
    store.studio.finishFeishu(outgoing.id, 'om_prior_reply')
    const message = store.studio.addUser({ conversationId: project.id, requestId: 'prior-request', text: 'Preserved owner message', channel: 'gui' }).message
    store.studio.startMessage(message.id, 'old-leader')
    store.studio.recordMessageSource(message.id, { sessionId: 'old-leader', eventSeq: 1 })
    const task = store.registerTask({ projectId: project.id, requestText: message.text, requestId: message.id,
      sourceMessageId: studioOwnerMessageId(message.id), workspacePath: null, permission: 'read-only', requesterBotId: project.leaderBotId!,
      leader: { sessionId: 'old-leader', managementEpoch: 1 } })
    const execution = store.beginExecution(task.taskId, 'old-worker', 1, route)!
    expect(store.finishExecution(execution, { text: 'Preserved result', eventSeq: 4 }, 'delivered')).toBe(true)
    store.studio.finishMessage(message.id, 'completed')
    store.finishRun()
    return { projectId: project.id, id: message.id, taskId: task.taskId }
  } finally {
    store.close()
    using db = new DatabaseSync(path)
    db.exec('DROP TABLE studio_project_forward_notice; DROP TABLE studio_project_forward; ALTER TABLE studio_task DROP COLUMN source_session_id; PRAGMA user_version=1')
  }
}

function seedV0(db: DatabaseSync) {
  db.exec(readFileSync(new URL('./fixtures/studio-v0.sql', import.meta.url), 'utf8'))
  db.exec(`BEGIN;
    INSERT INTO studio_leader_bot VALUES ('old-bot');
    INSERT INTO studio_project VALUES ('old-project', 'Preserved project', 'Preserved objective', NULL, 1);
    INSERT INTO studio_project_binding VALUES ('old-leader', 'old-project', 'old-bot', 1, 'old-binding', '2026-11-28T00:00:00.000Z');
    INSERT INTO agent_studio_settings VALUES (1, 1, '${JSON.stringify(route)}', 'null');
    INSERT INTO agent_studio_feishu_binding VALUES (1, 'prior-scope', 3, ${cutover});
    INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, status, feishu_scope, feishu_id, feishu_generation)
      VALUES ('old-message', 'assistant', 'user', 'feishu', 'Preserved owner message', ${cutover + 1}, 'completed', 'prior-scope', 'om_old', 3);
    INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, reply_to)
      VALUES ('old-reply', 'assistant', 'assistant', 'studio', 'Preserved Feishu reply', ${cutover + 2}, 'old-message');
    INSERT INTO agent_studio_feishu_outbox (id, generation, kind, message_id, parent_message_id, state, remote_id)
      VALUES ('old-delivery', 3, 'message', 'old-reply', 'old-message', 'sent', 'om_old_reply');
    COMMIT;`)
  return { projectId: 'old-project', id: 'old-message', taskId: undefined }
}

describe('Studio Phase 3 SQLite migration', () => {
  it.each([0, 1])('upgrades a populated V%i ledger to V2 without losing published rows or changing the Feishu cutover', version => {
    const { path, cleanup } = directory()
    onTestFinished(cleanup)
    const ids = version === 1 ? seedV1(path) : undefined
    using db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    const { projectId, id, taskId } = ids ?? seedV0(db)
    const rows = (sql: string) => db.prepare(sql).all()
    const published = ['agent_studio_message', 'agent_studio_settings', 'agent_studio_feishu_binding', 'agent_studio_feishu_outbox']
    const readTables = (tables: readonly string[]) => tables.map(name => rows(`SELECT * FROM "${name}" ORDER BY rowid`))
    expect(rows('PRAGMA user_version')).toEqual([{ user_version: version }])
    expect(rows('PRAGMA table_info(studio_task)').some(column => column.name === 'source_session_id')).toBe(false)
    const before = readTables(published)
    let baseline: unknown
    for (let pass = 0; pass < 3; pass++) {
      const store = new ManagedWorkerStore(path)
      try {
        expect(store.recoveredTasks).toBe(0)
        expect(rows('PRAGMA user_version')).toEqual([{ user_version: 2 }])
        expect(readTables(published)).toEqual(before)
        expect(store.projects.get(projectId)).toMatchObject({ name: 'Preserved project', objective: 'Preserved objective',
          leaderSessionId: 'old-leader', managementEpoch: 1, ...(version === 0 && { readonlyLegacy: true }) })
        expect(store.studio.message(version === 0 ? assistant : projectId, id)?.text).toBe('Preserved owner message')
        expect(store.studio.settings({ assistant: null, leader: null })).toEqual({ revision: 1, assistant: route, leader: null })
        expect(store.studio.activateFeishu('prior-scope', cutover + 50)).toBe(cutover)
        if (taskId) expect(store.task(taskId)).toMatchObject({ status: 'delivered', resultSummary: 'Preserved result', sourceSessionId: 'old-leader' })
        const tables = rows("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map(({ name }) => String(name))
        for (const table of tables) expect(rows(`PRAGMA foreign_key_check("${table}")`), table).toEqual([])
        const snapshot = readTables(tables.filter(table => table !== 'studio_host_run'))
        if (pass === 0) baseline = snapshot
        else expect(snapshot).toEqual(baseline)
        store.finishRun()
      } finally { store.close() }
    }
  })
})

describe('Studio Phase 3 directory copy', () => {
  it.each([
    { label: 'a dangling V2 foreign key', sql: "INSERT INTO studio_project_forward_notice VALUES ('missing-forward', 'fixture')",
      error: /foreign key validation: studio_project_forward_notice/u },
    { label: 'an unsupported schema version', sql: 'PRAGMA user_version=1', error: /database copy user_version: 1/u },
    { label: 'only a dangling legacy foreign key', sql: 'CREATE TABLE legacy_parent (id TEXT PRIMARY KEY);'
      + 'CREATE TABLE legacy_child (id TEXT REFERENCES legacy_parent(id)); INSERT INTO legacy_child VALUES (\'missing\')' },
  ])('validates the actual backup before publishing its marker: $label', async ({ sql, error }) => {
    const { dir, cleanup } = directory()
    onTestFinished(cleanup)
    const from = join(dir, 'old'), target = join(dir, 'new')
    const path = join(from, STUDIO_DB)
    const store = new ManagedWorkerStore(path)
    try {
      store.finishRun()
      {
        using original = new DatabaseSync(path, { enableForeignKeyConstraints: false })
        original.exec(sql)
        expect(original.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
      }
      const change = new StudioDirectorySwitch(from, target, 'copy')
      if (error) {
        await expect(change.prepare(store)).rejects.toThrow(error)
        expect(existsSync(join(target, STUDIO_DB))).toBe(true)
        expect(existsSync(join(target, '.studio-directory'))).toBe(false)
        expect(() => confirmStudioDirectory(target, change.token)).toThrow()
      } else {
        await change.prepare(store)
        expect(() => confirmStudioDirectory(target, change.token)).not.toThrow()
      }
    } finally { store.close() }
  })
})

describe('Studio Phase 3 owner flows', () => {
  it('rejects an unnamed or ambiguous authenticated project target and accepts a unique complete name or ID', async () => {
    const f = fixture(), short = await f.project('A'), long = await f.project('A Pro'), chinese = await f.project('审计项目')
    const rejected = [
      { text: '请检查 Atlas 的进展。', target: short.id, code: 'PROJECT_TARGET_NOT_NAMED', message: /Do not forward/u },
      { text: '请 A Pro 汇报。', target: short.id, code: 'PROJECT_TARGET_NOT_NAMED', message: /exact name or ID/u },
      { text: '请 A 或者审计项目给出进展。', target: short.id, code: 'PROJECT_TARGET_AMBIGUOUS', message: /Ask the owner/u },
      { text: '请 A Pro 汇报，并检查 A 的进展。', target: long.id, code: 'PROJECT_TARGET_AMBIGUOUS', message: /Ask the owner/u },
    ]
    for (const { text, target, code, message } of rejected) {
      f.drive('assistant', text, async turn => {
        const attempt = turn.tool(FORWARD_PROJECT, { projectId: target })
        await expect(attempt).rejects.toMatchObject({ code, status: 409, message: expect.stringMatching(message) })
        if (code === 'PROJECT_TARGET_AMBIGUOUS') {
          const other = text.includes(chinese.name) ? chinese : long
          await expect(attempt).rejects.toMatchObject({ message: expect.stringContaining(`${short.name} (${short.id})`) })
          await expect(attempt).rejects.toMatchObject({ message: expect.stringContaining(`${other.name} (${other.id})`) })
        }
        turn.say('No project was forwarded')
      })
      const request = await f.send(text)
      await f.wait(async () => (await f.status(request.id)).messageStatus === 'completed')
      expect((await f.status(request.id)).forward).toBeNull()
      expect(f.readSql('SELECT forward_id FROM studio_project_forward')).toEqual([])
      expect(f.turn('leader', text)).toBeUndefined()
    }
    for (const [text, projectId] of [[`Please send to a pRO and report back.`, long.id], ['请审计项目给出进展。', chinese.id],
      [`请${short.id.toUpperCase()}给出进展。`, short.id]] as const) {
      f.drive('assistant', text, async turn => { await turn.tool(FORWARD_PROJECT, { projectId }) })
      const request = await f.send(text)
      await f.wait(async () => (await f.status(request.id)).forward?.status === 'delivered')
      expect((await f.status(request.id)).forward?.projectId).toBe(projectId)
    }
  })

  it.each(['before binding', 'previous binding', 'current binding'] as const)('keeps Web forwards in their own binding generation (%s)', async origin => {
    const f = fixture(), project = await f.project('Delivery Project')
    const scope = 'current-binding'
    if (origin !== 'before binding') f.service.feishu.activate(origin === 'current binding' ? scope : 'prior-binding', Date.now() - 1)
    const text = '请 Delivery Project 交付一句摘要。', result = '仅向原入口交付的项目结果'
    const release = Promise.withResolvers<void>()
    f.signal.addEventListener('abort', () => release.resolve(), { once: true })
    f.drive('assistant', text, async turn => { await turn.tool(FORWARD_PROJECT, { projectId: project.id }) })
    f.drive('leader', text, async turn => { await turn.tool(WORKER_DELEGATE, {}) })
    f.drive('worker', text, async turn => { await release.promise; turn.say(result) })
    const request = await f.send(text)
    await f.wait(async () => (await f.currentTask(request.id))?.status === 'running')
    expect(f.readSql("SELECT message_id FROM agent_studio_feishu_outbox WHERE kind = 'message' AND parent_message_id IS NULL"))
      .toEqual(origin === 'before binding' ? [] : [{ message_id: request.id }])
    if (origin !== 'current binding') f.service.feishu.activate(scope, Date.now())
    release.resolve()
    await f.wait(async () => (await f.status(request.id)).forward?.status === 'delivered')
    const replies = await f.replies(request.id)
    expect(replies).toHaveLength(2)
    expect(replies[1]?.text).toContain(result)
    if (origin === 'current binding') {
      const echo = f.service.feishu.next(scope)!
      expect(echo).toMatchObject({ channel: 'gui', text })
      f.service.feishu.finish(echo.id, 'om_web_original')
      for (const [index, reply] of replies.entries()) {
        const out = f.service.feishu.next(scope)!
        expect(out).toMatchObject({ parentId: 'om_web_original', text: reply.text })
        f.service.feishu.finish(out.id, `om_web_reply_${index}`)
      }
    } else {
      const generation = origin === 'before binding' ? 1 : 2
      expect(f.readSql(`SELECT id FROM agent_studio_feishu_outbox WHERE generation = ${generation}`)).toEqual([])
    }
    expect(f.service.feishu.next(scope)).toBeUndefined()
  })

  it.each(['gui', 'feishu'] as const)('verifies tool text and target, deduplicates input and returns only the final Leader reply to %s', async channel => {
    const f = fixture(), project = await f.project(), archived = await f.project('Archived target')
    const scope = 'leader-reply-fixture', remote = 'om_direct_leader'
    if (channel === 'feishu') f.service.feishu.activate(scope, cutover)
    await f.call('archiveProject', projectCoord(archived.id, 1))
    const text = '  请 Phase 3 project 给出简短进展。\n保持原样。  '
    const result = '最终项目回复'; const scratch = '不得出现在 Assistant 的 Leader 中间步骤'
    f.drive('assistant', text, async turn => {
      await expect(turn.tool(FORWARD_PROJECT, { projectId: project.id, request: text.trim() })).rejects.toMatchObject(expectError('EXPECTED_EXACT_OWNER_REQUEST'))
      await expect(turn.tool(FORWARD_PROJECT, { projectId: 'missing', request: text })).rejects.toMatchObject(expectError('PROJECT_NOT_FOUND', 404))
      await expect(turn.tool(FORWARD_PROJECT, { projectId: archived.id, request: text })).rejects.toMatchObject(expectError('PROJECT_ARCHIVED', 409))
      expect(f.readSql('SELECT forward_id FROM studio_project_forward')).toEqual([])
      await expect(turn.tool(FORWARD_PROJECT, { projectId: project.id, request: text })).resolves.toMatchObject({ text: expect.stringContaining(project.name) })
      await expect(turn.tool(FORWARD_PROJECT, { projectId: project.id, request: text })).rejects.toMatchObject(expectError('TASK_SOURCE_STALE', 409))
    })
    f.drive('leader', text, turn => { turn.say(scratch, true); turn.say('较早的可见项目回复'); turn.say(result) })
    const send = async () => {
      if (channel === 'gui') return (await f.send(text, assistant, 'web-forward')).id
      await f.service.feishu.receive({ scope, id: remote, text, sourceTimeMs: cutover + 1 }, f.signal)
      return f.domain.studio.feishuInput(scope, remote)!.id
    }
    const id = await send()
    await f.wait(async () => (await f.status(id)).forward?.status === 'delivered')
    expect(await send()).toBe(id)
    const { forward, tasks } = await f.status(id)
    expect(forward).toMatchObject({ projectId: project.id, status: 'delivered' }); expect(tasks).toEqual([])
    const stored = f.domain.studio.registerForward(id, project.id, 1, f.domain.projects.get(project.id)!.leaderSessionId!)
    expect(stored).toMatchObject({ created: false, forward: { forwardId: forward!.forwardId }, message: { id: forward!.projectMessageId, text } })
    expect(f.readSql('SELECT origin_message_id FROM studio_project_forward')).toEqual([{ origin_message_id: id }])
    expect((await f.call('timeline', { conversationId: project.id })).items.map(item => item.text)).toEqual([text, scratch, '较早的可见项目回复', result])
    const replies = await f.replies(id)
    expect(replies.map(item => item.text)).toEqual([expect.stringContaining(forward!.forwardId), expect.stringContaining(result)])
    expect(replies[1]?.text).not.toContain(scratch)
    if (channel === 'feishu') {
      for (const [index, reply] of replies.entries()) {
        const outgoing = f.service.feishu.next(scope)!
        expect(outgoing).toMatchObject({ kind: 'message', parentId: remote, text: reply.text })
        f.service.feishu.finish(outgoing.id, `om_direct_reply_${index}`)
      }
      expect(f.service.feishu.next(scope)).toBeUndefined()
    }
  })

  it.each(['gui', 'feishu'] as const)('returns one waiting approval and delivery for a forwarded task from %s, without internal steps', async channel => {
    const f = fixture(), project = await f.project('Phase 3 project', f.workspace)
    const scope = 'forward-fixture', remote = 'om_named_project'
    if (channel === 'feishu') f.service.feishu.activate(scope, cutover)
    const text = '把 Phase 3 project 的摘要登记为任务并允许发起写入确认。'
    const result = '可交付的任务结果', internal = '不得向原入口回传的项目工具步骤'
    f.drive('assistant', text, async turn => { await turn.tool(FORWARD_PROJECT, { projectId: project.id, request: text }) })
    f.drive('leader', text, async turn => {
      turn.say(internal, true)
      await turn.tool(WORKER_DELEGATE, { permission: 'workspace-write' })
    })
    f.drive('worker', text, turn => turn.say(result))
    const receive = () => f.service.feishu.receive({ id: remote, scope, sourceTimeMs: cutover + 1, text }, f.signal)
    const id = channel === 'gui' ? (await f.send(text, assistant, 'write-forward')).id
      : (await receive(), f.domain.studio.feishuInput(scope, remote)!.id)
    if (channel === 'feishu') await receive()
    await f.wait(async () => (await f.currentTask(id))?.status === 'waiting_approval')
    const waiting = (await f.currentTask(id))!
    const pending = (await f.call('pending', {})).items.find(item => item.taskId === waiting.taskId)!
    expect(await f.status(id)).toMatchObject({ accepted: true, forward: { status: 'delegated', projectId: project.id }, tasks: [{ taskId: waiting.taskId, status: 'waiting_approval' }] })
    expect((await f.replies(id)).map(item => item.text)).toEqual([expect.stringContaining('已受理登记'), expect.stringContaining(waiting.taskId)])
    expect(f.domain.notifyForwardTask(waiting.taskId)).toBe(false)
    if (channel === 'feishu') {
      const registration = f.service.feishu.next(scope)!
      expect(registration).toMatchObject({ kind: 'message', parentId: remote, text: expect.stringContaining('已受理登记') })
      f.service.feishu.finish(registration.id, 'om_accepted')
      const approval = f.service.feishu.next(scope)!
      expect(approval).toMatchObject({ kind: 'pending', pending: { id: pending.id, taskId: waiting.taskId, state: 'pending' } })
      f.service.feishu.finish(approval.id, 'om_write_card')
      expect(f.service.feishu.next(scope)).toBeUndefined()
      expect(f.service.feishu.answer({ scope, messageId: 'om_write_card', pendingId: pending.id, value: pending.options[0]! })).toBe(true)
    } else await f.call('answer', { id: pending.id, value: pending.options[0]! })
    await f.wait(async () => (await f.currentTask(id))?.status === 'delivered')
    const delivered = await f.status(id)
    expect(delivered).toMatchObject({ messageId: id, messageStatus: 'completed', forward: { status: 'delivered' }, tasks: [{ taskId: waiting.taskId, status: 'delivered' }] })
    expect(f.domain.notifyForwardTask(waiting.taskId)).toBe(false)
    expect((await f.replies(id)).map(item => item.text)).toEqual([expect.stringContaining('已受理登记'),
      expect.stringContaining(waiting.taskId), expect.stringContaining(result)])
    if (channel === 'feishu') {
      const update = f.service.feishu.next(scope)!
      expect(update).toMatchObject({ kind: 'pending-update', cardMessageId: 'om_write_card', pending: { state: 'resolved', answeredBy: 'feishu' } })
      f.service.feishu.finish(update.id, 'om_write_card')
      const output = f.service.feishu.next(scope)!
      expect(output).toMatchObject({ kind: 'message', parentId: remote, text: expect.stringContaining(result) })
      expect(output.text).not.toContain(internal)
      f.service.feishu.finish(output.id, 'om_delivered')
      expect(f.service.feishu.next(scope)).toBeUndefined()
    }
    expect((await f.call('tasks', { conversationId: project.id })).items).toHaveLength(1)
  })

  it('changes project metadata, fences old epoch work for rebind/unbind, Leader replacement and archive, then reopens', async () => {
    const f = fixture()
    let project = await f.project('Managed project', f.workspace)
    const { id } = project
    const first = f.domain.projects.get(id)!.leaderSessionId
    const coord = () => projectCoord(id, project.managementEpoch)
    expect(project).toMatchObject({ workspacePath: f.workspace, state: 'active', managementEpoch: 1 })
    project = await f.call('updateProject', { ...coord(), objective: 'Revised objective' })
    expect(project).toMatchObject({ objective: 'Revised objective', workspacePath: f.workspace, managementEpoch: 1 })
    for (const [name, mutate] of [
      ['rebind', () => f.call('updateProject', { ...coord(), workspacePath: f.nextWorkspace })],
      ['unbind', () => f.call('updateProject', { ...coord(), workspacePath: null })],
      ['replace', () => f.call('replaceProjectLeader', coord())],
      ['archive', () => f.call('archiveProject', coord())],
    ] as const) {
      const text = `In-flight project work before ${name}`
      const old = f.domain.projects.get(id)!
      const release = Promise.withResolvers<void>()
      const unblock = () => release.resolve()
      f.signal.addEventListener('abort', unblock, { once: true })
      f.drive('leader', text, async turn => {
        await turn.tool(WORKER_DELEGATE, {})
        await release.promise
        turn.say('Stale Leader must not publish')
      })
      const worker = Promise.withResolvers<void>()
      f.drive('worker', text, turn => new Promise<void>(resolve => {
        turn.signal.addEventListener('abort', () => resolve(), { once: true }); worker.resolve()
      }))
      const message = await f.send(text, id)
      await f.wait(() => f.turn('worker', text))
      await worker.promise
      const running = (await f.currentTask(message.id, id))!
      expect(running).toMatchObject({ status: 'running', authorizationVersion: 1 })
      expect(f.turn('leader', text)?.agent.id).toBe(old.leaderSessionId)
      await expect(f.call('updateProject', { ...projectCoord(id, old.managementEpoch + 1), objective: 'stale' }))
        .rejects.toMatchObject(expectError('PROJECT_EPOCH_CONFLICT', 409))
      try {
        project = await mutate()
        expect(project.managementEpoch).toBe(old.managementEpoch + 1)
        expect(await f.call('task', { taskId: running.taskId })).toMatchObject({ status: 'interrupted', authorizationVersion: 2, resultSummary: null })
        expect((await f.status(message.id, id)).messageStatus).toBe('interrupted')
        expect(f.service.sessions.activeLeader(f.turn('leader', text)!.agent)).toBeUndefined()
        expect(f.service.sessions.canAsk(f.turn('leader', text)!.agent)).toBe(false)
        await expect(f.turn('leader', text)!.tool(WORKER_DELEGATE, {})).rejects.toMatchObject(expectError('EXPECTED_EXACT_OWNER_REQUEST'))
        if (name === 'rebind') expect(project.workspacePath).toBe(f.nextWorkspace)
        if (name === 'unbind') expect(project.workspacePath).toBeNull()
        if (name === 'replace' || name === 'archive') expect(f.domain.projects.currentLeader(old.leaderSessionId!)).toBeUndefined()
      } finally { f.signal.removeEventListener('abort', unblock); unblock() }
      await f.wait(() => !f.service.sessions.busy)
      expect((await f.replies(message.id, id)).map(item => item.text)).not.toContain('Stale Leader must not publish')
    }
    expect(f.domain.projects.currentLeader(first!)).toBeUndefined()
    expect((await f.call('state', {})).archivedProjects).toEqual([project])
    await expect(f.send('No work in archive', id)).rejects.toMatchObject(expectError('PROJECT_ARCHIVED', 409))
    await expect(f.call('reopenProject', projectCoord(id, project.managementEpoch - 1))).rejects.toMatchObject(expectError('PROJECT_EPOCH_CONFLICT', 409))
    const reopened = await f.call('reopenProject', coord())
    expect(reopened).toMatchObject({ id, state: 'active', managementEpoch: project.managementEpoch + 1, workspacePath: null })
    const input = await f.send('Work after reopen', id)
    await f.wait(async () => (await f.status(input.id, id)).messageStatus === 'completed')
    expect((await f.replies(input.id, id)).map(item => item.text)).toEqual(['Offline leader result: Work after reopen'])
  })

  it('shows write confirmations in the task ledger and stops exactly one parallel task', async () => {
    const f = fixture()
    const run = (key: string) => {
      const text = `Task ${key} in ${JSON.stringify(f.workspace)}`
      f.drive('assistant', text, async turn => { await turn.tool(WORKER_DELEGATE, { permission: 'workspace-write', workspacePath: f.workspace }) })
      return f.send(text)
    }
    const [a, b] = await Promise.all([run('A'), run('B')])
    await f.wait(async () => (await f.currentTask(a.id))?.status === 'waiting_approval' && (await f.currentTask(b.id))?.status === 'waiting_approval')
    const taskA = (await f.currentTask(a.id))!, taskB = (await f.currentTask(b.id))!
    const pending = (await f.call('pending', {})).items
    const itemA = pending.find(item => item.taskId === taskA.taskId)!, itemB = pending.find(item => item.taskId === taskB.taskId)!
    expect(taskA.workerSessionId).toBeNull(); expect(taskB.workerSessionId).toBeNull()
    expect((await f.call('tasks', { conversationId: assistant, scope: 'active', status: 'waiting_approval' })).items.map(item => item.taskId).sort())
      .toEqual([taskA.taskId, taskB.taskId].sort())
    expect(await f.call('stopTask', { taskId: taskA.taskId })).toMatchObject({ status: 'cancelled', authorizationVersion: 2 })
    expect((await f.call('pending', {})).items).toEqual(expect.arrayContaining([expect.objectContaining({ id: itemA.id, state: 'expired' }), itemB]))
    await expect(f.call('answer', { id: itemA.id, value: itemA.options[0]! })).rejects.toMatchObject(expectError('QUESTION_EXPIRED', 409))
    expect(await f.call('task', { taskId: taskB.taskId })).toEqual(taskB)
    await f.call('answer', { id: itemB.id, value: itemB.options[0]! })
    await f.wait(async () => (await f.currentTask(b.id))?.status === 'delivered')
    expect((await f.currentTask(a.id))?.status).toBe('cancelled')
    expect(f.turn('worker', a.text)).toBeUndefined()
    expect(f.turn('worker', b.text)).toBeDefined()
  })

  it('checks verified Feishu receipts and deduplicates manual resubmission, and handles exact owner queries without another model turn', async () => {
    const f = fixture()
    const text = 'Recover this exact post-cutover request', good = 'om_valid', early = 'om_early', boundary = 'om_boundary', bad = 'om_bad'
    const lookup = vi.fn(async (messageId: string) => ({ message_id: messageId, chat_id: binding.chatId,
      create_time: String(messageId === early ? cutover - 1 : messageId === boundary ? cutover : cutover + 1),
      msg_type: 'text', body: { content: JSON.stringify({ text }) },
      sender: { id_type: 'open_id', id: messageId === bad ? 'ou_another' : binding.ownerOpenId, sender_type: 'user' } }))
    const transport = new StudioFeishuConversation({ botOpenId: async () => binding.botOpenId, getMessage: lookup } as unknown as StudioFeishuSdk,
      binding, f.service.feishu, () => true, noop)
    f.service.bindFeishuLookup(transport)
    await expect(f.call('feishuMessageStatus', { messageId: good })).rejects.toMatchObject(expectError('FEISHU_LOOKUP_UNAVAILABLE', 503))
    f.service.feishu.activate(transport.scope, cutover)
    f.drive('assistant', text, async turn => { await turn.tool(WORKER_DELEGATE, {}) })
    const hold = Promise.withResolvers<void>()
    f.drive('worker', text, turn => new Promise<void>(resolve => {
      turn.signal.addEventListener('abort', () => resolve(), { once: true }); hold.resolve()
    }))
    expect(await f.call('feishuMessageStatus', { messageId: good })).toEqual({ feishuMessageId: good, accepted: false, messageId: null,
      messageStatus: null, forward: null, tasks: [] })
    for (const messageId of [early, boundary, bad]) {
      await expect(f.call('feishuMessageStatus', { messageId })).rejects.toMatchObject(expectError('FEISHU_MESSAGE_UNVERIFIED', 422))
      await expect(f.call('resubmitFeishuMessage', { messageId })).rejects.toMatchObject(expectError('FEISHU_MESSAGE_UNVERIFIED', 422))
    }
    const [first, replay] = await Promise.all([f.call('resubmitFeishuMessage', { messageId: good }), f.call('resubmitFeishuMessage', { messageId: good })])
    expect(first).toMatchObject({ accepted: true, feishuMessageId: good, messageId: expect.any(String) })
    expect(replay.messageId).toBe(first.messageId)
    const id = first.messageId!
    await f.wait(async () => (await f.currentTask(id))?.status === 'running')
    await hold.promise
    await f.wait(async () => (await f.status(id)).messageStatus === 'completed')
    const status = await f.status(id), { taskId } = status.tasks[0]!
    expect(await f.call('feishuMessageStatus', { messageId: good })).toEqual({ feishuMessageId: good, ...status })
    expect(await f.call('resubmitFeishuMessage', { messageId: good })).toEqual({ feishuMessageId: good, ...status })
    expect((await f.call('tasks', {})).items.map(item => item.taskId)).toEqual([taskId])
    expect(f.readSql('SELECT task_id FROM studio_task_execution')).toEqual([{ task_id: taskId }])
    expect(f.readSql("SELECT id FROM agent_studio_message WHERE role = 'user'")).toEqual([{ id }])
    await expect(f.call('messageStatus', { conversationId: assistant, id: 'unknown' })).rejects.toMatchObject(expectError('MESSAGE_NOT_FOUND', 404))
    for (const [query, expected] of [[`查询受理 ${id}`, '已受理登记'], ['最近任务', taskId], [`查询任务 ${taskId}`, taskId], [`停止任务 ${taskId}`, '已停止任务']]) {
      const receipt = await f.send(query!)
      expect((await f.replies(receipt.id)).map(item => item.text)).toEqual([expect.stringContaining(expected!)])
      expect(f.turn('assistant', query!)).toBeUndefined()
    }
    expect((await f.currentTask(id))?.status).toBe('cancelled')
    const query = `查询受理 ${good}`
    await f.service.feishu.receive({ scope: transport.scope, id: 'om_query', sourceTimeMs: cutover + 2, text: query }, f.signal)
    const source = f.domain.studio.feishuInput(transport.scope, 'om_query')!
    await f.wait(async () => (await f.replies(source.id))[0]?.text.includes(taskId))
    expect(f.turn('assistant', query)).toBeUndefined()
    expect(lookup.mock.calls.map(([id]) => id).filter(id => id === good)).toHaveLength(3)
  })

  it('never records, executes or queues reserved Feishu messages or control text through manual submission', async () => {
    const f = fixture()
    const request = f.domain.registerTask({ projectId: null, requestId: 'guard-fixture', sourceMessageId: 'original-guard-message',
      requestText: 'Original guarded work', requesterBotId: f.domain.assistantBotId, workspacePath: null, permission: 'read-only' })
    const execution = f.domain.beginExecution(request.taskId, 'guarded-worker', null, route)!
    const guard = f.domain.recordGuardInterception(execution, { code: 'STUDIO_READ_ONLY_VIOLATION', reason: 'Fixture denial', needsOwnerDecision: true }, 'fixture', 'Write')
    expect(guard.pendingId).toMatch(/^guard-intercept:/u)
    const guardText = `仅解除等待 ${guard.pendingId}`
    const cases = new Map(Object.entries({
      om_check: '/studio-feishu-check 11111111-1111-4111-8111-111111111111', om_clear: guardText,
      om_cancel: `取消任务 ${guard.pendingId}`, om_approve: `批准 ${request.taskId}`, om_decline: '拒绝这项',
      om_lookup: '查询受理 om_other', om_recent: '最近任务', om_status: `查询任务 ${request.taskId}`,
      om_stop: `停止任务 ${request.taskId}`, om_submit: '补交消息 om_other', om_pending: '待我处理',
      om_decisions: '查询确认结果', om_projects: '列出项目', om_active: '正在处理什么任务',
      om_unblock: `解除阻塞 ${request.taskId}: fixed`,
    }))
    const sourceTimeMs = Date.now() + 1
    const sdk = { botOpenId: async () => binding.botOpenId, getMessage: async (messageId: string) => ({
      message_id: messageId, chat_id: binding.chatId, create_time: String(sourceTimeMs),
      msg_type: 'text', body: { content: JSON.stringify({ text: cases.get(messageId) }) },
      sender: { id_type: 'open_id', id: binding.ownerOpenId, sender_type: 'user' },
    }) } as unknown as StudioFeishuSdk
    const transport = new StudioFeishuConversation(sdk, binding, f.service.feishu, () => true, noop)
    f.service.bindFeishuLookup(transport)
    f.service.feishu.activate(transport.scope, cutover)
    const task = f.domain.task(request.taskId), pending = f.domain.studio.pendingItem(guard.pendingId!)
    const executions = f.readSql('SELECT * FROM studio_task_execution')
    for (const [messageId, text] of cases) {
      await expect(f.call('resubmitFeishuMessage', { messageId })).rejects.toMatchObject(expectError('FEISHU_RECOVERY_CONTROL_UNSUPPORTED', 409))
      expect(f.turn('assistant', text)).toBeUndefined()
    }
    expect(f.domain.task(request.taskId)).toEqual(expect.objectContaining({ ...task, status: 'waiting_approval' }))
    expect(f.domain.studio.pendingItem(guard.pendingId!)).toEqual(expect.objectContaining({ ...pending, state: 'pending' }))
    expect(f.readSql('SELECT id FROM agent_studio_message')).toEqual([])
    expect(f.readSql('SELECT * FROM studio_task_execution')).toEqual(executions)
    expect(f.service.sessions.busy).toBe(false)
    await f.service.feishu.receive({ id: 'om_check', text: cases.get('om_check')!, scope: transport.scope, sourceTimeMs }, f.signal)
    expect(f.domain.studio.feishuInput(transport.scope, 'om_check')).toBeUndefined()
    await f.service.feishu.receive({ id: 'om_clear', text: guardText, scope: transport.scope, sourceTimeMs }, f.signal)
    expect(f.domain.task(request.taskId)?.status).toBe('interrupted')
    expect(f.domain.studio.pendingItem(guard.pendingId!)).toMatchObject({ state: 'resolved', answeredBy: 'feishu' })
    expect(f.turn('assistant', guardText)).toBeUndefined()
    await expect(f.call('resubmitFeishuMessage', { messageId: 'om_clear' })).rejects.toMatchObject(expectError('FEISHU_RECOVERY_CONTROL_UNSUPPORTED', 409))
  })

  it('bounds the real system prompt background across scopes, preferring newer entries and marking omissions', async () => {
    const f = fixture(), project = await f.project()
    const long = '"\\\r😀'.repeat(780)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(cutover + 1)
      for (let i = 0; i < 205; i++) await f.call('savePreference', { key: `a-old-${i}`, text: long })
      await f.call('savePreference', { projectId: project.id, key: 'a-old-project', text: long })
      vi.setSystemTime(cutover + 2)
      await f.call('updateProjectArchive', { projectId: project.id, decisions: `recent-archive:${long}${long}`, progress: 'archive-progress' })
      vi.setSystemTime(cutover + 3)
      await f.call('savePreference', { key: 'z-latest-global', text: `recent-global:${long}` })
      await f.call('savePreference', { projectId: project.id, key: 'z-latest-project', text: `recent-project:${long}` })
    } finally { vi.useRealTimers() }
    for (const [role, room] of [['assistant', assistant], ['leader', project.id]] as const) {
      const text = `Probe bounded ${role} prompt`
      let prompt = ''
      f.drive(role, text, turn => { prompt = turn.prompt(); turn.say('Context recorded') })
      const message = await f.send(text, room)
      await f.wait(async () => (await f.status(message.id, room)).messageStatus === 'completed')
      const background = prompt.split('\n\n').at(-1)!
      expect(background.length).toBeLessThanOrEqual(12_000)
      expect(background).toContain('reference background and collaboration preferences only')
      expect(background).toContain('never replaces Host tool authorization, workspace/path boundaries, or owner confirmation')
      const data = JSON.parse(background.split('\n').at(-1)!)
      const global = data.globalPreferences[0], archived = role === 'leader' ? Object.values({ decisions: data.project.decisions, progress: data.project.progress }).filter(Boolean).length : 0
      const allItems = role === 'leader' ? 210 : 206
      expect(data.omittedEntries).toBe(allItems - data.globalPreferences.length - (data.projectPreferences?.length ?? 0) - archived)
      expect(data.omittedEntries).toBeGreaterThan(0)
      expect(data.truncatedEntries).toBeGreaterThan(0)
      expect(global.key).toBe('z-latest-global')
      const excerpts: string[] = [global.text]
      if (role === 'leader') {
        expect(data.projectPreferences[0].key).toBe('z-latest-project')
        expect(data.project.decisions).toMatch(/^recent-archive:/u)
        excerpts.push(data.projectPreferences[0].text, data.project.decisions)
      } else expect(background).not.toMatch(/recent-archive|z-latest-project/u)
      for (const value of excerpts) {
        expect(value.endsWith('…') && value.isWellFormed()).toBe(true)
        expect(JSON.stringify(value).length).toBeLessThanOrEqual(2_000)
      }
    }
  })

  it('applies archive and preference CRUD/CAS and injects only active data in each role’s dynamic system prompt', async () => {
    const f = fixture(), project = await f.project(), other = await f.project('Separate project')
    const projectId = project.id
    expect(await f.call('projectArchive', { projectId })).toEqual({ projectId, decisions: '', progress: '', openIssues: '', updatedAt: null, readonly: false })
    const fields = { decisions: 'Keep local evidence', progress: 'Reviewed source', openIssues: 'Check remaining units' }
    await f.call('updateProjectArchive', { projectId, decisions: fields.decisions })
    const archive = await f.call('updateProjectArchive', { projectId, progress: fields.progress, openIssues: fields.openIssues })
    expect(archive).toMatchObject({ ...fields, readonly: false })
    await f.call('updateProjectArchive', { projectId: other.id, decisions: 'other-private-archive' })
    const global = await f.call('savePreference', { key: 'format', text: 'global-old-format' })
    const newGlobal = await f.call('updatePreference', { key: global.key, expectedVersion: global.version, text: 'global-current-format' })
    expect(newGlobal).toMatchObject({ preferenceId: global.preferenceId, version: 2 })
    await expect(f.call('updatePreference', { key: global.key, expectedVersion: 1, text: 'stale' })).rejects.toMatchObject(expectError('PREFERENCE_CONFLICT', 409))
    const own = await f.call('savePreference', { projectId, key: global.key, text: 'only-own-preference' })
    await f.call('savePreference', { projectId: other.id, key: global.key, text: 'other-private-preference' })
    const forgotten = await f.call('savePreference', { projectId, key: 'forgotten-tombstone', text: 'forgotten-private-value' })
    await expect(f.call('forgetPreference', { projectId, key: forgotten.key, expectedVersion: 2 })).rejects.toMatchObject(expectError('PREFERENCE_CONFLICT', 409))
    expect(await f.call('forgetPreference', { projectId, key: forgotten.key, expectedVersion: 1 }))
      .toMatchObject({ preferenceId: forgotten.preferenceId, version: 2, text: '', state: 'forgotten' })
    expect(await f.call('preferences', {})).toEqual([newGlobal])
    expect(await f.call('preferences', { projectId })).toEqual([own])
    const markers = new Map<string, string>()
    const probe = async (role: 'assistant' | 'leader', room: string, text: string) => {
      f.drive(role, text, turn => { markers.set(text, turn.prompt()); turn.say('Context recorded') })
      const message = await f.send(text, room)
      await f.wait(async () => (await f.status(message.id, room)).messageStatus === 'completed')
      const system = markers.get(text)!
      for (const denied of ['global-old-format', 'other-private-preference', 'other-private-archive', 'forgotten-tombstone', 'forgotten-private-value']) {
        expect(system).not.toContain(denied)
      }
      return JSON.parse(system.split('\n').at(-1)!) as unknown
    }
    const globalPreferences = [{ key: newGlobal.key, text: newGlobal.text }]
    expect(await probe('assistant', assistant, 'Read Assistant prompt')).toEqual({ globalPreferences })
    expect(await probe('leader', projectId, 'Read Leader prompt')).toEqual({ globalPreferences,
      project: { name: project.name, objective: project.objective, workspacePath: null, ...fields }, projectPreferences: [{ key: own.key, text: own.text }] })
    await f.call('archiveProject', projectCoord(projectId, 1))
    expect(await f.call('projectArchive', { projectId })).toEqual({ ...archive, readonly: true })
    await expect(f.call('updateProjectArchive', { projectId, decisions: 'Cannot overwrite' })).rejects.toMatchObject(expectError('PROJECT_ARCHIVED', 409))
    await expect(f.call('updatePreference', { projectId, key: own.key, expectedVersion: own.version, text: 'Cannot overwrite' }))
      .rejects.toMatchObject(expectError('PROJECT_ARCHIVED', 409))
    expect(await f.call('preferences', { projectId })).toEqual([own])
  })
})
