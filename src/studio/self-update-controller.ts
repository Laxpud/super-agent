import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { restoreStudioDatabase, validateStudioDatabase } from '../managed-worker/sqlite-state.ts'
import { clearDeadStudioHostLock, tryStudioStateGuard } from '../managed-worker/state-lock.ts'
import type { ManagedWorkerStore } from '../managed-worker/store.ts'
import { isStudioLoopbackOrigin, probeStudioHealth } from './health.ts'
import { inspectLocalProcess, localProcessState } from './local-process.ts'
import type { StudioSelfUpdateFailureCode, StudioSelfUpdatePhase, StudioSelfUpdateRecord } from './protocol.ts'
import { minimalEnvironment } from './self-update-build.ts'
import { atomicJson, canonicalDirectory, copyRelease, lockStudioInstallRoot, logUpdateController, readPrivateJson, releaseTarget, StudioUpdateFailure,
  switchRelease, updateFailureCode, updateIdPattern, validateReloadCommand, verifyRelease, writeUpdateState, type StudioReloadCommand } from './self-update-files.ts'
import { STUDIO_DB } from './settings-protocol.ts'

type Seal = ReturnType<ManagedWorkerStore['checkpointAndSeal']>
interface Identity { pid: number; started: string }
export interface StudioControllerPlan {
  stateDir: string; installRoot: string; current: string; old: Identity; command: StudioReloadCommand
  runId: string; origin: string; healthTimeoutMs: number; record: StudioSelfUpdateRecord
}

function identity(pid: number): Identity | undefined {
  const state = inspectLocalProcess(pid)
  if (state && state !== 'gone') return { pid, started: `${state.bootId}:${state.starttime}` }
}

function processState(token: Identity): 'running' | 'gone' | 'unknown' {
  if (!token || typeof token.started !== 'string') return 'unknown'
  const [bootId = '', starttime = ''] = token.started.split(':')
  return localProcessState({ pid: token.pid, bootId, starttime })
}
const sameProcess = (token: Identity) => processState(token) === 'running'

export function liveStudioUpdateController(dir: string, runId: string): boolean {
  try {
    const plan = readPrivateJson<StudioControllerPlan>(join(dir, 'controller.json'))
    return plan.runId === runId && sameProcess(readPrivateJson<Identity>(join(dir, 'runner-ready.json')))
  } catch { return false }
}

