/** 独立主面板：对话、待处理、记录和设置始终留在 Studio。 */
import { useCallback, useMemo, useState } from 'react'
import { ASSISTANT_CONVERSATION, type StudioState } from '../studio/protocol.ts'
import { callStudio, type StudioCall } from './api.ts'
import { Conversation, Original } from './conversation.tsx'
import { addressKey, type Drafts } from './drafts.ts'
import type { T } from './locales.ts'
import { Pending } from './pending.tsx'
import { useQuery, type StudioQuery } from './query.ts'
import { RecordDetail, Records } from './records.tsx'
import { feishuTone, Settings } from './settings.tsx'
import { styles } from './styles.ts'
import { Button, FailureNotice, StudioContext, type StudioView } from './ui.tsx'

const home = { view: { kind: 'chat', conversationId: ASSISTANT_CONVERSATION } } as const
interface Location { view: StudioView; previous?: Location }

function View({ view }: { view: StudioView }) {
  switch (view.kind) {
    case 'chat': return <Conversation view={view} key={JSON.stringify([addressKey(view), view.cursors])} />
    case 'original': return <Original {...view} key={JSON.stringify([view.conversationId, view.messageId])} />
    case 'pending': return <Pending cursors={view.cursors} key={JSON.stringify(view.cursors ?? [])} />
    case 'records': return <Records view={view} key={view.query ?? ''} />
    case 'record': return <RecordDetail view={view} key={JSON.stringify(view)} />
    case 'settings': return <Settings />
  }
}

/** Studio 第一次打开 Assistant；查看来源或话题时，返回栈保留原分页。 */
export function Studio({ t, locale, stateQuery, drafts, call = callStudio }: {
  t: T; locale: string; stateQuery: StudioQuery<StudioState>; drafts: Drafts; call?: StudioCall
}) {
  const host = useQuery(stateQuery)
  const state = host.data
  const [location, setLocation] = useState<Location>(home)
  const open = useCallback((view: StudioView, replace = false) => setLocation(current => ({
    view, previous: replace ? current.previous : current,
  })), [])
  const back = useCallback(() => setLocation(current => current.previous ?? home), [])
  const dates = useMemo(() => {
    const options = { dateStyle: 'medium', timeStyle: 'short' } as const
    try { return new Intl.DateTimeFormat(locale, options) } catch { return new Intl.DateTimeFormat(undefined, options) }
  }, [locale])
  const view = location.view
  const projectId = view.kind === 'chat' && view.conversationId !== ASSISTANT_CONVERSATION ? view.conversationId : ''
  const pending = state?.pendingCount ?? 0
  const on = (kind: 'pending' | 'records' | 'settings') => view.kind === kind ? undefined : () => open({ kind })
  return <StudioContext.Provider value={{ t, dates, call, state, reloadState: stateQuery.reload, drafts, location, open, back }}>
    <section className="as-studio" aria-label={t('studio')}>
      <style>{styles}</style>
      <header className="as-header">
        <div className="as-brand"><h1>{t('studio')}</h1>
          {state && <Button className="as-feishu" data-tone={feishuTone(state.feishu)} onClick={on('settings')}>
            <span className="as-dot" aria-hidden="true" />{t(`feishu.${state.feishu}`)}
          </Button>}</div>
        <nav className="as-nav" aria-label={t('navigation')}>
          <Button aria-current={view.kind === 'chat' && view.conversationId === ASSISTANT_CONVERSATION ? 'page' : undefined}
            onClick={() => setLocation(home)}>{t('assistant')}</Button>
          <select aria-label={t('project')} value={projectId} disabled={!state?.projects.length} onChange={event => {
            const conversationId = event.currentTarget.value
            setLocation(conversationId ? { view: { kind: 'chat', conversationId } } : home)
          }}>
            <option value="">{t('project')}</option>
            {projectId && !state?.projects.some(project => project.id === projectId) && <option value={projectId}>{projectId}</option>}
            {state?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Button aria-current={view.kind === 'pending' ? 'page' : undefined} onClick={on('pending')}>
            {t('pending')}{pending > 0 && <span className="as-pill as-count" aria-label={t('pendingCount', { count: pending })}>{pending}</span>}
          </Button>
          <Button aria-current={view.kind === 'records' || view.kind === 'record' ? 'page' : undefined}
            onClick={on('records')}>{t('records')}</Button>
          <Button aria-current={view.kind === 'settings' ? 'page' : undefined} onClick={on('settings')}>{t('settings')}</Button>
        </nav>
      </header>
      {host.failure !== undefined && <div className="as-banner"><FailureNotice failure={host.failure} retry={stateQuery.reload} /></div>}
      <div className="as-content"><View view={view} /></div>
    </section>
  </StudioContext.Provider>
}
