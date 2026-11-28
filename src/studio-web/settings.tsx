/** Studio 默认模型是带修订版本的单独设置，不改对话窗口或宿主配置。 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { FeishuState, StudioModel, StudioSettings } from '../studio/protocol.ts'
import { HostSettings } from './configuration.tsx'
import { createQuery, useQuery, type QuerySnapshot } from './query.ts'
import { SETTINGS_SECTIONS, type ModelCatalog, type SettingsSection } from './settings-fields.tsx'
import { Button, FailureNotice, PageHeading, QueryStatus, useStudio } from './ui.tsx'

const MODEL_ROLES = ['assistant', 'leader'] as const
type ModelRole = typeof MODEL_ROLES[number]
type Edits = Partial<Pick<StudioSettings, ModelRole>>
interface Draft { base: StudioSettings; edits: Edits }
const equal = (a: StudioModel | null, b: StudioModel | null) => a?.provider === b?.provider && a?.model === b?.model &&
  a?.reasoningEffort === b?.reasoningEffort

function ModelFields({ role, value, options, change, disabled }: { role: ModelRole; value: StudioModel | null; options: ModelCatalog;
  change: (value: StudioModel | null) => void; disabled: boolean }) {
  const { t } = useStudio()
  const id = useId()
  const provider = value?.provider ?? ''
  const model = value?.model ?? ''
  const effort = value?.reasoningEffort ?? ''
  const providers = [...new Set(options.map(option => option.provider))]
  const models = options.filter(option => option.provider === provider)
  const efforts = models.find(option => option.model === model)?.reasoningEfforts ?? []
  return <fieldset className="as-model-fields" disabled={disabled}>
    <legend>{t(`role.${role}`)}</legend>
    <div className="as-model-grid">
      <label htmlFor={`${id}-provider`}>{t('provider')}
        <select id={`${id}-provider`} value={provider} onChange={event => {
          const selected = event.currentTarget.value
          const available = options.filter(option => option.provider === selected)
          change(selected ? { provider: selected, model: available.length === 1 ? available[0]!.model : '' } : null)
        }}>
          <option value="">{t('useDefault')}</option>
          {provider && !providers.includes(provider) && <option value={provider}>{t('unavailableOption', { name: provider })}</option>}
          {providers.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-model`}>{t('model')}
        <select id={`${id}-model`} value={model} disabled={!provider || !models.length}
          onChange={event => change({ provider, model: event.currentTarget.value })}>
          {!model && <option value="">{t(provider ? 'modelChoice' : 'useDefault')}</option>}
          {model && !models.some(option => option.model === model) && <option value={model}>{t('unavailableOption', { name: model })}</option>}
          {models.map(option => <option key={option.model} value={option.model}>{option.label}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-effort`}>{t('effort')}
        <select id={`${id}-effort`} value={effort} disabled={!model || (!efforts.length && !effort)}
          onChange={event => change({ provider, model, reasoningEffort: event.currentTarget.value || undefined })}>
          <option value="">{t('modelDefault')}</option>
          {effort && !efforts.includes(effort) && <option value={effort}>{t('unavailableOption', { name: effort })}</option>}
          {efforts.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
    </div>
  </fieldset>
}

export function feishuTone(state: FeishuState) {
  return state === 'online' ? 'success' : state === 'offline' || state === 'identity-mismatch' || state === 'credential-missing' ? 'warn' : undefined
}

function DialogueModels({ models, reload, locked, dirtyChange, busyChange }: {
  models: QuerySnapshot<ModelCatalog>; reload: () => void; locked: boolean;
  dirtyChange: (value: boolean) => void; busyChange: (value: boolean) => void
}) {
  const { t, state, call, reloadState } = useStudio()
  const [draft, setDraft] = useState<Draft>()
  const [saved, setSaved] = useState<StudioSettings>()
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const remote = state?.settings
  // 保存回执可先于 state 轮询到达，不让上一次快照回退刚保存的修订版本。
  const latest = remote && (!saved || remote.scope !== saved.scope || remote.revision >= saved.revision) ? remote : saved
  const values = draft ? { ...draft.base, ...draft.edits } : latest
  const crossScope = !!draft && !!latest && draft.base.scope !== latest.scope
  const stale = !!draft && !!latest && (crossScope || draft.base.revision !== latest.revision)
  const invalid = MODEL_ROLES.some(role => values?.[role] && !values[role]?.model)
  useEffect(() => { dirtyChange(!!draft) }, [draft, dirtyChange])
  useEffect(() => { busyChange(busy) }, [busy, busyChange])
  function change(role: ModelRole, value: StudioModel | null) {
    if (!latest || saving.current) return
    const base = draft?.base ?? latest
    const edits = { ...draft?.edits }
    if (equal(base[role], value)) delete edits[role]
    else edits[role] = value
    setDraft(Object.keys(edits).length ? { base, edits } : undefined)
    setFailure(undefined)
  }
  function rebase() {
    if (!draft || !latest || crossScope) return
    // 只把用户实际编辑的角色移到最新版本，不覆盖别处更改的另一角色。
    const edits = { ...draft.edits }
    for (const role of MODEL_ROLES) {
      const value = edits[role]
      if (value !== undefined && equal(latest[role], value)) delete edits[role]
    }
    setDraft(Object.keys(edits).length ? { base: latest, edits } : undefined)
    setFailure(undefined)
  }
  const save = async () => {
    if (!draft || stale || invalid || locked || saving.current) return
    saving.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      setSaved(await call('settings', { ...draft.base, ...draft.edits }))
      setDraft(undefined)
    } catch (error) {
      setFailure(error)
    } finally {
      saving.current = false
      setBusy(false)
      reloadState()
    }
  }
  return <form className="as-card as-fields" onSubmit={event => { event.preventDefault(); void save() }}>
      <h3>{t('modelSettings')}</h3>
      <p className="as-muted">{t('modelsIntro')} {t('liveModelsEffect')}</p>
      {values && <p className="as-meta">{t('revision', { revision: values.revision })}</p>}
      <QueryStatus query={models} reload={reload} />
      {values && models.data && MODEL_ROLES.map(role => <ModelFields key={role} role={role} value={values[role]}
        options={models.data!} change={value => change(role, value)} disabled={busy || locked} />)}
      {failure !== undefined && <FailureNotice failure={failure} />}
      {stale && <div className="as-warning">
        <p role="status">{t('settingsChanged')}</p>
        <div className="as-actions">
          {!crossScope && <Button onClick={rebase}>{t('rebaseSettings')}</Button>}
          <Button onClick={() => { setDraft(undefined); setFailure(undefined) }}>{t('discardSettings')}</Button>
        </div>
      </div>}
      {saved && !draft && <p className="as-success" role="status">{t('settingsSaved')}</p>}
      {invalid && <p className="as-muted">{t('modelChoice')}</p>}
      <div className="as-actions"><Button type="submit" primary disabled={!draft || stale || busy || locked || invalid || !models.data}>
        {t(busy ? 'saving' : 'save')}</Button>
        {draft && !busy && !stale && <Button onClick={() => { setDraft(undefined); setFailure(undefined) }}>{t('discardSettings')}</Button>}</div>
    </form>
}

/** 设置各页共享模型目录，标签切换不丢草稿；宿主重载和即时模型保存不得并行。 */
export function Settings({ section = 'models', dirtyChange, busyChange }: {
  section?: SettingsSection; dirtyChange: (dirty: boolean) => void; busyChange: (busy: boolean) => void
}) {
  const { t, state, call, open } = useStudio()
  const catalog = useMemo(() => createQuery(signal => call('models', {}, signal)), [call])
  const models = useQuery(catalog)
  const [modelDirty, setModelDirty] = useState(false)
  const [hostDirty, setHostDirty] = useState(false)
  const [modelBusy, setModelBusy] = useState(false)
  const [hostBusy, setHostBusy] = useState(false)
  useEffect(() => { dirtyChange(modelDirty || hostDirty) }, [dirtyChange, modelDirty, hostDirty])
  useEffect(() => { busyChange(modelBusy || hostBusy) }, [busyChange, modelBusy, hostBusy])
  const select = (target: SettingsSection) => { if (target !== section) open({ kind: 'settings', section: target }, true) }
  return <section className="as-detail as-settings">
    <PageHeading title={t('settings')}>
      {(modelDirty || hostDirty) && <span className="as-pill" data-tone="warn">{t('settingsDirty')}</span>}
    </PageHeading>
    <nav className="as-settings-nav" aria-label={t('settingsNavigation')}>
      {SETTINGS_SECTIONS.map(key => <Button key={key} aria-current={section === key ? 'page' : undefined}
        onClick={() => select(key)}>{t(`section.${key}`)}</Button>)}
    </nav>
    <div className="as-config-view" hidden={section !== 'models'}>
      <DialogueModels models={models} reload={catalog.reload} locked={hostBusy} dirtyChange={setModelDirty} busyChange={setModelBusy} />
      <section className="as-card as-fields">
        <div className="as-meta"><h3>{t('feishuConnection')}</h3>
          {state && <span className="as-pill" data-tone={feishuTone(state.feishu)}>{t(`feishu.${state.feishu}`)}</span>}</div>
        <p className="as-muted">{t('feishuLimits')}</p>
        <div className="as-actions"><Button onClick={() => select('feishu')}>{t('configureFeishu')}</Button></div>
      </section>
    </div>
    <HostSettings section={section} select={select} models={models} reloadOptions={catalog.reload} dirtyChange={setHostDirty} busyChange={setHostBusy}
      modelsBusy={modelBusy} modelsDirty={modelDirty} />
  </section>
}
