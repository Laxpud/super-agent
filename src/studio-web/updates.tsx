/** 自举更新先生成候选和统一待办；只有单独确认待办才允许宿主切换发布。 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SELF_UPDATE_CHOICES, type StudioHealthStatus, type StudioProjectSummary, type StudioSelfUpdatePhase,
  type StudioSelfUpdateRecord, type StudioSelfUpdateStatus } from '../studio/protocol.ts'
import { callStudioHealth, STUDIO_WEB_BUILD_ID, StudioApiError } from './api.ts'
import type { en } from './locales.ts'
import { createQuery, useQuery } from './query.ts'
import { SettingSelect } from './settings-fields.tsx'
import { Button, Time, useStudio } from './ui.tsx'

const pollInterval = 2_500
const switching = new Set<StudioSelfUpdatePhase>(['approved', 'draining', 'stopping', 'switching', 'starting', 'rolling_back'])
const inFlight = (phase: StudioSelfUpdatePhase) => phase === 'prechecking' || phase === 'awaiting_confirmation' || switching.has(phase)
const phaseTone = {
  prechecking: undefined, awaiting_confirmation: 'warn', approved: undefined, draining: undefined, stopping: undefined,
  switching: undefined, starting: undefined, rolling_back: 'warn', succeeded: 'success', failed_precheck: 'error',
  failed_drain: 'error', rolled_back: 'warn', recovery_required: 'error', cancelled: undefined, expired: 'warn',
} as const satisfies Record<StudioSelfUpdatePhase, string | undefined>

const updateErrors = {
  STUDIO_UPDATE_FINGERPRINT_CONFLICT: 'updateError.fingerprint',
  STUDIO_DRAINING: 'updateError.draining',
  STUDIO_UPDATE_NOT_CONFIGURED: 'updateError.notConfigured',
  STUDIO_SELF_UPDATE_DISABLED: 'updateError.notConfigured',
  STUDIO_UPDATE_RELOAD_UNAVAILABLE: 'updateError.reloadUnavailable',
  STUDIO_UPDATE_PROFILE_MISMATCH: 'updateError.reloadUnavailable',
  STUDIO_UPDATE_WORKSPACE_MISMATCH: 'updateError.workspace',
  STUDIO_UPDATE_SOURCE_INVALID: 'updateError.source',
  STUDIO_UPDATE_INSTALL_INVALID: 'updateError.install',
  STUDIO_UPDATE_BUSY: 'updateError.busy',
  STUDIO_UPDATE_CONFIRMATION_INVALID: 'updateError.confirmation',
  STUDIO_UPDATE_NO_BASELINE: 'updateError.noBaseline',
  STUDIO_UPDATE_ALREADY_BASELINE: 'updateError.alreadyBaseline',
  OPERATION_UNCONFIRMED: 'updateError.unconfirmed',
  PROJECT_EPOCH_CONFLICT: 'domainError.PROJECT_EPOCH_CONFLICT',
  PROJECT_ARCHIVED: 'domainError.PROJECT_ARCHIVED',
  PROJECT_NOT_FOUND: 'domainError.PROJECT_NOT_FOUND',
  INVALID_INPUT: 'domainError.INVALID_INPUT',
} as const satisfies Record<string, keyof typeof en>

const draining = (error: unknown) => error instanceof StudioApiError && error.code === 'STUDIO_DRAINING'
const connectionInterrupted = (error: unknown) => error instanceof StudioApiError && (error.kind === 'network'
  || error.kind === 'timeout' || error.kind === 'unavailable' || [502, 503, 504].includes(error.status))
const projectCoordinate = ({ id, managementEpoch }: StudioProjectSummary) => JSON.stringify([id, managementEpoch])

function newRequestId() {
  // 局域网 HTTP 页面也需要唯一标记；getRandomValues 不依赖安全上下文。
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 宿主只返回绝对 logPath。只显示已知更新目录与日志名，不暴露数据目录、用户名或日志内容。 */
function logReference({ logPath, updateId }: StudioSelfUpdateRecord) {
  const match = /(?:^|[/\\])(updates[/\\]([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})[/\\](?:precheck|controller)\.log)$/u.exec(logPath)
  return match?.[2] === updateId ? match[1]!.replaceAll('\\', '/') : undefined
}

