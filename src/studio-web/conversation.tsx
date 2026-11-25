/** 主时间线、独立话题和跨分页的原消息入口。 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { ASSISTANT_CONVERSATION, STUDIO_TEXT_LIMIT, type StudioMessage } from '../studio/protocol.ts'
import { addressKey, reference, snippet, type Address } from './drafts.ts'
import { createQuery, nextPage, useQuery } from './query.ts'
import { Button, chatTitle, FailureNotice, PageHeading, Pager, QueryStatus, SourceButton, Time, useStudio, type ChatView } from './ui.tsx'

/** 引用不改变收件范围；回复才按原消息的话题发送。 */
function useMessageActions() {
  const { drafts, location, open, back } = useStudio()
  const current = location.view.kind === 'original' ? location.previous?.view : location.view
  const go = (address: Address) => {
    const same = current?.kind === 'chat' && addressKey(address) === addressKey(current)
    if (same && !current.cursors?.length) {
      if (location.view.kind === 'original') back()
      return
    }
    // 在同一对话的旧页选中引用时回到最新页，以便编辑草稿。开启话题保留原页作为返回位置。
    open({ kind: 'chat', ...address }, location.view.kind === 'original' || same)
  }
  return {
    reply(message: StudioMessage) {
      const topicId = message.topicId ?? message.id
      const address = { conversationId: message.conversationId, topicId }
      drafts.edit(address, { reply: message.topicId ? reference(message) : undefined }, true)
      go(address)
    },
    quote(message: StudioMessage) {
      const address = { conversationId: message.conversationId,
        topicId: current?.kind === 'chat' && current.conversationId === message.conversationId ? current.topicId : message.topicId }
      drafts.edit(address, { quote: reference(message) }, true)
      go(address)
    },
  }
}

function QuoteJump({ conversationId, id, text, drafting = false }: {
  conversationId: string; id: string; text: string; drafting?: boolean
}) {
  const { t, open } = useStudio()
  return <button type="button" className="as-quote" onClick={() => open({ kind: 'original', conversationId, messageId: id })}>
    <strong>{t(drafting ? 'quoting' : 'openOriginal')}</strong><span>{snippet(text) || t('noOutput')}</span>
  </button>
}

function Message({ message, inTopic = false, focused = false }: { message: StudioMessage; inTopic?: boolean; focused?: boolean }) {
  const { t, open } = useStudio()
  const { reply, quote } = useMessageActions()
  const original = useRef<HTMLElement>(null)
  useEffect(() => { if (focused) original.current?.focus() }, [focused, message.id])
  return <article ref={original} className="as-message" data-role={message.role} data-message-id={message.id}
    data-focused={focused || undefined} tabIndex={focused ? -1 : undefined}>
    <header className="as-meta">
      <strong>{t(`role.${message.role}`)}</strong><span className="as-pill">{t(`channel.${message.channel}`)}</span>
      <Time value={message.createdAt} />
    </header>
    {message.quote && <QuoteJump conversationId={message.conversationId} id={message.quote.messageId} text={message.quote.text} />}
    {message.text && <div className="as-message-text">{message.text}</div>}
    {(message.status || message.feishuDelivery) && <div className="as-meta">
      {message.status && <span className="as-pill" data-tone={message.status === 'failed' ? 'error'
        : message.status === 'interrupted' ? 'warn' : undefined}>{t(`status.${message.status}`)}</span>}
      {message.feishuDelivery && <span className="as-pill" data-tone={message.feishuDelivery === 'unconfirmed' ? 'warn' : undefined}>
        {t(`delivery.${message.feishuDelivery}`)}</span>}
    </div>}
    {message.error && <p className="as-error">{message.error}</p>}
    {!!message.artifacts?.length && <div className="as-artifacts">
      {message.artifacts.map((artifact, index) => <details key={index} className="as-artifact">
        <summary>{artifact.title}</summary>
        <div className="as-message-text" tabIndex={0} role="region" aria-label={artifact.title}>{artifact.text}</div>
        <SourceButton source={artifact.source} />
      </details>)}
    </div>}
    <footer className="as-actions">
      <Button onClick={() => quote(message)}>{t('quote')}</Button>
      <Button onClick={() => reply(message)}>{t('reply')}</Button>
      {!inTopic && !message.topicId && message.replyCount > 0 && <Button onClick={() => open({ kind: 'chat',
        conversationId: message.conversationId, topicId: message.id })}>
        {message.replyCount === 1 ? t('openTopicOne') : t('openTopic', { count: message.replyCount })}
      </Button>}
      {message.source && <SourceButton source={message.source} />}
    </footer>
  </article>
}

