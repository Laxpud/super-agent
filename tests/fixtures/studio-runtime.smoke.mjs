// 使用当前安装的 rc.5 验证 Studio 的真实 Web 授权、Session 生命周期和合成模型流程。
// 启动单独的进程：env -i PATH=/usr/bin:/bin HOME="$HOME" DSH_INSTALL_DIR="$DSH_INSTALL_DIR" "$DSH_NODE_EXECUTABLE" tests/fixtures/studio-runtime.smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const install = process.env.DSH_INSTALL_DIR
assert.ok(install && isAbsolute(install), 'Set DSH_INSTALL_DIR to the installed CLI package directory.')
const anchored = createRequire(join(install, 'package.json'))
assert.equal(anchored(join(install, 'package.json')).version, '0.2.2-rc.5')
const src = fileURLToPath(new URL('../../', import.meta.url))
const tempParent = realpathSync('/tmp')
const prefix = join(tempParent, 'studio-runtime-')
const fixture = mkdtempSync(prefix)
const originalCwd = process.cwd()
const provider = 'studio-smoke-offline'
const model = 'smoke-default'
const assistantModel = 'smoke-assistant'
const leaderModel = 'smoke-leader'
const low = 'smoke-low'
const high = 'smoke-high'
const efforts = [{ id: low, name: 'Fixture low' }, { id: high, name: 'Fixture high' }]
const plans = [
  { name: 'Offline Smoke Alpha', objective: 'Exercise the first passive Leader binding.',
    intent: 'Please create an ongoing project named Offline Smoke Alpha for testing Studio.',
    first: 'Offline alpha-89: keep this detail only in this project.',
    next: 'Offline alpha-89: follow up in the original project.' },
  { name: 'Offline Smoke Beta', objective: 'Exercise a separate passive Leader binding.',
    intent: 'Please create an ongoing project named Offline Smoke Beta for testing Studio.',
    first: 'Offline beta-16: keep this different detail only in this project.' },
]
const greeting = 'Offline smoke: confirm the Studio timeline can preserve this text.'
const replies = { greeting: 'Offline Studio fixture reply.', confirm: 'Offline Studio project decision recorded.' }
const conversationId = 'assistant'
const taskRequest = 'Write one sentence using the name Alpine and two details: blue door, late bus.'
const taskResult = 'Alpine saw the blue door and took the late bus.'
const readRequest = 'Read the exact saved result from the offline Worker task.'
let knownTaskId
const calls = []
const workspacePlans = new Map()
const workspaceReadbacks = new Map()
const nativeResults = new Map()
let runtime
let origin
let cookie
const actualFetch = globalThis.fetch.bind(globalThis)

// 限定 HTTP 调用只到本轮绑定的地址；离线 adapter 本身不做 I/O。
globalThis.fetch = (url, init) => {
  const target = new URL(typeof url === 'object' && 'url' in url ? url.url : String(url))
  if (target.origin !== origin) throw new Error('Unexpected outbound HTTP request from the offline fixture')
  return actualFetch(url, init)
}

async function checkStatus(response, expected, label) {
  assert.equal(response.status, expected, label)
  return response
}

function selectCookie(response) {
  const [header] = response.headers.getSetCookie()
  assert.ok(header && /;\s*HttpOnly\b/iu.test(header), 'Native DSH issued an HttpOnly cookie')
  return header.split(';', 1)[0]
}

async function post(op, input, { auth = cookie, marker = true, from = origin, expected = 200 } = {}) {
  const response = await checkStatus(await fetch(`${origin}/agent-studio/api`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: from,
      ...(marker ? { 'x-agent-studio-request': '1' } : {}), ...(auth ? { cookie: auth } : {}) },
    body: JSON.stringify({ op, input }), signal: AbortSignal.timeout(5_000),
  }), expected, `Studio ${op} HTTP status`)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response.json()
}

async function until(label, fn) {
  const deadline = Date.now() + 9_000
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await pause(35)
  }
  throw new Error(`Waited too long for ${label}`)
}

async function completed(id, room = conversationId) {
  return until('Studio message completion', async () => {
    const value = await post('message', { conversationId: room, id })
    if (['failed', 'interrupted'].includes(value.status)) throw new Error(`Native Studio turn ended ${value.status}: ${value.error}`)
    return value.status === 'completed' ? value : undefined
  })
}

const invoke = (id, text, room = conversationId) => post('send', { conversationId: room, requestId: id, text })
const textBlock = text => ({ type: 'text', text })

