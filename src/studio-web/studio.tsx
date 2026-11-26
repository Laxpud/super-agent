/** 独立主面板：对话、待处理、记录和设置始终留在 Studio。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ASSISTANT_CONVERSATION, type StudioState } from '../studio/protocol.ts'
import { callStudio, type StudioCall } from './api.ts'
import { Conversation, Original } from './conversation.tsx'
import { addressKey, type Drafts } from './drafts.ts'
import type { T } from './locales.ts'
import { Pending } from './pending.tsx'
import { useQuery, type StudioQuery } from './query.ts'
import { RecordDetail, Records } from './records.tsx'
import { SettingsConfirm } from './settings-fields.tsx'
import { feishuTone, Settings } from './settings.tsx'
import { styles } from './styles.ts'
import { Button, FailureNotice, StudioContext, type StudioView } from './ui.tsx'

const home = { view: { kind: 'chat', conversationId: ASSISTANT_CONVERSATION } } as const
interface Location { view: StudioView; previous?: Location }

function View({ view, settingsDirty, settingsBusy }: { view: StudioView; settingsDirty(value: boolean): void; settingsBusy(value: boolean): void }) {
  switch (view.kind) {
    case 'chat': return <Conversation view={view} key={JSON.stringify([addressKey(view), view.cursors])} />
    case 'original': return <Original {...view} key={JSON.stringify([view.conversationId, view.messageId])} />
    case 'pending': return <Pending cursors={view.cursors} key={JSON.stringify(view.cursors ?? [])} />
    case 'records': return <Records view={view} key={view.query ?? ''} />
    case 'record': return <RecordDetail view={view} key={JSON.stringify(view)} />
    case 'settings': return <Settings section={view.section} dirtyChange={settingsDirty} busyChange={settingsBusy} />
  }
}

/** Studio 第一次打开 Assistant；查看来源或话题时，返回栈保留原分页。 */
export function Studio({ t, locale, stateQuery, drafts, call = callStudio }: {
  t: T; locale: string; stateQuery: StudioQuery<StudioState>; drafts: Drafts; call?: StudioCall
}) {
  const host = useQuery(stateQuery)
  const state = host.data
  const [location, setLocation] = useState<Location>(home)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [leaving, setLeaving] = useState<Location>()
  const navigate = useCallback((next: Location) => {
    if (location.view.kind === 'settings' && next.view.kind !== 'settings') {
      if (settingsBusy) return
      if (settingsDirty) { setLeaving(next); return }
    }
    setLocation(next)
  }, [location.view.kind, settingsBusy, settingsDirty])
  const open = useCallback((view: StudioView, replace = false) => navigate({ view, previous: replace ? location.previous : location }),
    [location, navigate])
  const back = useCallback(() => navigate(location.previous ?? home), [location.previous, navigate])
  useEffect(() => {
    if (location.view.kind !== 'settings' || (!settingsDirty && !settingsBusy)) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [location.view.kind, settingsDirty, settingsBusy])
  const dates = useMemo(() => {
    const options = { dateStyle: 'medium', timeStyle: 'short' } as const
    try { return new Intl.DateTimeFormat(locale, options) } catch { return new Intl.DateTimeFormat(undefined, options) }
  }, [locale])
  const view = location.view
  const projectId = view.kind === 'chat' && view.conversationId !== ASSISTANT_CONVERSATION ? view.conversationId : ''
  const pending = state?.pendingCount ?? 0
  const on = (kind: 'pending' | 'records') => view.kind === kind ? undefined : () => open({ kind })
  const feishuPage = view.kind === 'settings' && view.section === 'feishu'
  const settingsRoot = view.kind === 'settings' && (!view.section || view.section === 'models')
  return <StudioContext.Provider value={{ t, dates, call, state, reloadState: stateQuery.reload, drafts, location, open, back }}>
    <section className="as-studio" aria-label={t('studio')}>
      <style>{styles}</style>
      <header className="as-header">
        <div className="as-brand"><h1>{t('studio')}</h1>
          <div className="as-meta">
            {state && <span className="as-feishu-state" data-tone={feishuTone(state.feishu)}>
              <span className="as-dot" aria-hidden="true" />{t(`feishu.${state.feishu}`)}</span>}
            {!feishuPage && <Button className="as-feishu" onClick={() => open({ kind: 'settings', section: 'feishu' }, view.kind === 'settings')}>
              {t('configureFeishu')}
            </Button>}
          </div>
        </div>
        <nav className="as-nav" aria-label={t('navigation')}>
          <Button aria-current={view.kind === 'chat' && view.conversationId === ASSISTANT_CONVERSATION ? 'page' : undefined}
            disabled={view.kind === 'settings' && settingsBusy} onClick={() => navigate(home)}>{t('assistant')}</Button>
          <select aria-label={t('project')} value={projectId} disabled={!state?.projects.length || view.kind === 'settings' && settingsBusy} onChange={event => {
            const conversationId = event.currentTarget.value
            navigate(conversationId ? { view: { kind: 'chat', conversationId } } : home)
          }}>
            <option value="">{t('project')}</option>
            {projectId && !state?.projects.some(project => project.id === projectId) && <option value={projectId}>{projectId}</option>}
            {state?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button aria-current={view.kind === 'pending' ? 'page' : undefined}
            disabled={view.kind === 'settings' && settingsBusy} onClick={on('pending')}>
            {t('pending')}{pending > 0 && <span className="as-pill as-count" aria-label={t('pendingCount', { count: pending })}>{pending}</span>}
          </Button>
          <Button aria-current={view.kind === 'records' || view.kind === 'record' ? 'page' : undefined}
            disabled={view.kind === 'settings' && settingsBusy} onClick={on('records')}>{t('records')}</Button>
          <Button aria-current={view.kind === 'settings' ? 'page' : undefined}
            onClick={settingsRoot ? undefined : () => open({ kind: 'settings' }, view.kind === 'settings')}>{t('settings')}</Button>
        </nav>
      </header>
      {host.failure !== undefined && <div className="as-banner"><FailureNotice failure={host.failure} retry={stateQuery.reload} /></div>}
      <div className="as-content"><View view={view} settingsDirty={setSettingsDirty} settingsBusy={setSettingsBusy} /></div>
      {leaving && <SettingsConfirm title={t('leaveSettings')} body={t('leaveSettingsBody')} cancelLabel={t('stayInSettings')}
        acceptLabel={t('leaveSettingsConfirm')} dismiss={() => setLeaving(undefined)} accept={() => {
          setLeaving(undefined); setSettingsDirty(false); setLocation(leaving)
        }} />}
    </section>
  </StudioContext.Provider>
}
