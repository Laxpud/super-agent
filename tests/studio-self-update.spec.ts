import type { Context } from '@deepseek-ai/cordis'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createConnection, createServer as createSocketServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { validateStudioDatabase } from '../src/managed-worker/sqlite-state.ts'
import { ManagedWorkerStore } from '../src/managed-worker/store.ts'
import { lockStudioHostDirectory } from '../src/managed-worker/state-lock.ts'
import { computeReleaseManifest, RELEASE_ASSETS } from '../src/studio/build-info.ts'
import { openStudioHealthSocket, probeStudioHealth, studioHealthSocket } from '../src/studio/health.ts'
import { registerStudioHttp, type StudioHttpOperations } from '../src/studio/http.ts'
import { SELF_UPDATE_CHOICES, STUDIO_HEADER, STUDIO_HEALTH, type StudioSelfUpdateRecord } from '../src/studio/protocol.ts'
import { StudioSelfUpdate } from '../src/studio/self-update.ts'
import { handoffStudioUpdate, runStudioUpdateController, type StudioControllerPlan } from '../src/studio/self-update-controller.ts'
import { atomicJson, copyRelease, lockStudioInstallRoot, releaseTarget, switchRelease } from '../src/studio/self-update-files.ts'
import { StudioService } from '../src/studio/service.ts'
import { STUDIO_DB, type StudioSelfUpdateConfig } from '../src/studio/settings-protocol.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

function temp() {
  const dir = mkdtempSync(join(realpathSync('/tmp'), 'su-'))
  cleanups.push(() => { if (realpathSync(dir) === dir) rmSync(dir, { recursive: true }) })
  return dir
}
const mkdir = (path: string) => { mkdirSync(path, { mode: 0o700, recursive: true }); return path }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const signal = new AbortController().signal
const [approve, cancel] = SELF_UPDATE_CHOICES
const noop = () => {}
const err = (code: string, status = 409) => expect.objectContaining({ code, status })
const loopback = 'http://127.0.0.1:38472'
const snapshotPath = (stateDir: string, updateId: string, name: string) => join(stateDir, 'updates', updateId, name)
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for Studio fixture')
    await delay(20)
  }
}

function release(root: string, buildId: string) {
  for (const name of RELEASE_ASSETS) {
    const path = join(root, name)
    if (['package.json', 'cordis.patch.yml'].includes(name)) writeFileSync(path, name === 'package.json' ? '{"name":"agent-studio"}' : '[]')
    else mkdir(path)
  }
  mkdir(join(root, 'studio-web', 'lib'))
  for (const path of ['lib/managed-worker.js', 'lib/self-update-runner.js', 'studio-web/index.js']) writeFileSync(join(root, path), '// fixture\n')
  writeFileSync(join(root, 'studio-web/lib/client.js'), `/* agent-studio-build:${buildId} */\n`)
  return computeReleaseManifest(root).artifactFingerprint
}

function fixture(overrides: Partial<StudioSelfUpdateConfig> = {}, failedCheck = false,
  mode: 'mock' | 'real-precheck' | 'real-handoff' = 'mock', runnerBody?: string) {
  const root = temp(), stateDir = mkdir(join(root, 's')), installRoot = mkdir(join(root, 'i'))
  const packageRoot = mkdir(join(installRoot, 'releases', 'v0')), repoPath = mkdir(join(root, 'repo'))
  release(packageRoot, 'baseline')
  if (runnerBody) writeFileSync(join(packageRoot, 'lib', 'self-update-runner.js'), runnerBody)
  const artifactFingerprint = computeReleaseManifest(packageRoot).artifactFingerprint
  symlinkSync('releases/v0', join(installRoot, 'current'))
  mkdir(join(repoPath, 'src', 'managed-worker')); mkdir(join(repoPath, 'src', 'studio-web'))
  for (const name of ['cordis.patch.yml', 'tsdown.config.ts', 'pnpm-lock.yaml', 'src/managed-worker/index.ts', 'src/studio-web/index.tsx']) {
    writeFileSync(join(repoPath, name), '')
  }
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'agent-studio', packageManager: 'pnpm@11.7.0',
    scripts: { check: 'node -e "process.exit(17)"' } }))
  const path = join(stateDir, STUDIO_DB), domain = new ManagedWorkerStore(path, stateDir)
  const stop = new AbortController(), handoff = vi.fn(async () => {})
  let updates: StudioSelfUpdate
  cleanups.push(async () => { stop.abort(); await updates?.drain(); domain.close() })
  const precheck = vi.fn(async (source: string, work: string, log: string, buildId: string) => {
    let exitCode: number | null = 0
    if (failedCheck) {
      // 复用已经运行测试的 pnpm 版本；临时 HOME 不应为单测再次联网安装工具。
      const corepackHome = process.env.COREPACK_HOME ?? join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'node', 'corepack')
      const checked = spawnSync('pnpm', ['check'], { cwd: source, env: { HOME: root, PATH: process.env.PATH,
        COREPACK_HOME: corepackHome, COREPACK_ENABLE_NETWORK: '0', CI: 'true' }, encoding: 'utf8', timeout: 12_000 })
      if (checked.error) throw checked.error
      exitCode = checked.status
      writeFileSync(log, checked.stdout + checked.stderr)
    } else release(work, buildId)
    return { exitCode, sourceHead: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) }
  })
  const build = { packageRoot, artifactFingerprint, buildId: 'baseline', version: '0.1.0' }
  const config = { repoPath, installRoot, reloadCommand: { executable: process.execPath, args: ['--profile', 'isolated'], profileName: 'isolated' }, ...overrides }
  let draining = false, sealed = false
  const runtime = { stopping: stop.signal, canReload: () => true, origin: () => loopback, enterMaintenance: () => {
    draining = true
    return () => { draining = false }
  }, busy: () => false, sealed: (value: boolean) => { sealed = value; if (!value) draining = false }, wake: noop,
  warn: (message: string) => { throw new Error(message) } }
  updates = new StudioSelfUpdate(domain, runtime, { stateDir, build, config, runPrecheck: mode === 'real-precheck' ? undefined : precheck,
    handoff: mode === 'real-handoff' ? handoffStudioUpdate : handoff })
  const ctx = { on: () => noop, logger: { warn: noop } } as unknown as Context
  const service = new StudioService(ctx, domain, repoPath, { assistant: null, leader: null }, () => true,
    stop.signal, () => 'disabled', noop, undefined, { updates, draining: () => draining, sealed: () => sealed, available: () => true, configOk: () => true })
  const input = { requestId: 'prepare', expectedCurrentFingerprint: artifactFingerprint }
  const prepare = () => {
    const record = service.operations.prepareSelfUpdate(input, signal) as StudioSelfUpdateRecord
    expect(record.phase).toBe('prechecking')
    return record
  }
  const awaiting = async () => { const { updateId } = prepare(); await updates.drain(); return updates.status(updateId).record! }
  return { root, repoPath, installRoot, packageRoot, stateDir, path, domain, updates, service, ctx, handoff, precheck, input, prepare, awaiting,
    runtime, config, build, draining: () => draining }
}

