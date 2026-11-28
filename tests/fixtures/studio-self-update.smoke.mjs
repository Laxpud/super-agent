// 在 Linux 上运行：DSH_INSTALL_DIR=/absolute/path/to/@deepseek-ai/dsh STUDIO_SMOKE_BROWSER=/absolute/path/to/chromium node tests/fixtures/studio-self-update.smoke.mjs
// 依赖 pnpm 11.7.0 及可访问锁文件指定的注册表；不读写检出的 node_modules 或真实用户缓存。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'linux')
const source = realpathSync(fileURLToPath(new URL('../../', import.meta.url)))
const install = process.env.DSH_INSTALL_DIR
assert.ok(install && isAbsolute(install), 'Set DSH_INSTALL_DIR to the installed CLI package directory.')
const dsh = realpathSync(join(install, 'lib/bin.js'))
const pkg = json(join(install, 'package.json'))
assert.equal(pkg.name, '@deepseek-ai/dsh'); assert.equal(pkg.version, '0.2.2-rc.5')
const requireDSH = createRequire(join(install, 'package.json'))
const { PROFILE_TEMPLATES } = await import(pathToFileURL(requireDSH.resolve('@deepseek-ai/dsh-official-bundles')).href)
const browser = process.env.STUDIO_SMOKE_BROWSER ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/microsoft/msedge/msedge'].find(existsSync)
assert.ok(browser && isAbsolute(browser) && existsSync(browser), 'Set STUDIO_SMOKE_BROWSER to a Chromium-based browser executable.')

const root = mkdtempSync(join(realpathSync('/tmp'), 'su-'))
const repo = join(root, 'repo'), installRoot = join(root, 'i'), releases = join(installRoot, 'releases')
const current = join(installRoot, 'current'), baseline = join(releases, 'v0'), stateDir = join(root, 's')
const home = join(root, 'h'), dshHome = join(root, 'd'), sideHome = join(root, 'h2'), sideDshHome = join(root, 'd2')
const workspace = join(root, 'w'), dbPath = join(stateDir, 'managed-worker.sqlite'), preload = join(root, 'offline.mjs')
const labelPath = 'src/studio-web/locales.ts', markerNew = 'Assistant V1 Worker Fixture', badFlag = join(root, 'disable-bad-build')
const editLabel = { file_path: labelPath, old_string: "assistant: 'Assistant'", new_string: `assistant: '${markerNew}'`, replace_all: true }
const assistantRequest = 'Keep the Assistant conversation across self-update.'
const iterationRequest = `In this project’s repository, change the Assistant navigation label in ${labelPath} to "${markerNew}" in both locales, then run pnpm check.`
const assistantReply = 'Persistent synthetic native reply.'
const workerReply = 'Updated both Assistant navigation labels and ran the requested check.'
const profile = 'studio-update-smoke', sideProfile = 'studio-bystander-smoke'
const assetNames = ['lib', 'studio-web', 'cordis.patch.yml', 'package.json', 'locale', 'prompts', 'skills', 'README.md']
const ticketRows = ['agent-studio', 'agent-studio-github', 'agent-studio-feishu', 'agent-studio-worker-preset', 'agent-studio-router-preset']
const nativeProvider = 'studio-update-offline', secret = 'synthetic-app-secret-not-valid-on-feishu'
const binding = { appId: 'cli_0123456789abcdef', ownerOpenId: 'ou_fixtureowner', botOpenId: 'ou_fixturebot', chatId: 'oc_fixturechat' }
const own = new Map(), reserved = new Set()
const proof = text => console.log(`OK ${text}`)
let completed = false, sideMonitor
const runSignal = new AbortController()
const stop = () => runSignal.abort(new Error('Smoke interrupted'))
process.on('SIGTERM', stop); process.on('SIGINT', stop)

function privateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); return path }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function write(path, body) { writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body), { mode: 0o600 }) }
function birth(pid) {
  try {
    const data = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = data.slice(data.lastIndexOf(') ') + 2).split(' ')
    return ['Z', 'X'].includes(fields[0]) ? undefined : fields[19]
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error }
}
function remember(pid) {
  const token = pid && birth(pid)
  if (token) own.set(pid, token)
}
function same(pid) { return own.has(pid) && birth(pid) === own.get(pid) }
function envFor(user, dshDir) {
  // 独立 HOME/XDG 已隔离用户 Git 配置；不要设置 GIT_CONFIG_GLOBAL，仓库回归会验证它原先未设置。
  return { HOME: user, DSH_HOME: dshDir, DSH_TELEMETRY_DISABLED: '1', GIT_CONFIG_NOSYSTEM: '1', CI: 'true',
    XDG_CONFIG_HOME: join(user, '.config'), XDG_CACHE_HOME: join(user, '.cache'), XDG_DATA_HOME: join(user, '.local/share'),
    npm_config_cache: join(user, '.npm'), TMPDIR: root, LANG: 'C.UTF-8', PATH: [...new Set([dirname(process.execPath),
      ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute), '/usr/bin', '/bin'])].join(delimiter) }
}
async function until(label, fn, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    runSignal.signal.throwIfAborted()
    const result = await fn()
    if (result) return result
    await pause(70)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function outputChild(exe, args, env, cwd, log) {
  const fd = openSync(log, 'a', 0o600)
  try {
    const child = spawn(exe, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
    remember(child.pid)
    const done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    void done.catch(() => {})
    return { child, done }
  } finally { closeSync(fd) }
}
async function cmd(exe, args, { cwd = workspace, env = envFor(home, dshHome), name = exe, ms = 120_000 } = {}) {
  const log = join(root, `${name}.log`)
  const { child, done } = outputChild(exe, args, env, cwd, log)
  const timeout = AbortSignal.any([runSignal.signal, AbortSignal.timeout(ms)])
  const result = await Promise.race([done, pause(ms, undefined, { signal: timeout, ref: false }).then(() => { throw new Error(`${name} timed out`) })])
  assert.deepEqual(result, { code: 0, signal: null }, `${name} failed:\n${readFileSync(log, 'utf8').slice(-4000)}`)
  assert.ok(child.pid)
  return readFileSync(log, 'utf8')
}
async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  if (port === 3082 || reserved.has(port)) return reservePort()
  reserved.add(port)
  return port
}
function profileDir(dshDir, name) { return join(dshDir, 'profiles', name) }
function beginProfile(dshDir, name, patch, managed) {
  const profilePath = privateDir(profileDir(dshDir, name))
  const modules = privateDir(join(profilePath, 'node_modules'))
  if (managed) symlinkSync(current, join(modules, 'agent-studio'))
  write(join(profilePath, 'package.json'), { private: true, ...(managed && { dependencies: { 'agent-studio': `link:${current}` } }),
    dsh: { profile: { bundles: [...PROFILE_TEMPLATES.web.bundles, ...(managed ? ['agent-studio'] : [])] } } })
  write(join(profilePath, 'cordis.patch.yml'), patch)
}
function bootArgs(name, port) { return ['--import', preload, dsh, '--profile', name, '--host', '127.0.0.1', '--port', String(port), '--no-open'] }
const postHeaders = (host, cookie) => ({ 'content-type': 'application/json', origin: host, 'x-agent-studio-request': '1', cookie })
async function loopback(url, options = {}) {
  const address = new URL(url)
  assert.equal(address.hostname, '127.0.0.1'); assert.ok(reserved.has(Number(address.port)))
  return fetch(address, { signal: AbortSignal.timeout(4_000), ...options, redirect: 'manual' })
}
async function post(host, cookie, op, input = {}, status = 200) {
  const res = await loopback(host + '/agent-studio/api', { method: 'POST', headers: postHeaders(host, cookie), body: JSON.stringify({ op, input }) })
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const data = await res.json()
  assert.equal(res.status, status, `${op}: HTTP ${res.status} (${data.code ?? 'no code'})`)
  return data
}
async function health(host, cookie) {
  const res = await loopback(host + '/agent-studio/health', { headers: { cookie, 'x-agent-studio-request': '1' } })
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store')
  return res.json()
}
async function login(name, host, release) {
  const file = join(root, `${name}.ready`)
  return until(`${name} ready`, async () => {
    try {
      const info = json(file)
      if (!birth(info.pid) || info.release !== release) return
      remember(info.pid)
      assert.equal(new URL(info.url).origin, host)
      const response = await loopback(info.url)
      if (response.status !== 303) return
      const header = response.headers.getSetCookie()[0]
      assert.match(header, /;\s*HttpOnly\b/iu)
      const cookie = header.split(';', 1)[0]
      if (release && !(await health(host, cookie)).ready) return
      return { ...info, cookie }
    } catch (error) { if (!['ENOENT', 'EISDIR'].includes(error.code) && !(error instanceof TypeError)) throw error }
  })
}
function snapshot(key, value = []) {
  using db = new DatabaseSync(dbPath, { readOnly: true })
  return db.prepare(key).all(...value)
}
function updatePath(id, name) {
  assert.match(id, /^[a-f0-9-]{36}$/u)
  return join(stateDir, 'updates', id, name)
}
async function record(host, cookie, id, expected, ms) {
  return until(expected, async () => {
    const value = (await post(host, cookie, 'selfUpdateStatus', { updateId: id })).record
    if (!value || ['prechecking', 'approved', 'draining', 'stopping', 'switching', 'starting', 'rolling_back'].includes(value.phase)) return
    if (value.phase !== expected) {
      const logPath = updatePath(id, value.phase === 'failed_precheck' ? 'precheck.log' : 'controller.log')
      const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-5000) : ''
      throw new Error(`Expected update phase ${expected}, got ${value.phase}; exit ${value.exitCode}\n${tail}`)
    }
    return value
  }, ms)
}
async function handoff(id, expected) {
  return until(expected, () => {
    const dir = updatePath(id, 'state.json')
    if (!existsSync(dir)) return
    const ready = updatePath(id, 'runner-ready.json')
    if (existsSync(ready)) {
      const { pid, started } = json(ready)
      if (started?.split(':').at(-1) === birth(pid)) remember(pid)
    }
    const data = json(dir)
    if (['failed_drain', 'recovery_required', 'succeeded', 'rolled_back'].includes(data.phase)) {
      assert.equal(data.phase, expected, `Controller log:\n${readFileSync(updatePath(id, 'controller.log'), 'utf8')}`)
      return data
    }
  }, 90_000)
}