function Composer({ address, refresh }: { address: Address; refresh: () => void }) {
  const { drafts, call, t } = useStudio()
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.get(address), () => drafts.get(address))
  const inputId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (drafts.consumeFocus(address)) input.current?.focus() }, [address, draft.version, drafts])
  return <form className="as-composer" onSubmit={async event => {
    event.preventDefault()
    if (await drafts.send(address, call)) refresh()
  }}>
    {draft.quote && <div className="as-reference">
      <QuoteJump conversationId={address.conversationId} id={draft.quote.id} text={draft.quote.text} drafting />
      <Button onClick={() => drafts.edit(address, { quote: undefined })}>{t('removeQuote')}</Button>
    </div>}
    {draft.reply && <div className="as-reference as-meta">
      <span>{t('replyingTo')}: {draft.reply.text}</span>
      <Button onClick={() => drafts.edit(address, { reply: undefined })}>{t('clearReply')}</Button>
    </div>}
    {draft.failure !== undefined && <FailureNotice failure={draft.failure} summary={t('sendFailed')} />}
    <label htmlFor={inputId} className="as-meta">{t('composer')}</label>
    <textarea ref={input} id={inputId} placeholder={t('composerPlaceholder')} rows={2} maxLength={STUDIO_TEXT_LIMIT}
      value={draft.text} onChange={event => drafts.edit(address, { text: event.currentTarget.value })} />
    <div className="as-actions as-end"><Button type="submit" primary disabled={draft.sending || !draft.text.trim()}>
      {t(draft.sending ? 'sending' : 'send')}</Button></div>
  </form>
}

function TopicRoot({ conversationId, topicId }: Required<Address>) {
  const { call, t } = useStudio()
  const query = useMemo(() => createQuery(signal => call('message', { conversationId, id: topicId }, signal)), [call, conversationId, topicId])
  const result = useQuery(query)
  return <section className="as-topic-root" aria-label={t('topicRoot')}>
    <p className="as-meta">{t('topicRoot')}</p>
    <QueryStatus query={result} reload={query.reload} />
    {result.data && <Message message={result.data} inTopic />}
  </section>
}

/** 最新页轮询，旧页固定在服务端游标上。点击原消息直接按 id 读取，不逐页遍历。 */
export function Conversation({ view }: { view: ChatView }) {
  const { t, call, state, open } = useStudio()
  const { conversationId, topicId, cursors = [] } = view
  const before = cursors.at(-1)
  const query = useMemo(() => createQuery(signal => call('timeline', { conversationId, topicId, before }, signal),
    before === undefined ? 4000 : undefined), [call, conversationId, topicId, before])
  const result = useQuery(query)
  const next = nextPage(cursors, result.data?.next)
  const scroll = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    if (before === undefined && result.data && atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [before, result.data])
  const title = chatTitle(t, state, conversationId)
  const project = state?.projects.find(item => item.id === conversationId)
  return <section className="as-chat">
    <PageHeading title={topicId ? `${title} · ${t('topic')}` : title}
      detail={topicId ? undefined : conversationId === ASSISTANT_CONVERSATION ? t('assistantHint')
        : [project?.objective, t('projectHint')].filter(Boolean).join(' ')} />
    <Pager previous={cursors.length ? () => open({ ...view, cursors: cursors.slice(0, -1) }, true) : undefined}
      next={next !== undefined ? () => open({ ...view, cursors: [...cursors, next] }, true) : undefined}
      previousLabel={t('newerMessages')} nextLabel={t('olderMessages')} />
    <div className="as-timeline" aria-label={t('timeline')} role="region" tabIndex={0} ref={scroll} onScroll={event => {
      const node = event.currentTarget
      atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64
    }}>
      {topicId && <TopicRoot conversationId={conversationId} topicId={topicId} />}
      <QueryStatus query={result} reload={query.reload} />
      {result.data && !result.data.items.length && <p className="as-empty">{t(topicId ? 'emptyTopic' : 'emptyChat')}</p>}
      {result.data?.items.map(message => <Message key={message.id} message={message} inTopic={topicId !== undefined} />)}
    </div>
    {before === undefined && <Composer address={view} refresh={query.reload} />}
  </section>
}

/** 显示引用原文、待办关联消息或其来源；返回时保留来源页的分页位置。 */
export function Original({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const { t, state, call, open } = useStudio()
  const query = useMemo(() => createQuery(signal => call('message', { conversationId, id: messageId }, signal)), [call, conversationId, messageId])
  const result = useQuery(query)
  const message = result.data
  return <section className="as-detail">
    <PageHeading title={`${t('original')} · ${chatTitle(t, state, conversationId)}`} detail={t('originalHint')} />
    <QueryStatus query={result} reload={query.reload} />
    {message && <>
      <Message message={message} focused />
      <Button onClick={() => open({ kind: 'chat', conversationId, topicId: message.topicId }, true)}>
        {t(message.topicId ? 'topic' : 'openConversation')}
      </Button>
    </>}
  </section>
}