try {
  process.env.DSH_HOME = join(fixture, 'dsh')
  process.env.DSH_TELEMETRY_DISABLED = '1'
  // 子进程只运行自带的检查脚本；为精简 env 提供当前 Node 发行版的 npm，并禁止 npm 联网。
  process.env.PATH = [dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(delimiter)
  process.env.npm_config_offline = 'true'
  process.env.npm_config_cache = join(fixture, 'npm-cache')
  process.env.npm_config_userconfig = join(fixture, 'npmrc')
  const workspace = join(fixture, 'workspace')
  mkdirSync(workspace)
  process.chdir(workspace)
  const patch = join(fixture, 'offline.patch.json')
  const disabled = ['agent-studio', 'agent-studio-github', 'agent-studio-feishu', 'agent-studio-worker-preset',
    'agent-studio-router-preset', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account',
    'plugin-package-inventory-deepseek', 'web-search-deepseek', 'web-deepseek-api', 'session-title-llm']
  writeFileSync(patch, JSON.stringify([
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
    { id: 'agent-default-model', config: { provider, model } },
    { id: 'agent-studio-managed-worker', disabled: false, config: { stateDir: join(fixture, 'studio'), studioCwd: workspace } },
    ...['agent-studio-managed-worker-preset', 'agent-studio-assistant-preset', 'agent-studio-leader-preset']
      .map(id => ({ id, disabled: false })),
  ]))
  const load = name => import(pathToFileURL(anchored.resolve(name)).href)
  const { runProfile } = await load('@deepseek-ai/dsh/profile-boot')
  const { createLaunchEnvironmentSnapshot } = await load('@deepseek-ai/dsh-launch-environment')
  const { LlmAdapter } = await load('@deepseek-ai/dsh-llm')
  runtime = await runProfile({ profile: 'web', patchFiles: [resolve(src, 'cordis.patch.yml'), patch],
    args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], environment: createLaunchEnvironmentSnapshot([]) })
  const { ctx } = runtime
  assert.ok(ctx.connection && ctx.webServer && ctx.llm && ctx.agents && ctx.sessionQuery, 'Installed Host services are ready')
  origin = ctx.webServer.getOrigin()
  assert.equal(new URL(origin).hostname, '127.0.0.1')
  assert.notEqual(new URL(origin).port, '3082', 'The fixture must not use the active GUI port')
  assert.deepEqual(ctx.llm.listProviders(), [], 'No real provider may be mounted')
  process.stdout.write('OK isolated installed rc.5 Host and empty provider registry\n')

  // 返回固定的普通对话回复，或只对本轮明确的合成原话发出一次提案工具调用。
  const proposed = new Set()
  const contentText = message => message.content.filter(block => block.type === 'text').map(block => block.text)
  const plannedMessages = plans.flatMap(({ first, next }) => [first, ...(next ? [next] : [])])
  let readResult = false
  /** 离线适配器仅响应合成输入，不接触 Studio 之外的服务。 */
  class OfflineAdapter extends LlmAdapter {
    listModels(id) {
      assert.equal(id, provider)
      return Promise.resolve([model, assistantModel, leaderModel].map(id => ({ id, name: id, provider, inputModalities: ['text'] })))
    }
    async resolveModel(id, name) {
      assert.equal(id, provider)
      assert.ok([model, assistantModel, leaderModel].includes(name))
      return { id: name, name, provider, inputModalities: ['text'], context: { contextWindow: 65_536 }, defaultMaxTokens: 4_096,
        reasoning: { efforts } }
    }
    async * stream(options) {
      options.signal?.throwIfAborted()
      assert.equal(options.provider, provider)
      const texts = options.messages.filter(message => message.role === 'user').flatMap(contentText)
      const contextText = options.messages.flatMap(contentText).join('\n')
      const tools = options.tools?.map(tool => tool.name) ?? []
      calls.push({ model: options.model, reasoningEffort: options.reasoningEffort, texts, contextText, tools })
      const newest = texts.findLast(text => plans.some(plan => plan.intent === text) || plannedMessages.includes(text)
        || text === greeting || text === taskRequest || text === readRequest)
      const proposal = plans.find(plan => plan.intent === newest)
      const local = options.messages.filter(message => message.role === 'user').findLast(message =>
        contentText(message).some(text => workspacePlans.has(text)))
      const localPlan = local && workspacePlans.get(contentText(local)[0])
      let block
      if (localPlan) {
        const isWorker = local.source?.kind === 'agent-studio'
        const steps = isWorker ? localPlan.worker : localPlan.frontend
        const done = options.messages.flatMap(message => message.content).filter(item => item.type === 'tool-call' &&
          item.id.startsWith(`offline-local-${localPlan.id}-${isWorker ? 'worker' : 'front'}-`)).length
        if (done < steps.length) {
          const [name, args] = steps[done]
          assert.ok(tools.includes(name), `The native ${isWorker ? 'Worker' : 'frontend'} exposes ${name}`)
          block = { type: 'tool-call', id: `offline-local-${localPlan.id}-${isWorker ? 'worker' : 'front'}-${done}`, name,
            arguments: JSON.stringify(args) }
        } else {
          if (isWorker && localPlan.observe) localPlan.observe(contextText)
          if (localPlan.capture) workspaceReadbacks.set(localPlan.id, contextText)
          block = textBlock(isWorker ? localPlan.result : 'Offline local workspace request recorded.')
        }
      } else if (newest === taskRequest) {
        if (tools.length) {
          assert.ok(tools.includes('studio_delegate_task'))
          block = { type: 'tool-call', id: 'offline-delegate-call', name: 'studio_delegate_task', arguments: '{}' }
        } else {
          // rc.5 可由宿主附加时间上下文，与原生运行时快照一样不属于 Worker 收到的业务请求。
          const inputs = options.messages.filter(message => message.role === 'user' && message.source?.kind !== 'time-context'
            && !(message.source?.kind === 'runtime-context' && message.source.form === 'snapshot'))
          assert.deepEqual(inputs.map(message => [message.source?.kind, contentText(message)]), [['agent-studio', [taskRequest]]],
            'The Worker receives exactly its assigned business input alongside required native runtime context')
          assert.ok(!contextText.includes(greeting), 'The Worker receives no Assistant history')
          block = textBlock(taskResult)
        }
      } else if (newest === readRequest && !readResult) {
        assert.ok(tools.includes('studio_read_task'))
        readResult = true
        block = { type: 'tool-call', id: 'offline-read-call', name: 'studio_read_task', arguments: JSON.stringify({ taskId: knownTaskId }) }
      } else if (proposal && !proposed.has(proposal.name)) {
        assert.ok(options.tools?.some(tool => tool.name === 'studio_propose_project'), 'Native Assistant exposes the Studio proposal tool')
        proposed.add(proposal.name)
        block = { type: 'tool-call', id: `offline-project-${proposed.size}`, name: 'studio_propose_project',
          arguments: JSON.stringify({ name: proposal.name, objective: proposal.objective, intentQuote: proposal.intent }) }
      } else if (plannedMessages.includes(newest)) {
        block = textBlock(`Offline Leader heard: ${newest}`)
      } else {
        block = textBlock(proposal ? replies.confirm : replies.greeting)
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new OfflineAdapter())

  // 只在内存使用本轮 listener 的启动认证；不输出 token、cookie、响应头或别的 Host URL。
  await checkStatus(await fetch(`${origin}/`, { signal: AbortSignal.timeout(5_000) }), 401, 'Unauthenticated index')
  await post('state', {}, { expected: 401 })
  cookie = selectCookie(await checkStatus(await fetch(ctx.connection.authenticatedUrl(`${origin}/`),
    { redirect: 'manual', signal: AbortSignal.timeout(5_000) }), 303, 'Native owner login'))
  await post('state', {}, { marker: false, expected: 403 })
  await post('state', {}, { from: 'http://other.invalid', expected: 403 })
  const signedAt = cookie.indexOf('=') + 1
  const tampered = cookie.slice(0, signedAt) + (cookie[signedAt] === 'A' ? 'B' : 'A') + cookie.slice(signedAt + 1)
  await post('state', {}, { auth: tampered, expected: 401 })
  const authUrl = new URL(ctx.connection.authenticatedUrl(`${origin}/`))
  authUrl.pathname = '/connect'
  const apiCookie = selectCookie(await checkStatus(await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(5_000) }), 302,
    'Native API operator login'))
  await post('state', {}, { auth: apiCookie, expected: 403 })
  const page = await checkStatus(await fetch(`${origin}/`, { headers: { cookie }, signal: AbortSignal.timeout(5_000) }), 200, 'Authenticated Web shell')
  assert.ok((await page.text()).includes('agent-studio-web'), 'The authenticated shell advertises the Studio Client')
  const studioBundle = ctx.clientModules.graph().entries.find(entry => entry.id === 'agent-studio-web')
  assert.ok(studioBundle?.url, 'The mounted Studio Host contributes its built Client')
  const bundle = await checkStatus(await fetch(new URL(studioBundle.url, `${origin}/`), { headers: { cookie }, signal: AbortSignal.timeout(5_000) }),
    200, 'Studio Client bundle')
  assert.ok((await bundle.text()).includes('sidebar.panellist'), 'The delivered script registers the Studio sidebar entry')
  const initial = await post('state', {})
  assert.deepEqual(initial.projects, [])
  assert.equal(initial.pendingCount, 0)
  assert.equal(initial.feishu, 'disabled')
  assert.equal(initial.settings.assistant, null)
  assert.deepEqual((await post('models', {})).map(item => [item.model, item.reasoningEfforts]),
    [model, assistantModel, leaderModel].map(id => [id, [low, high]]))
  assert.deepEqual((await post('records', {})).items, [])
  assert.deepEqual(await post('tasks', {}), { items: [] })
  const configuration = await post('configuration', {})
  assert.equal(configuration.config.defaultWorkerPermission, 'read-only')
  assert.deepEqual(configuration.config.feishu, { mode: 'disabled' })
  process.stdout.write('OK signed browser cookie, CSRF/origin gate, separate API Peer rejection, initial state/catalog\n')

  const submitted = await invoke('smoke-request-1', greeting)
  const input = await completed(submitted.id)
  assert.ok(input.source, 'Studio saved exact native source coordinates')
  const { sessionId, eventSeq } = input.source
  await until('native Assistant teardown', () => !ctx.agents.get(sessionId))
  assert.deepEqual(calls.map(call => call.model), [model])
  assert.ok(calls[0].texts.includes(greeting))
  const timeline = await post('timeline', { conversationId })
  const reply = timeline.items.find(item => item.text === replies.greeting)
  assert.equal(reply?.source?.sessionId, sessionId)
  const results = await post('records', {})
  assert.equal(results.items.find(item => item.id === sessionId)?.role, 'assistant')
  const detail = await post('record', { sessionId })
  assert.equal(detail.events.find(event => event.seq === eventSeq)?.text, greeting)
  assert.equal(detail.events.find(event => event.seq === reply.source.eventSeq)?.text, replies.greeting)
  assert.ok(!ctx.agents.get(sessionId), 'Studio record read did not reopen the Agent')
  const native = await ctx.sessionQuery.readSession(sessionId)
  assert.equal(native.session.origin, undefined)
  assert.equal(native.session.parentSession, undefined)
  assert.equal(native.events[eventSeq].data.source.rpcId, input.id)
  assert.equal(native.events[eventSeq].data.source.kind, 'user')
  assert.equal((await invoke('smoke-request-1', greeting)).id, input.id)
  assert.equal(calls.length, 1)
  process.stdout.write('OK implicit native root, default model, exact persisted provenance, idempotent send and cold record read\n')

  const assistantRoute = { provider, model: assistantModel, reasoningEffort: high }
  const leaderRoute = { provider, model: leaderModel, reasoningEffort: low }
  const revision = initial.settings.revision
  const unsupported = await post('settings', { revision, assistant: { ...assistantRoute, reasoningEffort: 'unsupported' },
    leader: leaderRoute }, { expected: 409 })
  assert.equal(unsupported.code, 'MODEL_UNAVAILABLE')
  const saved = await post('settings', { revision, assistant: assistantRoute, leader: leaderRoute })
  assert.deepEqual(saved.assistant, assistantRoute)
  assert.deepEqual(saved.leader, leaderRoute)

  // 每个真实提案只创建被确认的项目和空闲 Leader，不让普通肯定句或旧按钮启动工作。
  const rooms = []
  for (const [index, plan] of plans.entries()) {
    const request = await invoke(`smoke-project-${index}`, plan.intent)
    const confirmation = await until('native confirmation', async () => {
      const { items } = await post('pending', {})
      return items.find(item => item.state === 'pending' && item.messageId === request.id)
    })
    assert.equal(confirmation.kind, 'confirmation')
    assert.equal(confirmation.mobile, 'card')
    assert.equal(confirmation.acceptsText, false)
    assert.equal((await post('state', {})).projects.length, index)
    await post('answer', { id: confirmation.id, value: 'yes' }, { expected: 400 })
    const decision = await post('answer', { id: confirmation.id, value: 'Create project' })
    assert.equal(decision.state, 'resolved')
    assert.equal(decision.answeredBy, 'gui')
    const finished = await completed(request.id)
    assert.equal(finished.source.sessionId, sessionId)
    await until('resumed Assistant teardown', () => !ctx.agents.get(sessionId))
    await post('answer', { id: confirmation.id, value: 'Create project' }, { expected: 409 })
    const { projects } = await post('state', {})
    assert.deepEqual(projects.map(({ name, objective }) => [name, objective]), plans.slice(0, index + 1).map(({ name, objective }) => [name, objective]))
    const project = projects.find(entry => entry.name === plan.name)
    assert.equal(project.workspacePath, null)
    assert.equal(project.state, 'active')
    assert.equal(project.managementEpoch, 1)
    const { items } = await post('records', {})
    const leader = items.find(item => item.role === 'leader' && item.conversationId === project.id)
    assert.ok(leader, 'Confirmed project has a visible Studio record for its passive Leader')
    const leaderRecord = await post('record', { sessionId: leader.id })
    assert.equal(leaderRecord.events.some(event => event.kind === 'turn/start'), false)
    assert.equal(ctx.agents.get(leader.id), undefined)
    const coldLeader = await ctx.sessionQuery.readSession(leader.id)
    assert.equal(coldLeader.session.origin, undefined)
    assert.equal(coldLeader.session.agentPreset, 'agent-studio-leader')
    rooms.push({ ...plan, id: project.id, leaderId: leader.id })
  }
  assert.deepEqual(calls.map(call => [call.model, call.reasoningEffort]),
    [[model, undefined], ...Array(4).fill([assistantModel, high])])
  await post('record', { sessionId: 'not-a-studio-record' }, { expected: 404 })
  process.stdout.write('OK configured reasoning effort, exact project intents, GUI confirmation, stale-answer rejection, passive Leader records\n')

  // 依次使用 Alpha、Beta、Alpha，确认恢复的是同一项目 Leader，且两项目和 Assistant 的上下文不会串线。
  assert.equal(new Set([sessionId, ...rooms.map(room => room.leaderId)]).size, 3)
  const [alpha, beta] = rooms
  async function leaderTurn(room, text, forbid, previous) {
    const count = calls.length
    const request = await invoke(`smoke-leader-${count}`, text, room.id)
    const result = await completed(request.id, room.id)
    assert.equal(result.source.sessionId, room.leaderId)
    await until('native Leader teardown', () => !ctx.agents.get(room.leaderId))
    assert.equal(calls.length, count + 1, 'A single Leader turn uses only its configured model')
    const [call] = calls.slice(count)
    assert.equal(call.model, leaderModel)
    assert.equal(call.reasoningEffort, low)
    assert.ok(call.texts.includes(text))
    for (const other of [greeting, replies.greeting, ...plans.map(plan => plan.intent), ...forbid]) {
      assert.ok(!call.contextText.includes(other), 'A Leader request must not include another conversation’s text')
    }
    if (previous) assert.ok(call.contextText.includes(previous), 'A resumed Leader retains its own exact earlier context')
    const timeline = await post('timeline', { conversationId: room.id })
    assert.ok(timeline.items.every(item => item.conversationId === room.id))
    assert.ok(timeline.items.some(item => item.role === 'leader' && item.text === `Offline Leader heard: ${text}`))
    await post('message', { conversationId, id: request.id }, { expected: 404 })
    const record = await post('record', { sessionId: room.leaderId })
    assert.equal(record.events.find(event => event.seq === result.source.eventSeq)?.text, text)
    assert.ok(!ctx.agents.get(room.leaderId))
  }
  await leaderTurn(alpha, alpha.first, [beta.first])
  await leaderTurn(beta, beta.first, [alpha.first, alpha.next])
  await leaderTurn(alpha, alpha.next, [beta.first], alpha.first)
  process.stdout.write('OK separate current Leader models, durable project context, and Assistant/project isolation\n')

  // 登记与交付分开核对；任务列表、详情和原对话必须使用同一个结果及来源。
  const beforeTask = calls.length
  const inputTask = await completed((await invoke('smoke-task', taskRequest)).id)
  assert.equal(inputTask.source.sessionId, sessionId)
  const task = await until('Worker result delivery', async () => {
    const current = (await post('tasks', { conversationId })).items.find(item => item.requestText === taskRequest)
    if (current && ['blocked', 'interrupted', 'cancelled'].includes(current.status)) {
      const observed = calls.slice(beforeTask).map(({ tools }) => tools)
      throw new Error(`Worker task ended ${current.status}; native call tool lists: ${JSON.stringify(observed)}.`)
    }
    return current?.status === 'delivered' ? current : undefined
  })
  knownTaskId = task.taskId
  assert.deepEqual(await post('task', { taskId: knownTaskId }), task)
  assert.equal(task.projectId, null)
  assert.equal(task.sourceMessageId, `agent-studio-owner:${inputTask.id}`)
  assert.equal(task.permission, 'read-only')
  assert.equal(task.resultSummary, taskResult)
  assert.deepEqual(await post('tasks', { conversationId: alpha.id }), { items: [] })
  const delivery = await until('task result in its original timeline', async () => (await post('timeline', { conversationId })).items
    .find(item => item.replyTo === inputTask.id && item.text === taskResult))
  assert.deepEqual(delivery.artifacts, [{ title: 'Worker result', text: taskResult, source: task.source }])
  assert.notEqual(task.source.sessionId, sessionId)
  assert.equal(calls.length, beforeTask + 2, 'Assistant delegates once and only the dedicated Worker calls the model again')
  assert.ok(calls[beforeTask].tools.includes('studio_delegate_task'))
  assert.deepEqual(calls[beforeTask + 1].tools, [])
  await until('delegating Assistant teardown', () => !ctx.agents.get(sessionId))

  const workerRecord = await post('record', { sessionId: task.source.sessionId })
  assert.equal(workerRecord.record.role, 'worker')
  assert.equal(workerRecord.record.readonlyLegacy, undefined)
  assert.equal(workerRecord.events.find(event => event.seq === task.source.eventSeq)?.text, taskResult)
  assert.ok(!ctx.agents.get(task.source.sessionId), 'The Worker record read does not reopen its Agent')
  assert.equal((await invoke('smoke-task', taskRequest)).id, inputTask.id)
  assert.equal(calls.length, beforeTask + 2)
  assert.equal((await post('stopTask', { taskId: knownTaskId }, { expected: 409 })).code, 'TASK_NOT_ACTIVE')

  const { DatabaseSync } = await import('node:sqlite')
  const ledger = new DatabaseSync(join(fixture, 'studio', 'managed-worker.sqlite'), { readOnly: true })
  try {
    const rows = ledger.prepare(`SELECT task_id, status, source_message_id, session_id, result_event_seq, outcome
      FROM studio_task JOIN studio_task_execution USING (task_id)`).all()
    assert.deepEqual(rows.map(row => Object.values(row)),
      [[knownTaskId, 'delivered', task.sourceMessageId, task.source.sessionId, task.source.eventSeq, 'delivered']])
  } finally { ledger.close() }
  const readInput = await completed((await invoke('smoke-read-task', readRequest)).id)
  await until('result-reading Assistant teardown', () => !ctx.agents.get(sessionId))
  assert.equal(readResult, true)
  const history = await post('record', { sessionId, from: readInput.source.eventSeq })
  assert.ok(history.events.some(event => event.kind === 'tool/result' && event.text.includes(taskResult)), 'The read tool returns the exact saved result')
  process.stdout.write('OK unified task registration, delivery, read-only Worker provenance, result lookup and no replay\n')

  // 记录 rc.5 原生派发及结构化结果；被拦截的模型调用和随后直接发往旧 Worker 的调用均不得进入工具本体。
  const dispatched = new Set()
  const staleCalls = new Map()
  ctx.on('tools/execute', (exec, next) => { dispatched.add(exec.callId); return next() })
  ctx.on('tools/result', (exec, result) => {
    if (!exec.callId.startsWith('offline-local-')) return
    nativeResults.set(exec.callId, result)
    if (exec.callId.startsWith('offline-local-denied-') && exec.callId.includes('-worker-') && result.error?.info?.code?.startsWith('STUDIO_')) {
      const stale = { type: 'tool-call', id: `stale-${exec.callId}`, name: 'read', arguments: JSON.stringify({ file_path: 'notes.txt' }) }
      staleCalls.set(exec.callId, ctx.tools.execute({ agent: exec.agent, calls: [stale], signal: AbortSignal.timeout(3_000) })
        .then(batch => batch.results[0].result, error => ({ error })))
    }
  })
  const plan = (request, details) => workspacePlans.set(request, details)
  const findTask = async (room, request, expected) => until(`local task ${expected}`, async () => {
    const row = (await post('tasks', { conversationId: room })).items.find(item => item.requestText === request)
    if (row && ['blocked', 'interrupted', 'cancelled', 'delivered', 'waiting_approval'].includes(row.status)) {
      assert.equal(row.status, expected, row.resultSummary ?? row.checkResult ?? 'Unexpected local task terminal status')
      return row
    }
  })
  const pendingFor = (messageId, match) => until('local task confirmation', async () => (await post('pending', {})).items
    .find(item => item.state === 'pending' && item.messageId === messageId && match(item)))
  const canonicalTask = (room, request) => (post('tasks', { conversationId: room })).then(page => page.items.find(item => item.requestText === request))
  const allowWrite = async (room, request, input, path) => {
    const pending = await pendingFor(input.id, item => item.options.includes('允许本任务写入'))
    assert.ok(pending.detail.includes(path) && pending.detail.includes(request))
    assert.equal(await canonicalTask(room, request), undefined, 'Project binding is not a grant; no task before owner confirmation')
    assert.equal((await post('answer', { id: pending.id, value: '允许本任务写入' })).answeredBy, 'gui')
  }

  const investigation = join(fixture, 'investigation')
  mkdirSync(investigation)
  const notes = 'Opening line\nunique-investigation-marker: alpine-red\nClosing line\n'
  const notesPath = join(investigation, 'notes.txt')
  writeFileSync(notesPath, notes)
  const beforeInvestigation = statSync(notesPath, { bigint: true })
  const investigate = `Investigate the read-only workspace ${JSON.stringify(investigation)} and report the exact source location.`
  const conclusion = 'The listed notes.txt contains unique-investigation-marker: alpine-red at notes.txt:2.'
  plan(investigate, { id: 'investigate', frontend: [['studio_delegate_task', { workspacePath: investigation, permission: 'read-only' }]],
    worker: [['studio_list_directory', {}], ['read', { file_path: 'notes.txt' }],
      ['grep', { pattern: 'unique-investigation-marker', path: '.' }]], result: conclusion,
    observe(text) { assert.ok(text.includes('unique-investigation-marker: alpine-red') && text.includes('notes.txt')) } })
  const projectCount = (await post('state', {})).projects.length
  const investigationInput = await invoke('smoke-local-investigate', investigate)
  await completed(investigationInput.id)
  const found = await findTask(conversationId, investigate, 'delivered')
  assert.equal(found.projectId, null)
  assert.equal(found.workspacePath, investigation)
  assert.equal(found.permission, 'read-only')
  assert.ok(found.resultSummary.includes(conclusion))
  assert.deepEqual(found.checkResult, { version: 1, changedFiles: [], checks: [], overallCheckStatus: 'not_run' })
  const investigationResults = [0, 1, 2].map(index => nativeResults.get(`offline-local-investigate-worker-${index}`))
  for (const result of investigationResults) assert.equal(result?.isError, false)
  assert.match(investigationResults[0].value.text, /"name":"notes\.txt","kind":"file"/u)
  assert.match(JSON.stringify(investigationResults[1].content), /unique-investigation-marker: alpine-red/u)
  assert.match(JSON.stringify(investigationResults[2].content), /(?:notes\.txt[^\d]*2|2:\s*unique-investigation-marker)/u)
  assert.equal(readFileSync(notesPath, 'utf8'), notes)
  assert.deepEqual(readdirSync(investigation), ['notes.txt'])
  assert.equal(statSync(notesPath, { bigint: true }).mtimeNs, beforeInvestigation.mtimeNs)
  assert.equal(statSync(notesPath, { bigint: true }).ctimeNs, beforeInvestigation.ctimeNs)
  assert.equal((await post('state', {})).projects.length, projectCount)
  process.stdout.write('OK local read-only Worker listed, read and searched native files; exact source, no writes or automatic project\n')

  const projectPath = join(fixture, 'project')
  mkdirSync(projectPath)
  writeFileSync(join(projectPath, 'notes.txt'), 'before\n')
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'studio-smoke-local', private: true,
    scripts: { check: 'node verify.mjs notes.txt after', test: 'node verify.mjs added.txt intentionally-different' } }))
  writeFileSync(join(projectPath, 'verify.mjs'), `import { readFileSync } from 'node:fs'
const [file, expected] = process.argv.slice(2)
const contents = readFileSync(file, 'utf8').trim()
if (contents !== expected) { console.error('fixture assertion failed'); process.exitCode = 7 }
else console.log('fixture assertion passed')
`)
  const projectName = 'Offline Local Workspace'
  const projectIntent = `Create an ongoing project named ${projectName} for ${JSON.stringify(projectPath)}.`
  plan(projectIntent, { id: 'project', frontend: [['studio_propose_project', { name: projectName, workspacePath: projectPath,
    objective: 'Verify local edits and native checks.', intentQuote: projectIntent }]] })
  const projectInput = await invoke('smoke-local-project', projectIntent)
  const projectPending = await pendingFor(projectInput.id, item => item.options.includes('Create project'))
  await post('answer', { id: projectPending.id, value: 'Create project' })
  await completed(projectInput.id)
  await until('project-creating Assistant teardown', () => !ctx.agents.get(sessionId))
  const project = (await post('state', {})).projects.find(item => item.name === projectName)
  assert.equal(project?.workspacePath, projectPath)

  const modify = 'Edit notes.txt, write added.txt, and run the package check and test in this project.'
  plan(modify, { id: 'modify', frontend: [['studio_delegate_task', { permission: 'workspace-write' }]],
    worker: [['edit', { file_path: 'notes.txt', old_string: 'before', new_string: 'after' }],
      ['write', { file_path: 'added.txt', content: 'new evidence\n' }],
      ['bash', { command: 'npm run check', workdir: projectPath, description: 'Run the offline fixture check' }],
      ['bash', { command: 'npm test', workdir: projectPath, description: 'Run the deliberately failing fixture check' }]],
    result: 'Worker claim: all checks passed.' })
  const modifyInput = await invoke('smoke-local-modify', modify, project.id)
  assert.equal(readFileSync(join(projectPath, 'notes.txt'), 'utf8'), 'before\n')
  await allowWrite(project.id, modify, modifyInput, projectPath)
  await completed(modifyInput.id, project.id)
  const modified = await findTask(project.id, modify, 'delivered')
  assert.equal(modified.permission, 'workspace-write')
  assert.equal(modified.workspacePath, projectPath)
  assert.equal(readFileSync(join(projectPath, 'notes.txt'), 'utf8'), 'after\n')
  assert.equal(readFileSync(join(projectPath, 'added.txt'), 'utf8'), 'new evidence\n')
  assert.equal(modified.checkResult.version, 1)
  assert.deepEqual(modified.checkResult.changedFiles, [{ path: 'notes.txt', action: 'edit' }, { path: 'added.txt', action: 'write' }])
  assert.deepEqual(modified.checkResult.checks.map(({ command, workdir, exitCode, status }) => [command, workdir, exitCode, status]),
    [['npm run check', projectPath, 0, 'passed'], ['npm test', projectPath, 7, 'failed']])
  assert.match(modified.checkResult.checks[0].output, /fixture assertion passed/u)
  assert.match(modified.checkResult.checks[1].output, /fixture assertion failed/u)
  assert.equal(modified.checkResult.overallCheckStatus, 'failed')
  assert.deepEqual(await post('task', { taskId: modified.taskId }), modified)
  assert.match(modified.resultSummary, /检查总体状态：failed[\s\S]*Worker 正文（不作为宿主证据）：\nWorker claim: all checks passed\./u)
  const readLocal = 'Read the saved result and observed checks for the project workspace task.'
  plan(readLocal, { id: 'readback', frontend: [['studio_read_task', { taskId: modified.taskId }]], capture: true })
  await completed((await invoke('smoke-local-readback', readLocal, project.id)).id, project.id)
  assert.ok(workspaceReadbacks.get('readback')?.includes(modified.resultSummary))
  process.stdout.write('OK owner-confirmed project edit and write; native exit 0 passed, exit 7 failed; tasks and studio_read_task report failed\n')

  const outsidePath = join(fixture, 'outside-notes.txt')
  const sentinel = 'outside-fixture-sentinel\n'
  writeFileSync(outsidePath, sentinel)
  symlinkSync(outsidePath, join(projectPath, 'external.txt'))
  for (const [id, permission, name, args, code] of [
    ['read', 'read-only', 'read', { file_path: 'external.txt' }, 'STUDIO_OUTSIDE_WORKSPACE'],
    ['write', 'workspace-write', 'write', { file_path: 'external.txt', content: 'must not be written' }, 'STUDIO_OUTSIDE_WORKSPACE'],
    // 不设置远程；即使守卫回归也不会联系任何服务。原生派发观测另外证明 git 进程未启动。
    ['push', 'workspace-write', 'bash', { command: 'git push', description: 'Attempt the prohibited local smoke command' }, 'STUDIO_HIGH_IMPACT_FORBIDDEN'],
  ]) {
    const request = `Offline guard scenario ${id}: exercise the requested local operation.`
    plan(request, { id: `denied-${id}`, frontend: [['studio_delegate_task', { permission }]], worker: [[name, args]],
      result: 'The guard smoke must never deliver a Worker result.' })
    const input = await invoke(`smoke-local-denied-${id}`, request, project.id)
    if (permission === 'workspace-write') await allowWrite(project.id, request, input, projectPath)
    await completed(input.id, project.id)
    const intercepted = await findTask(project.id, request, 'waiting_approval')
    const block = await pendingFor(input.id, item => item.id.startsWith('guard-intercept:'))
    assert.equal(block.taskId, intercepted.taskId)
    assert.equal(intercepted.authorizationVersion, 2)
    assert.ok(block.title.includes(code) && !block.detail.includes(outsidePath) && !block.detail.includes('git push'))
    const callId = `offline-local-denied-${id}-worker-0`
    const denied = await until('native guard result', () => nativeResults.get(callId))
    assert.equal(denied.error?.info?.code, code)
    assert.ok(!dispatched.has(callId), 'The denied action never entered native dispatch')
    const staleResult = await staleCalls.get(callId)
    assert.equal(staleResult?.error?.info?.code, 'STUDIO_EXECUTION_INACTIVE')
    assert.ok(!dispatched.has(`stale-${callId}`), 'The revoked execution cannot dispatch any later call')
    using proof = new DatabaseSync(join(fixture, 'studio', 'managed-worker.sqlite'), { readOnly: true })
    const execution = proof.prepare('SELECT ended_at, outcome FROM studio_task_execution WHERE task_id = ?').get(intercepted.taskId)
    assert.ok(execution.ended_at)
    assert.equal(execution.outcome, 'waiting_approval')
    assert.equal(readFileSync(outsidePath, 'utf8'), sentinel)
    const decision = id === 'read' ? '取消任务' : '仅解除等待（不重放被拒动作）'
    await post('answer', { id: block.id, value: decision })
    const ended = await post('task', { taskId: intercepted.taskId })
    assert.equal(ended.status, id === 'read' ? 'cancelled' : 'interrupted')
    await post('answer', { id: block.id, value: decision }, { expected: 409 })
    assert.equal(dispatched.has(callId), false)
  }
  assert.equal(readFileSync(outsidePath, 'utf8'), sentinel)
  process.stdout.write('OK native symlink read/write and git push denied before dispatch; atomic guard todo and immediate stale execution rejection, no replay\n')
} catch (error) {
  // 诊断只打印断言和测试阶段，不由运行时转储请求、认证数据或环境。
  console.error(error instanceof Error ? error.stack?.split('\n').slice(0, 9).join('\n') : 'Studio smoke failed')
  process.exitCode = 1
} finally {
  try { if (runtime) await runtime.shutdown.shutdown(process.exitCode ?? 0) }
  finally {
    process.chdir(originalCwd)
    assert.ok(fixture.startsWith(prefix) && /^studio-runtime-[a-z0-9]+$/iu.test(fixture.slice(tempParent.length + 1)))
    assert.equal(realpathSync(fixture), fixture, 'Only clean up the directory created by this fixture')
    rmSync(fixture, { recursive: true, force: true })
  }
}
