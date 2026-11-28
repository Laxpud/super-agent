import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate as yieldToHost, setTimeout as delay } from 'node:timers/promises'
import type { ManagedWorkerStore } from '../managed-worker/store.ts'
import { resolveLoadedBuildInfo } from './build-info.ts'
import { StudioError } from './pending.ts'
import { ASSISTANT_CONVERSATION, SELF_UPDATE_CHOICES, SELF_UPDATE_PENDING_ID, type StudioBuildInfo, type StudioPending,
  type StudioPrepareSelfUpdate, type StudioRollbackSelfUpdate, type StudioSelfUpdateRecord, type StudioSelfUpdateStatus } from './protocol.ts'
import { runStudioPrecheck, verifySource, type RunStudioPrecheck } from './self-update-build.ts'
import { handoffStudioUpdate, liveStudioUpdateController } from './self-update-controller.ts'
import { assertStudioInstallOwner, canonicalDirectory, copyRelease, fingerprintPattern, logUpdateController, overlaps, privateDirectory, readPrivateJson,
  releaseTarget, updateFailureCode, updateIdPattern, validateReloadCommand, verifyRelease, writeUpdateState, type StudioReloadCommand } from './self-update-files.ts'
import { updateRecordView, type StudioSelfUpdateLedger, type UpdateEntry } from './self-update-ledger.ts'
import type { StudioSelfUpdateConfig } from './settings-protocol.ts'

const confirmationWindow = 15 * 60_000
const handoffPhases = ['draining', 'stopping', 'switching', 'starting', 'reloading', 'rolling_back'] as const
const activePhases = new Set<StudioSelfUpdateRecord['phase']>(['prechecking', 'awaiting_confirmation', 'approved', ...handoffPhases])
const runnerPhases = new Set<StudioSelfUpdateRecord['phase']>([...handoffPhases, 'failed_drain', 'succeeded', 'rolled_back', 'recovery_required'])
const unavailable = () => new StudioError('STUDIO_SELF_UPDATE_DISABLED', 'Studio self-update is not provisioned for this Host.', 409)
const stale = () => new StudioError('STUDIO_UPDATE_FINGERPRINT_CONFLICT', 'The running Studio build changed. Reload its status before preparing an update.', 409)
const invalidPending = () => new StudioError('STUDIO_UPDATE_CONFIRMATION_INVALID', 'This update confirmation is no longer current.', 409)
const updateError = (code: string, message: string, status = 409) => new StudioError(code, message, status)

export const studioBuildIdentity = ({ version, buildId, artifactFingerprint }: StudioBuildInfo) => ({ version, buildId, artifactFingerprint })
export const disabledSelfUpdateStatus = (): StudioSelfUpdateStatus => ({ enabled: false, managedReload: false, record: null,
  current: studioBuildIdentity(resolveLoadedBuildInfo()) })

interface Runtime {
  canReload(): boolean
  origin(): string
  enterMaintenance(): () => void
  busy(): boolean
  sealed(value: boolean): void
  wake(): void
  warn(message: string): void
  stopping: AbortSignal
}
export interface StudioSelfUpdateOptions {
  stateDir: string
  hostHome?: string
  hostProfile?: string
  config: StudioSelfUpdateConfig
  build: Readonly<StudioBuildInfo>
  runPrecheck?: RunStudioPrecheck
  handoff?: typeof handoffStudioUpdate
  drainTimeoutMs?: number
}

/** 受管更新只接受坐标和并发指纹；构建输入、进程配方、发布目标和授权来源都不由请求指定。 */
export class StudioSelfUpdate {
  readonly #config: StudioSelfUpdateConfig
  readonly #ledger: StudioSelfUpdateLedger
  readonly #jobs = new Set<Promise<void>>()
  readonly #timers = new Set<NodeJS.Timeout>()
  readonly #build: Readonly<StudioBuildInfo>
  readonly #precheck: RunStudioPrecheck
  readonly #handoff: typeof handoffStudioUpdate
  #probation = false

