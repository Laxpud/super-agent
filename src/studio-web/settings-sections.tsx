/** 分组呈现实际可配置项；所有依赖校验仍由宿主执行，前端只提前提示可修正的输入。 */
import { useId } from 'react'
import type { StudioModel } from '../studio/protocol.ts'
import type { PinnedModel, StudioConfiguration, StudioDispatchRole, StudioQuotaPool } from '../studio/settings-protocol.ts'
import { blankModel, ModelEditor, SettingSelect, SettingText, SettingToggle, type ModelCatalog } from './settings-fields.tsx'
import { Button, useStudio } from './ui.tsx'

const ROLES = ['assistant', 'leader'] as const
export type Patch<T> = (patch: Partial<T>) => void
interface Fields { value: StudioConfiguration; change: Patch<StudioConfiguration>; models?: ModelCatalog }
const routeId = (route: StudioModel) => JSON.stringify([route.provider, route.model, route.reasoningEffort ?? ''])
const routeLabel = (route: StudioModel) => `${route.provider} / ${route.model} · ${route.reasoningEffort ?? ''}`
const filledModel = (route: StudioModel | null) => !route || !!route.provider && !!route.model

function validPolicy(value: StudioConfiguration) {
  const ids = value.textWorkerRoutes.map(routeId)
  if (new Set(ids).size !== ids.length || value.textWorkerRoutes.some(row => !filledModel(row) || !row.reasoningEffort)) return false
  return ROLES.every(role => {
    const { min, max } = value.textWorkerBounds[role]
    const choice = value.textWorkerDefaults[role]
    const start = min ? ids.indexOf(routeId(min)) : 0
    const end = max ? ids.indexOf(routeId(max)) : ids.length - 1
    if (min && start < 0 || max && end < 0 || (ids.length && start > end)) return false
    const chosen = choice ? ids.indexOf(routeId(choice)) : undefined
    return chosen === undefined || chosen >= start && chosen <= end
  })
}

/** 文本编辑保留分隔符；提交时才规范化提供方 ID，不丢失输入框的插入位置。 */
export function normalizeConfiguration(value: StudioConfiguration): StudioConfiguration {
  return { ...value, studioCwd: value.studioCwd.trim(), quotaPools: value.quotaPools.map(pool => ({ id: pool.id.trim(),
    providers: pool.providers.map(provider => provider.trim()).filter(Boolean) })), feishu: value.feishu.mode === 'off' ? value.feishu : {
    ...value.feishu, binding: { appId: value.feishu.binding.appId.trim(), botOpenId: value.feishu.binding.botOpenId.trim(),
      ownerOpenId: value.feishu.binding.ownerOpenId.trim(), chatId: value.feishu.binding.chatId.trim() },
    ...(value.feishu.mode === 'text' ? { cwd: value.feishu.cwd.trim() } : {}),
  } }
}

function validQuotas(values: StudioQuotaPool[]) {
  const providers = values.flatMap(value => value.providers)
  return new Set(values.map(value => value.id)).size === values.length && new Set(providers).size === providers.length
    && values.every(value => /^[a-z][a-z0-9_-]{0,47}$/u.test(value.id) && value.providers.length > 0 && value.providers.length <= 32
      && value.providers.every(provider => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(provider)))
}

/** 只返回一条需要先修正的原因，区分类目以便从当前选项卡直达问题。 */
export function configurationProblem(value: StudioConfiguration) {
  const legacyInbox = value.feishu.mode === 'document' || value.feishu.mode === 'text'
  if (!validPolicy(value)) return { section: 'workers', key: 'workerPolicyInvalid' } as const
  if (!validQuotas(value.quotaPools)) return { section: 'oversight', key: 'quotaInvalid' } as const
  if (!filledModel(value.advisor)) return { section: 'workers', key: 'modelChoice' } as const
  if (!filledModel(value.assistantModel) || !filledModel(value.leaderModel)) return { section: 'advanced', key: 'modelChoice' } as const
  if (value.feishu.mode === 'text' && (!value.feishu.cwd || !filledModel(value.feishu.route))) return { section: 'feishu', key: 'textRouteRequired' } as const
  if (value.quotaFeishuAlerts && (!legacyInbox || !value.quotaPools.length)) return { section: 'oversight', key: 'configError.STUDIO_QUOTA_ALERT_REQUIREMENTS' } as const
  if (value.documentRecovery && !value.watchdog) return { section: 'oversight', key: 'configError.STUDIO_WATCHDOG_REQUIRED' } as const
  if (value.documentFailureFeishuAlerts && (!legacyInbox || !value.documentRecovery)) return { section: 'oversight', key: 'configError.STUDIO_DOCUMENT_ALERT_REQUIREMENTS' } as const
  const interval = value.systemdJobPollSeconds
  if (interval !== 0 && (!value.systemdJobInbox || !Number.isInteger(interval) || interval < 5 || interval > 300)) {
    return { section: 'oversight', key: 'configError.STUDIO_JOB_INTERVAL' } as const
  }
}

