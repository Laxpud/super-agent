/** 任务账本以对话和生命周期筛选；宿主收据与原请求和交付正文分开展示。 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { ASSISTANT_CONVERSATION, type StudioCheckResult, type StudioPage, type StudioTaskScope, type StudioTaskSummary } from '../studio/protocol.ts'
import { StudioApiError } from './api.ts'
import { snippet } from './drafts.ts'
import { createQuery, nextPage, useQuery, type StudioQuery } from './query.ts'
import { Button, FailureNotice, PageHeading, QueryStatus, Time, projectById, useAction, useStudio, type TasksView } from './ui.tsx'

const scopes = ['all', 'active', 'terminal'] as const satisfies readonly StudioTaskScope[]
const isActive = (status: StudioTaskSummary['status']) => status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'blocked'

function TaskStatus({ status }: { status: StudioTaskSummary['status'] }) {
  const { t } = useStudio()
  const tone = status === 'blocked' || status === 'waiting_approval' || status === 'interrupted' ? 'warn'
    : status === 'delivered' ? 'success' : undefined
  return <span className="as-pill" data-tone={tone}><span className="as-dot" aria-hidden="true" />{t(`taskStatus.${status}`)}</span>
}

function ProjectName({ task }: { task: StudioTaskSummary }) {
  const { t, state } = useStudio()
  return task.projectId ? task.projectName ?? projectById(state, task.projectId)?.name ?? task.projectId : t('unassignedProject')
}

function TaskRow({ task, selected, choose }: { task: StudioTaskSummary; selected: boolean; choose: () => void }) {
  const { t } = useStudio()
  return <button className="as-record-row as-task-row" type="button" aria-pressed={selected} onClick={choose}>
    <span className="as-task-row-title"><strong>{task.title || t('task', { id: task.taskId })}</strong><TaskStatus status={task.status} /></span>
    {task.requestText && <span className="as-task-snippet">{snippet(task.requestText)}</span>}
    <span className="as-meta"><strong><ProjectName task={task} /></strong><span>{t(`permission.${task.permission}`)}</span>
      <Time value={task.updatedAt} /></span>
    <span className="as-muted">{task.workspacePath ?? t('noWorkspace')}</span>
  </button>
}

function CheckStatus({ status }: { status: StudioCheckResult['overallCheckStatus'] }) {
  const { t } = useStudio()
  return <span className="as-pill" data-tone={status === 'passed' ? 'success' : status === 'failed' ? 'error' : undefined}>
    <span className="as-dot" aria-hidden="true" />{t(`checkStatus.${status}`)}</span>
}

function CheckReceipt({ value }: { value: StudioTaskSummary['checkResult'] }) {
  const { t } = useStudio()
  return <section className="as-fields as-task-section">
    <h4>{t('checkReceipt')}</h4>
    {value === null ? <p className="as-muted">{t('noReceipt')}</p> : typeof value === 'string'
      ? <p className="as-message-text">{value}</p> : <>
        <div className="as-meta">{t('overallCheckStatus')} <CheckStatus status={value.overallCheckStatus} /></div>
        <strong>{t('changedFiles')}</strong>
        {value.changedFiles.length ? <ul className="as-task-files">{value.changedFiles.map((file, index) => <li key={index}>
          <code>{file.path}</code> <span className="as-muted">{t(`fileAction.${file.action}`)}</span>
        </li>)}</ul> : <p className="as-muted">{t('noChangedFiles')}</p>}
        {!!value.omittedChangedFiles && <p className="as-muted">{t('omittedFiles', { count: value.omittedChangedFiles })}</p>}
        <strong>{t('commandChecks')}</strong>
        {!value.checks.length && <p className="as-muted">{t('noChecks')}</p>}
        {value.checks.map((check, index) => <details key={index} className="as-artifact">
          <summary><code>{check.command}</code> <CheckStatus status={check.status} />
            <span className="as-muted"> {t('checkExitCode', { code: check.exitCode ?? t('unknownValue') })}</span></summary>
          <div className="as-meta">
            <span>{t('checkWorkdir')}: <code>{check.workdir}</code></span>
            {check.signal && <span>{t('checkSignal', { signal: check.signal })}</span>}
            {check.timedOut && <span>{t('checkTimedOut')}</span>}
            {check.aborted && <span>{t('checkAborted')}</span>}
          </div>
          <pre className="as-message-text as-check-output" tabIndex={0} aria-label={t('checkOutput')}>{check.output || t('noOutput')}</pre>
        </details>)}
        {!!value.omittedChecks && <p className="as-muted">{t('omittedChecks', { count: value.omittedChecks })}</p>}
      </>}
  </section>
}

function TaskDetail({ taskId, close, stopped, refresh }: {
  taskId: string; close: () => void; stopped: (task: StudioTaskSummary) => void; refresh: () => void
}) {
  const { t, call, open } = useStudio()
  const query = useMemo(() => createQuery(async signal => {
    const task = await call('task', { taskId }, signal)
    if (task.taskId !== taskId) throw new StudioApiError('badResponse', 200)
    return task
  }, 4000), [call, taskId])
  const result = useQuery(query)
  const action = useAction()
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const task = result.data
  const sourceId = task?.workerSessionId || task?.sourceSessionId
  const focusSeq = task?.source?.sessionId === sourceId ? task?.source?.eventSeq : undefined
  const stop = () => action.run(async () => {
    try {
      const receipt = await call('stopTask', { taskId })
      if (receipt.taskId !== taskId || isActive(receipt.status)) throw new StudioApiError('badResponse', 200)
      query.reconcile(() => receipt)
      stopped(receipt)
    } catch (error) {
      // 另一个入口可能已经停止或交付任务；读取当前状态，不重发停止请求。
      query.reload()
      refresh()
      throw error
    }
  })
  return <article className="as-card as-task-detail" aria-label={t('taskDetails')}>
    <header className="as-task-row-title"><h3 ref={heading} tabIndex={-1}>{task?.title || t('taskDetails')}</h3>
      <Button onClick={close}>{t('closeDetails')}</Button></header>
    <QueryStatus query={result} reload={query.reload} />
    {action.failure !== undefined && <FailureNotice failure={action.failure} />}
    {task && <>
      <dl className="as-facts">
        <div><dt>{t('taskId')}</dt><dd><code>{task.taskId}</code></dd></div>
        <div><dt>{t('owningProject')}</dt><dd><ProjectName task={task} /></dd></div>
        <div><dt>{t('projectWorkspace')}</dt><dd><code>{task.workspacePath ?? t('noWorkspace')}</code></dd></div>
        <div><dt>{t('taskPermission')}</dt><dd>{t(`permission.${task.permission}`)} <code>{task.permission}</code></dd></div>
        <div><dt>{t('authorizationVersion')}</dt><dd>{task.authorizationVersion}</dd></div>
        <div><dt>{t('taskState')}</dt><dd><TaskStatus status={task.status} /></dd></div>
        <div><dt>{t('updatedAt')}</dt><dd><Time value={task.updatedAt} /></dd></div>
      </dl>
      <div className="as-actions">
        {sourceId && <Button onClick={() => open({ kind: 'record', sessionId: sourceId, focusSeq })}>{t('source')}</Button>}
        {isActive(task.status) && <Button disabled={action.busy} onClick={() => void stop()}>{t(action.busy ? 'stoppingTask' : 'stopTask')}</Button>}
        {(task.status === 'waiting_approval' || task.status === 'blocked') && <Button onClick={() => open({ kind: 'pending' })}>{t('pending')}</Button>}
      </div>
      <section className="as-fields as-task-section"><h4>{t('originalRequest')}</h4><p className="as-message-text">{task.requestText}</p></section>
      <CheckReceipt value={task.checkResult} />
      <section className="as-fields as-task-section"><h4>{t('resultSummary')}</h4>
        <p className={task.resultSummary ? 'as-message-text' : 'as-muted'}>{task.resultSummary ?? t('noTaskResult')}</p>
      </section>
    </>}
  </article>
}

type TaskListQuery = StudioQuery<StudioPage<StudioTaskSummary>>
type LoadTasks = (before: number | undefined, signal: AbortSignal) => Promise<StudioPage<StudioTaskSummary>>

/** 返回时恢复已打开的页数。以相邻页的新游标为准，避免新任务挤占第一页后在两页间漏掉记录。 */
function TaskPage({ view, load, pages, cursors = [], seen = new Set<string>() }: {
  view: TasksView; load: LoadTasks; pages: Set<TaskListQuery>; cursors?: number[]; seen?: ReadonlySet<string>
}) {
  const { t, open } = useStudio()
  const before = cursors.at(-1)
  const query = useMemo(() => createQuery(signal => load(before, signal), before === undefined ? 4000 : undefined), [load, before])
  const result = useQuery(query)
  useEffect(() => { pages.add(query); return () => { pages.delete(query) } }, [pages, query])
  const items = result.data?.items.filter(task => !seen.has(task.taskId)) ?? []
  const next = nextPage(cursors, result.data?.next)
  const pageCount = view.pageCount ?? 1
  return <>
    <QueryStatus query={result} reload={query.reload} />
    {before === undefined && result.data && !items.length && <p className="as-empty">{t('emptyTasks')}</p>}
    {!!items.length && <ul className="as-record-list">
      {items.map(task => <li key={task.taskId}><TaskRow task={task} selected={view.taskId === task.taskId}
        choose={() => open({ ...view, taskId: view.taskId === task.taskId ? undefined : task.taskId }, true)} /></li>)}
    </ul>}
    {next !== undefined && (cursors.length + 1 < pageCount
      ? <TaskPage view={view} load={load} pages={pages} cursors={[...cursors, next]} seen={new Set([...seen, ...items.map(task => task.taskId)])} />
      : <div className="as-actions"><Button onClick={() => open({ ...view, pageCount: pageCount + 1 }, true)}>{t('loadMoreTasks')}</Button></div>)}
  </>
}