/** 在真实 Chromium 中用 CDP 观察已执行页面的脚本请求，而不是猜静态文件 URL。 */
async function verifyBrowser(host, auth, buildId) {
  const user = privateDir(join(root, 'browser'))
  const { child } = outputChild(browser, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run',
    '--disable-background-networking', '--disable-component-update', '--no-proxy-server', '--window-size=1360,880',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=${user}`, '--remote-debugging-port=0', 'about:blank'],
  envFor(home, dshHome), workspace, join(root, 'browser.log'))
  try {
    const debug = await until('isolated Chromium debugging endpoint', () => {
      const path = join(user, 'DevToolsActivePort')
      return existsSync(path) && Number(readFileSync(path, 'utf8').split('\n')[0])
    })
    assert.ok(debug !== 3082 && !reserved.has(debug)); reserved.add(debug)
    const tabs = await (await loopback(`http://127.0.0.1:${debug}/json/list`)).json()
    const target = tabs.find(tab => tab.type === 'page')
    const socketUrl = new URL(target.webSocketDebuggerUrl)
    assert.equal(socketUrl.host, `127.0.0.1:${debug}`)
    const ws = new WebSocket(socketUrl)
    try {
      await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
      let nextId = 0, clientRequest
      const calls = new Map(), urlById = new Map(), errors = []
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId
        calls.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
      ws.addEventListener('message', ({ data }) => {
        const event = JSON.parse(data)
        if (event.method === 'Network.responseReceived') {
          const { requestId, response: { url, status } } = event.params
          if (url.startsWith(host + '/') && status === 200 && /agent-studio-web\/client\.js/u.test(url)) urlById.set(requestId, url)
          if (status >= 400 && url.startsWith(host + '/')) errors.push(`${status} ${new URL(url).pathname}`)
        }
        if (event.method === 'Network.loadingFailed') errors.push(event.params.errorText)
        if (event.method === 'Network.loadingFinished' && urlById.has(event.params.requestId)) clientRequest = event.params.requestId
        const call = calls.get(event.id)
        if (call) { calls.delete(event.id); event.error ? call.reject(new Error(event.error.message)) : call.resolve(event.result) }
      })
      await send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 20_000_000 })
      await send('Page.enable')
      const navigation = await send('Page.navigate', { url: auth })
      assert.equal(navigation.errorText, undefined)
      const requestId = await until('Chromium to load the Studio Client module', () => clientRequest).catch(error => {
        throw new Error(`${error.message}; Chromium errors: ${errors.slice(0, 15).join(', ')}`)
      })
      const result = await send('Network.getResponseBody', { requestId })
      const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body
      assert.ok(body.includes(`/* agent-studio-build:${buildId} */\n`))
      assert.ok(body.includes(markerNew))
      const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value
      await until('Chromium to open the Studio panel', () => evaluate(`(() => {
        if (document.querySelector('.as-studio')) return true;
        const entry = document.querySelector('[title="Agent Studio"], [aria-label="Agent Studio"]');
        if (entry) { entry.click(); return true; }
        return false;
      })()`))
      await until('Chromium to render the new Assistant label', () => evaluate(`Array.from(document.querySelectorAll('.as-nav button'))
        .some(item => item.textContent.trim() === ${JSON.stringify(markerNew)})`))
    } finally { ws.close() }
  } finally { if (same(child.pid)) process.kill(-child.pid, 'SIGTERM') }
}