function WorkerSelection({ rows, value, label, empty, change }: {
  rows: PinnedModel[]; value: PinnedModel | null; label: string; empty: string; change: (value: PinnedModel | null) => void
}) {
  const { t } = useStudio()
  const position = value ? rows.findIndex(row => routeId(row) === routeId(value)) : -1
  return <SettingSelect label={label} value={position >= 0 ? String(position) : value ? 'missing' : ''}
    change={index => { if (index !== 'missing') change(index ? rows[Number(index)] ?? null : null) }}>
    <option value="">{empty}</option>
    {position < 0 && value && <option value="missing">{t('workerMissingRoute', { name: routeLabel(value) })}</option>}
    {rows.map((row, index) => <option key={index} value={index} disabled={!row.model || !row.reasoningEffort}>
      {index + 1} · {routeLabel(row)}</option>)}
  </SettingSelect>
}

export function WorkerSettings({ value, models, change }: Fields) {
  const { t } = useStudio()
  const rows = value.textWorkerRoutes
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    const [selected] = next.splice(from, 1)
    if (selected) { next.splice(to, 0, selected); change({ textWorkerRoutes: next }) }
  }
  const bound = (role: StudioDispatchRole, side: 'min' | 'max', route: PinnedModel | null) => change({
    textWorkerBounds: { ...value.textWorkerBounds, [role]: { ...value.textWorkerBounds[role], [side]: route } },
  })
  return <>
    <section className="as-card as-fields">
      <h3>{t('workerRoutes')}</h3><p>{t('workersIntro')}</p><p className="as-muted">{t('workerRoutesHint')}</p>
      {rows.map((row, index) => <div className="as-setting-row" key={index}>
        <ModelEditor title={t('workerRoute', { index: index + 1 })} value={row} options={models} exact change={model => {
          if (model) change({ textWorkerRoutes: rows.map((existing, at) => at === index ? { ...model, reasoningEffort: model.reasoningEffort ?? '' } : existing) })
        }} />
        <div className="as-actions">
          <Button disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={t('moveRouteUp', { index: index + 1 })}>{t('moveUp')}</Button>
          <Button disabled={index === rows.length - 1} onClick={() => move(index, index + 1)} aria-label={t('moveRouteDown', { index: index + 1 })}>{t('moveDown')}</Button>
          <Button aria-label={t('removeRoute', { index: index + 1 })} onClick={() => change({ textWorkerRoutes: rows.filter((_, at) => at !== index) })}>{t('remove')}</Button>
        </div>
      </div>)}
      <div className="as-actions"><Button disabled={rows.length >= 64} onClick={() => change({ textWorkerRoutes: [...rows, { ...blankModel, reasoningEffort: '' }] })}>{t('addRoute')}</Button></div>
      {ROLES.map(role => <fieldset key={role} className="as-model-fields">
        <legend>{t('workerRole', { role: t(`role.${role}`) })}</legend>
        <div className="as-model-grid">
          <WorkerSelection rows={rows} label={t('workerDefault')} empty={t('workerNoDefault')} value={value.textWorkerDefaults[role]}
            change={route => change({ textWorkerDefaults: { ...value.textWorkerDefaults, [role]: route } })} />
          <WorkerSelection rows={rows} label={t('workerMin')} empty={t('workerNoBound')} value={value.textWorkerBounds[role].min} change={route => bound(role, 'min', route)} />
          <WorkerSelection rows={rows} label={t('workerMax')} empty={t('workerNoBound')} value={value.textWorkerBounds[role].max} change={route => bound(role, 'max', route)} />
        </div>
      </fieldset>)}
    </section>
    <section className="as-card as-fields"><p>{t('advisorHint')}</p>
      <ModelEditor title={t('advisorModel')} value={value.advisor} options={models} disableLabel={t('noneConfigured')} change={advisor => change({ advisor })} />
    </section>
  </>
}

export function DocumentSettings({ value, change }: Fields) {
  const { t } = useStudio()
  return <section className="as-card as-fields">
    <SettingToggle label={t('docCapture')} hint={t('docCaptureHint')} checked={value.guiDocumentInbox} change={guiDocumentInbox => change({ guiDocumentInbox })} />
    <SettingToggle label={t('docContinuation')} hint={t('docContinuationHint')} checked={value.documentContinuations} change={documentContinuations => change({ documentContinuations })} />
    <SettingToggle label={t('memorySetting')} hint={t('memorySettingHint')} checked={value.memory} change={memory => change({ memory })} />
  </section>
}

