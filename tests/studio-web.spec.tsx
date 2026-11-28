// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DRAFT_DELEGATE, DRAFT_READ, STUDIO_API, STUDIO_HEADER, WORKER_DELEGATE, WORKER_READ, type StudioMessage, type StudioOp, type StudioPending, type StudioSessionRecord,
  type StudioState } from '../src/studio/protocol.ts'
import { STUDIO_TASK_STATUSES, type StudioPreference, type StudioProjectArchive, type StudioProjectSummary, type StudioTaskSummary } from '../src/studio/protocol.ts'
import type { ConfigurationSnapshot } from '../src/studio/settings-protocol.ts'
import { apply } from '../src/studio-web/index.tsx'
import { en, NS, zh, type T } from '../src/studio-web/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const t = ((key: keyof typeof en, vars?: Record<string, unknown>) => en[key].replace(/\{(\w+)\}/g,
  (match, id: string) => String(vars?.[id] ?? match))) as T

interface Entry {
  options: { name: string; id?: string; key?: string; label?: () => string; locale?: string }
  Component: ComponentType<Record<string, unknown>>
}
function slots() {
  const entries: Entry[] = []
  const registerLocale = vi.fn()
  apply({
    effect: (effect: () => unknown) => effect(),
    locale: { register: registerLocale, bind: () => t, getLocale: () => ({ active: 'en' }) },
    slots: {
      inject: (_slot: string, register: () => Iterable<unknown> | (() => void)) => {
        const result = register()
        if (typeof result !== 'function') [...result]
      },
      register: (options: Entry['options'], Component: Entry['Component']) => { entries.push({ options, Component }); return () => {} },
    },
  } as never)
  return { entries, registerLocale, main: entries.find(entry => entry.options.name === 'main')!,
    icon: entries.find(entry => entry.options.name === 'sidebar.panellist')! }
}

