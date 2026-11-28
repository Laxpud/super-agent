/** 宿主设置草稿按配置修订号提交，读取回执与生效状态分别呈现。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { feishuBinding, sameBinding, type ConfigurationChange, type ConfigurationReceipt, type ConfigurationSnapshot,
  type DirectoryMode, type StudioConfiguration } from '../studio/settings-protocol.ts'
import { StudioApiError } from './api.ts'
import { createQuery, useQuery, type QuerySnapshot } from './query.ts'
import { FeishuSettings, type VerifiedFeishu } from './settings-feishu.tsx'
import { ConfigurationFailure, SettingSelect, SettingText, SettingsConfirm, type ModelCatalog, type SettingsSection } from './settings-fields.tsx'
import { absolute, AdvancedSettings, configurationProblem, normalizeConfiguration, WorkerSettings } from './settings-sections.tsx'
import { Button, QueryStatus, useStudio } from './ui.tsx'

interface Draft { revision: string; value: StudioConfiguration }
interface ApplyIntent { input: ConfigurationChange; kind: 'settings' | 'disconnect' | 'directory' }
interface Outcome { intent: ApplyIntent; receipt?: ConfigurationReceipt }
const canonical = (value: unknown) => JSON.stringify(value, (_key, node: unknown) => node && typeof node === 'object' && !Array.isArray(node)
  ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : node)
const equal = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const unknownOutcome = (error: unknown) => !(error instanceof StudioApiError) || error.status === 0
  || error.kind === 'timeout' || error.kind === 'badResponse'
  || (error.status >= 500 && !['STUDIO_MODELS_UNCONFIRMED', 'STUDIO_CREDENTIAL_UNCONFIRMED'].includes(error.code ?? ''))
const FIELD_LABELS = {
  stateDir: 'stateDirectory', studioCwd: 'workDirectory', assistantModel: 'role.assistant', leaderModel: 'role.leader',
  workerModelRoutes: 'workerRoutes', workerModelDefaults: 'workerDefault', defaultWorkerPermission: 'workerPermission', feishu: 'feishuMode',
} as const satisfies Record<keyof StudioConfiguration, string>

/** 普通设置、明确解绑和切换目录分别确认，避免一次提交夹带未检查的改动。 */
export function HostSettings({ section, select, models, reloadOptions, dirtyChange, busyChange, modelsBusy, modelsDirty }: {
  section: SettingsSection; select: (section: SettingsSection) => void; models: QuerySnapshot<ModelCatalog>; reloadOptions: () => void;
  dirtyChange: (dirty: boolean) => void; busyChange: (busy: boolean) => void; modelsBusy: boolean; modelsDirty: boolean
}) {
  const { t, call, reloadState } = useStudio()
  const query = useMemo(() => createQuery(signal => call('configuration', {}, signal), 4000), [call])
  const result = useQuery(query)
  const snapshot = result.data
  const [draft, setDraft] = useState<Draft>()
  const [verified, setVerified] = useState<{ evidence: VerifiedFeishu; revision: string }>()
  const [transient, setTransient] = useState(false)
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<DirectoryMode | ''>('')
  const [typed, setTyped] = useState('')
  const [confirm, setConfirm] = useState<ApplyIntent>()
  const [failure, setFailure] = useState<unknown>()
  const [outcome, setOutcome] = useState<Outcome>()
  const [notice, setNotice] = useState<'applied' | 'observed' | 'previous'>()
  const [cleanup, setCleanup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const running = useRef(false)
  const [formRevision, restartForm] = useState(0)
  const value = draft?.value ?? snapshot?.config
  const next = value && normalizeConfiguration(value)
  const current = snapshot?.config
  const hostDirty = !!(next && current && !equal(next, current))
  const baseRevision = draft?.revision ?? snapshot?.revision
  const stale = !!draft && snapshot?.revision !== baseRevision && !outcome
  const activeBinding = current && feishuBinding(current.feishu)
  const targetBinding = next && feishuBinding(next.feishu)
  const verificationId = verified && verified.revision === snapshot?.revision && verified.evidence.expiresAt > Date.now()
    && targetBinding && sameBinding(verified.evidence.binding, targetBinding) ? verified.evidence.id : undefined
  const needsCheck = !!(targetBinding && !verificationId && (!sameBinding(activeBinding, targetBinding)
    || snapshot?.feishu.credential === 'missing' && !equal(next?.feishu, current?.feishu)))
  const problem = next && hostDirty ? configurationProblem(next) : undefined
  const available = !!snapshot?.writable && result.failure === undefined && !busy && !checking && !modelsBusy && !outcome && !stale
  const lockFields = !available
  const disconnect = !!(activeBinding && next?.feishu.mode === 'disabled')
  const changed = hostDirty || !!verificationId
  const dirty = !!(draft || verificationId || transient || path || mode || outcome)
  const directoryBlocked = changed || transient || modelsDirty
  useEffect(() => { dirtyChange(dirty) }, [dirty, dirtyChange])
  useEffect(() => { busyChange(busy || checking) }, [busy, checking, busyChange])

  function change(patch: Partial<StudioConfiguration>) {
    if (!snapshot || !value || !available) return
    setFailure(undefined); setNotice(undefined)
    setDraft(previous => {
      const changed = { ...(previous?.value ?? snapshot.config), ...patch }
      return equal(changed, snapshot.config) ? undefined : { revision: previous?.revision ?? snapshot.revision, value: changed }
    })
  }

  function clearDraft() {
    setDraft(undefined); setVerified(undefined); setTransient(false); setPath(''); setMode(''); setTyped('')
    restartForm(value => value + 1)
  }

  useEffect(() => {
    if (!outcome?.receipt || outcome.receipt.revision !== snapshot?.revision || result.failure !== undefined) return
    setCleanup(outcome.receipt.credentialCleanup === 'unconfirmed')
    setNotice('applied'); setOutcome(undefined); setFailure(undefined); clearDraft()
  }, [outcome, snapshot?.revision, result.failure])

  function review() {
    if (!next || !snapshot || !available || !changed || problem || needsCheck || transient) return
    setConfirm({ kind: disconnect ? 'disconnect' : 'settings', input: { allowReload: true, revision: baseRevision!, config: next,
      ...(verificationId ? { verificationId } : {}) } })
  }

  function reviewDirectory() {
    const target = path.trim()
    if (!snapshot || !mode || !absolute(target) || target === snapshot.config.stateDir || !available || directoryBlocked) return
    setTyped('')
    setConfirm({ kind: 'directory', input: { allowReload: true, revision: snapshot.revision,
      config: { ...snapshot.config, stateDir: target }, directory: { mode, confirmation: target } } })
  }

  async function apply(intent: ApplyIntent) {
    if (running.current) return
    running.current = true
    setConfirm(undefined); setBusy(true); setFailure(undefined); setNotice(undefined); setCleanup(false)
    try {
      const receipt = await call('saveConfiguration', intent.input)
      setOutcome({ intent, receipt })
    } catch (error) {
      setFailure(error)
      if (unknownOutcome(error)) setOutcome({ intent })
    } finally {
      running.current = false; setBusy(false); query.reload(); reloadState()
    }
  }

  /** 回执丢失时只读现状；对比请求目标，不自动重新提交。 */
  async function recheck() {
    if (!outcome || running.current) return
    running.current = true; setChecking(true)
    try {
      const observed = await call('configuration', {})
      const confirmed = outcome.receipt?.revision === observed.revision
      const same = equal(observed.config, outcome.intent.input.config)
        && (!outcome.intent.input.verificationId || observed.revision !== outcome.intent.input.revision)
      setNotice(confirmed ? 'applied' : same ? 'observed' : 'previous')
      setCleanup(confirmed && outcome.receipt?.credentialCleanup === 'unconfirmed')
      // 不把失败当成成功；未生效的草稿继续保留，若修订号变了则要求放弃后再编辑。
      if (confirmed || same) clearDraft()
      setOutcome(undefined); setFailure(undefined)
    } catch (error) { setFailure(error) }
    finally { running.current = false; setChecking(false); query.reload(); reloadState() }
  }

  if (section === 'models' && !snapshot) return null
  return <div hidden={section === 'models' || section === 'updates'} className="as-config-view">
    <QueryStatus query={result} reload={query.reload} />
    {snapshot && value && <>
      {!snapshot.writable && <p className="as-warning" role="status">{t('readOnlyConfiguration')}</p>}
      {snapshot.profile && section === 'advanced' && <p className="as-muted">{t('configProfile', { name: snapshot.profile })}</p>}
      {(section === 'workers' || section === 'advanced') && <div className="as-actions">
        <QueryStatus query={models} reload={reloadOptions} />
        {models.failure === undefined && <Button onClick={reloadOptions}>{t('reloadOptions')}</Button>}
      </div>}
      <div hidden={section !== 'feishu'}>
        <FeishuSettings key={`${snapshot.revision}:${formRevision}`} snapshot={snapshot} value={value.feishu}
          change={feishu => change({ feishu })} verify={evidence => setVerified(evidence ? { evidence, revision: snapshot.revision } : undefined)}
          transient={setTransient} reload={query.reload} disabled={lockFields} />
      </div>
      {(section === 'workers' || section === 'advanced') && <fieldset className="as-setting-panel as-fields" disabled={lockFields}>
        {section === 'workers' ? <WorkerSettings value={value} change={change} models={models.data} />
          : <AdvancedSettings value={value} change={change} models={models.data} />}
      </fieldset>}
      {failure !== undefined && <ConfigurationFailure error={failure} />}
      {stale && <div className="as-warning"><span>{t('configConflict')}</span>
        <Button onClick={() => { clearDraft(); setFailure(undefined); query.reload() }}>{t('useCurrentSettings')}</Button></div>}
      {outcome && <div className="as-warning"><span role="status">{t(outcome.receipt ? 'configReadback' : 'configUnknown')}</span>
        <Button disabled={checking} onClick={() => void recheck()}>{t(checking ? 'configChecking' : 'configRecheck')}</Button></div>}
      {notice && <p className={notice === 'previous' ? 'as-warning' : 'as-success'} role="status">
        {t(notice === 'applied' ? 'configApplied' : notice === 'observed' ? 'configObserved' : 'configPrevious')}
      </p>}
      {cleanup && <p className="as-warning" role="status">{t('credentialCleanup')}</p>}
      {problem && <div className="as-warning"><span>{t(problem.key)}</span>
        {problem.section !== section && <Button onClick={() => select(problem.section)}>{t(`section.${problem.section}`)}</Button>}</div>}
      {!problem && needsCheck && <div className="as-warning"><span>{t('feishuBindingNeedsCheck')}</span>
        {section !== 'feishu' && <Button onClick={() => select('feishu')}>{t('configureFeishu')}</Button>}</div>}
      {transient && <div className="as-warning"><span>{t('feishuFinishCheck')}</span>
        {section !== 'feishu' && <Button onClick={() => select('feishu')}>{t('configureFeishu')}</Button>}</div>}
      <div className="as-actions">
        <Button primary disabled={!available || !changed || !!problem || needsCheck || transient} onClick={review}>
          {t(busy ? 'applyingConfig' : disconnect ? 'feishuReviewAndDisconnect' : 'applyConfig')}
        </Button>
        {changed && available && <Button onClick={() => { clearDraft(); setFailure(undefined) }}>{t('discardSettings')}</Button>}
      </div>
      {section === 'advanced' && <section className="as-card as-fields">
        <h3>{t('stateDirectory')}</h3><p>{t('stateDirectoryHint')}</p>
        <code className="as-settings-code">{snapshot.config.stateDir}</code>
        <fieldset className="as-setting-panel as-fields" disabled={!available || directoryBlocked}>
          <SettingText label={t('directoryTarget')} hint={t('directoryTargetHint')} maxLength={4096} value={path} change={setPath} />
          <SettingSelect label={t('directoryMode')} value={mode} change={newMode => setMode(newMode as DirectoryMode | '')}>
            <option value="">{t('directoryChooseMode')}</option><option value="copy">{t('directoryCopy')}</option><option value="empty">{t('directoryEmpty')}</option>
          </SettingSelect>
          {mode && <p className={mode === 'empty' ? 'as-warning' : 'as-muted'}>{t(mode === 'copy' ? 'directoryCopyHint' : 'directoryEmptyHint')}</p>}
          <div className="as-actions"><Button disabled={!absolute(path.trim()) || !mode || path.trim() === snapshot.config.stateDir}
            onClick={reviewDirectory}>{t('directoryReview')}</Button></div>
        </fieldset>
        {directoryBlocked && <p className="as-muted">{t('directorySeparate')}</p>}
      </section>}
      {confirm && <SettingsConfirm title={t(confirm.kind === 'directory' ? 'directoryTitle' : confirm.kind === 'disconnect' ? 'feishuUnbindTitle' : 'applyConfigTitle')}
        body={`${confirm.kind === 'directory' ? `${t(confirm.input.directory!.mode === 'copy' ? 'directoryCopyHint' : 'directoryEmptyHint')} `
          : confirm.kind === 'disconnect' ? `${t('feishuUnbindBody')} ` : ''}${t('applyConfigBody')}`}
        acceptLabel={t(confirm.kind === 'directory' ? 'directoryApply' : confirm.kind === 'disconnect' ? 'feishuUnbind' : 'applyConfigConfirm')}
        dismiss={() => setConfirm(undefined)} accept={() => void apply(confirm)}
        disabled={!available || confirm.input.revision !== snapshot.revision || (confirm.kind === 'directory' && typed !== confirm.input.directory?.confirmation)}>
        {confirm.kind === 'directory' ? <><code className="as-settings-code">{confirm.input.config.stateDir}</code>
          <SettingText label={t('directoryConfirm')} value={typed} maxLength={4096} change={setTyped} /></> : <div className="as-fields">
          <strong>{t('confirmChanges')}</strong><ul className="as-settings-changes">
            {(Object.keys(FIELD_LABELS) as Array<keyof StudioConfiguration>).filter(key => !equal(snapshot.config[key], confirm.input.config[key]))
              .map(key => <li key={key}>{t(FIELD_LABELS[key])}{key === 'feishu' ? ` · ${t(`mode.${confirm.input.config.feishu.mode}`)}`
                : key === 'defaultWorkerPermission' ? ` · ${t(`permission.${confirm.input.config.defaultWorkerPermission}`)}` : ''}</li>)}
            {confirm.input.verificationId && <li>{t('confirmCredentialWrite')}</li>}
          </ul></div>}
      </SettingsConfirm>}
    </>}
  </div>
}