function UpdateFailure({ failure, write = false }: { failure: unknown; write?: boolean }) {
  const { t } = useStudio()
  const error = failure instanceof StudioApiError ? failure : undefined
  const code = error?.code
  const message = code && Object.hasOwn(updateErrors, code) ? t(updateErrors[code as keyof typeof updateErrors])
    : write && (connectionInterrupted(failure) || error?.kind === 'badResponse') ? t('updateError.unconfirmed')
      : error ? t(error.kind, { status: error.status }) : t('updateError.generic')
  return <p className="as-error" role="alert">{message}</p>
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

function Fingerprint({ value, brief }: { value?: string; brief?: boolean }) {
  const { t } = useStudio()
  if (!value) return <span>{t('updateUnknown')}</span>
  return brief ? <code title={value} aria-label={value}>{value.slice(0, 12)}…{value.slice(-6)}</code> : <code>{value}</code>
}

function HealthFacts({ health }: { health: StudioHealthStatus }) {
  const { t } = useStudio()
  const ready = health.phase === 'ready' && health.ready && health.ok
  const healthLabel = ready ? 'updateHealth.ready' : health.phase === 'draining' ? 'updateHealth.draining'
    : health.ok ? 'updateHealth.starting' : 'updateHealth.unhealthy'
  return <dl className="as-facts as-update-health">
    <Fact label={t('updateHealthLabel')}><span className="as-pill" data-tone={ready ? 'success' : 'warn'}>{t(healthLabel)}</span></Fact>
    <Fact label={t('updateDatabase')}>{t(health.sqlite.ok ? 'updateHealthy' : 'updateUnhealthy')}</Fact>
    <Fact label={t('updateConfiguration')}>{t(health.configOk ? 'updateHealthy' : 'updateUnhealthy')}</Fact>
    <Fact label={t('feishuConnection')}>{t(`feishu.${health.feishu}`)}</Fact>
  </dl>
}

function UpdateRecord({ record, busy, locked, canApprove, resolved, answer, rollback }: {
  record: StudioSelfUpdateRecord; busy: boolean; locked: boolean; canApprove: boolean; resolved: boolean;
  answer: (approve: boolean) => void; rollback?: { available: boolean; request: () => void }
}) {
  const { t } = useStudio()
  const { phase, kind } = record
  const confirming = phase === 'awaiting_confirmation' && !!record.pendingId
  const reference = logReference(record)
  return <article className="as-card as-update-record" data-confirming={confirming || undefined}>
    <div className="as-meta">
      <h3>{t(`updateRecord.${kind}`)}</h3>
      <span className="as-pill" data-tone={phaseTone[phase]}>{t(`updatePhase.${phase}`)}</span>
    </div>
    <p role="status">{t(resolved && confirming ? 'updateDecisionRecorded' : `updateHint.${phase}`)}</p>
    <dl className="as-facts">
      <Fact label={t('updateCandidateBuild')}><code>{record.candidateBuildId}</code></Fact>
      <Fact label={t('updateCandidateFingerprint')}><Fingerprint value={record.candidateFingerprint} /></Fact>
      <Fact label={t('updateBaselineFingerprint')}><Fingerprint value={record.baselineFingerprint} /></Fact>
      {confirming && record.expiresAt !== undefined && <Fact label={t('updateConfirmationExpiry')}><Time value={record.expiresAt} /></Fact>}
      {record.failedPhase && <Fact label={t('updateFailedPhase')}>{t(`updatePhase.${record.failedPhase}`)}</Fact>}
      {record.exitCode !== undefined && <Fact label={t('updatePrecheckExit')}>{record.exitCode ?? t('updateUnknown')}</Fact>}
      <Fact label={t('updateLog')}>
        {reference ? <code>{reference}</code> : <span>{t('updateLogPrivate')}</span>}
      </Fact>
    </dl>
    {confirming && !resolved && <>
      <p className="as-warning">{t('updateInterruption')}</p>
      <div className="as-actions">
        <Button primary disabled={locked || !canApprove} onClick={() => answer(true)}>
          {t(kind === 'rollback' ? 'updateApproveRollback' : 'updateApprove')}
        </Button>
        <Button disabled={locked} onClick={() => answer(false)}>{t(kind === 'rollback' ? 'updateCancelRollback' : 'updateCancel')}</Button>
      </div>
    </>}
    {rollback && <>
      <p className="as-muted">{t('updateRollbackHint')}</p>
      <div className="as-actions"><Button disabled={locked || !rollback.available} onClick={rollback.request}>{t('updateRequestRollback')}</Button></div>
    </>}
    {busy && <p className="as-muted" role="status">{t('updateSubmitting')}</p>}
  </article>
}

/** 只轮询状态与健康探针。写入仅来自按钮，回执不明时先读取现状，不自动重发。 */
export function Updates({ locked, busyChange }: { locked: boolean; busyChange: (value: boolean) => void }) {
  const { t, call, state, reloadState } = useStudio()
  const statusQuery = useMemo(() => {
    const query = createQuery(async (signal): Promise<StudioSelfUpdateStatus> => {
      const tracked = query.getSnapshot().data?.record
      const updateId = tracked && inFlight(tracked.phase) ? tracked.updateId : undefined
      const live = await call('selfUpdateStatus', updateId ? { updateId } : {}, signal)
      // 重载期间宿主可能先提供探针再恢复更新账簿；空结果不能冲掉正在追踪的记录。
      if (updateId && live.record?.updateId !== updateId) throw new StudioApiError('unavailable', 503)
      return live
    }, pollInterval)
    return query
  }, [call])
  const healthQuery = useMemo(() => createQuery(callStudioHealth, pollInterval), [])
  const status = useQuery(statusQuery)
  const probe = useQuery(healthQuery)
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [readback, setReadback] = useState<StudioSelfUpdateStatus>()
  const [resolvedId, setResolvedId] = useState<string>()
  const [source, setSource] = useState('')
  const running = useRef(false)
  useEffect(() => { busyChange(busy) }, [busy, busyChange])

  const snapshot = status.data
  const record = snapshot?.record
  const health = probe.failure === undefined ? probe.data : undefined
  const current = (status.failure === undefined ? snapshot?.current : health) ?? snapshot?.current ?? health
  const projects = state?.projects.filter(project => project.state === 'active' && !!project.workspacePath) ?? []
  const project = projects.find(item => projectCoordinate(item) === source)
  const active = !!record && inFlight(record.phase)
  const reloading = !!record && switching.has(record.phase)
  const readingBack = !!snapshot && snapshot === readback
  const hostDraining = health?.phase === 'draining' || draining(status.failure) || draining(probe.failure)
    || (readingBack && draining(failure))
  const reconnecting = hostDraining || ((active || readingBack) && [status.failure, probe.failure].some(connectionInterrupted))
  const buildChanged = !!health && !!snapshot && (health.buildId !== snapshot.current.buildId
    || health.artifactFingerprint !== snapshot.current.artifactFingerprint)
  const blocked = locked || busy || reconnecting || readingBack || buildChanged || status.failure !== undefined
  const pendingId = record?.phase === 'awaiting_confirmation' ? record.pendingId : undefined
  const canDecide = !!pendingId && pendingId !== resolvedId
  const canApprove = canDecide && !!snapshot?.managedReload && !!record?.candidateFingerprint
    && record.baselineFingerprint === snapshot.current.artifactFingerprint
  // succeeded 表示控制器曾验证过基线；申请回滚时后端仍会核验保留的产物。
  const canRollback = record?.phase === 'succeeded' && !!record.candidateFingerprint && !!record.baselineBuildId
    && record.candidateFingerprint === snapshot?.current.artifactFingerprint && record.baselineFingerprint !== record.candidateFingerprint
  const canPrepare = !!snapshot?.enabled && !!snapshot.current.artifactFingerprint && !recordBlocked(record) && (!source || !!project)
  const available = { prepare: canPrepare, rollback: canRollback && !!snapshot?.managedReload, approve: canApprove, cancel: canDecide }
  const refresh = () => { statusQuery.reload(); healthQuery.reload() }

  async function submit(action: keyof typeof available) {
    if (!snapshot || blocked || running.current || !available[action]) return
    running.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      if (action === 'approve' || action === 'cancel') {
        const id = pendingId!
        const result = await call('answer', { id, value: SELF_UPDATE_CHOICES[action === 'approve' ? 0 : 1] })
        if (result.id !== id || result.state !== 'resolved') throw new StudioApiError('badResponse', 200)
        setResolvedId(id)
      } else {
        const request = { requestId: newRequestId(), expectedCurrentFingerprint: snapshot.current.artifactFingerprint }
        const receipt = action === 'prepare'
          ? await call('prepareSelfUpdate', { ...request, ...(project && { projectId: project.id, expectedEpoch: project.managementEpoch }) })
          : await call('rollbackSelfUpdate', { ...request, updateId: record!.updateId })
        // 轮询可能比写入回执先看到同一更新；保留已读到的阶段，随后继续向宿主核对。
        statusQuery.reconcile(latest => !latest || latest.record?.updateId === receipt.updateId
          || (latest.record && latest.record.updateId !== record?.updateId && latest.record.createdAt >= receipt.createdAt)
          ? latest : { ...latest, record: receipt })
      }
    } catch (error) {
      setFailure(error)
    } finally {
      // 冲突或网络中断之后，等一份新的宿主状态；下一次写入仍须用户重新点击。
      setReadback(statusQuery.getSnapshot().data)
      refresh()
      reloadState()
      running.current = false
      setBusy(false)
    }
  }

  const outdated = !!current?.buildId && current.buildId !== STUDIO_WEB_BUILD_ID
  return <div className="as-config-view">
    <section className="as-card as-fields">
      <div className="as-meta as-update-heading"><h3>{t('updateCurrent')}</h3><Button onClick={refresh}>{t('updateRefreshStatus')}</Button></div>
      {!current && status.failure === undefined && <p className="as-muted" role="status">{t('loading')}</p>}
      <dl className="as-facts">
        <Fact label={t('updateHostVersion')}>{current?.version || t('updateUnknown')}</Fact>
        <Fact label={t('updateHostBuild')}><code>{current?.buildId || t('updateUnknown')}</code></Fact>
        <Fact label={t('updateHostFingerprint')}><Fingerprint value={current?.artifactFingerprint} brief /></Fact>
        <Fact label={t('updateBrowserBuild')}><code>{STUDIO_WEB_BUILD_ID}</code></Fact>
        <Fact label={t('updateManagedRepository')}>{t(!snapshot ? 'updateUnknown' : snapshot.enabled ? 'updateEnabled' : 'updateDisabled')}</Fact>
        <Fact label={t('updateManagedReload')}>{t(!snapshot ? 'updateUnknown' : snapshot.managedReload ? 'updateEnabled' : 'updateDisabled')}</Fact>
      </dl>
      {health ? <HealthFacts health={health} /> : <p className="as-muted">{t('updateHealthUnconfirmed')}</p>}
      {reconnecting && <p className="as-warning" role="status">
        {t(reloading || hostDraining ? 'updateReconnecting' : 'updateCheckingConnection')}
      </p>}
      {buildChanged && !reconnecting && <p className="as-muted" role="status">{t('updateCheckingVersion')}</p>}
      {status.failure !== undefined && !draining(status.failure) && !(reconnecting && connectionInterrupted(status.failure)) && <UpdateFailure failure={status.failure} />}
      {probe.failure !== undefined && !draining(probe.failure) && !(reconnecting && connectionInterrupted(probe.failure)) && <UpdateFailure failure={probe.failure} />}
      {outdated && !buildChanged && <div className="as-warning">
        <span role="status">{t('updateBrowserOutdated')}</span>
        <Button disabled={locked || busy || reconnecting || reloading} onClick={() => window.location.reload()}>{t('updateReloadPage')}</Button>
      </div>}
    </section>
    {failure !== undefined && !(reconnecting && draining(failure)) && <UpdateFailure failure={failure} write />}
    {record && <UpdateRecord record={record} locked={blocked} busy={busy} canApprove={canApprove}
      resolved={!!resolvedId && record.pendingId === resolvedId} answer={approve => void submit(approve ? 'approve' : 'cancel')}
      rollback={canRollback ? { available: available.rollback, request: () => void submit('rollback') } : undefined} />}
    {snapshot && <section className="as-card as-fields">
      <h3>{t('updatePrepare')}</h3>
      <p className="as-muted">{t(!snapshot.enabled ? 'updateError.notConfigured' : 'updatePrepareHint')}</p>
      {snapshot.enabled && !snapshot.managedReload && <p className="as-warning">{t('updateNoReload')}</p>}
      {snapshot.enabled && <fieldset className="as-setting-panel as-fields" disabled={blocked || recordBlocked(record)}>
        <SettingSelect label={t('updateSource')} value={source} change={setSource}>
          <option value="">{t('updateRegisteredSource')}</option>
          {source && !project && <option value={source} disabled>{t('updateSourceChanged')}</option>}
          {projects.map(item => <option key={item.id} value={projectCoordinate(item)}>{item.name}</option>)}
        </SettingSelect>
        <div className="as-actions"><Button primary disabled={!canPrepare} onClick={() => void submit('prepare')}>
          {t(busy && !record ? 'updateSubmitting' : 'updatePrepare')}
        </Button></div>
      </fieldset>}
    </section>}
  </div>
}

function recordBlocked(record?: StudioSelfUpdateRecord | null) {
  return !!record && (inFlight(record.phase) || record.phase === 'recovery_required')
}