const roots: { root: Root; host: HTMLElement }[] = []
async function render({ Component }: Entry, props: Record<string, unknown> = {}) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  roots.push({ root, host })
  await act(async () => { root.render(<Component {...props} t={t} />) })
  return host
}
afterEach(() => {
  act(() => { for (const { root, host } of roots.splice(0)) { root.unmount(); host.remove() } })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function node<E extends HTMLElement>(selector: string, root: ParentNode = document): E {
  const value = root.querySelector<E>(selector)
  if (!value) throw new Error(`Missing element: ${selector}`)
  return value
}
function button(label: string, root: ParentNode = document) {
  const value = Array.from(root.querySelectorAll('button')).find(item => item.textContent?.trim() === label)
  if (!value) throw new Error(`Missing button: ${label}`)
  return value
}
async function click(target: string | HTMLElement, root?: ParentNode) {
  await act(async () => { (typeof target === 'string' ? button(target, root) : target).click() })
}
async function change(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const back = () => click(node('.as-back'))
const compose = () => node<HTMLTextAreaElement>('.as-composer textarea')
const at = Date.UTC(2026, 10, 24, 8)
const message = (id: string, text: string, data: Partial<StudioMessage> = {}): StudioMessage => ({
  id, text, sequence: 1, conversationId: 'assistant', role: 'user', channel: 'gui', createdAt: at, replyCount: 0, ...data,
})
const record: StudioSessionRecord = { id: 'session-1', conversationId: 'assistant', createdAt: at, role: 'worker' }
const legacyRecord: StudioSessionRecord = { ...record, id: 'historic-worker', role: 'draft-worker', readonlyLegacy: true }
const confirmation: StudioPending = { id: 'waiting-1', conversationId: 'project-a', kind: 'confirmation', requester: 'Leader A',
  title: 'Approve deployment', detail: 'Specific request', taskId: 'task-1', messageId: 'source-in-project', options: ['Approve', 'Decline'],
  acceptsText: false, mobile: 'unsupported', state: 'pending', createdAt: at }
function deferred<T>() {
  let resolve!: (result: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { resolve, promise }
}
interface Request { op: StudioOp; input: Record<string, unknown>; signal?: AbortSignal }
function server(handle: (request: Request) => unknown = () => undefined) {
  const state: StudioState = { projects: [{ id: 'project-a', name: 'Project A', objective: 'Release', workspacePath: null, state: 'active', managementEpoch: 1 }], pendingCount: 0,
    settings: { revision: 3, assistant: null, leader: { provider: 'p1', model: 'm1' } }, feishu: 'offline' }
  const requests: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(STUDIO_API)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(new Headers(init.headers).get(STUDIO_HEADER)).toBe('1')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    const request = { ...JSON.parse(String(init.body)), signal: init.signal } as Request
    requests.push(request)
    const handled = await handle(request)
    if (handled instanceof Response) return handled
    if (handled !== undefined) return Response.json(handled)
    if (request.op === 'state') return Response.json(state)
    if (request.op === 'models') return Response.json([{ provider: 'p1', model: 'm1', label: 'Model One', reasoningEfforts: ['low', 'high'] }])
    return Response.json({ items: [] })
  }))
  return { state, requests }
}

it('adds a localized Agent Studio entry, shares state with its pending-only badge, and preserves tool presentation', async () => {
  const app = server()
  const { main, icon, registerLocale, entries } = slots()
  app.state.pendingCount = 2
  expect(main.options).toMatchObject({ name: 'main', key: 'agent-studio', locale: NS })
  expect(icon.options.id).toBe(main.options.key)
  expect(icon.options.label?.()).toBe('Agent Studio')
  expect(registerLocale).toHaveBeenCalledWith(NS, { en, zh })
  const glyph = await render(icon, { size: 16, active: false })
  const panel = await render(main)
  expect(node('h2', panel).textContent).toBe(en.assistant)
  expect(glyph.querySelector(`[title="${t('pendingCount', { count: 2 })}"]`)?.textContent).toBe('2')
  expect(app.requests.filter(request => request.op === 'state')).toHaveLength(1)
  app.state.pendingCount = 0
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(glyph.querySelector('[title]')).toBeNull()
  const tools = entries.filter(entry => entry.options.name === 'tool.call.toolview')
  expect(tools.map(tool => tool.options.key)).toEqual([WORKER_DELEGATE, WORKER_READ, DRAFT_DELEGATE, DRAFT_READ])
  for (const tool of tools) {
    const view = await render(tool, { phase: 'result', useDisclosure: () => ({ expanded: true, toggle: () => {} }),
      block: { meta: { title: 'Saved receipt', text: '<b>Literal tool text</b>' }, content: [], isError: false } })
    expect(node('pre', view).textContent).toBe('<b>Literal tool text</b>')
    expect(view.querySelector('b')).toBeNull()
  }
})

it('opens an older quote directly, keeps topic replies off the main timeline, and routes replies separately from quotes', async () => {
  const root = message('root', 'Recent root', { channel: 'feishu', replyCount: 1, quote: { messageId: 'old', text: 'Old excerpt' } })
  const old = message('old', 'Original from an older page')
  const reply = message('reply', 'Topic reply', { topicId: root.id, channel: 'studio', role: 'assistant' })
  const app = server(({ op, input }) => {
    if (op === 'timeline') return input.topicId ? { items: [reply] } : input.before !== undefined ? { items: [old] } : { items: [root], next: 42 }
    if (op === 'message') return [root, old, reply].find(item => item.id === input.id)
    if (op === 'send') return message('accepted', String(input.text))
  })
  await render(slots().main)
  expect(document.body.textContent).toContain(en['channel.feishu'])
  expect(document.body.textContent).not.toContain('Topic reply')
  expect(document.activeElement).toBe(node('h2'))
  expect(node('.as-timeline').tabIndex).toBe(0)
  await click(node('.as-message .as-quote'))
  expect(app.requests.at(-1)).toMatchObject({ op: 'message', input: { conversationId: 'assistant', id: 'old' } })
  expect(node('[data-focused][data-message-id="old"]').textContent).toContain(old.text)
  await back()
  await click(en.olderMessages)
  expect(app.requests.at(-1)).toMatchObject({ op: 'timeline', input: { before: 42 } })
  await click(en.quote)
  expect(node('.as-composer .as-quote').textContent).toContain(old.text)
  expect(document.activeElement).toBe(compose())
  await change(compose(), '  Main message with preserved spaces  ')
  await click(en.send)
  expect(app.requests.find(request => request.op === 'send')?.input).toEqual({ conversationId: 'assistant', quoteId: 'old',
    text: '  Main message with preserved spaces  ', requestId: expect.any(String) })
  await click(en.reply, node('[data-message-id="root"]'))
  expect(node('h2').textContent).toContain(en.topic)
  expect(node('.as-topic-root').textContent).toContain(root.text)
  expect(document.activeElement).toBe(compose())
  await back()
  await click(en.openTopicOne)
  expect(document.activeElement).toBe(node('h2'))
  await click(en.reply, node('[data-message-id="reply"]'))
  expect(document.activeElement).toBe(compose())
  await change(compose(), 'Answer the topic reply')
  await click(en.send)
  expect(app.requests.filter(request => request.op === 'send').at(-1)?.input).toMatchObject({ conversationId: 'assistant', replyTo: 'reply' })
  await back()
  expect(document.body.textContent).not.toContain(reply.text)
  expect(document.activeElement).toBe(node('h2'))
})

it('reports unreadable data without losing the current timeline and can retry', async () => {
  let stateReads = 0, timelineReads = 0
  server(({ op }) => {
    if (op === 'state' && ++stateReads === 1) return { projects: null }
    if (op === 'timeline') return timelineReads++ === 1 ? { items: [null] } : { items: [message('saved', 'Saved earlier')] }
  })
  await render(slots().main)
  expect(node('.as-banner [role="alert"]').textContent).toContain(en.badResponse)
  await click(en.retry, node('.as-banner'))
  expect(document.querySelector('.as-banner')).toBeNull()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  const timeline = node('.as-timeline')
  expect(node('[role="alert"]', timeline).textContent).toContain(en.badResponse)
  expect(timeline.textContent).toContain('Saved earlier')
  await click(en.retry, timeline)
  expect(timeline.querySelector('[role="alert"]')).toBeNull()
})

it('drops a late timeline, keeps drafts isolated from a late send, and retries an unconfirmed write with the same key', async () => {
  const stale = deferred<unknown>()
  const sending = deferred<unknown>()
  let assistantReads = 0, assistantSends = 0
  const app = server(({ op, input }) => {
    if (op === 'timeline') {
      if (input.conversationId === 'project-a') return { items: [message('leader', 'Leader timeline', { conversationId: 'project-a', role: 'leader' })] }
      if (++assistantReads === 1) return stale.promise
      return { items: [] }
    }
    if (op === 'send') {
      if (input.conversationId === 'project-a') return sending.promise
      if (++assistantSends === 1) return Response.json({ error: 'No receipt', code: 'OPERATION_UNCONFIRMED' }, { status: 500 })
      // This is a successful StudioMessage carrying an execution error, not an API error envelope.
      return message('failed', String(input.text), { status: 'failed', error: 'Execution failed' })
    }
  })
  await render(slots().main)
  await change(node<HTMLSelectElement>('[aria-label="Project conversation"]'), 'project-a')
  const first = app.requests.find(request => request.op === 'timeline')!
  expect(first.signal?.aborted).toBe(true)
  await act(async () => { stale.resolve({ items: [message('bad', 'Late Assistant message')] }) })
  expect(document.body.textContent).not.toContain('Late Assistant message')
  expect(node('h2').textContent).toBe('Project A')
  await change(compose(), 'Use current Leader')
  await click(en.send)
  await click(en.assistant)
  await change(compose(), 'Assistant draft')
  await act(async () => { sending.resolve(message('project-result', 'Leader result', { conversationId: 'project-a' })) })
  expect(compose().value).toBe('Assistant draft')
  expect(document.body.textContent).not.toContain('Leader result')
  await click(en.send)
  expect(node('.as-composer [role="alert"]').textContent).toContain('No receipt')
  expect(compose().value).toBe('Assistant draft')
  await click(en.send)
  const retries = app.requests.filter(request => request.op === 'send' && request.input.conversationId === 'assistant')
  expect(retries).toHaveLength(2)
  expect(retries[0]?.input.requestId).toBe(retries[1]?.input.requestId)
  expect(compose().value).toBe('')
})

it('searches Session history read-only and opens the precise source event without scanning earlier pages', async () => {
  const app = server(({ op, input }) => {
    if (op === 'timeline') return { items: [message('with-source', 'Recorded answer', { source: { sessionId: record.id, eventSeq: 87 } })] }
    if (op === 'records') return input.query === 'assistant' ? { items: [legacyRecord] } : { items: [] }
    if (op === 'record') return { record: input.sessionId === legacyRecord.id ? legacyRecord : record, events: [{ seq: input.from ?? 1, kind: 'assistant/message', text: 'Read-only history' }] }
  })
  await render(slots().main)
  await click(en.source)
  expect(app.requests.at(-1)).toMatchObject({ op: 'record', input: { sessionId: record.id, from: 87 } })
  expect(node('.as-event-list [data-focused]').textContent).toContain('Source event #87')
  expect(document.querySelector('textarea')).toBeNull()
  expect(document.body.textContent).toContain(en['role.worker'])
  await back()
  await click(en.records)
  await change(node<HTMLInputElement>('input[type="search"]'), 'assistant')
  await click(en.search)
  expect(app.requests.at(-1)).toMatchObject({ op: 'records', input: { query: 'assistant' } })
  await click(node('.as-record-row'))
  expect(app.requests.at(-1)).toMatchObject({ op: 'record', input: { sessionId: legacyRecord.id } })
  expect(document.body.textContent).toContain(en['role.draft-worker'])
  expect(document.body.textContent).toContain(en.legacyReadOnly)
  expect(app.requests.some(request => request.op === 'send')).toBe(false)
})

it('opens a pending item’s context, serializes explicit answers, and keeps text after a rejection', async () => {
  const question: StudioPending = { ...confirmation, id: 'open-question', kind: 'question', title: 'What changed?', options: [],
    acceptsText: true, mobile: 'topic' }
  const second = { ...confirmation, id: 'waiting-2', title: 'Approve checks', options: ['Run checks'] }
  const answer = deferred<unknown>()
  let questionAttempts = 0
  const app = server(({ op, input }) => {
    if (op === 'pending') return { items: [confirmation, second, questionAttempts > 1
      ? { ...question, state: 'resolved', answer: 'Answered elsewhere', answeredBy: 'feishu' } : question] }
    if (op === 'message') return message('source-in-project', 'Project source', { conversationId: 'project-a' })
    if (op === 'answer') {
      if (input.id === second.id) return { ...second, state: 'resolved', answer: 'Run checks', answeredBy: 'gui' }
      if (input.id !== question.id) return answer.promise
      return ++questionAttempts === 1 ? Response.json({ error: 'Connection lost' }, { status: 503 })
        : Response.json({ error: 'Already handled', code: 'QUESTION_EXPIRED' }, { status: 409 })
    }
  })
  await render(slots().main)
  await click(en.pending)
  expect(document.body.textContent).toContain(en.decisionText)
  await click(en.source, node('.as-pending-item'))
  expect(app.requests.at(-1)).toMatchObject({ op: 'message', input: { conversationId: 'project-a', id: 'source-in-project' } })
  await back()
  const confirm = node('.as-pending-item')
  await click('Approve', confirm)
  expect(button('Decline', confirm).disabled).toBe(true)
  await click('Decline', confirm)
  expect(app.requests.filter(request => request.op === 'answer').map(request => request.input)).toEqual([{ id: confirmation.id, value: 'Approve' }])
  await act(async () => { answer.resolve({ ...confirmation, state: 'resolved', answer: 'Approve', answeredBy: 'gui' }) })
  expect(document.body.textContent).toContain(en.answerSaved)
  expect(confirm.textContent).toContain(en['answerFrom.gui'])
  await click('Run checks')
  // 即使一次旧快照仍把两项标记为待处理，第二项回执也不能恢复第一项按钮。
  expect(confirm.textContent).toContain(en['answerFrom.gui'])
  expect(Array.from(confirm.querySelectorAll('button')).map(item => item.textContent)).not.toContain('Approve')
  const input = node<HTMLTextAreaElement>('.as-pending-item textarea')
  await change(input, 'Text stays after failure')
  await click(en.answer)
  expect(input.value).toBe('Text stays after failure')
  expect(document.body.textContent).toContain('Connection lost')
  await click(en.answer)
  expect(document.body.textContent).toContain(en['answerFrom.feishu'])
  expect(document.querySelector('.as-pending-item textarea')).toBeNull()
})

it('preserves model edits on a revision conflict, rebases explicitly, and sends null for Host defaults', async () => {
  let count = 0
  let snapshot: ConfigurationSnapshot = { revision: 'a'.repeat(64), writable: true, credentialsWritable: true,
    config: { stateDir: '/studio-state', studioCwd: '/studio-work', assistantModel: null, leaderModel: null,
      workerModelRoutes: [{ id: 'analysis-route', provider: 'p1', model: 'm1' }], workerModelDefaults: {},
      defaultWorkerPermission: 'read-only', feishu: { mode: 'disabled' } },
    feishu: { state: 'disabled', credential: 'none' } }
  const app = server(({ op, input }) => {
    if (op === 'configuration') return snapshot
    if (op === 'saveConfiguration') {
      expect(input.revision).toBe(snapshot.revision)
      snapshot = { ...snapshot, revision: 'b'.repeat(64), config: input.config as ConfigurationSnapshot['config'] }
      return { revision: snapshot.revision }
    }
    if (op !== 'settings') return
    if (++count === 1) {
      app.state.settings = { ...app.state.settings, revision: 4, leader: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } }
      return Response.json({ error: 'Settings changed elsewhere', code: 'SETTINGS_CONFLICT' }, { status: 409 })
    }
    return app.state.settings = { ...input, revision: 5 } as unknown as StudioState['settings']
  })
  await render(slots().main)
  await click(en.settings)
  expect(document.body.textContent).toContain(en.feishuLimits)
  const selections = () => Array.from(document.querySelectorAll<HTMLSelectElement>('.as-model-fields select'))
  expect(selections()[0]?.value).toBe('')
  await change(selections()[0]!, 'p1')
  await change(selections()[2]!, 'high')
  await click(en.save)
  expect(selections()[2]?.value).toBe('high')
  expect(button(en.save).disabled).toBe(true)
  await click(en.rebaseSettings)
  expect(selections()[5]?.value).toBe('low')
  await change(selections()[3]!, '')
  await click(en.save)
  const changes = app.requests.filter(request => request.op === 'settings')
  expect(changes[0]?.input.revision).toBe(3)
  expect(changes[1]?.input).toEqual({ revision: 4, assistant: { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, leader: null })
  expect(document.body.textContent).toContain(en.settingsSaved)
  expect(document.body.textContent).toContain('Revision 5')

  const tabs = node('.as-settings-nav')
  expect(Array.from(tabs.querySelectorAll('button'), item => item.textContent)).toEqual([
    en['section.models'], en['section.workers'], en['section.feishu'], en['section.advanced'],
  ])
  await click(en['section.workers'], tabs)
  const fields = Array.from(node('.as-config-view:not([hidden])').querySelectorAll<HTMLSelectElement>(':scope > fieldset select'))
  await change(fields[3]!, 'analysis-route')
  await change(fields[5]!, 'workspace-write')
  await click(en.applyConfig)
  expect(node('dialog').textContent).toContain(en['permission.workspace-write'])
  await click(en.applyConfigConfirm, node('dialog'))
  expect(app.requests.find(request => request.op === 'saveConfiguration')?.input).toMatchObject({
    revision: 'a'.repeat(64), allowReload: true, config: { workerModelDefaults: { assistant: 'analysis-route' }, defaultWorkerPermission: 'workspace-write' },
  })
  expect(document.body.textContent).toContain(en.configApplied)
  await click(en['section.feishu'], tabs)
  expect(Array.from(node<HTMLSelectElement>('.as-config-view:not([hidden]) select').options, item => item.value)).toEqual(['disabled', 'conversation'])
})

function field<E extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label: string, root: ParentNode) {
  const match = Array.from(root.querySelectorAll('label')).find(item => item.textContent?.trim().startsWith(label))
  if (!match?.control) throw new Error(`Missing field: ${label}`)
  return match.control as E
}