export function Tasks({ view }: { view: TasksView }) {
  const { t, state, open, call, reloadState } = useStudio()
  const { conversationId, scope = 'all' } = view
  const load = useCallback<LoadTasks>((before, signal) => call('tasks', { scope, conversationId, before }, signal), [call, scope, conversationId])
  const pages = useMemo(() => new Set<TaskListQuery>(), [load])
  const refresh = () => { for (const query of pages) query.reload(); reloadState() }
  const stopped = (task: StudioTaskSummary) => {
    for (const query of pages) query.reconcile(page => page && { ...page,
      items: page.items.flatMap(item => item.taskId === task.taskId ? scope === 'active' ? [] : [task] : [item]) })
    reloadState()
  }
  const projects = [...(state?.projects ?? []), ...(state?.archivedProjects ?? [])]
  const list = useRef<HTMLDivElement>(null)
  const scopeFilter = useRef<HTMLSelectElement>(null)
  return <section className="as-detail">
    <PageHeading title={t('tasks')} detail={t('tasksIntro')} focusKey="tasks" />
    <div className="as-task-filters">
      <label className="as-setting-field">{t('taskScope')}
        <select ref={scopeFilter} value={scope} onChange={event => {
          const chosen = scopes.find(value => value === event.currentTarget.value)
          if (chosen) open({ kind: 'tasks', scope: chosen, conversationId }, true)
        }}>
          {scopes.map(value => <option key={value} value={value}>{t(`taskScope.${value}`)}</option>)}
        </select>
      </label>
      <label className="as-setting-field">{t('taskConversation')}
        <select value={conversationId ?? ''} onChange={event => open({ kind: 'tasks', scope, conversationId: event.currentTarget.value || undefined }, true)}>
          <option value="">{t('allConversations')}</option><option value={ASSISTANT_CONVERSATION}>{t('assistant')}</option>
          {conversationId && conversationId !== ASSISTANT_CONVERSATION && !projects.some(project => project.id === conversationId)
            && <option value={conversationId}>{conversationId}</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
    </div>
    <div className="as-tasks-layout" data-selected={!!view.taskId || undefined}>
      <div ref={list} className="as-task-list"><TaskPage view={view} load={load} pages={pages} /></div>
      {view.taskId && <TaskDetail key={view.taskId} taskId={view.taskId} refresh={refresh} stopped={stopped}
        close={() => {
          const target = list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? scopeFilter.current
          open({ ...view, taskId: undefined }, true)
          target?.focus()
        }} />}
    </div>
  </section>
}
