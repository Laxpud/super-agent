// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { STUDIO_API, STUDIO_HEADER, type StudioMessage, type StudioOp, type StudioPending, type StudioSessionRecord,
  type StudioState } from '../src/studio/protocol.ts'
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
const record: StudioSessionRecord = { id: 'session-1', conversationId: 'assistant', createdAt: at, role: 'assistant' }
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
  const state: StudioState = { projects: [{ id: 'project-a', name: 'Project A', objective: 'Release' }], pendingCount: 0,
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
  expect(tools).toHaveLength(6)
  const view = await render(tools[0]!, { phase: 'result', useDisclosure: () => ({ expanded: true, toggle: () => {} }),
    block: { meta: { title: 'Saved receipt', text: '<b>Literal tool text</b>' }, content: [], isError: false } })
  expect(node('pre', view).textContent).toBe('<b>Literal tool text</b>')
  expect(view.querySelector('b')).toBeNull()
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
    if (op === 'records') return input.query === 'assistant' ? { items: [record] } : { items: [] }
    if (op === 'record') return { record, events: [{ seq: input.from ?? 1, kind: 'assistant/message', text: 'Read-only history' }] }
  })
  await render(slots().main)
  await click(en.source)
  expect(app.requests.at(-1)).toMatchObject({ op: 'record', input: { sessionId: record.id, from: 87 } })
  expect(node('.as-event-list [data-focused]').textContent).toContain('Source event #87')
  expect(document.querySelector('textarea')).toBeNull()
  await back()
  await click(en.records)
  await change(node<HTMLInputElement>('input[type="search"]'), 'assistant')
  await click(en.search)
  expect(app.requests.at(-1)).toMatchObject({ op: 'records', input: { query: 'assistant' } })
  await click(node('.as-record-row'))
  expect(app.requests.at(-1)).toMatchObject({ op: 'record', input: { sessionId: record.id } })
  expect(document.body.textContent).toContain(en.readOnly)
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
  expect(document.body.textContent).toContain(en['mobile.unsupported'])
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
  const app = server(({ op, input }) => {
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
})