it('renders all seven task badges, filters the ledger and opens evidence and source without writing to the Session', async () => {
  const tasks = STUDIO_TASK_STATUSES.map((status, index): StudioTaskSummary => {
    const project = status !== 'queued' && status !== 'cancelled'
    return { taskId: `task-${index}`, projectId: project ? 'project-a' : null, projectName: project ? 'Project A' : null,
      conversationId: project ? 'project-a' : 'assistant', sourceSessionId: 'origin-session', workerSessionId: record.id,
      sourceMessageId: 'origin-message', requesterBotId: 'bot-1', assigneeBotId: null, workspacePath: '/studio-work',
      permission: 'workspace-write', authorizationVersion: 3, status, title: `Fixture ${status}`, requestText: 'Exact test request',
      resultSummary: status === 'delivered' ? 'Worker delivery is separate from evidence' : null, checkResult: status === 'delivered' ? {
        version: 1, changedFiles: [{ path: 'src/report.ts', action: 'edit' }, { path: 'notes.txt', action: 'write' }], checks: [
          { command: 'pnpm check', workdir: '/studio-work', exitCode: 0, signal: null, timedOut: false, aborted: false, status: 'passed', output: 'Typecheck passed' },
          { command: 'pnpm test', workdir: '/studio-work', exitCode: 7, signal: null, timedOut: false, aborted: false, status: 'failed', output: 'Fixture failed' },
        ], overallCheckStatus: 'failed',
      } : null, artifacts: [], externalJob: null, createdAt: at, updatedAt: at,
      ...(status === 'delivered' && { source: { sessionId: record.id, eventSeq: 17 } }) }
  })
  const active = new Set(['queued', 'running', 'waiting_approval', 'blocked'])
  const app = server(({ op, input }) => {
    if (op === 'tasks') return { items: tasks.filter(task => (!input.conversationId || task.conversationId === input.conversationId)
      && (input.scope === 'all' || active.has(task.status) === (input.scope === 'active'))) }
    if (op === 'task') return tasks.find(task => task.taskId === input.taskId)
    if (op === 'stopTask') {
      const task = tasks.find(task => task.taskId === input.taskId)!
      return Object.assign(task, { status: 'cancelled', authorizationVersion: 4 })
    }
    if (op === 'record') return { record, events: [{ seq: 17, kind: 'assistant/message', text: 'Cold result from source' }] }
  })
  const panel = await render(slots().main)
  await click(en.tasks, panel)
  const badges = () => Array.from(panel.querySelectorAll('.as-task-row .as-pill'), item => item.textContent)
  expect(badges()).toEqual(STUDIO_TASK_STATUSES.map(status => en[`taskStatus.${status}`]))
  const filters = node('.as-task-filters', panel)
  await change(field<HTMLSelectElement>(en.taskConversation, filters), 'project-a')
  await change(field<HTMLSelectElement>(en.taskScope, filters), 'active')
  expect(app.requests.filter(request => request.op === 'tasks').at(-1)?.input).toEqual({ scope: 'active', conversationId: 'project-a' })
  expect(badges()).toEqual((['running', 'waiting_approval', 'blocked'] as const).map(status => en[`taskStatus.${status}`]))
  const row = (title: string) => Array.from(panel.querySelectorAll<HTMLButtonElement>('.as-task-row')).find(item =>
    item.querySelector('strong')?.textContent === title)!
  await click(row('Fixture waiting_approval'))
  const waiting = tasks.find(task => task.title === 'Fixture waiting_approval')!
  await click(en.stopTask, node('.as-task-detail', panel))
  expect(app.requests.filter(request => request.op === 'stopTask').map(request => request.input)).toEqual([{ taskId: waiting.taskId }])
  expect(row('Fixture waiting_approval')).toBeUndefined()
  expect(node('.as-task-detail', panel).textContent).toContain(en['taskStatus.cancelled'])

  await change(field<HTMLSelectElement>(en.taskScope, filters), 'terminal')
  expect(app.requests.filter(request => request.op === 'tasks').at(-1)?.input).toEqual({ scope: 'terminal', conversationId: 'project-a' })
  await click(row('Fixture delivered'))
  const detail = node('.as-task-detail', panel)
  const proof = Array.from(detail.querySelectorAll('.as-task-section')).find(item => item.querySelector('h4')?.textContent === en.checkReceipt)!
  expect(proof.querySelector('.as-meta .as-pill')?.textContent).toBe(en['checkStatus.failed'])
  expect(Array.from(proof.querySelectorAll('.as-task-files code'), item => item.textContent)).toEqual(['src/report.ts', 'notes.txt'])
  const checks = [...proof.querySelectorAll('details')]
  expect(checks.map(item => [item.querySelector('code')?.textContent, item.querySelector('.as-pill')?.textContent, item.querySelector('summary .as-muted')?.textContent?.trim()]))
    .toEqual([['pnpm check', en['checkStatus.passed'], t('checkExitCode', { code: 0 })], ['pnpm test', en['checkStatus.failed'], t('checkExitCode', { code: 7 })]])
  await click(node('summary', checks[1]))
  expect(checks[1]?.open).toBe(true)
  expect(node('pre', checks[1]).textContent).toBe('Fixture failed')
  expect(detail.textContent).toContain('Worker delivery is separate from evidence')
  await click(en.source, detail)
  expect(app.requests.at(-1)).toMatchObject({ op: 'record', input: { sessionId: record.id, from: 17 } })
  expect(node('.as-event-list [data-focused]', panel).textContent).toContain('Cold result from source')
  expect(panel.querySelector('textarea')).toBeNull()
  expect(app.requests.some(request => request.op === 'send')).toBe(false)
})