function PoolFields({ index, pool, change, remove }: { index: number; pool: StudioQuotaPool; change: Patch<StudioQuotaPool>; remove(): void }) {
  const { t } = useStudio()
  const id = useId()
  return <fieldset className="as-model-fields as-fields">
    <legend>{t('quotaPool', { index })}</legend>
    <SettingText label={t('quotaId')} value={pool.id} maxLength={48} change={id => change({ id })} />
    <div className="as-setting-field"><label htmlFor={id}>{t('quotaProviderIds')}</label>
      <textarea id={id} aria-describedby={`${id}-help`} rows={3} maxLength={4160} spellCheck={false} value={pool.providers.join('\n')}
        onChange={event => change({ providers: event.currentTarget.value.split(/\r?\n|,/u) })} />
      <p id={`${id}-help`} className="as-muted">{t('quotaProvidersHint')}</p>
    </div>
    <div className="as-actions"><Button aria-label={t('quotaRemove', { index })} onClick={remove}>{t('remove')}</Button></div>
  </fieldset>
}

export function OversightSettings({ value, change }: Fields) {
  const { t } = useStudio()
  const id = useId()
  const hasInbox = value.feishu.mode === 'document' || value.feishu.mode === 'text'
  return <>
    <section className="as-card as-fields">
      <h3>{t('quotaPools')}</h3><p>{t('quotaPoolsHint')}</p>
      {value.quotaPools.map((pool, index) => <PoolFields key={index} index={index + 1} pool={pool}
        change={patch => change({ quotaPools: value.quotaPools.map((current, at) => at === index ? { ...pool, ...patch } : current) })}
        remove={() => change({ quotaPools: value.quotaPools.filter((_, at) => at !== index) })} />)}
      <div className="as-actions"><Button disabled={value.quotaPools.length >= 32}
        onClick={() => change({ quotaPools: [...value.quotaPools, { id: '', providers: [] }] })}>{t('quotaAdd')}</Button></div>
      <SettingToggle label={t('quotaAlerts')} hint={t('quotaAlertsHint')} checked={value.quotaFeishuAlerts}
        disabled={!value.quotaFeishuAlerts && (!hasInbox || !value.quotaPools.length)} change={quotaFeishuAlerts => change({ quotaFeishuAlerts })} />
    </section>
    <section className="as-card as-fields">
      <SettingToggle label={t('watchdog')} hint={t('watchdogHint')} checked={value.watchdog} change={watchdog => change({ watchdog })} />
      <SettingToggle label={t('docRecovery')} hint={t('docRecoveryHint')} checked={value.documentRecovery}
        disabled={!value.documentRecovery && !value.watchdog} change={documentRecovery => change({ documentRecovery })} />
      <SettingToggle label={t('docFailureAlerts')} hint={t('docFailureAlertsHint')} checked={value.documentFailureFeishuAlerts}
        disabled={!value.documentFailureFeishuAlerts && (!hasInbox || !value.documentRecovery)} change={documentFailureFeishuAlerts => change({ documentFailureFeishuAlerts })} />
    </section>
    <section className="as-card as-fields">
      <SettingToggle label={t('externalJobs')} hint={t('externalJobsHint')} checked={value.systemdJobInbox} change={systemdJobInbox => change({ systemdJobInbox })} />
      <div className="as-setting-field"><label htmlFor={id}>{t('pollInterval')}</label>
        <input id={id} aria-describedby={`${id}-help`} type="number" step={1} min={0} max={300} placeholder="0" value={value.systemdJobPollSeconds || ''}
          disabled={!value.systemdJobInbox && !value.systemdJobPollSeconds} onChange={event => change({ systemdJobPollSeconds: Number(event.currentTarget.value) })} />
        <p id={`${id}-help`} className="as-muted">{t('pollIntervalHint')}</p>
      </div>
    </section>
  </>
}

export function AdvancedSettings({ value, change, models }: Fields) {
  const { t } = useStudio()
  return <>
    <section className="as-card as-fields"><SettingText label={t('workDirectory')} hint={t('workDirectoryHint')} maxLength={4096}
      value={value.studioCwd} change={studioCwd => change({ studioCwd })} /></section>
    <section className="as-card as-fields"><h3>{t('initialModels')}</h3><p>{t('initialModelsHint')}</p>
      <ModelEditor title={t('role.assistant')} value={value.assistantModel} options={models} disableLabel={t('inheritance')}
        change={assistantModel => change({ assistantModel })} />
      <ModelEditor title={t('role.leader')} value={value.leaderModel} options={models} disableLabel={t('inheritance')}
        change={leaderModel => change({ leaderModel })} />
    </section>
  </>
}
