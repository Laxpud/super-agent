/** 仅管理所有者显式登记的偏好；全局和项目范围的读写、版本及表单各自独立。 */
import { useMemo, useState } from 'react'
import type { StudioPreference } from '../studio/protocol.ts'
import { StudioApiError } from './api.ts'
import { createQuery, useQuery } from './query.ts'
import { SettingText, SettingsConfirm } from './settings-fields.tsx'
import { Button, FailureNotice, PageHeading, QueryStatus, Time, projectById, useAction, useStudio, type PreferencesView } from './ui.tsx'

type Existing = { key: string; version: number }
type Edit = Existing & { text: string }
type Change = { op: 'savePreference'; key: string; text: string } | ({ op: 'updatePreference' } & Edit) | ({ op: 'forgetPreference' } & Existing)
const validKey = (key: string) => /^[a-z][a-z0-9-]{0,63}$/u.test(key)

function PreferenceText({ value, change, disabled }: { value: string; change: (text: string) => void; disabled: boolean }) {
  const { t } = useStudio()
  return <label className="as-setting-field">{t('preferenceText')}
    <textarea rows={3} maxLength={4000} value={value} disabled={disabled} onChange={event => change(event.currentTarget.value)} />
  </label>
}

function PreferenceScope({ projectId }: { projectId?: string }) {
  const { t, state, call, reloadState } = useStudio()
  const project = projectId ? projectById(state, projectId) : undefined
  const readOnly = !!projectId && project?.state !== 'active'
  const scope = useMemo(() => projectId ? { projectId } : {}, [projectId])
  const query = useMemo(() => createQuery(async signal => {
    const items = await call('preferences', scope, signal)
    if (items.some(item => item.projectId !== (projectId ?? null))) throw new StudioApiError('badResponse', 200)
    return items
  }), [call, scope, projectId])
  const result = useQuery(query)
  const action = useAction()
  const [key, setKey] = useState('')
  const [text, setText] = useState('')
  const [edit, setEdit] = useState<Edit>()
  const [confirm, setConfirm] = useState<Existing>()
  const [notice, setNotice] = useState<'preferencesSaved' | 'preferenceForgotten'>()
  const items = result.data?.filter(item => item.state === 'active') ?? []
  const edited = edit && items.find(item => item.key === edit.key)
  const stale = !!edit && edited?.version !== edit.version

  const change = (command: Change) => {
    if (readOnly) return
    void action.run(async () => {
      const { op, key } = command
      const input = { key, ...scope }
      const forgetting = op === 'forgetPreference'
      const previousVersion = 'version' in command ? command.version : 0
      setNotice(undefined)
      try {
        const receipt = op === 'savePreference' ? await call(op, { ...input, text: command.text })
          : op === 'updatePreference' ? await call(op, { ...input, expectedVersion: command.version, text: command.text })
            : await call(op, { ...input, expectedVersion: command.version })
        if (receipt.key !== key || receipt.projectId !== (projectId ?? null) || receipt.version !== previousVersion + 1
          || receipt.state !== (forgetting ? 'forgotten' : 'active')) throw new StudioApiError('badResponse', 200)
        // 使用本次回执立刻更新清单，而不是等下一次读取才能移除已忘记的偏好。
        query.reconcile(current => {
          const others = current?.filter(item => item.key !== key) ?? []
          return forgetting ? others : [...others, receipt].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        })
        if (op === 'savePreference') { setKey(''); setText('') }
        if (op === 'updatePreference' || edit?.key === key) setEdit(undefined)
        setNotice(forgetting ? 'preferenceForgotten' : 'preferencesSaved')
      } catch (error) { query.reload(); if (projectId) reloadState(); throw error }
    })
  }
  const startEdit = (item: StudioPreference) => {
    action.clear(); setNotice(undefined); setEdit({ key: item.key, version: item.version, text: item.text })
  }
  return <>
    <QueryStatus query={result} reload={query.reload} />
    {action.failure !== undefined && <FailureNotice failure={action.failure} />}
    {notice && <p className="as-success" role="status">{t(notice)}</p>}
    {project?.state === 'archived' && <p className="as-muted">{t('archivedPreferences')}</p>}
    {result.data && !items.length && <p className="as-empty">{t('emptyPreferences')}</p>}
    {edit && (stale || readOnly) && <div className="as-warning" role="status">
      <span>{t(readOnly ? 'archivedPreferences' : 'preferenceDraftStale')}</span>
      <Button disabled={action.busy} onClick={() => setEdit(undefined)}>{t('discardSettings')}</Button>
    </div>}
    {items.map(item => <article className="as-card" key={item.preferenceId}>
      <header className="as-task-row-title"><h3><code>{item.key}</code></h3><div className="as-meta">
        <span>{t('preferenceVersion', { version: item.version })}</span><Time value={item.updatedAt} />
      </div></header>
      {edit?.key === item.key && !readOnly ? <form className="as-fields" onSubmit={event => {
        event.preventDefault()
        if (!stale && edit.text.trim() && edit.text !== item.text) change({ op: 'updatePreference', ...edit })
      }}>
        {stale && <p className="as-message-text">{item.text}</p>}
        <PreferenceText value={edit.text} disabled={action.busy} change={text => setEdit({ ...edit, text })} />
        <div className="as-actions">
          <Button type="submit" primary disabled={stale || action.busy || !edit.text.trim() || edit.text === item.text}>{t('savePreference')}</Button>
          {!stale && <Button disabled={action.busy} onClick={() => setEdit(undefined)}>{t('cancel')}</Button>}
        </div>
      </form> : <>
        <p className="as-message-text">{item.text}</p>
        {!readOnly && <div className="as-actions">
          <Button disabled={action.busy || !!edit} onClick={() => startEdit(item)}>{t('editPreference')}</Button>
          <Button disabled={action.busy || !!edit} onClick={() => setConfirm({ key: item.key, version: item.version })}>{t('forgetPreference')}</Button>
        </div>}
      </>}
    </article>)}
    {!readOnly && result.data && <form className="as-card as-fields" onSubmit={event => {
      event.preventDefault(); if (validKey(key) && text.trim()) change({ op: 'savePreference', key, text })
    }}>
      <h3>{t('newPreference')}</h3>
      <fieldset disabled={action.busy} className="as-setting-panel as-fields">
        <SettingText label={t('preferenceKey')} hint={t('preferenceKeyHint')} value={key} change={setKey} maxLength={64} />
        <PreferenceText value={text} change={setText} disabled={action.busy} />
      </fieldset>
      <div className="as-actions"><Button type="submit" primary disabled={action.busy || !validKey(key) || !text.trim()}>{t('addPreference')}</Button></div>
    </form>}
    {confirm && <SettingsConfirm title={t('forgetPreferenceTitle')} body={t('forgetPreferenceBody', { key: confirm.key })}
      acceptLabel={t('forgetPreference')} dismiss={() => setConfirm(undefined)} disabled={readOnly || action.busy} accept={() => {
        setConfirm(undefined); change({ op: 'forgetPreference', ...confirm })
      }} />}
  </>
}

export function Preferences({ view }: { view: PreferencesView }) {
  const { t, state, open } = useStudio()
  const { projectId } = view
  const project = projectId ? projectById(state, projectId) : undefined
  const projectMode = !!projectId && view.scope === 'project'
  return <section className="as-detail">
    <PageHeading title={t('preferences')} detail={t('preferencesIntro')} />
    <nav className="as-settings-nav" aria-label={t('preferenceScope')}>
      <Button aria-current={!projectMode ? 'page' : undefined} onClick={projectMode ? () => open({ ...view, scope: undefined }, true) : undefined}>
        {t('globalPreferences')}
      </Button>
      <Button disabled={!projectId} aria-current={projectMode ? 'page' : undefined} onClick={!projectMode && projectId
        ? () => open({ ...view, scope: 'project' }, true) : undefined}>{t('projectPreferences')}
      </Button>
    </nav>
    {projectMode ? <h3>{t('projectPreferencesFor', { name: project?.name ?? projectId })}</h3>
      : !projectId && <p className="as-muted">{t('selectProjectForPreferences')}</p>}
    <PreferenceScope key={projectMode ? projectId : ''} projectId={projectMode ? projectId : undefined} />
  </section>
}