it('renders task owners and executors and merges each selected historical task poll into page two', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const unassigned: StudioTaskSummary = { taskId: 'latest', projectId: null, projectName: null, conversationId: 'assistant', sourceSessionId: 'assistant-session',
    workerSessionId: null, sourceMessageId: 'source', requesterBotId: 'bot-assistant', assigneeBotId: null, workspacePath: null, permission: 'read-only',
    authorizationVersion: 1, status: 'queued', title: 'Latest Assistant work', requestText: 'First page',
    resultSummary: null, checkResult: null, artifacts: [], externalJob: null, createdAt: at, updatedAt: at }
  const historical: StudioTaskSummary = { ...unassigned, taskId: 'historical', projectId: 'project-a', projectName: 'Project A',
    conversationId: 'project-a', sourceSessionId: 'leader-session', status: 'running', title: 'Historical project work', requestText: 'Second page' }
  let detail = historical
  const app = server(({ op, input }) => {
    if (op === 'tasks') return input.before === 20 ? { items: [historical] } : { items: [unassigned], next: 20 }
    if (op === 'task') return input.taskId === unassigned.taskId ? unassigned : detail
  })
  const panel = await render(slots().main)
  await click(en.tasks, panel)
  const row = (title: string) => Array.from(panel.querySelectorAll<HTMLButtonElement>('.as-task-row')).find(item => item.querySelector('strong')?.textContent === title)!
  const fact = (label: string) => Array.from(panel.querySelectorAll('.as-task-detail dt')).find(el => el.textContent === label)?.nextElementSibling?.textContent
  await click(row(unassigned.title))
  expect(fact(en.taskOwner)).toBe(en.assistant)
  expect(fact(en.taskExecutor)).toBe(en.taskExecutorUnassigned)
  await click(en.closeDetails, node('.as-task-detail', panel))
  await click(en.loadMoreTasks, panel)
  await click(row(historical.title))
  expect(fact(en.taskOwner)).toBe(en.taskProjectLeader)
  expect(fact(en.taskExecutor)).toBe(en.taskExecutorUnassigned)
  expect(node('.as-pill', row(historical.title)).textContent).toBe(en['taskStatus.running'])
  detail = { ...historical, status: 'delivered', authorizationVersion: 2, updatedAt: at + 4_000, workerSessionId: 'historical-worker' }
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
  expect(app.requests.filter(request => request.op === 'task' && request.input.taskId === historical.taskId)).toHaveLength(2)
  expect(app.requests.filter(request => request.op === 'tasks' && request.input.before === 20)).toHaveLength(1)
  expect(fact(en.taskState)).toBe(en['taskStatus.delivered'])
  expect(fact(en.taskExecutor)).toBe(`${en.taskWorker} historical-worker`)
  expect(node('.as-pill', row(historical.title)).textContent).toBe(en['taskStatus.delivered'])
  await click(en.closeDetails, node('.as-task-detail', panel))
  expect(node('.as-pill', row(historical.title)).textContent).toBe(en['taskStatus.delivered'])
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
})

