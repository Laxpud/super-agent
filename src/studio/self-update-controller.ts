import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { ManagedWorkerStore } from '../managed-worker/store.ts'
import { probeStudioHealth } from './health.ts'
import type { StudioSelfUpdatePhase, StudioSelfUpdateRecord } from './protocol.ts'
import { minimalEnvironment } from './self-update-build.ts'
import { atomicJson, canonicalDirectory, copyRelease, readPrivateJson, releaseTarget, switchRelease, updateIdPattern,
  validateReloadCommand, verifyRelease, writeUpdateState, type StudioReloadCommand } from './self-update-files.ts'
import { STUDIO_DB } from './settings-protocol.ts'

type Seal = ReturnType<ManagedWorkerStore['checkpointAndSeal']>
interface Identity { pid: number; started: string }
export interface StudioControllerPlan {
  stateDir: string; installRoot: string; current: string; old: Identity; command: StudioReloadCommand
  runId: string; healthTimeoutMs: number; record: StudioSelfUpdateRecord
}

/** Linux 的启动时刻防止控制器将复用的 PID 当作原宿主；从不根据进程名或端口选择终止对象。 */
function inspectProcess(pid: number): Identity | 'gone' | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) return
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; return }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  if (fields[0] === 'Z' || fields[0] === 'X') return 'gone'
  if (!/^\d+$/u.test(fields[19] ?? '')) return
  try { return { pid, started: `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${fields[19]}` } }
  catch { /* 无法证明进程身份。 */ }
}

function identity(pid: number): Identity | undefined {
  const state = inspectProcess(pid)
  return state === 'gone' ? undefined : state
}

function processState(token: Identity): 'running' | 'gone' | 'unknown' {
  const state = inspectProcess(token.pid)
  return !state ? 'unknown' : state === 'gone' || state.started !== token.started ? 'gone' : 'running'
}

const sameProcess = (token: Identity) => processState(token) === 'running'

