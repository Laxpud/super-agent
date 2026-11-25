/** Studio 默认模型是带修订版本的单独设置，不改对话窗口或宿主配置。 */
import { useId, useMemo, useRef, useState } from 'react'
import type { FeishuState, StudioModel, StudioModelOption, StudioSettings } from '../studio/protocol.ts'
import { createQuery, useQuery } from './query.ts'
import { Button, FailureNotice, PageHeading, QueryStatus, useStudio } from './ui.tsx'

const MODEL_ROLES = ['assistant', 'leader'] as const
type ModelRole = typeof MODEL_ROLES[number]
type Edits = Partial<Pick<StudioSettings, ModelRole>>
interface Draft { base: StudioSettings; edits: Edits }
const equal = (a: StudioModel | null, b: StudioModel | null) => a?.provider === b?.provider && a?.model === b?.model &&
  a?.reasoningEffort === b?.reasoningEffort

function ModelFields({ role, value, options, change, disabled }: { role: ModelRole; value: StudioModel | null; options: StudioModelOption[];
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
          const first = options.find(option => option.provider === event.currentTarget.value)
          change(first ? { provider: first.provider, model: first.model } : null)
        }}>
          <option value="">{t('useDefault')}</option>
          {provider && !providers.includes(provider) && <option value={provider}>{t('unavailableOption', { name: provider })}</option>}
          {providers.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-model`}>{t('model')}
        <select id={`${id}-model`} value={model} disabled={!provider || !models.length}
          onChange={event => change({ provider, model: event.currentTarget.value })}>
          {!model && <option value="">{t('useDefault')}</option>}
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
  return state === 'online' ? 'success' : state === 'offline' || state === 'identity-mismatch' ? 'warn' : undefined
}

export function Settings() {
  const { t, state, call, reloadState } = useStudio()
  const catalog = useMemo(() => createQuery(signal => call('models', {}, signal)), [call])
  const models = useQuery(catalog)
  const [draft, setDraft] = useState<Draft>()
  const [saved, setSaved] = useState<StudioSettings>()
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const remote = state?.settings
  // 保存回执可先于 state 轮询到达，不让上一次快照回退刚保存的修订版本。
  const latest = remote && (!saved || remote.revision >= saved.revision) ? remote : saved
  const values = draft ? { ...draft.base, ...draft.edits } : latest
  const stale = !!draft && !!latest && draft.base.revision !== latest.revision
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
    if (!draft || !latest) return
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
    if (!draft || stale || saving.current) return
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
  return <section className="as-detail">
    <PageHeading title={t('settings')} />
    <form className="as-card as-fields" onSubmit={event => { event.preventDefault(); void save() }}>
      <h3>{t('modelSettings')}</h3>
      <p className="as-muted">{t('modelsIntro')}</p>
      {values && <p className="as-meta">{t('revision', { revision: values.revision })}</p>}
      <QueryStatus query={models} reload={catalog.reload} />
      {values && models.data && MODEL_ROLES.map(role => <ModelFields key={role} role={role} value={values[role]}
        options={models.data!} change={value => change(role, value)} disabled={busy} />)}
      {failure !== undefined && <FailureNotice failure={failure} />}
      {stale && <div className="as-warning">
        <p role="status">{t('settingsChanged')}</p>
        <div className="as-actions">
          <Button onClick={rebase}>{t('rebaseSettings')}</Button>
          <Button onClick={() => { setDraft(undefined); setFailure(undefined) }}>{t('discardSettings')}</Button>
        </div>
      </div>}
      {saved && !draft && <p className="as-success" role="status">{t('settingsSaved')}</p>}
      <div className="as-actions"><Button type="submit" primary disabled={!draft || stale || busy || !models.data}>
        {t(busy ? 'saving' : 'save')}</Button></div>
    </form>
    <section className="as-card as-fields">
      <div className="as-meta"><h3>{t('feishuConnection')}</h3>
        {state && <span className="as-pill" data-tone={feishuTone(state.feishu)}>{t(`feishu.${state.feishu}`)}</span>}</div>
      <p>{t('feishuScope')}</p><p className="as-muted">{t('feishuLimits')}</p>
    </section>
  </section>
}