it('hashes sorted relative paths and every runtime asset byte, without including the release manifest itself', () => {
  const root = temp()
  release(root, 'v0')
  writeFileSync(join(root, 'locale/Z.json'), 'first')
  writeFileSync(join(root, 'locale/A.json'), 'second')
  const manifest = computeReleaseManifest(root)
  const paths = Object.keys(manifest.files)
  expect(paths).toEqual([...paths].sort())
  const encoded = paths.map(path => JSON.stringify([path, sha(readFileSync(join(root, path)))]) + '\n').join('')
  expect(manifest.artifactFingerprint).toBe(sha(encoded))
  writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest))
  expect(computeReleaseManifest(root)).toEqual(manifest)
  for (const path of paths) {
    const location = join(root, path), bytes = readFileSync(location)
    writeFileSync(location, Buffer.concat([bytes, Buffer.from('!')]))
    expect(computeReleaseManifest(root).artifactFingerprint, path).not.toBe(manifest.artifactFingerprint)
    writeFileSync(location, bytes)
  }
  symlinkSync('A.json', join(root, 'locale/alias'))
  expect(() => computeReleaseManifest(root)).toThrow('regular files or directories')
})

it('requires registered canonical roots and fences project IDs, epochs, workspace and current fingerprint', async () => {
  const disabled = fixture({ repoPath: '' })
  expect(() => disabled.updates.prepareUpdate(disabled.input, signal)).toThrow(err('STUDIO_SELF_UPDATE_DISABLED'))
  const invalid = fixture({ repoPath: 'arbitrary-relative-path' })
  expect(() => invalid.updates.prepareUpdate(invalid.input, signal)).toThrow(err('STUDIO_UPDATE_SOURCE_INVALID'))
  const badInstall = fixture({ installRoot: '/tmp' })
  expect(() => badInstall.updates.prepareUpdate(badInstall.input, signal)).toThrow(err('STUDIO_UPDATE_INSTALL_INVALID'))
  expect(() => fixture({ reloadCommand: { executable: process.execPath, args: ['--from-default-profile=web'] } })).toThrow('Invalid Studio reload recipe')
  const f = fixture()
  const project = f.domain.projects.create({ name: 'Source', objective: 'Update', workspacePath: f.repoPath, leaderSessionId: 'fixture-leader' })
  const different = f.domain.projects.create({ name: 'Unbound', objective: 'Other', leaderSessionId: 'other-leader' })
  expect(() => f.updates.prepareUpdate({ ...f.input, projectId: 'unknown', expectedEpoch: 1 }, signal)).toThrow(err('PROJECT_NOT_FOUND', 404))
  expect(() => f.updates.prepareUpdate({ ...f.input, projectId: project.id, expectedEpoch: 2 }, signal)).toThrow(err('PROJECT_EPOCH_CONFLICT'))
  expect(() => f.updates.prepareUpdate({ ...f.input, projectId: different.id, expectedEpoch: 1 }, signal)).toThrow(err('STUDIO_UPDATE_WORKSPACE_MISMATCH'))
  expect(() => f.updates.prepareUpdate({ ...f.input, expectedCurrentFingerprint: 'f'.repeat(64) }, signal)).toThrow(err('STUDIO_UPDATE_FINGERPRINT_CONFLICT'))
  expect(f.precheck).not.toHaveBeenCalled()
  expect(f.domain.studio.pendingCount()).toBe(0)
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  expect(f.updates.prepareUpdate({ ...f.input, projectId: project.id, expectedEpoch: 1 }, signal).phase).toBe('prechecking')
  await f.updates.drain()
  expect(f.updates.status().record).toMatchObject({ projectId: project.id, projectEpoch: 1, phase: 'awaiting_confirmation' })
})