it('creates and edits an active project, sends an explicit null workspace and saves only edited archive fields', async () => {
  let current: StudioProjectSummary = { id: 'created', name: 'Phase Three', objective: 'Test workflow', workspacePath: '/work/phase3', state: 'active', managementEpoch: 1 }
  const archive: StudioProjectArchive = { projectId: current.id, decisions: 'Keep evidence', progress: '', openIssues: '', updatedAt: null, readonly: false }
  const app = server(({ op, input }) => {
    if (op === 'createProject' || op === 'updateProject') {
      if (op === 'updateProject') current = { ...current, objective: String(input.objective), workspacePath: null, managementEpoch: 2 }
      app.state.projects = [...app.state.projects.filter(project => project.id !== current.id), current]
      return current
    }
    if (op === 'projectArchive') return archive
    if (op === 'updateProjectArchive') return { ...archive, ...input, updatedAt: new Date(at).toISOString() }
  })
  const panel = await render(slots().main)
  const launcher = node('.as-project-nav > button', panel)
  expect(launcher.textContent).toContain(en.newProject)
  await click(launcher)
  const newForm = node('.as-project-nav form', panel)
  expect(button(en.createProject, newForm).disabled).toBe(true)
  await change(field<HTMLInputElement>(en.projectName, newForm), current.name)
  await change(field<HTMLTextAreaElement>(en.projectObjective, newForm), current.objective)
  await change(field<HTMLInputElement>(en.projectWorkspace, newForm), ` ${current.workspacePath} `)
  await click(en.createProject, newForm)
  expect(app.requests.find(request => request.op === 'createProject')?.input).toEqual({ name: current.name, objective: current.objective, workspacePath: current.workspacePath })
  expect(node('h2', panel).textContent).toBe(current.name)
  expect(panel.querySelector('.as-project-nav form')).toBeNull()
  const bar = node('.as-project-bar', panel)
  await click(en.manageProject, bar)
  const edit = node('.as-project-drawer form', bar)
  await change(field<HTMLTextAreaElement>(en.projectObjective, edit), 'Updated objective')
  await change(field<HTMLInputElement>(en.projectWorkspace, edit), '')
  await click(en.saveProject, edit)
  expect(app.requests.find(request => request.op === 'updateProject')?.input).toEqual({ projectId: current.id, expectedEpoch: 1, objective: 'Updated objective', workspacePath: null })
  expect(bar.textContent).toContain(en.noWorkspace)
  await click(en.projectArchive, bar)
  const dossier = node('.as-project-drawer form', bar)
  expect(field<HTMLTextAreaElement>(en['archiveField.decisions'], dossier).value).toBe(archive.decisions)
  const progress = field<HTMLTextAreaElement>(en['archiveField.progress'], dossier)
  expect(progress.readOnly).toBe(false)
  await change(progress, 'Verified the milestone')
  await click(en.saveArchive, dossier)
  expect(app.requests.find(request => request.op === 'updateProjectArchive')?.input).toEqual({ projectId: current.id, progress: 'Verified the milestone' })
  expect(dossier.textContent).toContain(en.archiveSaved)
})

