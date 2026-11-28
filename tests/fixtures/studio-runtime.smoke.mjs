// 使用当前安装的 rc.5 验证 Studio 的真实 Web 授权、Session 生命周期和合成模型流程。
// 启动单独的进程：env -i PATH=/usr/bin:/bin HOME="$HOME" DSH_INSTALL_DIR="$DSH_INSTALL_DIR" "$DSH_NODE_EXECUTABLE" tests/fixtures/studio-runtime.smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
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
      let block
      if (newest === taskRequest) {
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
} catch (error) {
  // 诊断只打印断言和测试阶段，不由运行时转储请求、认证数据或环境。
  console.error(error instanceof Error ? error.stack?.split('\n').slice(0, 9).join('\n') : 'Studio smoke failed')
  process.exitCode = 1
} finally {
  if (runtime) await runtime.shutdown.shutdown(process.exitCode ?? 0)
  process.chdir(originalCwd)
  assert.ok(fixture.startsWith(prefix) && /^studio-runtime-[a-z0-9]+$/iu.test(fixture.slice(tempParent.length + 1)))
  assert.equal(realpathSync(fixture), fixture, 'Only clean up the directory created by this fixture')
  rmSync(fixture, { recursive: true, force: true })
}
