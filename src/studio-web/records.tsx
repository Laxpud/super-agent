/** Session 记录为 Studio 内只读视图，按宿主提供的事件序号定位来源。 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createQuery, nextPage, useQuery } from './query.ts'
import { Button, chatTitle, PageHeading, Pager, QueryStatus, Time, useStudio, type StudioView } from './ui.tsx'

type HistoryView = Extract<StudioView, { kind: 'records' }>
type RecordView = Extract<StudioView, { kind: 'record' }>

export function Records({ view }: { view: HistoryView }) {
  const { t, call, open, state } = useStudio()
  const { query, cursors = [] } = view
  const before = cursors.at(-1)
  const history = useMemo(() => createQuery(signal => call('records', { query, before }, signal)), [call, query, before])
  const result = useQuery(history)
  const next = nextPage(cursors, result.data?.next)
  const [search, setSearch] = useState(query ?? '')
  const input = useId()
  return <section className="as-detail">
    <PageHeading title={t('records')} detail={t('recordsIntro')} />
    <form className="as-search" onSubmit={event => {
      event.preventDefault()
      const value = search.trim() || undefined
      if (value === query && before === undefined) history.reload()
      else open({ kind: 'records', query: value }, true)
    }}>
      <label className="as-visually-hidden" htmlFor={input}>{t('searchRecords')}</label>
      <input id={input} type="search" maxLength={256} placeholder={t('searchPlaceholder')} value={search}
        onChange={event => setSearch(event.currentTarget.value)} />
      <Button type="submit">{t('search')}</Button>
    </form>
    <Pager previous={cursors.length ? () => open({ ...view, cursors: cursors.slice(0, -1) }, true) : undefined}
      next={next !== undefined ? () => open({ ...view, cursors: [...cursors, next] }, true) : undefined}
      previousLabel={t('newerRecords')} nextLabel={t('olderRecords')} />
    <QueryStatus query={result} reload={history.reload} />
    {result.data && !result.data.items.length && <p className="as-empty">{t(query ? 'noSearchResults' : 'emptyRecords')}</p>}
    <ul className="as-record-list">
      {result.data?.items.map(item => <li key={item.id}>
        <button className="as-record-row" type="button" onClick={() => open({ kind: 'record', sessionId: item.id })}>
          <strong>{item.id}</strong>
          <span className="as-meta">
            <span>{chatTitle(t, state, item.conversationId)}</span><span>{t(`role.${item.role}`)}</span><Time value={item.createdAt} />
          </span>
        </button>
      </li>)}
    </ul>
  </section>
}

export function RecordDetail({ view }: { view: RecordView }) {
  const { t, call, open, state } = useStudio()
  const { sessionId, focusSeq, cursors = [] } = view
  // `from` 包含目标序号，可直接打开较老的来源事件，而不是加载到该处之前的所有事件。
  const from = cursors.at(-1) ?? focusSeq
  const record = useMemo(() => createQuery(signal => call('record', { sessionId, from }, signal)), [call, sessionId, from])
  const result = useQuery(record)
  const next = nextPage(focusSeq === undefined ? cursors : [focusSeq, ...cursors], result.data?.next)
  const target = useRef<HTMLLIElement>(null)
  useEffect(() => { if (result.data) target.current?.focus() }, [result.data])
  return <section className="as-detail">
    <PageHeading title={t('record')} detail={sessionId}>
      <span className="as-pill">{t('readOnly')}</span>
    </PageHeading>
    {result.data?.record && <div className="as-meta">
      <strong>{chatTitle(t, state, result.data.record.conversationId)}</strong><span>{t(`role.${result.data.record.role}`)}</span>
      <Time value={result.data.record.createdAt} />
    </div>}
    <Pager previous={cursors.length ? () => open({ ...view, cursors: cursors.slice(0, -1) }, true)
      : focusSeq ? () => open({ kind: 'record', sessionId }, true) : undefined}
      next={next !== undefined ? () => open({ ...view, cursors: [...cursors, next] }, true) : undefined}
      previousLabel={t('earlierEvents')} nextLabel={t('laterEvents')} />
    <QueryStatus query={result} reload={record.reload} />
    {result.data && !result.data.events.length && <p className="as-empty">{t('noEvents')}</p>}
    <ol className="as-event-list">
      {result.data?.events.map(event => {
        const focused = event.seq === focusSeq
        return <li key={event.seq} ref={focused ? target : undefined} data-focused={focused || undefined} tabIndex={focused ? -1 : undefined}
          className="as-card">
          <div className="as-meta"><strong>{t(focused ? 'sourceEvent' : 'event', { seq: event.seq })}</strong><span>{event.kind}</span></div>
          <p className="as-message-text">{event.text || t('noOutput')}</p>
        </li>
      })}
    </ol>
  </section>
}