it('confirms replacement and archiving, then opens the archived project read-only and reopens it from the archive list', async () => {
  const app = server(({ op, input }) => {
    const current = [...app.state.projects, ...(app.state.archivedProjects ?? [])][0]!
    if (op === 'projectArchive') return { projectId: current.id, decisions: 'Preserved decision', progress: '', openIssues: '', updatedAt: null, readonly: current.state === 'archived' }
    if (op === 'replaceProjectLeader' || op === 'archiveProject' || op === 'reopenProject') {
      const receipt = { ...current, managementEpoch: Number(input.expectedEpoch) + 1, state: op === 'archiveProject' ? 'archived' : 'active' } as const
      app.state.projects = receipt.state === 'active' ? [receipt] : []
      app.state.archivedProjects = receipt.state === 'archived' ? [receipt] : []
      return receipt
    }
  })
  const panel = await render(slots().main)
  await change(node<HTMLSelectElement>('[aria-label="Project conversation"]', panel), 'project-a')
  await click(en.manageProject, panel)
  await click(en.replaceProjectLeader, panel)
  const replace = node('dialog', panel)
  expect(replace.textContent).toContain(t('confirmBody.replaceProjectLeader', { name: 'Project A' }))
  expect(app.requests.some(request => request.op === 'replaceProjectLeader')).toBe(false)
  await click(en.cancel, replace)
  expect(panel.querySelector('dialog')).toBeNull()
  await click(en.replaceProjectLeader, panel)
  await click(en.replaceProjectLeader, node('dialog', panel))
  expect(app.requests.find(request => request.op === 'replaceProjectLeader')?.input).toEqual({ projectId: 'project-a', expectedEpoch: 1 })
  await click(en.archiveProject, panel)
  const archive = node('dialog', panel)
  expect(archive.textContent).toContain(t('confirmBody.archiveProject', { name: 'Project A' }))
  expect(app.requests.some(request => request.op === 'archiveProject')).toBe(false)
  await click(en.archiveProject, archive)
  expect(app.requests.find(request => request.op === 'archiveProject')?.input).toEqual({ projectId: 'project-a', expectedEpoch: 2 })
  await click(en.assistant, panel)
  const list = node<HTMLDetailsElement>('.as-project-nav-archived', panel)
  if (!list.open) await click(node('summary', list))
  await click('Project A', list)
  expect(node('h2', panel).textContent).toBe('Project A')
  expect(compose().disabled).toBe(true)
  expect(button(en.send, panel).disabled).toBe(true)
  expect(panel.querySelector(`[aria-label="${en.projectManagement}"] input`)).toBeNull()
  await click(en.projectArchive, node('.as-project-bar', panel))
  const readOnly = node('.as-project-drawer form', panel)
  expect(readOnly.textContent).toContain(en.archiveReadOnly)
  const textarea = field<HTMLTextAreaElement>(en['archiveField.decisions'], readOnly)
  expect(textarea.value).toBe('Preserved decision')
  expect(textarea.readOnly).toBe(true)
  expect(button(en.saveArchive, readOnly).disabled).toBe(true)
  await click(en.reopenProject, panel)
  expect(app.requests.find(request => request.op === 'reopenProject')?.input).toEqual({ projectId: 'project-a', expectedEpoch: 3 })
  expect(compose().disabled).toBe(false)
  expect(node('.as-project-bar', panel).textContent).toContain(en['projectSaved.reopenProject'])
  expect(list.textContent).toContain(en.noArchivedProjects)
})