async function stopKnownProcess(processIdentity: Identity): Promise<void> {
  const before = processState(processIdentity)
  if (before === 'gone') return
  if (before !== 'running') throw new Error('Studio process identity is unknown')
  try { process.kill(processIdentity.pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  const end = Date.now() + 15_000
  let state = processState(processIdentity)
  while (state === 'running' && Date.now() < end) { await delay(75); state = processState(processIdentity) }
  if (state !== 'gone') throw new Error('Studio process exit could not be confirmed')
}

const log = (dir: string, text: string) => appendFileSync(join(dir, 'controller.log'), `${new Date().toISOString()} ${text}\n`, { mode: 0o600 })
const candidatePath = (plan: StudioControllerPlan) => join(plan.installRoot, 'releases', plan.record.updateId)
const baselinePath = (plan: StudioControllerPlan) => join(plan.installRoot, 'releases', `${plan.record.updateId}-baseline`)

/** 宿主只准备两套已校验资产和控制器计划；真正的 SIGTERM 与切换必须发生在收到封存回执后。 */
export async function handoffStudioUpdate(dir: string, plan: Omit<StudioControllerPlan, 'old'>, store: ManagedWorkerStore,
  signal: AbortSignal, sealed: (value: boolean) => void): Promise<void> {
  const old = identity(process.pid)
  if (!old || releaseTarget(plan.installRoot) !== plan.current) throw new Error('Studio Host or managed release identity changed')
  validateReloadCommand(plan.command)
  const contents = { ...plan, old }
  const record = plan.record
  copyRelease(plan.current, join(dir, 'baseline'), record.baselineBuildId, record.baselineFingerprint)
  copyRelease(join(dir, 'baseline'), baselinePath(contents), record.baselineBuildId, record.baselineFingerprint)
  copyRelease(join(dir, 'candidate'), candidatePath(contents), record.candidateBuildId, record.candidateFingerprint)
  const path = join(dir, 'controller.json')
  atomicJson(dir, 'controller.json', contents)
  signal.throwIfAborted()
  const runner = join(plan.current, 'lib', 'self-update-runner.js')
  if (realpathSync(runner) !== runner || !lstatSync(runner).isFile()) throw new Error('No installed Studio update runner')
  const child = spawn(process.execPath, [runner, path], { cwd: dir, shell: false, detached: true, stdio: 'ignore', env: minimalEnvironment() })
  let exited = false
  child.once('error', () => { exited = true })
  child.once('exit', () => { exited = true })
  child.unref()
  let receipt: Seal | undefined
  try {
    const end = Date.now() + 5_000
    while (!exited && Date.now() < end && !lstatSync(join(dir, 'runner-ready.json'), { throwIfNoEntry: false })) await delay(30, undefined, { signal })
    const ready = readPrivateJson<Identity>(join(dir, 'runner-ready.json'))
    if (exited || !child.pid || ready.pid !== child.pid || !sameProcess(ready)) throw new Error('Studio update runner did not confirm readiness')
    signal.throwIfAborted()
    receipt = store.checkpointAndSeal()
    sealed(true)
    try { atomicJson(dir, 'seal.json', receipt) }
    catch (error) {
      // rename 后目录同步失败时，runner 可能已看到回执，不得重新开放写入。
      if (!lstatSync(join(dir, 'seal.json'), { throwIfNoEntry: false })) throw error
    }
    child.once('exit', () => {
      try {
        const state = readPrivateJson<StudioSelfUpdateRecord>(join(dir, 'state.json'))
        // runner 未持久登记 stopping 就没有权限发信号。收到确切退出通知后，同一 Host 可恢复写入。
        if (state.phase === 'draining' && releaseTarget(plan.installRoot) === plan.current) {
          store.resumeAfterSeal(plan.runId)
          sealed(false)
          writeUpdateState(dir, record, 'failed_drain', { failedPhase: 'draining' })
          log(dir, 'Runner exited before claiming the sealed Host')
        }
      } catch { /* 无法证明没有切换时保留封存，不自动重启或重试。 */ }
    })
  } catch (error) {
    if (receipt) { store.resumeAfterSeal(receipt.runId); sealed(false) }
    throw error
  }
}

function verifySeal(plan: StudioControllerPlan, dir: string): void {
  const seal = readPrivateJson<Seal>(join(dir, 'seal.json'))
  if (seal.checkpointed !== true || seal.runId !== plan.runId || !Number.isFinite(Date.parse(seal.sealedAt))) throw new Error('Invalid SQLite seal receipt')
  using db = new DatabaseSync(join(plan.stateDir, STUDIO_DB), { readOnly: true })
  const run = db.prepare('SELECT run_id, clean FROM studio_host_run WHERE singleton = 1').get()
  if (run?.run_id !== plan.runId || run.clean !== 1) throw new Error('SQLite write fence was not sealed')
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
    if (started.exited()) throw new Error('Studio profile exited before becoming ready')
    const processIdentity = started.token()
    const status = await probeStudioHealth(plan.stateDir).catch(() => undefined)
    if (status && processIdentity && sameProcess(processIdentity) && status.pid === processIdentity.pid && status.pid !== plan.old.pid) {
      if (status.buildId !== buildId || status.artifactFingerprint !== fingerprint) throw new Error('Studio profile loaded an unexpected release')
      if (status.ready === true && status.ok === true && status.phase === 'ready' && status.sqlite?.ok === true && status.configOk === true
        && (status.feishu === 'disabled' || status.feishu === 'online')) return
    }
    await delay(100)
  }
  throw new Error('Studio profile did not pass health checking before the deadline')
}

/** 脱离进程的唯一执行入口。只有经过 SQLite 封存验证并确认旧 PID 退出，才会切换发布指针。 */
export async function runStudioUpdateController(planFile: string): Promise<void> {
  const dir = canonicalDirectory(dirname(planFile), true)
  const plan = readPrivateJson<StudioControllerPlan>(planFile)
  const { record, current, installRoot } = plan
  if (basename(planFile) !== 'controller.json' || !updateIdPattern.test(record.updateId) || dir !== join(plan.stateDir, 'updates', record.updateId)
    || !record.candidateFingerprint || !sameProcess(plan.old) || !Number.isSafeInteger(plan.healthTimeoutMs)
    || plan.healthTimeoutMs < 1 || plan.healthTimeoutMs > 300_000 || releaseTarget(installRoot) !== current) throw new Error('Invalid Studio controller handoff')
  validateReloadCommand(plan.command)
  canonicalDirectory(plan.stateDir, true)
  verifyRelease(current, record.baselineBuildId, record.baselineFingerprint)
  verifyRelease(baselinePath(plan), record.baselineBuildId, record.baselineFingerprint)
  verifyRelease(candidatePath(plan), record.candidateBuildId, record.candidateFingerprint)
  const self = identity(process.pid)
  if (!self || lstatSync(join(dir, 'runner-ready.json'), { throwIfNoEntry: false })) throw new Error('Studio runner already used')
  // mkdir 是排他的：即使另一个 runner 在同一毫秒启动，也不能重复领取交接。
  mkdirSync(join(dir, 'runner-claim'), { mode: 0o700 })
  atomicJson(dir, 'runner-ready.json', self)
  const deadline = Date.now() + 7_000
  while (sameProcess(plan.old) && Date.now() < deadline && !lstatSync(join(dir, 'seal.json'), { throwIfNoEntry: false })) await delay(30)
  if (!sameProcess(plan.old) || !lstatSync(join(dir, 'seal.json'), { throwIfNoEntry: false })) return
  verifySeal(plan, dir)

  let phase: StudioSelfUpdatePhase = 'stopping'
  let started: ReturnType<typeof launch> | undefined
  let stopped = false
  const transition = (next: StudioSelfUpdatePhase, failedPhase?: StudioSelfUpdatePhase) => {
    phase = next
    writeUpdateState(dir, record, next, { ...(failedPhase && { failedPhase }) })
    try { log(dir, next + (failedPhase ? ` (failed: ${failedPhase})` : '')) }
    catch { /* 已持久化的发布状态不因附加日志失败而改变。 */ }
  }
  try {
    transition('stopping')
    await stopKnownProcess(plan.old)
    stopped = true
    verifySeal(plan, dir)
    transition('switching')
    verifyRelease(candidatePath(plan), record.candidateBuildId, record.candidateFingerprint)
    switchRelease(installRoot, candidatePath(plan), current)
    transition('starting')
    started = launch(plan)
    await awaitHealthy(plan, started, record.candidateBuildId, record.candidateFingerprint)
    transition('succeeded')
  } catch {
    const failure = phase
    try {
      if (!stopped || sameProcess(plan.old)) throw new Error('The old Studio profile has not stopped')
      transition('rolling_back', failure)
      if (started && !started.exited()) {
        const token = started.token()
        if (!token) throw new Error('Could not identify failed Studio profile')
        await stopKnownProcess(token)
      }
      verifyRelease(baselinePath(plan), record.baselineBuildId, record.baselineFingerprint)
      const pointer = releaseTarget(installRoot)
      if (pointer !== current && pointer !== candidatePath(plan)) throw new Error('Unexpected release during rollback')
      switchRelease(installRoot, baselinePath(plan), pointer)
      const recovered = launch(plan)
      await awaitHealthy(plan, recovered, record.baselineBuildId, record.baselineFingerprint)
      transition('rolled_back', failure)
    } catch { transition('recovery_required', failure) }
  }
}