async function stopKnownProcess(token: Identity, force = false): Promise<void> {
  const send = async (signal: NodeJS.Signals, timeout: number) => {
    const before = processState(token)
    if (before !== 'running') return before
    try { process.kill(token.pid, signal) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    const end = Date.now() + timeout
    let state = processState(token)
    while (state === 'running' && Date.now() < end) { await delay(75); state = processState(token) }
    return state
  }
  const stopped = await send('SIGTERM', 15_000)
  if (stopped === 'gone' || (force && stopped === 'running' && await send('SIGKILL', 3_000) === 'gone')) return
  throw new StudioUpdateFailure('STOP_TIMEOUT')
}

const candidatePath = (plan: StudioControllerPlan) => join(plan.installRoot, 'releases', plan.record.updateId)
const baselinePath = (plan: StudioControllerPlan) => join(plan.installRoot, 'releases', `${plan.record.updateId}-baseline`)
const backupPath = (dir: string) => join(dir, 'baseline', `${STUDIO_DB}.bak`)
const hasFile = (dir: string, name: string) => !!lstatSync(join(dir, name), { throwIfNoEntry: false })

/** 只有旧进程把封存和完整备份都落盘后，才向已占有发布根的控制器发布停机回执。 */
export async function handoffStudioUpdate(dir: string, plan: Omit<StudioControllerPlan, 'old'>, store: ManagedWorkerStore,
  signal: AbortSignal, sealed: (value: boolean) => void, settled: (record: StudioSelfUpdateRecord) => void): Promise<void> {
  const old = identity(process.pid)
  if (!old || releaseTarget(plan.installRoot) !== plan.current) throw new StudioUpdateFailure('FINGERPRINT_MISMATCH')
  if (!isStudioLoopbackOrigin(plan.origin)) throw new StudioUpdateFailure('ORIGIN_MISMATCH')
  validateReloadCommand(plan.command)
  const { record } = plan
  copyRelease(plan.current, join(dir, 'baseline'), record.baselineBuildId, record.baselineFingerprint)
  const path = join(dir, 'controller.json')
  atomicJson(dir, 'controller.json', { ...plan, old })
  signal.throwIfAborted()
  const runner = join(plan.current, 'lib', 'self-update-runner.js')
  if (realpathSync(runner) !== runner || !lstatSync(runner).isFile()) throw new StudioUpdateFailure('CONTROLLER_EXITED')
  // runner 以同一 HOME 重启宿主；不继承宿主密钥或其他启动环境。
  const child = spawn(process.execPath, [runner, path], { cwd: dir, shell: false, detached: true, stdio: 'ignore',
    env: { ...minimalEnvironment(), HOME: homedir() } })
  let exited = false, published = false
  child.once('error', () => { exited = true })
  child.once('exit', () => {
    exited = true
    if (!published) return
    try {
      // 控制器退出且 current 仍是未切换的本宿主发行目录，才可撤销同一运行的写栅栏。
      if (!sameProcess(old) || releaseTarget(plan.installRoot) !== plan.current) return
      store.resumeAfterSeal(plan.runId)
      sealed(false)
      let state = record
      try { state = readPrivateJson<StudioSelfUpdateRecord>(join(dir, 'state.json')) } catch { /* 旧宿主仍可恢复。 */ }
      const failedPhase = state.failedPhase ?? (state.phase === 'stopping' ? 'stopping' : 'draining')
      const failureCode = state.failureCode ?? 'CONTROLLER_EXITED'
      const terminal: StudioSelfUpdateRecord = { ...record, phase: 'failed_drain', failedPhase, failureCode, updatedAt: Date.now() }
      // SQLite 与文件分别落盘；任一副本的附加写入故障都不应影响另外一份收敛结果。
      try { settled(terminal) } catch { /* 仍尽力保留控制器镜像。 */ }
      try { writeUpdateState(dir, terminal, terminal.phase) }
      finally { logUpdateController(dir, terminal.phase, failedPhase, failureCode) }
    } catch { /* 无法确认没有切换或 SQLite 栅栏未释放时，不自动开放写入。 */ }
  })
  child.unref()
  let receipt: Seal | undefined
  try {
    const end = Date.now() + 5_000
    while (!exited && Date.now() < end && !hasFile(dir, 'runner-ready.json')) await delay(30, undefined, { signal })
    if (exited || !hasFile(dir, 'runner-ready.json')) {
      try {
        const state = readPrivateJson<StudioSelfUpdateRecord>(join(dir, 'state.json'))
        if (state.failureCode) throw new StudioUpdateFailure(state.failureCode)
      } catch (error) { if (error instanceof StudioUpdateFailure) throw error }
      throw new StudioUpdateFailure('CONTROLLER_EXITED')
    }
    const ready = readPrivateJson<Identity>(join(dir, 'runner-ready.json'))
    if (!child.pid || ready.pid !== child.pid || !sameProcess(ready)) throw new StudioUpdateFailure('CONTROLLER_EXITED')
    signal.throwIfAborted()
    try { receipt = store.checkpointAndSeal() } catch { throw new StudioUpdateFailure('SEAL_MISSING') }
    sealed(true)
    try { await store.backupSealedUpdate(backupPath(dir)) } catch { throw new StudioUpdateFailure('DB_CORRUPT') }
    signal.throwIfAborted()
    if (exited || !sameProcess(ready)) throw new StudioUpdateFailure('CONTROLLER_EXITED')
    try { atomicJson(dir, 'seal.json', receipt); published = true }
    catch (error) {
      // rename 成功后即使目录 fsync 报错，控制器也可能已见到回执，不得重新开放写入。
      if (!hasFile(dir, 'seal.json')) throw error
      published = true
    }
  } catch (error) {
    if (receipt && !published) { store.resumeAfterSeal(receipt.runId); sealed(false) }
    throw error
  }
}

function verifySeal(plan: StudioControllerPlan, dir: string): void {
  try {
    const seal = readPrivateJson<Seal>(join(dir, 'seal.json'))
    if (seal.checkpointed !== true || seal.runId !== plan.runId || !Number.isFinite(Date.parse(seal.sealedAt))) throw new Error('Invalid SQLite seal receipt')
  } catch { throw new StudioUpdateFailure('SEAL_MISSING') }
  try {
    validateStudioDatabase(backupPath(dir), plan.runId)
    validateStudioDatabase(join(plan.stateDir, STUDIO_DB), plan.runId)
  } catch { throw new StudioUpdateFailure('DB_CORRUPT') }
}

function launch(plan: StudioControllerPlan): { child: ChildProcess; token: () => Identity | undefined; exited: () => boolean } {
  const { executable, args, cwd, profileName, dshHome } = plan.command
  const child = spawn(executable, args, { cwd, stdio: 'ignore', shell: false,
    env: { ...minimalEnvironment(), HOME: homedir(), ...(dshHome && { DSH_HOME: dshHome }), ...(profileName && { DSH_PROFILE: profileName }) } })
  let ended = false
  let processIdentity = child.pid ? identity(child.pid) : undefined
  child.once('spawn', () => { if (!processIdentity && child.pid) processIdentity = identity(child.pid) })
  child.once('error', () => { ended = true })
  child.once('exit', () => { ended = true })
  child.unref()
  return { child, token: () => processIdentity, exited: () => ended }
}

async function awaitHealthy(plan: StudioControllerPlan, started: ReturnType<typeof launch>, buildId: string, fingerprint: string): Promise<void> {
  const deadline = Date.now() + plan.healthTimeoutMs
  while (Date.now() < deadline) {
    if (started.exited()) throw new StudioUpdateFailure('CANDIDATE_EXITED')
    const processIdentity = started.token()
    const status = await probeStudioHealth(plan.stateDir, Math.max(1, Math.min(1_000, deadline - Date.now()))).catch(() => undefined)
    if (Date.now() >= deadline) break
    if (status && processIdentity && sameProcess(processIdentity) && status.pid === processIdentity.pid && status.pid !== plan.old.pid) {
      if (status.buildId !== buildId || status.artifactFingerprint !== fingerprint) throw new StudioUpdateFailure('FINGERPRINT_MISMATCH')
      if ((status.origin !== undefined || status.ready) && status.origin !== plan.origin) throw new StudioUpdateFailure('ORIGIN_MISMATCH')
      if (status.ready === true && status.ok === true && status.phase === 'ready' && status.sqlite?.ok === true && status.configOk === true
        && (status.feishu === 'disabled' || status.feishu === 'online')) return
    }
    await delay(Math.max(1, Math.min(100, deadline - Date.now())))
  }
  throw new StudioUpdateFailure(started.exited() ? 'CANDIDATE_EXITED' : 'HEALTH_TIMEOUT')
}

function validateLiveDatabase(plan: StudioControllerPlan): void {
  try { validateStudioDatabase(join(plan.stateDir, STUDIO_DB)) }
  catch { throw new StudioUpdateFailure('DB_CORRUPT') }
}

async function stopFailedLaunch(started: ReturnType<typeof launch> | undefined): Promise<void> {
  if (!started || started.exited()) return
  const token = started.token()
  if (!token) throw new StudioUpdateFailure('STOP_TIMEOUT')
  await stopKnownProcess(token, true)
}

/** 控制器持有发布根内核锁，确认旧进程退出后才切换；回退前确认候选进程退出并核验／修复真实数据库。 */
export async function runStudioUpdateController(planFile: string): Promise<void> {
  const dir = canonicalDirectory(dirname(planFile), true)
  const plan = readPrivateJson<StudioControllerPlan>(planFile)
  const { record, current, installRoot } = plan
  if (basename(planFile) !== 'controller.json' || !updateIdPattern.test(record.updateId) || dir !== join(plan.stateDir, 'updates', record.updateId)
    || !record.candidateFingerprint || !sameProcess(plan.old) || !Number.isSafeInteger(plan.healthTimeoutMs)
    || plan.healthTimeoutMs < 1 || plan.healthTimeoutMs > 300_000 || !isStudioLoopbackOrigin(plan.origin)) throw new Error('Invalid Studio controller handoff')
  validateReloadCommand(plan.command)
  canonicalDirectory(plan.stateDir, true)
  const self = identity(process.pid)
  if (!self) throw new Error('Studio runner identity is unavailable')
  // 在任何写入前排他领取本次交接，重复调用不能覆盖原 runner 的状态或再次消费封存回执。
  mkdirSync(join(dir, 'runner-claim'), { mode: 0o700 })
  let phase: StudioSelfUpdatePhase = 'draining'
  let started: ReturnType<typeof launch> | undefined
  let unlock: (() => void) | undefined
  let stopped = false
  const transition = (next: StudioSelfUpdatePhase, failedPhase?: StudioSelfUpdatePhase, failureCode?: StudioSelfUpdateFailureCode) => {
    try { writeUpdateState(dir, record, next, { failedPhase, failureCode }) }
    catch (error) {
      // rename 后的成功回执已可能开放候选写入，即使 fsync 报错也不能再尝试回退。
      if (next !== 'succeeded' || readPrivateJson<StudioSelfUpdateRecord>(join(dir, 'state.json')).phase !== 'succeeded') throw error
    }
    phase = next
    logUpdateController(dir, next, failedPhase, failureCode)
  }
  try {
    unlock = lockStudioInstallRoot(installRoot, plan.stateDir)
    if (releaseTarget(installRoot) !== current) throw new StudioUpdateFailure('FINGERPRINT_MISMATCH')
    try {
      verifyRelease(current, record.baselineBuildId, record.baselineFingerprint)
      copyRelease(join(dir, 'baseline'), baselinePath(plan), record.baselineBuildId, record.baselineFingerprint)
      copyRelease(join(dir, 'candidate'), candidatePath(plan), record.candidateBuildId, record.candidateFingerprint)
    } catch { throw new StudioUpdateFailure('FINGERPRINT_MISMATCH') }
    atomicJson(dir, 'runner-ready.json', self)
    const deadline = Date.now() + 20_000
    while (sameProcess(plan.old) && Date.now() < deadline && !hasFile(dir, 'seal.json')) await delay(30)
    if (!sameProcess(plan.old) || !hasFile(dir, 'seal.json')) throw new StudioUpdateFailure('SEAL_MISSING')
    verifySeal(plan, dir)
    transition('stopping')
    await stopKnownProcess(plan.old)
    stopped = true
    verifySeal(plan, dir)
    transition('switching')
    try { verifyRelease(candidatePath(plan), record.candidateBuildId, record.candidateFingerprint) }
    catch { throw new StudioUpdateFailure('FINGERPRINT_MISMATCH') }
    switchRelease(installRoot, candidatePath(plan), current)
    transition('starting')
    started = launch(plan)
    await awaitHealthy(plan, started, record.candidateBuildId, record.candidateFingerprint)
    validateLiveDatabase(plan)
    transition('succeeded')
  } catch (error) {
    const failedPhase = phase
    let failureCode = updateFailureCode(error, 'CONTROLLER_EXITED')
    if (!stopped) {
      // 如果原宿主已自行记录交接失败，保留它的具体原因，不用 runner 的等待超时覆盖。
      try { if (readPrivateJson<StudioSelfUpdateRecord>(join(dir, 'state.json')).phase === 'failed_drain') return } catch { /* 仍需记录失败。 */ }
      transition(sameProcess(plan.old) ? 'failed_drain' : 'recovery_required', failedPhase, failureCode)
      return
    }
    try {
      transition('rolling_back', failedPhase, failureCode)
      await stopFailedLaunch(started)
      const guard = tryStudioStateGuard(plan.stateDir)
      if (!guard) throw new StudioUpdateFailure('LOCK_CONFLICT')
      try {
        try { clearDeadStudioHostLock(plan.stateDir) }
        catch { throw new StudioUpdateFailure('LOCK_CONFLICT') }
        try { validateLiveDatabase(plan) }
        catch {
          failureCode = 'DB_CORRUPT'
          logUpdateController(dir, 'restoring_database', failedPhase, failureCode)
          restoreStudioDatabase(join(plan.stateDir, STUDIO_DB), backupPath(dir), plan.runId)
        }
      } finally { guard() }
      verifyRelease(baselinePath(plan), record.baselineBuildId, record.baselineFingerprint)
      const pointer = releaseTarget(installRoot)
      if (pointer !== current && pointer !== candidatePath(plan)) throw new StudioUpdateFailure('FINGERPRINT_MISMATCH')
      switchRelease(installRoot, baselinePath(plan), pointer)
      const recovered = launch(plan)
      await awaitHealthy(plan, recovered, record.baselineBuildId, record.baselineFingerprint)
      validateLiveDatabase(plan)
      transition('rolled_back', failedPhase, failureCode)
    } catch (error) {
      logUpdateController(dir, 'rollback_failed', failedPhase, updateFailureCode(error, failureCode))
      transition('recovery_required', failedPhase, 'ROLLBACK_FAILED')
    }
  } finally { unlock?.() }
}