it('isolates global and project preferences, edits the displayed version and forgets only after confirming literal text', async () => {
  const sample = '<img src=x onerror="bad()"> & <b>literal</b>'
  const global: StudioPreference = { preferenceId: 'global', key: 'format', projectId: null, text: 'Global value', state: 'active', version: 1,
    updatedAt: new Date(at).toISOString() }
  let current: StudioPreference | undefined
  const app = server(({ op, input }) => {
    if (op === 'preferences') return input.projectId ? current ? [current] : [] : [global]
    if (op === 'savePreference') return current = { ...global, preferenceId: 'project', projectId: 'project-a', text: String(input.text) }
    if (op === 'updatePreference') return current = { ...current!, text: String(input.text), version: 2 }
    if (op === 'forgetPreference') {
      const tombstone = { ...current!, text: '', state: 'forgotten', version: 3 }
      current = undefined
      return tombstone
    }
  })
  const panel = await render(slots().main)
  await change(node<HTMLSelectElement>('[aria-label="Project conversation"]', panel), 'project-a')
  await click(en.preferences, panel)
  expect(app.requests.at(-1)).toMatchObject({ op: 'preferences', input: {} })
  expect(panel.textContent).toContain(global.text)
  await click(en.projectPreferences, panel)
  expect(app.requests.at(-1)).toMatchObject({ op: 'preferences', input: { projectId: 'project-a' } })
  expect(panel.textContent).not.toContain(global.text)
  const form = node('.as-detail form', panel)
  await change(field<HTMLInputElement>(en.preferenceKey, form), 'format')
  await change(field<HTMLTextAreaElement>(en.preferenceText, form), sample)
  await click(en.addPreference, form)
  expect(app.requests.find(request => request.op === 'savePreference')?.input).toEqual({ projectId: 'project-a', key: 'format', text: sample })
  const item = node('.as-detail article', panel)
  expect(node('.as-message-text', item).textContent).toBe(sample)
  expect(item.querySelector('img, b')).toBeNull()
  await click(en.editPreference, item)
  expect(item.textContent).toContain(t('preferenceVersion', { version: 1 }))
  await change(field<HTMLTextAreaElement>(en.preferenceText, item), `${sample} updated`)
  await click(en.savePreference, item)
  expect(app.requests.find(request => request.op === 'updatePreference')?.input).toEqual({ projectId: 'project-a', key: 'format', expectedVersion: 1, text: `${sample} updated` })
  expect(item.textContent).toContain(t('preferenceVersion', { version: 2 }))
  expect(node('.as-message-text', item).textContent).toBe(`${sample} updated`)
  expect(item.querySelector('img, b')).toBeNull()
  await click(en.forgetPreference, item)
  expect(app.requests.some(request => request.op === 'forgetPreference')).toBe(false)
  const dialog = node('dialog', panel)
  expect(dialog.textContent).toContain(en.forgetPreferenceTitle)
  await click(en.forgetPreference, dialog)
  expect(app.requests.find(request => request.op === 'forgetPreference')?.input).toEqual({ projectId: 'project-a', key: 'format', expectedVersion: 2 })
  expect(panel.querySelector('.as-detail article')).toBeNull()
  expect(panel.textContent).toContain(en.preferenceForgotten)
  await click(en.globalPreferences, panel)
  expect(node('.as-detail article .as-message-text', panel).textContent).toBe(global.text)
})
