// 使用当前安装的 rc.5 验证 Studio 的真实 Web 授权、Session 生命周期和合成模型流程。
// 启动单独的进程：env -i PATH=/usr/bin:/bin HOME="$HOME" DSH_INSTALL_DIR="$DSH_INSTALL_DIR" "$DSH_NODE_EXECUTABLE" tests/fixtures/studio-runtime.smoke.mjs
// 要验证已编译的文字修订流程，在命令最后添加 --revision。
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
const exerciseRevision = process.argv.includes('--revision')
const draftRequest = 'Draft one sentence using the name Alpine and two details: blue door, late bus.'
const draftBody = 'Alpine saw the blue door and took the late bus.'
const correction = 'Please revise the previous draft: rename Alpine to Birch, keeping both details.'
const revisedBody = 'Birch saw the blue door and took the late bus.'
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
  const disabled = ['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'dsh-superagent-worker-preset',
    'dsh-superagent-router-preset', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account',
    'plugin-package-inventory-deepseek', 'web-search-deepseek', 'web-deepseek-api', 'session-title-llm']
  writeFileSync(patch, JSON.stringify([
    ...disabled.map(id => ({ id, disabled: true })),
    { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } },
    { id: 'agent-default-model', config: { provider, model } },
    { id: 'dsh-superagent-managed-worker', disabled: false, config: { stateDir: join(fixture, 'studio'), studioCwd: workspace } },
    ...['dsh-superagent-managed-worker-preset', 'dsh-superagent-studio-assistant-preset', 'dsh-superagent-studio-leader-preset']
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
        || text === greeting || text === draftRequest || text === correction)
      const proposal = plans.find(plan => plan.intent === newest)
      const revisionInput = exerciseRevision && texts.find(text => text.startsWith('Revise the previous saved result only as requested'))
      let block
      if (revisionInput) {
        assert.deepEqual(tools, [], 'The revision Worker has no tools')
        const evidence = JSON.parse(revisionInput.slice(revisionInput.indexOf('\n\n') + 2))
        assert.deepEqual(evidence, { previousResult: draftBody, ownerCorrection: correction })
        assert.ok(!contextText.includes(greeting), 'The revision Worker receives only the bounded correction, not the Assistant room')
        block = textBlock(revisedBody)
      } else if (exerciseRevision && newest === correction) {
        assert.ok(tools.includes('studio_revise_text'), 'The Assistant must offer the native topic-revision tool')
        block = { type: 'tool-call', id: 'offline-revise-call', name: 'studio_revise_text', arguments: '{}' }
      } else if (exerciseRevision && newest === draftRequest) {
        if (tools.length) {
          assert.ok(tools.includes('studio_delegate_draft'))
          block = { type: 'tool-call', id: 'offline-draft-call', name: 'studio_delegate_draft', arguments: '{}' }
        } else {
          assert.ok(!contextText.includes(greeting), 'The original Worker receives only its exact assigned text')
          block = textBlock(draftBody)
        }
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
  assert.ok((await page.text()).includes('dsh-superagent-studio-web'), 'The authenticated shell advertises the Studio Client')
  const studioBundle = ctx.clientModules.graph().entries.find(entry => entry.id === 'dsh-superagent-studio-web')
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
    const { items } = await post('records', {})
    const leader = items.find(item => item.role === 'leader' && item.conversationId === project.id)
    assert.ok(leader, 'Confirmed project has a visible Studio record for its passive Leader')
    const leaderRecord = await post('record', { sessionId: leader.id })
    assert.equal(leaderRecord.events.some(event => event.kind === 'turn/start'), false)
    assert.equal(ctx.agents.get(leader.id), undefined)
    const coldLeader = await ctx.sessionQuery.readSession(leader.id)
    assert.equal(coldLeader.session.origin, undefined)
    assert.equal(coldLeader.session.agentPreset, 'dsh-superagent-studio-leader')
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

  if (exerciseRevision) {
    // 通过 GUI 回复修订已交付的原成果，再用本轮临时账本检查同一任务的原派工和独立的新 Worker。
    const beforeDraft = calls.length
    const draft = await completed((await invoke('smoke-draft-original', draftRequest)).id)
    await until('original Assistant teardown', () => !ctx.agents.get(sessionId))
    assert.equal(draft.source.sessionId, sessionId)
    const main = await post('timeline', { conversationId })
    const delivered = main.items.find(item => item.replyTo === draft.id && item.text === draftBody)
    assert.equal(delivered?.artifacts?.[0]?.title, 'Worker result')
    assert.equal(delivered.artifacts[0].text, draftBody)
    const parent = delivered.artifacts[0].source
    assert.notEqual(parent.sessionId, sessionId)
    assert.equal(calls.length, beforeDraft + 2, 'Assistant delegates once and only the dedicated Worker calls the model again')
    assert.ok(calls[beforeDraft].tools.includes('studio_delegate_draft'))
    assert.deepEqual(calls[beforeDraft + 1].tools, [])
    assert.ok(calls[beforeDraft + 1].texts.includes(draftRequest))

    const replyInput = { conversationId, requestId: 'smoke-draft-correction', text: correction, replyTo: delivered.id }
    const request = await post('send', replyInput)
    assert.equal(request.topicId, delivered.id)
    const fixed = await completed(request.id)
    assert.equal(fixed.source.sessionId, sessionId)
    await until('revision Assistant teardown', () => !ctx.agents.get(sessionId))
    assert.equal(calls.length, beforeDraft + 4, 'Correction uses the Assistant and one new Worker, and invokes neither again')
    assert.ok(calls[beforeDraft + 2].tools.includes('studio_revise_text'))
    assert.deepEqual(calls[beforeDraft + 3].tools, [])
    const topic = await post('timeline', { conversationId, topicId: delivered.id })
    const revised = topic.items.find(item => item.replyTo === fixed.id && item.text === revisedBody)
    assert.equal(revised?.artifacts?.[0]?.title, 'Revised result')
    assert.equal(revised.artifacts[0].text, revisedBody)
    const current = revised.artifacts[0].source
    assert.equal(new Set([sessionId, parent.sessionId, current.sessionId]).size, 3)
    for (const [source, expected] of [[parent, draftBody], [current, revisedBody]]) {
      const detail = await post('record', { sessionId: source.sessionId })
      assert.equal(detail.record.role, 'draft-worker')
      assert.equal(detail.events.find(event => event.seq === source.eventSeq)?.text, expected)
      assert.equal(ctx.agents.get(source.sessionId), undefined)
    }
    assert.equal((await post('send', replyInput)).id, request.id)
    assert.equal(calls.length, beforeDraft + 4)
    const { DatabaseSync } = await import('node:sqlite')
    const ledger = new DatabaseSync(join(fixture, 'studio', 'managed-worker.sqlite'), { readOnly: true })
    try {
      const drafts = ledger.prepare('SELECT task_id, source_request_id, worker_session_id, state FROM studio_draft_task').all()
      const revisions = ledger.prepare('SELECT work_id, origin_request_id, request_id, worker_session_id, state FROM agent_studio_revision').all()
      assert.deepEqual(drafts.map(row => [row.source_request_id, row.worker_session_id, row.state]), [[draft.id, parent.sessionId, 'completed']])
      assert.deepEqual(revisions.map(row => [row.work_id, row.origin_request_id, row.request_id, row.worker_session_id, row.state]),
        [[drafts[0].task_id, draft.id, fixed.id, current.sessionId, 'completed']])
    } finally { ledger.close() }
    process.stdout.write('OK original draft, topical correction on the same task, and independent tool-free Worker provenance\n')
  }
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