  constructor(private readonly store: ManagedWorkerStore, private readonly runtime: Runtime, private readonly options: StudioSelfUpdateOptions) {
    this.#config = structuredClone(options.config)
    if (this.#config.reloadCommand) validateReloadCommand(this.#config.reloadCommand)
    if (this.#config.healthTimeoutMs !== undefined && (!Number.isSafeInteger(this.#config.healthTimeoutMs) || this.#config.healthTimeoutMs < 1 ||
      this.#config.healthTimeoutMs > 300_000)) throw new Error('Invalid Studio health timeout')
    this.#build = Object.freeze({ ...options.build })
    this.#precheck = options.runPrecheck ?? runStudioPrecheck
    this.#handoff = options.handoff ?? handoffStudioUpdate
    this.#ledger = store.enableSelfUpdateLedger()
    this.#reconcilePreviousRuns()
    runtime.stopping.addEventListener('abort', () => { for (const timer of this.#timers) clearTimeout(timer); this.#timers.clear() }, { once: true })
  }

  async drain(): Promise<void> { await Promise.allSettled(this.#jobs) }

  #directory(id: string): string {
    if (!updateIdPattern.test(id)) throw updateError('STUDIO_UPDATE_UNKNOWN', 'Studio update not found.', 404)
    return join(this.options.stateDir, 'updates', id)
  }

  #record(entry: UpdateEntry): StudioSelfUpdateRecord {
    const { record } = entry
    if (runnerPhases.has(record.phase) && activePhases.has(record.phase)) {
      try {
        const state = readPrivateJson<StudioSelfUpdateRecord>(join(this.#directory(record.updateId), 'state.json'))
        // 只接受控制器有关执行阶段的镜像；身份、批准及预期指纹仍以 SQLite 账本为准。
        if (state.updateId === record.updateId && runnerPhases.has(state.phase) && Number.isSafeInteger(state.updatedAt)
          && state.updatedAt >= record.updatedAt) return updateRecordView({ ...record, phase: state.phase, updatedAt: state.updatedAt,
            failedPhase: state.failedPhase, failureCode: state.failureCode })
      } catch { /* 未证明写入后续阶段时保留 SQLite 记录。 */ }
    }
    if (record.phase === 'awaiting_confirmation' && (entry.runId !== this.store.runId || Date.now() >= (record.expiresAt ?? 0))) {
      return { ...record, phase: 'expired' }
    }
    return record
  }

  get probation(): boolean { return this.#probation }

  /** 确认旧轮次的最终状态，不接续旧批准。控制器仍在运行时暂缓收敛并保持候选业务只读。 */
  #reconcilePreviousRuns(): void {
    const wasOnProbation = this.#probation
    this.#probation = false
    for (const entry of this.#ledger.recent(true)) {
      if (entry.runId === this.store.runId) continue
      if (entry.record.phase === 'awaiting_confirmation' || entry.record.phase === 'approved') {
        this.#ledger.expire(entry)
        continue
      }
      const record = this.#record(entry), dir = this.#directory(record.updateId)
      if (activePhases.has(record.phase) && liveStudioUpdateController(dir, entry.runId)) { this.#probation = true; continue }
      let phase: StudioSelfUpdateRecord['phase'] = 'recovery_required'
      let failureCode: StudioSelfUpdateRecord['failureCode'] = 'RECOVERY_UNCONFIRMED'
      let failedPhase: StudioSelfUpdateRecord['failedPhase'] = record.failedPhase ?? record.phase
      try {
        const pointer = releaseTarget(this.#config.installRoot ?? '')
        const { buildId, artifactFingerprint, packageRoot } = this.#build
        if (pointer !== packageRoot || !fingerprintPattern.test(artifactFingerprint)) throw stale()
        verifyRelease(pointer, buildId, artifactFingerprint)
        if (record.phase === 'recovery_required') failureCode = record.failureCode ?? failureCode
        else if (buildId === record.candidateBuildId && artifactFingerprint === record.candidateFingerprint) {
          phase = 'succeeded'; failureCode = undefined; failedPhase = undefined
        } else if (buildId === record.baselineBuildId && artifactFingerprint === record.baselineFingerprint) {
          phase = record.phase === 'prechecking' ? 'failed_precheck' : record.phase === 'failed_drain' ? 'failed_drain' : 'rolled_back'
          failureCode = record.failureCode ?? 'CONTROLLER_EXITED'
        }
      } catch { /* 无法证明当前指针和已加载代码一致，不宣告应用或回退成功。 */ }
      const final = updateRecordView({ ...record, phase, failedPhase, failureCode, updatedAt: Date.now() })
      if (this.#ledger.settle(entry, final)) {
        try { writeUpdateState(dir, final, phase) } catch { this.runtime.warn('Studio could not mirror its recovered update state') }
        if (final.logRef === 'controller.log' && activePhases.has(record.phase)) logUpdateController(dir, phase, failedPhase, failureCode)
      }
    }
    if (this.#probation) this.#retryReconciliation(50)
    else if (wasOnProbation) this.runtime.wake()
  }

  #retryReconciliation(afterMs: number): void {
    if (this.runtime.stopping.aborted) return
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      try { this.#reconcilePreviousRuns() }
      catch {
        this.#probation = true
        this.#retryReconciliation(1_000)
        this.runtime.warn('Studio could not confirm its managed startup')
      }
    }, afterMs)
    timer.unref()
    this.#timers.add(timer)
  }

  #command(): StudioReloadCommand | undefined {
    const recipe = this.#config.reloadCommand
    if (!recipe) return
    const home = this.options.hostHome, profile = this.options.hostProfile
    if ((home && recipe.dshHome && realpathSync(home) !== recipe.dshHome) || (profile && recipe.profileName && profile !== recipe.profileName)) {
      throw updateError('STUDIO_UPDATE_PROFILE_MISMATCH', 'The reload recipe is not registered for the active Studio profile.')
    }
    const dshHome = recipe.dshHome ?? (home && realpathSync(home)), profileName = recipe.profileName ?? profile
    const command: StudioReloadCommand = { ...recipe, args: [...recipe.args], ...(dshHome && { dshHome }), ...(profileName && { profileName }) }
    validateReloadCommand(command)
    return command
  }

  status(updateId?: string): StudioSelfUpdateStatus {
    const entry = updateId ? this.#ledger.find(updateId) : this.#ledger.recent()[0]
    const enabled = !!(this.#config.repoPath && this.#config.installRoot && this.#build.artifactFingerprint)
    let managedReload = false
    try { managedReload = enabled && this.runtime.canReload() && !!this.#command() } catch { /* 配方与当前 profile 不匹配，禁止重载。 */ }
    return { enabled, managedReload,
      current: studioBuildIdentity(this.#build), record: entry ? this.#record(entry) : null }
  }

  #checkCurrent(expected: string): string {
    if (!fingerprintPattern.test(expected) || expected !== this.#build.artifactFingerprint) throw stale()
    const root = this.#config.installRoot
    if (!root) throw unavailable()
    try {
      canonicalDirectory(this.options.stateDir, true)
      if (overlaps(root, this.options.stateDir) || releaseTarget(root) !== this.#build.packageRoot) throw new Error('Release root does not match')
    } catch { throw updateError('STUDIO_UPDATE_INSTALL_INVALID', 'The current installation is not a matching owner-only managed release.') }
    try { assertStudioInstallOwner(root, this.options.stateDir) }
    catch { throw updateError('STUDIO_UPDATE_LOCK_CONFLICT', 'This managed installation belongs to another Studio state directory.') }
    return root
  }

  #project(projectId?: string, expectedEpoch?: number) {
    const path = this.#config.repoPath
    if (!path) throw unavailable()
    if (projectId !== undefined) {
      const project = this.store.studioProject(projectId)
      if (!project) throw updateError('PROJECT_NOT_FOUND', 'This Studio project does not exist.', 404)
      if (project.state !== 'active') throw updateError('PROJECT_ARCHIVED', 'The Studio project is not active.')
      if (!Number.isSafeInteger(expectedEpoch) || project.managementEpoch !== expectedEpoch) {
        throw updateError('PROJECT_EPOCH_CONFLICT', 'Studio project changed. Reload its management epoch.')
      }
      if (project.workspacePath !== path) throw updateError('STUDIO_UPDATE_WORKSPACE_MISMATCH', 'The project is not bound to the registered Studio source.')
    } else if (expectedEpoch !== undefined) throw updateError('INVALID_INPUT', 'An epoch requires a project ID.', 400)
    try {
      const hostHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
      const defaultHome = hostHome === '~' ? homedir() : hostHome.startsWith('~/') ? join(homedir(), hostHome.slice(2)) : resolve(hostHome)
      const roots = [this.options.stateDir, this.#config.installRoot, this.options.hostHome, this.#config.reloadCommand?.dshHome, defaultHome]
      if (roots.some(root => {
        if (!root) return false
        if (overlaps(root, path)) return true
        try { return overlaps(realpathSync(root), path) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      })) throw new Error('Overlapping source')
      verifySource(path)
    } catch { throw updateError('STUDIO_UPDATE_SOURCE_INVALID', 'The registered Studio source is not a valid isolated repository.') }
    return path
  }

  #existing(requestId: string, key: string) {
    if (!requestId || requestId.length > 256 || /[\s\0]/u.test(requestId)) throw updateError('INVALID_INPUT', 'Invalid Studio update request ID.', 400)
    const entry = this.#ledger.find(requestId, 'request_id')
    if (entry && entry.requestHash !== key) throw updateError('STUDIO_UPDATE_REQUEST_CONFLICT', 'This request ID was used for a different update.')
    return entry && this.#record(entry)
  }

  #create(kind: StudioSelfUpdateRecord['kind'], requestId: string, key: string, fields: Partial<StudioSelfUpdateRecord>): UpdateEntry {
    if (this.#ledger.recent(true).some(entry => activePhases.has(this.#record(entry).phase))) {
      throw updateError('STUDIO_UPDATE_BUSY', 'Another Studio update is active.')
    }
    const updateId = randomUUID(), directory = this.#directory(updateId), now = Date.now()
    privateDirectory(join(this.options.stateDir, 'updates'))
    mkdirSync(directory, { mode: 0o700 })
    const logPath = join(directory, 'precheck.log')
    writeFileSync(logPath, '', { mode: 0o600, flag: 'wx' })
    const record = writeUpdateState(directory, { updateId, kind, phase: 'prechecking', candidateBuildId: randomUUID(),
      createdAt: now, updatedAt: now, baselineBuildId: this.#build.buildId, baselineFingerprint: this.#build.artifactFingerprint, logRef: 'precheck.log', ...fields }, 'prechecking')
    this.#ledger.start(record, requestId, key)
    return { record, requestId, requestHash: key, runId: this.store.runId }
  }

  #track(fn: () => Promise<void>): void {
    const work = yieldToHost().then(fn).catch(() => this.runtime.warn('Studio self-update could not persist the final state'))
    this.#jobs.add(work)
    void work.finally(() => this.#jobs.delete(work))
  }

  #cleanup(dir: string, candidate: boolean): void {
    // 这些路径只由本次受管更新分配，不读取请求或发布产物中的路径。
    for (const name of ['worktree', 'build-home', ...(candidate ? ['candidate'] : [])]) {
      try { rmSync(join(dir, name), { recursive: true, force: true }) }
      catch { this.runtime.warn('Studio could not remove private update staging') }
    }
  }

  #transition(entry: UpdateEntry, phase: StudioSelfUpdateRecord['phase'], fields: Partial<StudioSelfUpdateRecord> = {}, item?: StudioPending) {
    const record = updateRecordView({ ...entry.record, ...fields, phase, updatedAt: Date.now() })
    if (!this.#ledger.transition(entry, record, item)) throw new Error('Studio update transition lost its run fence')
    try { writeUpdateState(this.#directory(record.updateId), record, phase) }
    catch { this.runtime.warn('Studio could not mirror update state to its private file') }
    return record
  }

  #confirm(entry: UpdateEntry, fields: Partial<StudioSelfUpdateRecord> & { candidateFingerprint: string }): StudioSelfUpdateRecord {
    const rollback = entry.record.kind === 'rollback'
    const id = `${rollback ? 'self-update-rollback' : 'self-update'}:${entry.record.updateId}`
    const now = Date.now(), expiresAt = now + confirmationWindow
    const record = this.#transition(entry, 'awaiting_confirmation', { ...fields, expiresAt, pendingId: id }, {
      id, kind: 'confirmation', conversationId: ASSISTANT_CONVERSATION, requester: 'Agent Studio',
      title: rollback ? '确认回滚 Agent Studio' : '确认更新 Agent Studio',
      detail: `当前发布指纹：${entry.record.baselineFingerprint}\n目标发布指纹：${fields.candidateFingerprint}\n批准将排空并重启本 profile。确认有效至 ${new Date(expiresAt).toISOString()}。\n待办 ID：${id}`,
      acceptsText: true, options: [...SELF_UPDATE_CHOICES], mobile: 'card', state: 'pending', createdAt: now,
    })
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      try { this.#expire(record.updateId) } catch { this.runtime.warn('Studio could not expire update confirmation') }
    }, confirmationWindow)
    timer.unref()
    this.#timers.add(timer)
    this.runtime.wake()
    return record
  }

  #expire(id: string): void {
    const item = this.#ledger.find(id)
    if (item?.record.phase === 'awaiting_confirmation' && Date.now() >= (item.record.expiresAt ?? 0) && this.#ledger.expire(item)) {
      this.#cleanup(this.#directory(id), true)
      try { writeUpdateState(this.#directory(id), item.record, 'expired') } catch { /* SQLite 为决定的权威状态。 */ }
      this.runtime.wake()
    }
  }

  prepareUpdate(input: StudioPrepareSelfUpdate, signal: AbortSignal): StudioSelfUpdateRecord {
    signal.throwIfAborted()
    const key = this.#hash(['update', input.projectId, input.expectedEpoch, input.expectedCurrentFingerprint])
    const prior = this.#existing(input.requestId, key)
    if (prior) return prior
    this.#checkCurrent(input.expectedCurrentFingerprint)
    const source = this.#project(input.projectId, input.expectedEpoch)
    const entry = this.#create('update', input.requestId, key, { ...(input.projectId && { projectId: input.projectId, projectEpoch: input.expectedEpoch }) })
    const { record } = entry, dir = this.#directory(record.updateId)
    this.#track(async () => {
      let diagnostics: Partial<StudioSelfUpdateRecord> = { exitCode: null }
      try {
        const buildSignal = AbortSignal.any([signal, this.runtime.stopping])
        buildSignal.throwIfAborted()
        const workspace = join(dir, 'worktree')
        mkdirSync(workspace, { mode: 0o700 })
        const result = await this.#precheck(source, workspace, join(dir, 'precheck.log'), record.candidateBuildId, buildSignal)
        diagnostics = result
        if (result.exitCode !== 0) throw new Error('Studio precheck failed')
        buildSignal.throwIfAborted()
        const candidateFingerprint = copyRelease(workspace, join(dir, 'candidate'), record.candidateBuildId)
        this.#checkCurrent(input.expectedCurrentFingerprint)
        this.#project(input.projectId, input.expectedEpoch)
        this.#confirm(entry, { ...result, candidateFingerprint })
      } catch {
        try { appendFileSync(join(dir, 'precheck.log'), 'Studio precheck or staging did not complete. No release was selected.\n') }
        finally { this.#transition(entry, 'failed_precheck', { ...diagnostics, failedPhase: 'prechecking', failureCode: 'PRECHECK_FAILED' }) }
      } finally {
        this.#cleanup(dir, this.#ledger.find(record.updateId)?.record.phase !== 'awaiting_confirmation')
      }
    })
    return record
  }

  rollbackSelfUpdate(input: StudioRollbackSelfUpdate, signal: AbortSignal): StudioSelfUpdateRecord {
    signal.throwIfAborted()
    const key = this.#hash(['rollback', input.updateId, input.expectedCurrentFingerprint])
    const prior = this.#existing(input.requestId, key)
    if (prior) return prior
    this.#checkCurrent(input.expectedCurrentFingerprint)
    const target = this.#ledger.find(input.updateId)
    const baseline = this.#directory(input.updateId)
    if (!target || !['succeeded', 'rolled_back'].includes(this.#record(target).phase) || !lstatSync(join(baseline, 'baseline'), { throwIfNoEntry: false })) {
      throw updateError('STUDIO_UPDATE_NO_BASELINE', 'No verified baseline is available for this update.', 404)
    }
    if (target.record.baselineFingerprint === input.expectedCurrentFingerprint) throw updateError('STUDIO_UPDATE_ALREADY_BASELINE', 'Studio is already using this baseline.')
    const entry = this.#create('rollback', input.requestId, key, { rollbackOf: input.updateId, candidateBuildId: target.record.baselineBuildId })
    try {
      const candidateFingerprint = copyRelease(join(baseline, 'baseline'), join(this.#directory(entry.record.updateId), 'candidate'),
        target.record.baselineBuildId, target.record.baselineFingerprint)
      return this.#confirm(entry, { candidateFingerprint })
    } catch {
      try { appendFileSync(join(this.#directory(entry.record.updateId), 'precheck.log'), 'Studio could not verify or stage the saved rollback baseline.\n') }
      catch { /* 即使日志不可写也结算失败。 */ }
      this.#cleanup(this.#directory(entry.record.updateId), true)
      return this.#transition(entry, 'failed_precheck', { failedPhase: 'prechecking', failureCode: 'PRECHECK_FAILED' })
    }
  }

  answer(id: string, value: string, by: 'gui' | 'feishu'): StudioPending {
    if (!SELF_UPDATE_PENDING_ID.test(id) || !SELF_UPDATE_CHOICES.some(option => option === value)) throw invalidPending()
    const updateId = id.slice(id.indexOf(':') + 1)
    this.#expire(updateId)
    const approve = value === SELF_UPDATE_CHOICES[0]
    const command = approve && this.runtime.canReload() ? this.#command() : undefined
    if (approve && !command) throw updateError('STUDIO_UPDATE_RELOAD_UNAVAILABLE', 'This Host has no available managed reload recipe.')
    const item = this.#ledger.decide(updateId, id, value, by, ({ record }) => {
      if (!record.expiresAt || record.expiresAt <= Date.now() || !fingerprintPattern.test(record.candidateFingerprint ?? '')) return false
      this.#checkCurrent(record.baselineFingerprint)
      if (approve && record.projectId) this.#project(record.projectId, record.projectEpoch)
      return true
    })
    if (!item) throw invalidPending()
    const entry = this.#ledger.find(updateId)!
    const dir = this.#directory(updateId)
    try { writeUpdateState(dir, entry.record, entry.record.phase) } catch { this.runtime.warn('Studio could not mirror the update decision') }
    this.runtime.wake()
    if (command) this.#track(() => this.#executeApproved(entry, command))
    else this.#cleanup(dir, true)
    return item
  }

  async #executeApproved(entry: UpdateEntry, command: StudioReloadCommand): Promise<void> {
    const { record } = entry, dir = this.#directory(record.updateId)
    let resume: (() => void) | undefined
    let durableSeal = false
    let current = entry
    try {
      const installRoot = this.#checkCurrent(record.baselineFingerprint)
      resume = this.runtime.enterMaintenance()
      const active = this.#transition(entry, 'draining')
      current = { ...entry, record: active }
      const signal = AbortSignal.any([this.runtime.stopping, AbortSignal.timeout(this.options.drainTimeoutMs ?? 30_000)])
      while (this.runtime.busy()) await delay(75, undefined, { signal })
      signal.throwIfAborted()
      await this.#handoff(dir, { stateDir: this.options.stateDir, installRoot, current: this.#build.packageRoot, command,
        origin: this.runtime.origin(), runId: this.store.runId, record: active, healthTimeoutMs: this.#config.healthTimeoutMs ?? 30_000 }, this.store,
      AbortSignal.any([this.runtime.stopping, AbortSignal.timeout(15_000)]), value => {
        durableSeal = value
        this.runtime.sealed(value)
      }, terminal => {
        if (!this.#ledger.transition(current, terminal)) this.runtime.warn('Studio could not persist the controller exit in its ledger')
      })
    } catch (error) {
      const failureCode = updateFailureCode(error, error instanceof StudioError && error.code === 'STUDIO_UPDATE_LOCK_CONFLICT' ? 'LOCK_CONFLICT' : 'DRAIN_FAILED')
      if (!durableSeal) {
        resume?.()
        this.#transition(current, 'failed_drain', { failedPhase: 'draining', failureCode })
      } else writeUpdateState(dir, current.record, 'recovery_required', { failedPhase: 'draining', failureCode })
      logUpdateController(dir, durableSeal ? 'recovery_required' : 'failed_drain', 'draining', failureCode)
    }
  }

  #hash(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex') }
}