try {
  for (const path of [baseline, stateDir, home, dshHome, sideHome, sideDshHome, workspace]) privateDir(path)
  assert.ok([root, installRoot, releases, baseline, stateDir, home, dshHome, sideHome, sideDshHome].every(path => (statSync(path).mode & 0o777) === 0o700))
  assert.ok(Buffer.byteLength(join(stateDir, 'runtime/health.sock')) < 55)
  const primaryPort = await reservePort(), sidePort = await reservePort()
  const origin = `http://127.0.0.1:${primaryPort}`, sideOrigin = `http://127.0.0.1:${sidePort}`
  await cmd('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--quiet', '--', source, repo], { name: 'clone' })
  // 开发验收同时覆盖未提交的测试和最小修复；只复制真实 Git 跟踪/未忽略的普通文件，绝不传入本机配置。
  const listed = await cmd('git', ['-c', 'core.fsmonitor=false', '-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { name: 'tracked' })
  for (const entry of new Set(listed.split('\0').filter(Boolean))) {
    const from = join(source, entry), to = join(repo, entry)
    assert.ok(!isAbsolute(entry) && entry !== '..' && !entry.startsWith('../'))
    assert.equal(relative(source, from), entry); assert.equal(relative(repo, to), entry)
    if (!existsSync(from)) { if (existsSync(to) && lstatSync(to).isFile()) rmSync(to); continue }
    assert.ok(lstatSync(from).isFile() && realpathSync(from) === from, 'Smoke only accepts regular source files')
    privateDir(dirname(to)); cpSync(from, to)
  }
  // pnpm 可能在运行脚本时自动校验/重装依赖，因此绝不把 clone 的 node_modules 链到原仓库。
  await cmd('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: repo, name: 'install-baseline' })
  await cmd('pnpm', ['build'], { cwd: repo, env: { ...envFor(home, dshHome), AGENT_STUDIO_BUILD_ID: 'studio-smoke-v0' }, name: 'build-baseline' })
  for (const name of assetNames) cpSync(join(repo, name), join(baseline, name), { recursive: true })
  symlinkSync('releases/v0', current)
  // Studio 发布树只包含指纹资产；共享的第三方运行时依赖位于托管根，不放进任何候选树。
  const runtimeModules = privateDir(join(installRoot, 'node_modules'))
  for (const dependency of Object.keys(json(join(repo, 'package.json')).dependencies)) {
    const link = join(runtimeModules, dependency)
    privateDir(dirname(link)); symlinkSync(realpathSync(join(repo, 'node_modules', dependency)), link)
  }
  const sdkPath = createRequire(join(baseline, 'package.json')).resolve('@larksuiteoapi/node-sdk')
  const llmPath = requireDSH.resolve('@deepseek-ai/dsh-llm')
  const disabled = [...ticketRows, 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account', 'plugin-package-inventory-deepseek',
    'web-search-deepseek', 'web-deepseek-api', 'session-title-llm', 'session-telemetry-otel']
  const shared = [...disabled.map(id => ({ id, disabled: true })), { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: false } }]
  const reloadCommand = { executable: process.execPath, args: bootArgs(profile, primaryPort), cwd: workspace, dshHome, profileName: profile }
  const primaryPatch = [...shared, { id: 'agent-default-model', config: { provider: nativeProvider, model: 'offline' } },
    { id: 'agent-studio-managed-worker', disabled: false, config: { stateDir, studioCwd: workspace,
      selfUpdate: { repoPath: repo, installRoot, reloadCommand, healthTimeoutMs: 15_000 } } },
    ...['agent-studio-managed-worker-preset', 'agent-studio-assistant-preset', 'agent-studio-leader-preset'].map(id => ({ id, disabled: false })),
    { insert: [{ id: 'fixture', name: join(root, 'fixture.mjs') }] }]
  beginProfile(dshHome, profile, primaryPatch, true)
  beginProfile(sideDshHome, sideProfile, [...shared, { insert: [{ id: 'fixture', name: join(root, 'fixture.mjs') }] }], false)

  // 替换 SDK 的网络边界，不替换 Studio 校验、配置写入、凭据库、出箱或健康逻辑。合成验证事件通过真实 EventDispatcher 投递。
  write(preload, `import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import sdk from ${JSON.stringify(pathToFileURL(sdkPath).href)}
const [profile] = process.argv.slice(process.argv.indexOf('--profile') + 1)
const primary = profile === ${JSON.stringify(profile)}
assert.equal(process.env.HOME, primary ? ${JSON.stringify(home)} : ${JSON.stringify(sideHome)})
assert.equal(process.env.DSH_HOME, primary ? ${JSON.stringify(dshHome)} : ${JSON.stringify(sideDshHome)})
const root = ${JSON.stringify(root)}, binding = ${JSON.stringify(binding)}
const release = primary ? realpathSync(${JSON.stringify(current)}) : null
const bad = primary && existsSync(release + '/studio-web/bad-smoke-release')
appendFileSync(root + '/hosts.ndjson', JSON.stringify({ pid: process.pid, profile, release, bad,
  started: readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19] }) + '\\n')
if (bad) {
  assert.ok(existsSync(${JSON.stringify(badFlag)}));
  // 保持候选 PID 存活但不启动 DSH，让真实控制器以健康超时终止它。
  await new Promise(() => { setInterval(() => {}, 1000) })
}
process.on('exit', code => appendFileSync(root + '/exits.ndjson', JSON.stringify({ pid: process.pid, code }) + '\\n'))
sdk.defaultHttpInstance.defaults.adapter = async config => {
  const url = String(config.url)
  let data
  if (url.includes('/auth/v3/tenant_access_token')) {
    assert.ok(JSON.stringify(config.data).includes(${JSON.stringify(secret)}))
    data = { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
  } else if (url.endsWith('/open-apis/bot/v3/info')) data = { code: 0, bot: { open_id: binding.botOpenId } }
  else if (url.includes('/im/v1/messages')) data = { code: 0, data: { chat_id: binding.chatId, message_id: 'om_' + randomUUID().replaceAll('-', '') } }
  else throw new Error('Unexpected offline SDK request')
  return { data, config, headers: {}, status: 200, statusText: 'OK' }
}
const connected = new WeakSet()
sdk.WSClient.prototype.start = async function({ eventDispatcher }) {
  connected.add(this)
  this.onReady()
  const timer = setInterval(() => {
    const input = root + '/challenge.json'
    if (!connected.has(this)) { clearInterval(timer); return }
    if (!existsSync(input)) return
    const { phrase, now } = JSON.parse(readFileSync(input, 'utf8'))
    void eventDispatcher.invoke({ schema: '2.0', header: { event_id: randomUUID(), event_type: 'im.message.receive_v1', app_id: binding.appId, create_time: String(now) },
      event: { sender: { sender_type: 'user', sender_id: { open_id: binding.ownerOpenId } }, message: { message_type: 'text', chat_type: 'p2p',
        message_id: 'om_fixturecheck', chat_id: binding.chatId, create_time: String(now), content: JSON.stringify({ text: phrase }) } } })
  }, 150).unref()
}
sdk.WSClient.prototype.getConnectionStatus = function() { return { state: connected.has(this) ? 'connected' : 'closed' } }
sdk.WSClient.prototype.close = function() { connected.delete(this) }
`)
  write(join(root, 'fixture.mjs'), `import assert from 'node:assert/strict'
import { renameSync, realpathSync, writeFileSync } from 'node:fs'
import { LlmAdapter } from ${JSON.stringify(pathToFileURL(llmPath).href)}
const provider = ${JSON.stringify(nativeProvider)}, model = { id: 'offline', name: 'Synthetic offline', provider, inputModalities: ['text'],
  context: { contextWindow: 65536 }, defaultMaxTokens: 4096 }
const iteration = ${JSON.stringify(iterationRequest)}
const steps = {
  leader: [['studio_delegate_task', { permission: 'workspace-write' }]],
  worker: [['read', { file_path: ${JSON.stringify(labelPath)} }], ['edit', ${JSON.stringify(editLabel)}],
    ['bash', { command: 'pnpm check', description: 'Check the Studio repository after editing', timeoutMs: 120_000 }]],
}
const workerReply = ${JSON.stringify(workerReply)}
export const inject = ['connection', 'webServer', 'llm', 'profileContext', 'clientModules']
export function apply(ctx) {
  assert.deepEqual(ctx.llm.listProviders(), [])
  const name = ctx.profileContext.name
  class Offline extends LlmAdapter {
    async listModels() { return [model] }
    async resolveModel() { return model }
    async *stream(options) {
      options.signal?.throwIfAborted()
      // 仅对本轮精确原文脚本化出工具调用；文件读取、编辑、命令和收据都是原生执行。
      const input = options.messages.findLast(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === iteration))
      let block = { type: 'text', text: ${JSON.stringify(assistantReply)} }
      if (input) {
        const role = input.source?.kind === 'agent-studio' ? 'worker' : 'leader'
        const prefix = 'v1-self-update-' + role + '-'
        const done = options.messages.flatMap(message => message.content)
          .filter(item => item.type === 'tool-call' && item.id.startsWith(prefix)).length
        const next = steps[role][done]
        if (next) {
          const [name, args] = next
          assert.ok(options.tools?.some(tool => tool.name === name), 'Native ' + role + ' must expose ' + name)
          block = { type: 'tool-call', id: prefix + done, name, arguments: JSON.stringify(args) }
        } else {
          // 委派工具自行结束前台轮次；只有 Worker 会在工具执行后输出交付正文。
          assert.equal(role, 'worker')
          block = { type: 'text', text: workerReply }
        }
      }
      yield { type: 'block-start', index: 0, blockType: block.type }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  ctx.llm.registerAdapter([provider], new Offline())
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'bash' && exec.callId.startsWith('v1-self-update-worker-') && result.value?.exitCode !== 0) {
      console.error('Worker check failed:\\n' + (result.value?.stderr?.text ?? result.error?.message ?? 'No native result'))
    }
  })
  const timer = setInterval(() => {
    const origin = ctx.webServer.getOrigin()
    if (!origin || !new URL(origin).port) return
    clearInterval(timer)
    const graph = ctx.clientModules.graph().entries.map(entry => entry.id)
    const path = ${JSON.stringify(root)} + '/' + name + '.ready'
    writeFileSync(path + '.tmp', JSON.stringify({ pid: process.pid, graph, url: ctx.connection.authenticatedUrl(origin + '/'),
      release: name === ${JSON.stringify(profile)} ? realpathSync(${JSON.stringify(current)}) : null }), { mode: 0o600 })
    renameSync(path + '.tmp', path)
  }, 500).unref()
  ctx.effect(() => () => clearInterval(timer))
}
`)
  const first = outputChild(process.execPath, bootArgs(profile, primaryPort), envFor(home, dshHome), workspace, join(root, 'primary.log'))
  const side = outputChild(process.execPath, bootArgs(sideProfile, sidePort), envFor(sideHome, sideDshHome), workspace, join(root, 'side.log'))
  const one = await login(profile, origin, baseline), bystander = await login(sideProfile, sideOrigin, null)
  const sidePing = async () => {
    assert.equal(side.child.pid, bystander.pid); assert.equal(same(bystander.pid), true)
    assert.equal((await loopback(sideOrigin + '/', { headers: { cookie: bystander.cookie } })).status, 200)
    assert.equal(json(join(root, `${sideProfile}.ready`)).pid, bystander.pid)
  }
  await sidePing()
  let sidePending = false, sideSamples = 0
  sideMonitor = setInterval(() => {
    if (sidePending) return
    sidePending = true
    void sidePing().then(() => { sideSamples++ }, error => runSignal.abort(error)).finally(() => { sidePending = false })
  }, 100).unref()
  assert.equal(one.pid, first.child.pid); assert.notEqual(one.pid, bystander.pid)
  assert.equal(one.graph.includes('agent-studio'), false); assert.equal(one.graph.includes('agent-studio-web'), true)
  const healthy0 = await health(origin, one.cookie)
  assert.equal(healthy0.buildId, 'studio-smoke-v0'); assert.match(healthy0.artifactFingerprint, /^[a-f0-9]{64}$/u)
  proof(`isolated DSH ${pkg.version} primary PID=${one.pid} on ${primaryPort}, bystander PID=${bystander.pid} on ${sidePort}; Ticket rows disabled`)

  const project = await post(origin, one.cookie, 'createProject', { name: 'Agent Studio self-host fixture', objective: 'Iterate on Studio and verify data across release changes', workspacePath: repo })
  assert.equal(project.workspacePath, repo); assert.equal(project.state, 'active'); assert.equal(project.managementEpoch, 1)
  const coordinate = { projectId: project.id, expectedEpoch: project.managementEpoch }
  const leader = (await post(origin, one.cookie, 'records')).items.find(item => item.conversationId === project.id && item.role === 'leader')
  assert.ok(leader, 'The bound project must have a current native Leader')
  await post(origin, one.cookie, 'updateProjectArchive', { projectId: project.id, decisions: 'retain decisions', progress: 'retain progress', openIssues: 'retain issues' })
  await post(origin, one.cookie, 'savePreference', { key: 'durable-global', text: 'remember globally' })
  await post(origin, one.cookie, 'savePreference', { projectId: project.id, key: 'durable-project', text: 'remember in this project' })
  const send = (conversationId, requestId, text) => post(origin, one.cookie, 'send', { conversationId, requestId, text })
  const messageCompleted = (conversationId, id) => until('native message completion', async () => {
    const message = await post(origin, one.cookie, 'message', { conversationId, id })
    assert.ok(!['failed', 'interrupted'].includes(message.status), message.error)
    return message.status === 'completed' && message
  })
  const assistant = await send('assistant', 'message-assistant', assistantRequest)
  await messageCompleted('assistant', assistant.id)

  // 将源码编辑交给获批的 Worker；验收脚本只读本次修改路径并计算预期文本，不写该文件。
  const changed = join(repo, labelPath), oldText = readFileSync(changed, 'utf8')
  assert.equal(oldText.split(editLabel.old_string).length - 1, 2, 'Expected the old visible label in both locales')
  assert.equal(oldText.includes(markerNew), false)
  const iteration = await send(project.id, 'message-self-iteration', iterationRequest)
  const projectTasks = cookie => post(origin, cookie, 'tasks', { conversationId: project.id })
  const pending = await until('Leader to request workspace-write in the unified inbox', async () => (await post(origin, one.cookie, 'pending')).items
    .find(item => item.messageId === iteration.id && item.state === 'pending' && item.options.includes('允许本任务写入')))
  assert.deepEqual(pending.options, ['允许本任务写入', 'Not now'])
  assert.ok(pending.detail.includes(repo) && pending.detail.includes(iterationRequest))
  const waiting = await post(origin, one.cookie, 'task', { taskId: pending.taskId })
  assert.deepEqual((await projectTasks(one.cookie)).items, [waiting])
  assert.equal(waiting.status, 'waiting_approval'); assert.equal(waiting.workerSessionId, null); assert.equal(waiting.checkResult, null)
  assert.equal(waiting.permission, 'workspace-write'); assert.equal(waiting.workspacePath, repo)
  assert.equal(waiting.sourceSessionId, leader.id); assert.equal(waiting.requestText, iterationRequest)
  assert.deepEqual(snapshot('SELECT session_id FROM studio_task_execution WHERE task_id = ?', [waiting.taskId]), [])
  assert.equal(readFileSync(changed, 'utf8'), oldText, 'The edit must not run before owner approval')
  const writeGranted = await post(origin, one.cookie, 'answer', { id: pending.id, value: '允许本任务写入' })
  assert.equal(writeGranted.state, 'resolved'); assert.equal(writeGranted.answeredBy, 'gui')
  assert.equal((await messageCompleted(project.id, iteration.id)).source.sessionId, leader.id)
  const task = await until('authorized Worker to deliver its native edit and pnpm check', async () => {
    const row = await post(origin, one.cookie, 'task', { taskId: waiting.taskId })
    assert.ok(!['waiting_approval', 'blocked', 'interrupted', 'cancelled'].includes(row.status), JSON.stringify(row))
    return row.status === 'delivered' && row
  }, 135_000)
  assert.deepEqual((await projectTasks(one.cookie)).items, [task])
  assert.deepEqual([task.projectId, task.sourceSessionId, task.sourceMessageId, task.permission, task.workspacePath],
    [project.id, leader.id, `agent-studio-owner:${iteration.id}`, 'workspace-write', repo])
  assert.equal(task.authorizationVersion, waiting.authorizationVersion + 2) // 批准写入和交付撤权各推进一次。
  assert.equal(task.workerSessionId, task.source.sessionId); assert.notEqual(task.workerSessionId, leader.id)
  assert.equal(task.checkResult.version, 1)
  assert.deepEqual(task.checkResult.changedFiles, [{ path: labelPath, action: 'edit' }])
  assert.equal(task.checkResult.overallCheckStatus, 'passed', JSON.stringify(task.checkResult))
  assert.deepEqual(task.checkResult.checks.map(({ command, workdir, exitCode, status }) => [command, workdir, exitCode, status]),
    [['pnpm check', repo, 0, 'passed']])
  assert.ok(task.resultSummary.includes(workerReply))
  assert.equal(readFileSync(changed, 'utf8'), oldText.replaceAll(editLabel.old_string, editLabel.new_string))
  assert.equal(readFileSync(join(source, labelPath), 'utf8'), oldText, 'Only the clone label may change')
  proof(`PID1 current Leader delegated task ${task.taskId}; waiting_approval → GUI workspace-write approval → native Worker read/edit and pnpm check (exit 0); changedFiles=${JSON.stringify(task.checkResult.changedFiles)}`)
  const settings = await post(origin, one.cookie, 'configuration')
  assert.equal(settings.profile, profile); assert.equal(settings.writable, true); assert.equal(settings.credentialsWritable, true)
  const check = await post(origin, one.cookie, 'feishuCheck', { action: 'start', revision: settings.revision, ...binding, secret })
  await until('Feishu synthetic transport waiting', async () => {
    const value = await post(origin, one.cookie, 'feishuCheck', { action: 'status', id: check.id })
    assert.notEqual(value.state, 'failed', value.reason)
    return value.state === 'waiting'
  })
  write(join(root, 'challenge.json'), { phrase: check.phrase, now: Date.now() })
  const verified = await until('verified isolated Feishu binding', async () => {
    const value = await post(origin, one.cookie, 'feishuCheck', { action: 'status', id: check.id })
    assert.notEqual(value.state, 'failed', value.reason)
    return value.state === 'verified' && value
  })
  assert.deepEqual(verified.binding, binding)
  rmSync(join(root, 'challenge.json'))
  await post(origin, one.cookie, 'saveConfiguration', { revision: settings.revision, allowReload: true, verificationId: check.id,
    config: { ...settings.config, feishu: { mode: 'conversation', binding } } })
  await until('healthy Studio with saved credential', async () => (await health(origin, one.cookie)).feishu === 'online')
  const profileFile = join(profileDir(dshHome, profile), 'cordis.patch.yml')
  const reference = /studioFeishuCredentialId:\s*([a-f0-9-]{36})/u.exec(readFileSync(profileFile, 'utf8'))?.[1]
  assert.ok(reference)
  const data = async cookie => ({
    project: (await post(origin, cookie, 'state')).projects.find(item => item.id === project.id),
    assistant: (await post(origin, cookie, 'timeline', { conversationId: 'assistant' })).items,
    leader: (await post(origin, cookie, 'timeline', { conversationId: project.id })).items,
    leaderRecord: await post(origin, cookie, 'record', { sessionId: leader.id }),
    task: await post(origin, cookie, 'task', { taskId: task.taskId }),
    taskLedger: snapshot(`SELECT t.*, e.* FROM studio_task t JOIN studio_task_execution e USING (task_id)
      WHERE t.task_id = ? ORDER BY e.execution_epoch`, [task.taskId]),
    worker: await post(origin, cookie, 'record', { sessionId: task.workerSessionId }),
    archive: await post(origin, cookie, 'projectArchive', { projectId: project.id }), global: await post(origin, cookie, 'preferences'),
    scoped: await post(origin, cookie, 'preferences', { projectId: project.id }),
    feishu: (await post(origin, cookie, 'configuration')).feishu, binding: snapshot('SELECT * FROM agent_studio_feishu_binding'),
    profileFingerprint: createHash('sha256').update(readFileSync(profileFile)).digest('hex'),
    reference: /studioFeishuCredentialId:\s*([a-f0-9-]{36})/u.exec(readFileSync(profileFile, 'utf8'))?.[1],
  })
  const original = await data(one.cookie)
  assert.equal(original.reference, reference); assert.equal(original.binding.length, 1)
  assert.equal(original.feishu.credential, 'stored'); assert.equal(original.feishu.state, 'online')
  assert.ok(original.assistant.some(item => item.replyTo === assistant.id && item.text === assistantReply))
  assert.ok(original.leader.some(item => item.id === iteration.id && item.text === iterationRequest))
  assert.ok(original.leaderRecord.events.some(event => event.kind === 'tool/call'
    && event.text === 'studio_delegate_task\n{"permission":"workspace-write"}'))
  assert.ok(original.leader.some(item => item.replyTo === iteration.id && item.text === task.resultSummary && item.source?.sessionId === task.workerSessionId))
  assert.deepEqual(original.task, task)
  assert.equal(original.taskLedger.length, 1)
  const [ledger] = original.taskLedger
  assert.deepEqual(JSON.parse(ledger.check_result), task.checkResult)
  assert.deepEqual([ledger.status, ledger.outcome, ledger.session_id, ledger.result_event_seq, ledger.captured_management_epoch],
    ['delivered', 'delivered', task.workerSessionId, task.source.eventSeq, coordinate.expectedEpoch])
  assert.equal(original.worker.record.role, 'worker')
  assert.ok(original.worker.events.some(event => event.kind === 'tool/call' && event.text === `edit\n${JSON.stringify(editLabel)}`))
  assert.equal(original.worker.events.find(event => event.seq === task.source.eventSeq)?.text, workerReply)
  assert.equal(readFileSync(profileFile, 'utf8').includes(secret), false)
  proof('read back native conversations, SQLite task receipt and Worker provenance, project/archive, both preferences, Feishu binding and credential reference')
  const prepare = (cookie, requestId, expectedCurrentFingerprint) => post(origin, cookie, 'prepareSelfUpdate', { requestId, expectedCurrentFingerprint, ...coordinate })
  const approveUpdate = async (cookie, row) => {
    assert.equal(row.pendingId, `self-update:${row.updateId}`)
    const pending = (await post(origin, cookie, 'pending')).items.find(item => item.id === row.pendingId)
    assert.deepEqual(pending?.options, ['批准更新', '取消更新']); assert.equal(pending?.state, 'pending')
    const item = await post(origin, cookie, 'answer', { id: pending.id, value: '批准更新' })
    assert.equal(item.answeredBy, 'gui'); assert.equal(item.state, 'resolved')
  }
  const firstUpdate = await prepare(one.cookie, 'good-update', healthy0.artifactFingerprint)
  assert.equal(firstUpdate.phase, 'prechecking')
  const ready = await record(origin, one.cookie, firstUpdate.updateId, 'awaiting_confirmation', 610_000)
  assert.deepEqual([ready.projectId, ready.projectEpoch, ready.baselineFingerprint],
    [coordinate.projectId, coordinate.expectedEpoch, healthy0.artifactFingerprint])
  assert.equal(ready.exitCode, 0); assert.notEqual(ready.candidateFingerprint, healthy0.artifactFingerprint)
  const checkLog = readFileSync(updatePath(ready.updateId, 'precheck.log'), 'utf8')
  assert.match(checkLog, /pnpm exec tsc --noEmit[\s\S]+pnpm exec vitest run[\s\S]+pnpm exec tsdown/u)
  assert.equal(realpathSync(current), baseline); assert.equal(same(one.pid), true); await sidePing()
  proof(`bound-project prepareSelfUpdate (epoch ${ready.projectEpoch}) passed isolated tsc, vitest and tsdown; preparation did not switch current`)
  const firstLink = lstatSync(current).ino
  await approveUpdate(one.cookie, ready)
  const success = await handoff(ready.updateId, 'succeeded')
  const v1 = join(releases, ready.updateId)
  assert.equal(realpathSync(current), v1); assert.ok(lstatSync(current).isSymbolicLink()); assert.notEqual(lstatSync(current).ino, firstLink)
  assert.deepEqual(await first.done, { code: 0, signal: null }); assert.equal(same(one.pid), false)
  const seal = json(updatePath(ready.updateId, 'seal.json'))
  assert.equal(seal.checkpointed, true); assert.ok(Date.parse(seal.sealedAt) && seal.runId)
  const two = await login(profile, origin, v1), healthy1 = await health(origin, two.cookie)
  assert.notEqual(two.pid, one.pid)
  assert.deepEqual([healthy1.pid, healthy1.buildId, healthy1.artifactFingerprint, healthy1.ready], [two.pid, ready.candidateBuildId, ready.candidateFingerprint, true])
  assert.equal((await record(origin, two.cookie, ready.updateId, 'succeeded')).candidateFingerprint, healthy1.artifactFingerprint)
  assert.equal(success.logRef, 'controller.log'); assert.equal(Object.hasOwn(success, 'logPath'), false)
  const backupDb = new DatabaseSync(updatePath(ready.updateId, 'baseline/managed-worker.sqlite.bak'), { readOnly: true })
  try { assert.equal(backupDb.prepare('PRAGMA quick_check').get().quick_check, 'ok') } finally { backupDb.close() }
  assert.deepEqual(await data(two.cookie), original)
  await verifyBrowser(origin, two.url, healthy1.buildId)
  await sidePing()
  proof(`GUI approved update; detached controller sealed SQLite and atomically selected v1; PID1=${one.pid} exited 0, PID2=${two.pid} ready with build ${healthy1.buildId}; Chromium rendered "${markerNew}"; retained records match exactly`)

  const packagePath = join(repo, 'package.json'), packageText = readFileSync(packagePath, 'utf8')
  const brokenPackage = JSON.parse(packageText)
  // 保留真实 check 命令，在 typecheck 本身加入明确的类型错误；坏版本不应生成确认。
  const badTs = join(repo, 'src/studio/smoke-typecheck.ts')
  assert.equal(existsSync(badTs), false)
  write(badTs, 'export const smokeTypecheck: number = "intentional Stage 4 fixture failure"\n')
  const prevLink = lstatSync(current).ino
  const broken = await prepare(two.cookie, 'bad-precheck', healthy1.artifactFingerprint)
  const failed = await record(origin, two.cookie, broken.updateId, 'failed_precheck', 610_000)
  assert.notEqual(failed.exitCode, 0); assert.equal(failed.failedPhase, 'prechecking'); assert.equal(failed.pendingId, undefined)
  assert.match(readFileSync(updatePath(broken.updateId, 'precheck.log'), 'utf8'), /smoke-typecheck\.ts.*TS2322/u)
  assert.equal((await post(origin, two.cookie, 'pending')).items.some(item => item.id.endsWith(broken.updateId)), false)
  assert.equal(realpathSync(current), v1); assert.equal(lstatSync(current).ino, prevLink); assert.equal((await health(origin, two.cookie)).pid, two.pid)
  rmSync(badTs); assert.deepEqual(json(packagePath), brokenPackage)
  await sidePing()
  proof('intentional TypeScript error failed real pnpm check; no pending approval and PID2/current inode unchanged')

  // 该发布字节是正常静态资产，只由隔离启动器识别；不改产品启动代码，不绕过构建、清单或健康校验。
  write(join(repo, 'studio-web', 'bad-smoke-release'), 'Unhealthy candidate exercise\n')
  write(badFlag, 'within this fixture only')
  const bad = await prepare(two.cookie, 'bad-start', healthy1.artifactFingerprint)
  const badReady = await record(origin, two.cookie, bad.updateId, 'awaiting_confirmation', 610_000)
  assert.equal(badReady.exitCode, 0)
  assert.match(readFileSync(updatePath(bad.updateId, 'precheck.log'), 'utf8'), /pnpm exec tsc --noEmit[\s\S]+pnpm exec vitest run[\s\S]+pnpm exec tsdown/u)
  await approveUpdate(two.cookie, badReady)
  const rolled = await handoff(bad.updateId, 'rolled_back')
  const restored = join(releases, `${bad.updateId}-baseline`)
  assert.equal(realpathSync(current), restored); assert.equal(same(two.pid), false)
  const three = await login(profile, origin, restored), recovered = await health(origin, three.cookie)
  const exited = readFileSync(join(root, 'exits.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.ok([one.pid, two.pid].every(pid => exited.some(entry => entry.pid === pid && entry.code === 0)))
  const attempts = readFileSync(join(root, 'hosts.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const candidates = attempts.filter(item => item.bad)
  assert.equal(candidates.length, 1); assert.equal(candidates[0].release, join(releases, bad.updateId))
  assert.notEqual(birth(candidates[0].pid), candidates[0].started, 'Failed candidate must not survive rollback')
  assert.equal(new Set([one.pid, two.pid, candidates[0].pid, three.pid, bystander.pid]).size, 5)
  assert.deepEqual([recovered.pid, recovered.buildId, recovered.artifactFingerprint, recovered.ready], [three.pid, healthy1.buildId, healthy1.artifactFingerprint, true])
  assert.equal(rolled.failedPhase, 'starting'); assert.equal(rolled.logRef, 'controller.log')
  assert.equal(rolled.failureCode, 'HEALTH_TIMEOUT'); assert.equal(Object.hasOwn(rolled, 'logPath'), false)
  assert.match(readFileSync(updatePath(bad.updateId, rolled.logRef), 'utf8'), /stopping[\s\S]+switching[\s\S]+starting[\s\S]+rolling_back \(failed: starting\)[\s\S]+rolled_back \(failed: starting\)/u)
  assert.equal((await record(origin, three.cookie, bad.updateId, 'rolled_back')).failedPhase, 'starting')
  assert.deepEqual(await data(three.cookie), original)
  await sidePing()
  proof(`healthy build but unhealthy candidate PID=${candidates[0].pid} was terminated; current restored baseline with PID3=${three.pid}, original v1 hash and intact data; state=rolled_back failedPhase=starting log=controller.log`)
  assert.ok(sideSamples >= 200, `Expected at least 200 authenticated bystander probes, got ${sideSamples}`)
  runSignal.signal.throwIfAborted()
  proof(`bystander PID=${bystander.pid} and authenticated Web listener stayed healthy across ${sideSamples} periodic probes and every checkpoint; no real accounts contacted`)
  completed = true
} catch (error) {
  // 只在失败时输出隔离启动日志的尾部；auth URL 和凭据不进入这些日志。
  for (const name of ['primary.log', 'side.log', 'browser.log']) {
    const path = join(root, name)
    if (existsSync(path)) console.error(`${name}:\n${readFileSync(path, 'utf8').slice(name === 'primary.log' ? -14_000 : -2000)}`)
  }
  throw error
} finally {
  clearInterval(sideMonitor)
  // 直接子进程有出生时刻，脱离的 runner/候选有私有回执；同时收拢工作目录仍在本轮短路径下的构建与浏览器孙进程。
  const evidence = join(root, 'hosts.ndjson')
  const collect = () => {
    for (const entry of readdirSync('/proc').filter(name => /^\d+$/u.test(name))) {
      const pid = Number(entry)
      if (pid === process.pid) continue
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`)
        if (cwd === root || cwd.startsWith(`${root}/`)) remember(pid)
      } catch (error) { if (!['EACCES', 'EPERM', 'ENOENT', 'ESRCH'].includes(error.code)) throw error }
    }
    if (existsSync(evidence)) for (const line of readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean)) {
      try { const { pid, started } = JSON.parse(line); if (started === birth(pid)) remember(pid) } catch { /* 写入可能尚未结束。 */ }
    }
    const updates = join(stateDir, 'updates')
    if (existsSync(updates)) for (const id of readdirSync(updates)) {
      const path = updatePath(id, 'runner-ready.json')
      if (existsSync(path)) {
        const { pid, started } = json(path)
        if (started?.split(':').at(-1) === birth(pid)) remember(pid)
      }
    }
  }
  for (const stopSignal of ['SIGTERM', 'SIGKILL']) {
    for (let round = 0; round < 100; round++) {
      collect()
      const active = [...own.keys()].filter(same)
      if (!active.length) break
      for (const pid of active) {
        try { process.kill(pid, stopSignal) } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      await pause(35)
    }
  }
  assert.deepEqual([...own.keys()].filter(same), [], 'Every fixture process must exit')
  assert.equal(realpathSync(root), root)
  rmSync(root, { recursive: true })
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
  if (completed) proof('all isolated children and temporary directories cleaned')
}
