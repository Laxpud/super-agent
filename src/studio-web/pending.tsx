/** 待处理事项只对仍有效的明确选项或文本开放回答。 */
import { useId, useMemo, useRef, useState } from 'react'
import type { StudioPending } from '../studio/protocol.ts'
import { StudioApiError } from './api.ts'
import { createQuery, nextPage, useQuery } from './query.ts'
import { Button, chatTitle, FailureNotice, PageHeading, Pager, QueryStatus, Time, useStudio } from './ui.tsx'

function PendingItem({ item, resolved, refresh }: { item: StudioPending; resolved: (item: StudioPending) => void; refresh: () => void }) {
  const { t, state, open, call } = useStudio()
  const [text, setText] = useState('')
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const inputId = useId()
  const blocked = item.kind === 'blocked'
  const answer = async (value: string) => {
    if (running.current || item.state !== 'pending' || !value.trim()) return
    running.current = true
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await call('answer', { id: item.id, value })
      if (result.id !== item.id || result.state !== 'resolved') throw new StudioApiError('badResponse', 200)
      resolved(result)
      setText('')
    } catch (error) {
      // 本地文本仍可复制或重试。刷新列表和标记，包括不轮询的旧页，以免其他渠道已处理的事项仍显示按钮。
      setFailure(error)
      refresh()
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  function source() {
    if (item.messageId) open({ kind: 'original', conversationId: item.conversationId, messageId: item.messageId })
    else if (item.recordSessionId) open({ kind: 'record', sessionId: item.recordSessionId })
    else open({ kind: 'chat', conversationId: item.conversationId, topicId: item.topicId })
  }
  return <article className="as-card as-pending-item">
    <div className="as-meta">
      <span className="as-pill">{t(`pendingKind.${item.kind}`)}</span><span className="as-pill">{t(`pendingState.${item.state}`)}</span>
      <Time value={item.createdAt} />
    </div>
    <h3>{item.title}</h3>
    <div className="as-meta">
      <strong>{chatTitle(t, state, item.conversationId)}</strong><span>{t('requester', { name: item.requester })}</span>
      {item.taskId && <span>{t('task', { id: item.taskId })}</span>}
    </div>
    {item.detail && <p className="as-message-text">{item.detail}</p>}
    <div className="as-actions">
      <Button onClick={source}>{t(item.messageId || item.recordSessionId ? 'source' : item.topicId ? 'topic' : 'openConversation')}</Button>
      {item.state === 'pending' && <span className="as-pill" data-tone={item.kind !== 'confirmation' && item.mobile === 'unsupported' ? 'warn' : undefined}>
        {t(item.kind === 'confirmation' ? 'decisionText' : `mobile.${item.mobile}`)}</span>}
    </div>
    {failure !== undefined && <FailureNotice failure={failure} />}
    {item.state === 'pending' ? <>
      {!!item.options.length && <div className="as-actions">
        {item.options.map(value => <Button key={value} disabled={busy} onClick={() => void answer(value)}>{value}</Button>)}
      </div>}
      {item.acceptsText && <form className="as-fields" onSubmit={event => { event.preventDefault(); void answer(text) }}>
        <label htmlFor={inputId}>{t(blocked ? 'unblockLabel' : 'answerLabel')}</label>
        {blocked && <p id={`${inputId}-help`} className="as-muted">{t('unblockHint')}</p>}
        <textarea id={inputId} rows={2} value={text} disabled={busy} maxLength={blocked ? 1_000 : 4_000} aria-describedby={blocked ? `${inputId}-help` : undefined}
          onChange={event => setText(event.currentTarget.value)} />
        <div className="as-actions"><Button type="submit" primary disabled={busy || !text.trim()}>{t(busy ? 'answering' : blocked ? 'unblockAction' : 'answer')}</Button></div>
      </form>}
      {busy && !item.acceptsText && <p className="as-muted" role="status">{t('answering')}</p>}
    </> : item.state === 'resolved' && <div className="as-fields">
      {item.answer && <p className="as-message-text">{item.answer}</p>}
      {item.answeredBy && <p className="as-meta">{t(`answerFrom.${item.answeredBy}`)}</p>}
    </div>}
  </article>
}

export function Pending({ cursors = [] }: { cursors?: number[] }) {
  const { t, call, open, reloadState } = useStudio()
  const before = cursors.at(-1)
  const query = useMemo(() => createQuery(signal => call('pending', { before }, signal), before === undefined ? 4000 : undefined), [call, before])
  const result = useQuery(query)
  const next = nextPage(cursors, result.data?.next)
  const [answered, setAnswered] = useState<ReadonlyMap<string, StudioPending>>(() => new Map())
  const refresh = () => { query.reload(); reloadState() }
  return <section className="as-detail">
    <PageHeading title={t('pending')} detail={t('pendingIntro')} />
    <Pager previous={cursors.length ? () => open({ kind: 'pending', cursors: cursors.slice(0, -1) }, true) : undefined}
      next={next !== undefined ? () => open({ kind: 'pending', cursors: [...cursors, next] }, true) : undefined}
      previousLabel={t('newerItems')} nextLabel={t('olderItems')} />
    <QueryStatus query={result} reload={query.reload} />
    {answered.size > 0 && <p className="as-success" role="status">{t('answerSaved')}</p>}
    {result.data && !result.data.items.length && <p className="as-empty">{t('emptyPending')}</p>}
    {result.data?.items.map(item => <PendingItem key={item.id}
      item={item.state === 'pending' ? answered.get(item.id) ?? item : item} refresh={refresh}
      resolved={value => {
        // 同一页可先后收到多条回执；任何旧快照都不能重新开放已经处理的选择。
        setAnswered(current => new Map(current).set(value.id, value))
        refresh()
      }} />)}
  </section>
}