it('retains the idempotent receipt and never creates a confirmation or moves current after a real failing pnpm check', async () => {
  const f = fixture({}, true)
  const record = f.prepare()
  expect(f.updates.prepareUpdate(f.input, signal)).toEqual(record)
  expect(() => f.updates.prepareUpdate({ ...f.input, expectedCurrentFingerprint: 'c'.repeat(64) }, signal)).toThrow(err('STUDIO_UPDATE_REQUEST_CONFLICT'))
  await f.updates.drain()
  expect(f.updates.prepareUpdate(f.input, signal)).toMatchObject({ updateId: record.updateId, phase: 'failed_precheck', failedPhase: 'prechecking', exitCode: 17 })
  expect(readFileSync(snapshotPath(f.stateDir, record.updateId, record.logRef), 'utf8')).toContain('process.exit(17)')
  expect(f.precheck).toHaveBeenCalledTimes(1)
  expect(f.handoff).not.toHaveBeenCalled()
  expect(f.domain.studio.pendingCount()).toBe(0)
  expect(readlinkSync(join(f.installRoot, 'current'))).toBe('releases/v0')
}, 15_000)

it.each(['gui', 'feishu'] as const)('creates only a confirmation and settles a Web/Feishu CAS race once (%s wins)', async winner => {
  const f = fixture(), port = f.service.feishu
  port.activate('offline', Date.now())
  const ready = await f.awaiting(), id = `self-update:${ready.updateId}`
  expect(ready).toMatchObject({ phase: 'awaiting_confirmation', pendingId: id, candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
  expect(f.domain.studio.pending().items).toEqual([expect.objectContaining({ id, kind: 'confirmation', state: 'pending', options: [approve, cancel] })])
  expect(f.handoff).not.toHaveBeenCalled()
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  port.finish(port.next('offline')!.id, 'om_card')
  const gui = () => f.service.operations.answer({ id, value: approve }, signal)
  const mobile = () => port.answer({ scope: 'offline', messageId: 'om_card', pendingId: id, value: approve })
  const actions = winner === 'gui' ? [gui, mobile] : [mobile, gui]
  const results = await Promise.allSettled(actions.map(async answer => answer()))
  if (winner === 'gui') {
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { state: 'resolved', answeredBy: 'gui' } })
    expect(results[1]).toEqual({ status: 'fulfilled', value: false })
  } else {
    expect(results[0]).toEqual({ status: 'fulfilled', value: true })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: err('STUDIO_UPDATE_CONFIRMATION_INVALID') })
  }
  expect(() => gui()).toThrow(err('STUDIO_UPDATE_CONFIRMATION_INVALID'))
  expect(mobile()).toBe(false)
  await f.updates.drain()
  expect(f.handoff).toHaveBeenCalledTimes(1)
  expect(f.domain.studio.pendingItem(id)).toMatchObject({ state: 'resolved', answeredBy: winner })
})

it('rejects manual Feishu recovery of a reserved update approval and expires the original confirmation', async () => {
  const f = fixture(), port = f.service.feishu
  const cutover = Date.now()
  port.activate('offline', cutover)
  const { updateId, pendingId, expiresAt } = await f.awaiting()
  port.finish(port.next('offline')!.id, 'om_card')
  f.service.bindFeishuLookup({ scope: 'offline', verifiedMessage: async id => ({ id, scope: 'offline', sourceTimeMs: cutover + 1,
    text: id === 'om_anchor' ? approve : `${approve} ${pendingId}`, ...(id === 'om_anchor' && { parentId: 'om_card' }) }) })
  for (const messageId of ['om_anchor', 'om_explicit']) {
    await expect(f.service.operations.resubmitFeishuMessage({ messageId }, signal)).rejects.toMatchObject(err('FEISHU_RECOVERY_CONTROL_UNSUPPORTED'))
    expect(f.domain.studio.feishuInput('offline', messageId)).toBeUndefined()
  }
  expect(f.domain.studio.pendingItem(pendingId!)?.state).toBe('pending')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(expiresAt!)
  expect(() => f.service.operations.answer({ id: pendingId!, value: approve }, signal)).toThrow(err('STUDIO_UPDATE_CONFIRMATION_INVALID'))
  expect(port.answer({ scope: 'offline', messageId: 'om_card', pendingId: pendingId!, value: approve })).toBe(false)
  expect(f.updates.status(updateId).record?.phase).toBe('expired')
  expect(f.domain.studio.pendingItem(pendingId!)?.state).toBe('expired')
  expect(f.handoff).not.toHaveBeenCalled()
})

