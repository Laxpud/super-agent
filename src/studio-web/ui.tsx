/** Studio 子页共用的路由、作用域和主题化控件。 */
import { createContext, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ASSISTANT_CONVERSATION, type StudioProjectSummary, type StudioSource, type StudioState, type StudioTaskScope } from '../studio/protocol.ts'
import { failureText, type StudioCall } from './api.ts'
import type { Address, Drafts } from './drafts.ts'
import type { T } from './locales.ts'
import type { QuerySnapshot } from './query.ts'
import type { SettingsSection } from './settings-fields.tsx'

export interface ChatView extends Address { kind: 'chat'; cursors?: number[] }
export interface TasksView { kind: 'tasks'; scope?: StudioTaskScope; conversationId?: string; pageCount?: number; taskId?: string }
export interface PreferencesView { kind: 'preferences'; projectId?: string; scope?: 'project' }
export type StudioView = ChatView | TasksView | PreferencesView
  | { kind: 'original'; conversationId: string; messageId: string }
  | { kind: 'pending'; cursors?: number[] }
  | { kind: 'records'; query?: string; cursors?: number[] }
  | { kind: 'record'; sessionId: string; focusSeq?: number; cursors?: number[] }
  | { kind: 'settings'; section?: SettingsSection }
interface Location { view: StudioView; previous?: Location }

interface StudioFace {
  t: T
  dates: Intl.DateTimeFormat
  call: StudioCall
  state?: StudioState
  reloadState: () => void
  applyProject: (project: StudioProjectSummary) => void
  drafts: Drafts
  location: Location
  open: (view: StudioView, replace?: boolean) => void
  back: () => void
}
export const StudioContext = createContext<StudioFace | undefined>(undefined)
export function useStudio() {
  const face = useContext(StudioContext)
  if (!face) throw new Error('Studio view rendered outside Agent Studio')
  return face
}

export function projectById(state: StudioState | undefined, id: string) {
  return state?.projects.find(project => project.id === id) ?? state?.archivedProjects?.find(project => project.id === id)
}

export function chatTitle(t: T, state: StudioState | undefined, id: string): string {
  return id === ASSISTANT_CONVERSATION ? t('assistant') : projectById(state, id)?.name ?? id
}

/** 写入只响应明确操作；防止连续点击重复提交，失败后保留调用方的表单内容。 */
export function useAction() {
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  return {
    busy, failure, clear: () => setFailure(undefined),
    async run(action: () => Promise<void>) {
      if (running.current) return false
      running.current = true
      setBusy(true)
      setFailure(undefined)
      try { await action(); return true } catch (error) { setFailure(error); return false }
      finally { running.current = false; setBusy(false) }
    },
  }
}

export function Button({ primary, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" className={`as-button${primary ? ' as-primary' : ''}${className ? ` ${className}` : ''}`} {...props} />
}

export function PageHeading({ title, detail, children, back = true, focusKey }: {
  title: string; detail?: string; children?: ReactNode; back?: boolean; focusKey?: string
}) {
  const studio = useStudio()
  const heading = useRef<HTMLHeadingElement>(null)
  const focus = focusKey ?? studio.location.view
  // 子页替换后为键盘和读屏用户提供定位点；普通轮询与同页按钮不得抢走焦点。
  useEffect(() => { heading.current?.focus() }, [focus])
  return <header className="as-view-heading">
    {back && studio.location.previous && <Button className="as-back" onClick={studio.back}>
      <span aria-hidden="true">←</span> {studio.t('back')}
    </Button>}
    <div className="as-heading-copy"><h2 ref={heading} tabIndex={-1}>{title}</h2>{detail && <p>{detail}</p>}</div>
    {children}
  </header>
}

export function FailureNotice({ failure, retry, summary }: { failure: unknown; retry?: () => void; summary?: string }) {
  const { t } = useStudio()
  return <div className="as-error" role="alert">
    <span>{summary && <strong>{summary} </strong>}{failureText(t, failure)}</span>
    {retry && <Button onClick={retry}>{t('retry')}</Button>}
  </div>
}

export function QueryStatus<T>({ query, reload }: { query: QuerySnapshot<T>; reload: () => void }) {
  const { t } = useStudio()
  if (query.failure !== undefined) return <FailureNotice failure={query.failure} retry={reload} />
  if (query.data === undefined) return <p className="as-muted" role="status">{t('loading')}</p>
  return null
}

export function Time({ value }: { value: number | string }) {
  const { dates } = useStudio()
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{dates.format(date)}</time> : null
}

export function SourceButton({ source }: { source: StudioSource }) {
  const { open, t } = useStudio()
  return <Button onClick={() => open({ kind: 'record', sessionId: source.sessionId, focusSeq: source.eventSeq })}>{t('source')}</Button>
}

export function Pager({ previous, next, previousLabel, nextLabel }: {
  previous?: () => void; next?: () => void; previousLabel: string; nextLabel: string
}) {
  if (!previous && !next) return null
  return <div className="as-pager">
    {previous && <Button onClick={previous}>{previousLabel}</Button>}
    {next && <Button onClick={next}>{nextLabel}</Button>}
  </div>
}