it('requires a fresh, cancellable rollback confirmation for a verified baseline', () => {
  const f = fixture(), updateId = randomUUID(), dir = mkdir(join(f.stateDir, 'updates', updateId))
  const baselineFingerprint = release(mkdir(join(dir, 'baseline')), 'older')
  const ledger = f.domain.enableSelfUpdateLedger()
  const target: StudioSelfUpdateRecord = { updateId, kind: 'update', phase: 'succeeded', candidateBuildId: 'baseline', baselineBuildId: 'older',
    baselineFingerprint, candidateFingerprint: f.input.expectedCurrentFingerprint, createdAt: Date.now(), updatedAt: Date.now(), logRef: 'controller.log' }
  ledger.start(target, 'historic', 'historic')
  const request = { ...f.input, updateId }
  const rollback = f.updates.rollbackSelfUpdate(request, signal)
  expect(rollback.updateId).not.toBe(updateId)
  expect(rollback).toMatchObject({ kind: 'rollback', phase: 'awaiting_confirmation', rollbackOf: updateId,
    pendingId: `self-update-rollback:${rollback.updateId}`, candidateBuildId: 'older', candidateFingerprint: baselineFingerprint })
  expect(f.updates.rollbackSelfUpdate(request, signal)).toEqual(rollback)
  expect(f.domain.studio.pendingCount()).toBe(1)
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  expect(f.service.operations.answer({ id: rollback.pendingId!, value: cancel }, signal)).toMatchObject({ state: 'resolved', answeredBy: 'gui' })
  expect(f.updates.status(rollback.updateId).record?.phase).toBe('cancelled')
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  expect(f.handoff).not.toHaveBeenCalled()
})

it('refuses a WAL-busy seal, then writes a clean fence to the main database after the reader releases', () => {
  const f = fixture()
  using reader = new DatabaseSync(f.path, { readOnly: true })
  reader.exec('BEGIN')
  expect(reader.prepare('SELECT clean FROM studio_host_run').get()?.clean).toBe(0)
  f.domain.studio.activateFeishu('persist-me', Date.now())
  expect(statSync(`${f.path}-wal`).size).toBeGreaterThan(0)
  expect(() => f.domain.checkpointAndSeal()).toThrow('Studio WAL checkpoint is busy or failed')
  expect(() => f.domain.assertActive()).not.toThrow()
  reader.exec('ROLLBACK')
  const receipt = f.domain.checkpointAndSeal()
  expect(receipt).toEqual({ checkpointed: true, runId: f.domain.runId, sealedAt: expect.any(String) })
  expect(statSync(`${f.path}-wal`).size).toBe(0)
  const standalone = join(f.root, 'checkpoint.sqlite')
  writeFileSync(standalone, readFileSync(f.path))
  using sealed = new DatabaseSync(standalone, { readOnly: true })
  expect(sealed.prepare('SELECT run_id, clean FROM studio_host_run').get()).toEqual({ run_id: receipt.runId, clean: 1 })
  expect(sealed.prepare('SELECT scope FROM agent_studio_feishu_binding').get()?.scope).toBe('persist-me')
  expect(() => f.domain.assertActive()).toThrow()
})

it('serves authenticated, minimal read-only health and rejects arbitrary request paths over real HTTP', async () => {
  const f = fixture(), beginWrite = vi.fn(() => noop), peer = { id: 'browser', principal: { kind: 'owner' } }
  f.domain.studio.addUser({ requestId: 'hello', conversationId: 'assistant', text: 'private chat', channel: 'gui' })
  const http = createServer()
  cleanups.push(() => { http.closeAllConnections(); http.close() })
  const ctx = { ...f.ctx, webServer: { register({ handler }: { handler: Parameters<typeof http.on>[1] }) { http.on('request', handler); return noop } } }
  registerStudioHttp(ctx as unknown as Context, { browserPeer: peer, admit: req => req.headers.cookie === 'auth=test' ? { peer } : { rejection: 401 } },
    () => true, f.service.operations as StudioHttpOperations, { health: () => f.service.health(), beginWrite })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing isolated listener')
  const origin = `http://127.0.0.1:${address.port}`, headers = { cookie: 'auth=test', [STUDIO_HEADER]: '1' }
  expect((await fetch(origin + STUDIO_HEALTH)).status).toBe(401)
  expect((await fetch(origin + STUDIO_HEALTH, { headers: { cookie: headers.cookie } })).status).toBe(403)
  expect((await fetch(origin + STUDIO_HEALTH, { method: 'POST', headers })).status).toBe(405)
  const before = readFileSync(`${f.path}-wal`)
  for (let index = 0; index < 2; index++) {
    const response = await fetch(origin + STUDIO_HEALTH, { headers })
    expect(response.headers.get('cache-control')).toBe('no-store')
    const value: unknown = await response.json()
    expect(value).toEqual({ version: '0.1.0', buildId: 'development', artifactFingerprint: '', configOk: true, ok: true, ready: true,
      phase: 'ready', pid: process.pid, sqlite: { version: expect.any(Number), ok: true }, feishu: 'disabled' })
    expect(JSON.stringify(value)).not.toMatch(/private chat|credential|packageRoot|stateDir/u)
  }
  expect(readFileSync(`${f.path}-wal`)).toEqual(before)
  expect(beginWrite).not.toHaveBeenCalled()
  const api = await fetch(origin + '/agent-studio/api', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'prepareSelfUpdate', input: { ...f.input, repoPath: f.root, installRoot: f.root } }) })
  expect(api.status).toBe(400)
  expect(await api.json()).toMatchObject({ code: 'INVALID_INPUT' })
  expect(f.precheck).not.toHaveBeenCalled()
})

it('echoes independent Unix socket challenges, restricts socket permissions and removes the binding on exit', async () => {
  const f = fixture(), address = studioHealthSocket(f.stateDir)
  const close = await openStudioHealthSocket(f.stateDir, () => f.service.health())
  cleanups.push(close)
  expect(lstatSync(address).mode & 0o777).toBe(0o600)
  for (const nonce of [randomBytes(32).toString('hex'), randomBytes(32).toString('hex'), 'not-a-challenge']) {
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(address)
      let output = ''
      socket.setEncoding('utf8').on('data', part => { output += part }).on('end', () => resolve(output)).on('error', reject)
      socket.on('connect', () => socket.write(nonce + '\n'))
    })
    if (nonce.length === 64) expect(JSON.parse(response)).toEqual({ nonce, health: f.service.health() })
    else expect(response).toBe('')
  }
  expect(await probeStudioHealth(f.stateDir)).toEqual(f.service.health())
  close()
  expect(existsSync(address)).toBe(false)
  await expect(probeStudioHealth(f.stateDir)).rejects.toThrow()
})

it('rejects a no-op check script in the real isolated precheck without staging a candidate or approval', async () => {
  const f = fixture({}, false, 'real-precheck')
  const checked = (args: string[], input?: string) => {
    const result = spawnSync('git', args, { cwd: f.repoPath, input, encoding: 'utf8', timeout: 5_000 })
    expect(result.status, result.stderr ?? String(result.error)).toBe(0)
    return result.stdout.trim()
  }
  // 只为临时夹具写入合成 HEAD；隔离候选本身没有 Git 元数据，不依赖原仓库引用。
  checked(['init', '--quiet'])
  const tree = checked(['mktree'], '')
  const head = checked(['hash-object', '-w', '-t', 'commit', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nSynthetic test fixture\n`)
  checked(['update-ref', 'HEAD', head])
  writeFileSync(join(f.repoPath, 'package.json'), JSON.stringify({ name: 'agent-studio', scripts: {
    check: 'true', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsdown',
  } }))
  const receipt = f.prepare()
  await f.updates.drain()
  expect(f.updates.status(receipt.updateId).record).toMatchObject({ phase: 'failed_precheck', exitCode: 1, failureCode: 'PRECHECK_FAILED' })
  expect(readFileSync(snapshotPath(f.stateDir, receipt.updateId, 'precheck.log'), 'utf8')).toContain('scripts do not match')
  expect(f.domain.studio.pendingCount()).toBe(0)
  expect(existsSync(snapshotPath(f.stateDir, receipt.updateId, 'candidate'))).toBe(false)
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
})

it.skipIf(process.platform !== 'linux')('unseals the still-running baseline when the detached controller dies after staging stopping', async () => {
  const f = fixture({}, false, 'real-handoff', `import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectLocalProcess } from ${JSON.stringify(new URL('../src/studio/local-process.ts', import.meta.url).href)}
const path = process.argv[2], dir = dirname(path), plan = JSON.parse(readFileSync(path, 'utf8'))
const write = (name, value) => {
  const tmp = join(dir, name + '.tmp')
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, join(dir, name))
}
const { pid, bootId, starttime } = inspectLocalProcess(process.pid)
write('runner-ready.json', { pid, started: bootId + ':' + starttime })
const deadline = Date.now() + 4000
while (!existsSync(join(dir, 'seal.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
if (!existsSync(join(dir, 'seal.json'))) process.exit(46)
write('state.json', { ...plan.record, phase: 'stopping', updatedAt: Date.now() })
process.kill(process.pid, 'SIGKILL')
`)
  const ready = await f.awaiting()
  f.updates.answer(ready.pendingId!, approve, 'gui')
  await f.updates.drain()
  await until(() => f.updates.status(ready.updateId).record?.phase === 'failed_drain')
  expect(f.updates.status(ready.updateId).record).toMatchObject({ failedPhase: 'stopping', failureCode: 'CONTROLLER_EXITED' })
  expect(f.draining()).toBe(false)
  expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  expect(f.service.health().phase).toBe('ready')
  expect(() => f.domain.studio.addUser({ requestId: 'after-crash', conversationId: 'assistant', text: 'accepted after resuming', channel: 'gui' })).not.toThrow()
  expect(() => validateStudioDatabase(snapshotPath(f.stateDir, ready.updateId, `baseline/${STUDIO_DB}.bak`), f.domain.runId)).not.toThrow()
})

it.each(['baseline', 'candidate', 'unknown'] as const)('converges old-run intermediate phases on startup (%s) without replay or permanent busy', async actual => {
  const f = fixture(), ledger = f.domain.enableSelfUpdateLedger()
  const candidate = mkdir(join(f.installRoot, 'releases', 'next')), candidateFingerprint = release(candidate, 'next')
  const phases = ['prechecking', 'draining', 'stopping', 'switching', 'reloading'] as const
  const previous = phases.map(phase => {
    const updateId = randomUUID()
    mkdir(join(f.stateDir, 'updates', updateId))
    ledger.start({ updateId, kind: 'update', phase, candidateBuildId: 'next', baselineBuildId: 'baseline', baselineFingerprint: f.build.artifactFingerprint,
      candidateFingerprint: phase === 'prechecking' ? undefined : candidateFingerprint, logRef: 'precheck.log', createdAt: Date.now(), updatedAt: Date.now() }, updateId, updateId)
    return updateId
  })
  const build = { ...f.build }
  if (actual !== 'baseline') {
    build.packageRoot = actual === 'candidate' ? candidate : mkdir(join(f.installRoot, 'releases', 'unrelated'))
    build.buildId = actual === 'candidate' ? 'next' : 'unrelated'
    build.artifactFingerprint = actual === 'candidate' ? candidateFingerprint : release(build.packageRoot, build.buildId)
    switchRelease(f.installRoot, build.packageRoot, f.packageRoot)
  }
  f.domain.close()
  using _cleanup = { [Symbol.dispose]: () => domain.close() }
  const domain = new ManagedWorkerStore(f.path, f.stateDir)
  const startup = new StudioSelfUpdate(domain, f.runtime, { stateDir: f.stateDir, build, config: f.config, runPrecheck: f.precheck, handoff: f.handoff })
  for (const [index, updateId] of previous.entries()) {
    const record = startup.status(updateId).record!
    expect(record.phase).toBe(actual === 'unknown' || (actual === 'candidate' && index === 0) ? 'recovery_required'
      : actual === 'candidate' ? 'succeeded' : index === 0 ? 'failed_precheck' : 'rolled_back')
    expect(JSON.parse(readFileSync(snapshotPath(f.stateDir, updateId, 'state.json'), 'utf8')).phase).toBe(record.phase)
  }
  expect(startup.prepareUpdate({ requestId: 'new-after-restart', expectedCurrentFingerprint: build.artifactFingerprint }, signal).phase).toBe('prechecking')
  await startup.drain()
  expect(f.handoff).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'linux')('rejects a second state directory for the same install root and excludes even same-owner concurrent controllers', () => {
  const f = fixture(), secondDir = mkdir(join(f.root, 'second'))
  const unlock = lockStudioInstallRoot(f.installRoot, f.stateDir)
  try {
    expect(() => lockStudioInstallRoot(f.installRoot, f.stateDir)).toThrow(expect.objectContaining({ code: 'LOCK_CONFLICT' }))
    expect(() => lockStudioInstallRoot(f.installRoot, secondDir)).toThrow(expect.objectContaining({ code: 'LOCK_CONFLICT' }))
  } finally { unlock() }
  expect(() => lockStudioInstallRoot(f.installRoot, secondDir)).toThrow(expect.objectContaining({ code: 'LOCK_CONFLICT' }))
  lockStudioInstallRoot(f.installRoot, f.stateDir)()
  expect(JSON.parse(readFileSync(join(f.installRoot, '.studio-owner.json'), 'utf8'))).toEqual({ stateDirHash: sha(f.stateDir) })
  const secondStore = new ManagedWorkerStore(join(secondDir, STUDIO_DB), secondDir)
  try {
    const second = new StudioSelfUpdate(secondStore, f.runtime, { stateDir: secondDir, build: f.build, config: f.config })
    expect(() => second.prepareUpdate(f.input, signal)).toThrow(err('STUDIO_UPDATE_LOCK_CONFLICT'))
    expect(secondStore.studio.pendingCount()).toBe(0)
    expect(releaseTarget(f.installRoot)).toBe(f.packageRoot)
  } finally { secondStore.close() }
})

it.skipIf(process.platform !== 'linux')('never reclaims the state lock while the recorded host identity is still alive', async () => {
  const f = fixture()
  const unlock = await lockStudioHostDirectory(f.stateDir, noop)
  try {
    const owner = readFileSync(join(f.stateDir, 'runtime/host-lock.json'), 'utf8')
    const inode = lstatSync(`${f.stateDir}.lock`).ino
    await expect(lockStudioHostDirectory(f.stateDir, noop)).rejects.toMatchObject({ code: 'ELOCKED' })
    expect(lstatSync(`${f.stateDir}.lock`).ino).toBe(inode)
    expect(readFileSync(join(f.stateDir, 'runtime/host-lock.json'), 'utf8')).toBe(owner)
  } finally { unlock() }
  expect(existsSync(join(f.stateDir, 'runtime/host-lock.json'))).toBe(false)
  expect(existsSync(`${f.stateDir}.lock`)).toBe(false)
})

it('serves an allowlisted logRef and structured failureCode over HTTP even for a legacy absolute logPath', async () => {
  const f = fixture(), updateId = randomUUID(), dir = mkdir(join(f.stateDir, 'updates', updateId)), now = Date.now()
  const record = { updateId, kind: 'update', phase: 'draining', baselineBuildId: 'baseline', baselineFingerprint: f.build.artifactFingerprint,
    candidateBuildId: 'next', logRef: 'controller.log', createdAt: now, updatedAt: now, logPath: join(dir, 'controller.log') } as const
  f.domain.enableSelfUpdateLedger().start(record, 'legacy-path', 'legacy-path')
  atomicJson(dir, 'state.json', { ...record, phase: 'failed_drain', failedPhase: 'stopping', failureCode: 'STOP_TIMEOUT' })
  const http = createServer()
  cleanups.push(() => { http.closeAllConnections(); http.close() })
  const ctx = { ...f.ctx, webServer: { register({ handler }: { handler: Parameters<typeof http.on>[1] }) { http.on('request', handler); return noop } } }
  const peer = { id: 'browser', principal: { kind: 'owner' } }
  registerStudioHttp(ctx as unknown as Context, { browserPeer: peer, admit: () => ({ peer }) }, () => true, f.service.operations as StudioHttpOperations)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Missing isolated listener')
  const response = await fetch(`http://127.0.0.1:${address.port}/agent-studio/api`, { method: 'POST', headers: { [STUDIO_HEADER]: '1', 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'selfUpdateStatus', input: { updateId } }) })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).not.toContain('logPath')
  expect(text).not.toContain(f.root)
  expect(JSON.parse(text).record).toMatchObject({ phase: 'failed_drain', failureCode: 'STOP_TIMEOUT', logRef: 'controller.log' })
})

it('enforces an absolute Unix probe deadline despite receiving a continuous trickle of bytes', async () => {
  const f = fixture(), address = studioHealthSocket(f.stateDir)
  mkdir(join(f.stateDir, 'runtime'))
  let socketClosed = false
  const server = createSocketServer(socket => {
    const timer = setInterval(() => socket.write('.'), 20)
    socket.on('error', noop)
    socket.on('close', () => { clearInterval(timer); socketClosed = true })
    socket.resume()
  })
  cleanups.push(() => { server.close() })
  await new Promise<void>(resolve => server.listen(address, resolve))
  chmodSync(address, 0o600)
  const before = performance.now()
  await expect(probeStudioHealth(f.stateDir, 150)).rejects.toThrow('health response is unavailable')
  expect(performance.now() - before).toBeLessThan(1_500)
  await until(() => socketClosed)
})

function started(pid: number) {
  try {
    const result = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = result.slice(result.lastIndexOf(') ') + 2).split(' ')
    return ['Z', 'X'].includes(fields[0]!) ? undefined : `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}`
  } catch { return undefined }
}

it.skipIf(process.platform !== 'linux').each(['succeeded', 'rolled_back', 'recovery_required', 'db-corrupt', 'sigkill', 'origin-mismatch'] as const)(
  'runs the real controller with an atomic pointer and bounded replacement attempts: %s', async scenario => {
    const outcome = scenario === 'succeeded' || scenario === 'recovery_required' ? scenario : 'rolled_back'
    const f = fixture(), updateId = randomUUID(), dir = mkdir(join(f.stateDir, 'updates', updateId))
    const current = join(f.installRoot, 'current'), initialLink = lstatSync(current).ino
    const fallback = join(f.installRoot, 'releases', `${updateId}-baseline`), candidate = join(f.installRoot, 'releases', updateId)
    const candidateFingerprint = release(mkdir(join(dir, 'candidate')), 'next')
    const snapshot = join(dir, 'baseline'), backup = join(snapshot, `${STUDIO_DB}.bak`)
    copyRelease(f.packageRoot, snapshot, 'baseline', f.input.expectedCurrentFingerprint)
    f.domain.studio.activateFeishu('retained-binding', 123456)
    const history = join(f.root, 'launches'), oldExit = join(f.root, 'old-exit'), script = join(f.root, 'process.mjs')
    // fixture 仅替换 DSH 启动；真实子进程调用宿主锁、SQLite 和 Unix 健康服务。
    writeFileSync(script, `import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openStudioHealthSocket } from ${JSON.stringify(new URL('../src/studio/health.ts', import.meta.url).href)}
import { lockStudioHostDirectory } from ${JSON.stringify(new URL('../src/managed-worker/state-lock.ts', import.meta.url).href)}
import { ManagedWorkerStore } from ${JSON.stringify(new URL('../src/managed-worker/store.ts', import.meta.url).href)}
const [mode, current, candidate, state, history, oldExit, scenario, nextHash, baselineHash, origin] = process.argv.slice(2)
if (mode === 'old') {
  process.on('SIGTERM', () => { writeFileSync(oldExit, realpathSync(current)); process.exit(0) })
  process.send('ready')
} else {
  const path = realpathSync(current), next = path === candidate, db = join(state, '${STUDIO_DB}')
  const unlock = await lockStudioHostDirectory(state, error => { throw error })
  const owner = JSON.parse(readFileSync(join(state, 'runtime/host-lock.json'), 'utf8'))
  const register = () => appendFileSync(history, JSON.stringify({ pid: process.pid, path, started: owner.starttime,
    held: existsSync(state + '.lock') && owner.pid === process.pid }) + '\\n')
  if (next && scenario === 'db-corrupt') {
    register()
    writeFileSync(db, 'damaged SQLite header')
    writeFileSync(db + '-wal', 'discard this sidecar')
    writeFileSync(db + '-shm', 'discard this sidecar')
    unlock()
    process.exit(9)
  }
  const store = new ManagedWorkerStore(db, state)
  const ready = scenario === 'succeeded' || (!next && scenario !== 'recovery_required') || scenario === 'origin-mismatch'
  const close = await openStudioHealthSocket(state, () => ({ buildId: next ? 'next' : 'baseline', artifactFingerprint: next ? nextHash : baselineHash,
    pid: process.pid, ready, ok: ready, phase: ready ? 'ready' : 'starting', sqlite: store.sqliteHealth(), configOk: true, feishu: 'disabled',
    origin: next && scenario === 'origin-mismatch' ? 'http://127.0.0.1:38473' : origin }))
  register()
  if (next && scenario === 'sigkill') process.kill(process.pid, 'SIGKILL')
  process.on('SIGTERM', () => { close(); store.close(); unlock(); process.exit(0) })
}
setInterval(() => {}, 1000)
`)
    const old = spawn(process.execPath, ['--experimental-transform-types', script, 'old', current, candidate, f.stateDir, history, oldExit],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const oldPid = old.pid!
    const oldToken = started(oldPid)!
    const launches = (): Array<{ pid: number; path: string; started: string; held: boolean }> => existsSync(history)
      ? readFileSync(history, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
    cleanups.push(async () => {
      const pids = [{ pid: oldPid, started: oldToken.split(':').at(-1) }, ...launches()]
      for (const entry of pids) if (started(entry.pid)?.split(':').at(-1) === entry.started) process.kill(entry.pid, 'SIGTERM')
      for (let i = 0; i < 100 && pids.some(entry => started(entry.pid)?.split(':').at(-1) === entry.started); i++) await delay(20)
      for (const entry of pids) if (started(entry.pid)?.split(':').at(-1) === entry.started) process.kill(entry.pid, 'SIGKILL')
    })
    await new Promise<void>((resolve, reject) => {
      old.once('message', () => resolve()); old.once('exit', code => reject(new Error(`Old fixture exited before ready: ${code}`))); old.once('error', reject)
    })
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => old.on('exit', (code, signal) => resolve({ code, signal })))
    const record: StudioSelfUpdateRecord = { updateId, kind: 'update', phase: 'draining', candidateBuildId: 'next', candidateFingerprint,
      baselineBuildId: 'baseline', baselineFingerprint: f.input.expectedCurrentFingerprint, createdAt: Date.now(), updatedAt: Date.now(), logRef: 'controller.log' }
    const plan: StudioControllerPlan = { stateDir: f.stateDir, installRoot: f.installRoot, current: f.packageRoot, origin: loopback,
      old: { pid: oldPid, started: oldToken }, runId: f.domain.runId, healthTimeoutMs: 1_400, record, command: { executable: process.execPath,
        args: ['--experimental-transform-types', script, 'new', current, candidate, f.stateDir, history, oldExit, scenario, candidateFingerprint,
          record.baselineFingerprint, loopback] } }
    const planFile = join(dir, 'controller.json')
    atomicJson(dir, 'controller.json', plan)
    const run = runStudioUpdateController(planFile)
    const observed = new Set<string>()
    const watch = setInterval(() => { try { observed.add(releaseTarget(f.installRoot)) } catch { observed.add('missing') } }, 5)
    try {
      expect(realpathSync(current)).toBe(f.packageRoot)
      const seal = f.domain.checkpointAndSeal()
      await f.domain.backupSealedUpdate(backup)
      f.domain.close()
      atomicJson(dir, 'seal.json', seal)
      await run
    } finally { clearInterval(watch) }
    expect(await exited).toEqual({ code: 0, signal: null })
    expect(readFileSync(oldExit, 'utf8')).toBe(f.packageRoot)
    expect(lstatSync(current).isSymbolicLink()).toBe(true)
    expect(lstatSync(current).ino).not.toBe(initialLink)
    expect(observed.has('missing')).toBe(false)
    const final = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as StudioSelfUpdateRecord
    const log = readFileSync(join(dir, final.logRef), 'utf8')
    expect(final.phase).toBe(outcome)
    expect(final.logRef).toBe('controller.log')
    expect(() => validateStudioDatabase(backup, plan.runId)).not.toThrow()
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(log).toMatch(/stopping[\s\S]+switching[\s\S]+starting/u)
    if (outcome === 'succeeded') {
      expect(releaseTarget(f.installRoot)).toBe(candidate)
      const [next] = launches()
      expect(launches()).toHaveLength(1)
      expect(next?.pid).not.toBe(oldPid)
      expect(await probeStudioHealth(f.stateDir)).toMatchObject({ pid: next?.pid, ready: true, buildId: 'next', artifactFingerprint: candidateFingerprint })
    } else {
      const failureCode = { succeeded: undefined, recovery_required: 'ROLLBACK_FAILED', rolled_back: 'HEALTH_TIMEOUT', 'db-corrupt': 'DB_CORRUPT',
        sigkill: 'CANDIDATE_EXITED', 'origin-mismatch': 'ORIGIN_MISMATCH' }[scenario]
      expect(final).toMatchObject({ failedPhase: 'starting', failureCode })
      expect(releaseTarget(f.installRoot)).toBe(fallback)
      expect(log).toContain(`${outcome} (failed: starting) ${JSON.stringify({ failureCode })}`)
      const [failed, restored] = launches()
      expect(launches().map(entry => entry.path)).toEqual([candidate, fallback])
      expect(started(failed!.pid)).toBeUndefined()
      expect(new Set([oldPid, failed?.pid, restored?.pid]).size).toBe(3)
      if (outcome === 'rolled_back') {
        expect(await probeStudioHealth(f.stateDir)).toMatchObject({ pid: restored?.pid, ready: true, origin: loopback,
          buildId: 'baseline', artifactFingerprint: record.baselineFingerprint })
        expect(() => validateStudioDatabase(f.path)).not.toThrow()
        using restoredDb = new DatabaseSync(f.path, { readOnly: true })
        expect(restoredDb.prepare('SELECT scope, cutover FROM agent_studio_feishu_binding').get()).toEqual({ scope: 'retained-binding', cutover: 123456 })
      } else { await delay(150); expect(launches()).toHaveLength(2) }
      if (scenario === 'db-corrupt') expect(log).toContain('restoring_database (failed: starting) {"failureCode":"DB_CORRUPT"}')
      if (scenario === 'sigkill') {
        expect(failed?.held).toBe(true)
        expect(restored?.held).toBe(true)
        expect(JSON.parse(readFileSync(join(f.stateDir, 'runtime/host-lock.json'), 'utf8')).pid).toBe(restored?.pid)
      }
    }
  }, 8_000)
