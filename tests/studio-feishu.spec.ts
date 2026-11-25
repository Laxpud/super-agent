import type { EventDispatcher } from '@larksuiteoapi/node-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { feishuSourceScope, type FeishuInboxConfig } from '../src/managed-worker/feishu-inbox.ts'
import { StudioFeishuSdk } from '../src/managed-worker/feishu-sdk.ts'
import { StudioFeishuConversation, type StudioFeishuDelivery, type StudioFeishuPort } from '../src/studio/feishu.ts'
import { ASSISTANT_CONVERSATION, type StudioPending } from '../src/studio/protocol.ts'

interface HttpRequest { url?: string; method?: string; params?: unknown; data?: unknown; proxy?: unknown; maxRedirects?: number }
interface MockSocket { dispatcher: EventDispatcher; open(): void; disconnect(): void }
const network = vi.hoisted(() => ({ request: vi.fn<(config: HttpRequest) => unknown>(), socket: vi.fn<(socket: MockSocket) => void>() }))

// 只替换网络边界。实际 SDK 仍负责 V2 分发、token 请求、路径和请求体序列化。
vi.mock('@larksuiteoapi/node-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof import('@larksuiteoapi/node-sdk')>()
  class MockWSClient {
    private connected = false
    constructor(private readonly options: ConstructorParameters<typeof sdk.WSClient>[0]) {}
    start({ eventDispatcher }: { eventDispatcher: EventDispatcher }): Promise<void> {
      network.socket({ dispatcher: eventDispatcher, open: () => { this.connected = true; this.options.onReady?.() },
        disconnect: () => { this.connected = false; this.options.onError?.(new Error('Mock disconnect')) } })
      return Promise.resolve()
    }
    getConnectionStatus() { return { state: this.connected ? 'connected' : 'connecting' } }
    close() { this.connected = false }
  }
  return { ...sdk, WSClient: MockWSClient, defaultHttpInstance: {
    create: (options: Parameters<typeof sdk.defaultHttpInstance.create>[0]) => sdk.defaultHttpInstance.create({ ...options,
      adapter: async config => ({ data: await network.request(config), status: 200, statusText: 'OK', headers: {}, config }),
    }),
  } }
})

const binding: FeishuInboxConfig = { appId: 'cli_0123456789abcdef', botOpenId: 'ou_robot', ownerOpenId: 'ou_owner', chatId: 'oc_private' }
const scope = feishuSourceScope(binding)
const cutover = 1_790_000_000_000
const receipt = (messageId: string, chatId = binding.chatId) => ({ code: 0, data: { message_id: messageId, chat_id: chatId } })
const newSdk = () => new StudioFeishuSdk(binding.appId, 'mock-app-secret')
const path = (config: HttpRequest) => new URL(config.url!).pathname
const writes = () => network.request.mock.calls.map(([request]) => request).filter(request => path(request).startsWith('/open-apis/im/'))
const body = (request: HttpRequest) => JSON.parse(request.data as string) as {
  content: string; msg_type?: string; reply_in_thread?: boolean; uuid?: string; receive_id?: string
}
const envelope = (type: string, event: object, appId = binding.appId) => ({ schema: '2.0', header: { event_type: type, app_id: appId }, event })

const owner = { sender_type: 'user', sender_id: { open_id: binding.ownerOpenId } }
function message(fields: object = {}, sender = owner, appId = binding.appId) {
  return envelope('im.message.receive_v1', { sender, message: { message_id: 'om_input', chat_id: binding.chatId, chat_type: 'p2p',
    create_time: String(cutover + 1), message_type: 'text', content: JSON.stringify({ text: '  原始文字\n保留换行  ' }), ...fields } }, appId)
}

const confirmation: StudioPending = { id: 'pending-one', conversationId: 'project-one', taskId: 'task-one', title: '继续检查？',
  detail: '只检查修改过的文档。', requester: 'Leader', kind: 'confirmation', mobile: 'card', state: 'pending',
  acceptsText: false, options: ['继续检查', '停止检查'], createdAt: cutover + 1 }

const active: { stop: AbortController; done: Promise<void> }[] = []
function track(start: (signal: AbortSignal) => Promise<void>) {
  const stop = new AbortController()
  const done = start(stop.signal)
  active.push({ stop, done })
  return { stop, done }
}

function harness(queue: StudioFeishuDelivery[] = [], ready = () => true) {
  const port = {
    activate: vi.fn<StudioFeishuPort['activate']>().mockReturnValue(cutover),
    receive: vi.fn<StudioFeishuPort['receive']>().mockResolvedValue(undefined),
    answer: vi.fn<StudioFeishuPort['answer']>().mockReturnValue(false),
    next: vi.fn<StudioFeishuPort['next']>(() => queue.shift()), finish: vi.fn<StudioFeishuPort['finish']>(),
  }
  const warn = vi.fn<(message: string) => void>()
  const adapter = new StudioFeishuConversation(newSdk(), binding, port, ready, warn)
  const run = track(signal => adapter.run(signal))
  return { ...run, adapter, port, warn }
}

async function socket() {
  await vi.waitFor(() => expect(network.socket).toHaveBeenCalled())
  return network.socket.mock.lastCall![0]
}

function installHttp(im: (request: HttpRequest) => unknown, bot = binding.botOpenId) {
  network.request.mockImplementation(request => {
    switch (path(request)) {
      case '/open-apis/auth/v3/tenant_access_token/internal': return { code: 0, tenant_access_token: 'mock-token', expire: 7200 }
      case '/open-apis/bot/v3/info': return { code: 0, bot: { open_id: bot } }
      default: return im(request)
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installHttp(() => receipt('om_default'))
})
afterEach(async () => {
  const running = active.splice(0)
  for (const { stop } of running) stop.abort()
  await Promise.allSettled(running.map(({ done }) => done))
})

const invoke = ({ dispatcher }: MockSocket, wire: unknown) => dispatcher.invoke(wire, { needCheck: false }) as Promise<unknown>

describe('Studio Feishu official SDK channel', () => {
  it('preserves the legacy listener and void reply while verifying new reply receipts', async () => {
    const sdk = newSdk()
    const old = { ready: vi.fn(), problem: vi.fn(), receive: vi.fn() }
    const { stop } = track(signal => sdk.listen(signal, old))
    const ws = await socket()
    expect(ws.dispatcher.handles.has('card.action.trigger')).toBe(false)
    ws.open()
    await invoke(ws, message())
    expect(old.receive).toHaveBeenCalledWith(expect.objectContaining({ app_id: binding.appId, sender: owner }))
    await expect(sdk.replyText(binding.chatId, 'om_input', 'legacy', 'legacy-key', stop.signal)).resolves.toBeUndefined()
    await expect(sdk.replyTextReceipt(binding.chatId, 'om_input', 'visible', 'new-key', stop.signal)).resolves.toBe('om_default')
    installHttp(() => receipt('om_wrong', 'oc_unrelated'))
    await expect(sdk.replyTextReceipt(binding.chatId, 'om_input', 'visible', 'wrong-chat-key', stop.signal)).rejects.toThrow('reply was not confirmed')
    expect(writes()).toHaveLength(3)
    expect(writes()[1]).toMatchObject({ method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_input/reply',
      proxy: false, maxRedirects: 0 })
    expect(body(writes()[1]!)).toEqual({ msg_type: 'text', content: '{"text":"visible"}', reply_in_thread: true, uuid: 'new-key' })
  })

  it('admits only new owner text from the verified app and private chat, preserving native coordinates', async () => {
    const { adapter, port, stop, done } = harness()
    const ws = await socket()
    expect(adapter.state).toBe('connecting')
    await invoke(ws, message())
    expect(port.receive).not.toHaveBeenCalled()
    ws.open()
    expect(adapter.scope).toBe(scope)
    expect(adapter.state).toBe('online')
    expect(port.activate).toHaveBeenCalledWith(scope, expect.any(Number))
    for (const wire of [message({ create_time: String(cutover - 1) }), message({ create_time: String(cutover) }), message({ create_time: '1790000000' }),
      message({ chat_id: 'oc_other' }), message({ chat_type: 'group' }), message({}, owner, 'cli_other'),
      message({}, { ...owner, sender_id: { open_id: binding.botOpenId } }), message({}, { ...owner, sender_type: 'app' }),
      message({ content: 'plain not JSON' }), message({ content: '{"text":"  "}' }), message({ message_type: 'post' }),
      message({ parent_id: 'not-a-message' }), message({ content: JSON.stringify({ text: '\u0000' }) })]) await invoke(ws, wire)
    expect(port.receive).not.toHaveBeenCalled()
    await invoke(ws, message({ parent_id: 'om_card', root_id: 'om_root', thread_id: 'omt_existing' }))
    expect(port.receive).toHaveBeenCalledExactlyOnceWith({ scope, id: 'om_input', sourceTimeMs: cutover + 1,
      text: '  原始文字\n保留换行  ', parentId: 'om_card', rootId: 'om_root', threadId: 'omt_existing' }, expect.any(AbortSignal))
    expect(port.answer).not.toHaveBeenCalled() // 交给应用核对原卡片，适配器不从普通文字推断授权。
    stop.abort()
    await done
    expect(adapter.state).toBe('offline')
    await invoke(ws, message())
    expect(port.receive).toHaveBeenCalledTimes(1)
  })

  it('fails closed before opening a socket when the bot identity differs', async () => {
    installHttp(() => receipt('om_unexpected'), 'ou_anotherBot')
    const { done, adapter, port } = harness()
    await done
    expect(adapter.state).toBe('identity-mismatch')
    expect(network.socket).not.toHaveBeenCalled()
    expect(port.activate).not.toHaveBeenCalled()
    expect(port.next).not.toHaveBeenCalled()
  })

  it('reverifies after disconnect and does not reactivate an identity that has changed', async () => {
    const { adapter, port, done, warn } = harness()
    const ws = await socket()
    ws.open()
    expect(adapter.state).toBe('online')
    installHttp(() => receipt('om_unexpected'), 'ou_changedBot')
    ws.disconnect()
    await done
    expect(adapter.state).toBe('identity-mismatch')
    expect(network.request.mock.calls.map(([request]) => path(request)).filter(uri => uri === '/open-apis/bot/v3/info')).toHaveLength(2)
    expect(network.socket).toHaveBeenCalledTimes(1)
    expect(port.activate).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('Studio Feishu long connection is unavailable')
  })

  it('mirrors only the visible text with explicit attribution, threading through the exact mapped parent', async () => {
    let sequence = 0
    installHttp(() => receipt(`om_out${++sequence}`))
    const queue: StudioFeishuDelivery[] = []
    const { adapter, port } = harness(queue)
    ;(await socket()).open()
    queue.push({ id: 'gui-message', kind: 'message', channel: 'gui', text: '来自工作室的指令' },
      { id: 'assistant-message', kind: 'message', channel: 'studio', parentId: 'om_origin', text: '看到了。' },
      { id: 'card-reply', kind: 'pending', parentId: 'om_origin', pending: confirmation })
    adapter.wake()
    await vi.waitFor(() => expect(port.finish).toHaveBeenCalledTimes(3))
    const calls = writes()
    expect(calls.map(path)).toEqual(['/open-apis/im/v1/messages', '/open-apis/im/v1/messages/om_origin/reply', '/open-apis/im/v1/messages/om_origin/reply'])
    expect(calls[0]?.params).toEqual({ receive_id_type: 'open_id' })
    expect(body(calls[0]!)).toMatchObject({ receive_id: binding.ownerOpenId, msg_type: 'text', content: JSON.stringify({ text: '你 · 来自 GUI\n来自工作室的指令' }),
      uuid: expect.stringMatching(/^studio-[0-9a-f]{32}$/) })
    expect(body(calls[1]!)).toMatchObject({ msg_type: 'text', reply_in_thread: true, content: JSON.stringify({ text: 'Assistant\n看到了。' }) })
    expect(body(calls[2]!)).toMatchObject({ msg_type: 'interactive', reply_in_thread: true })
    expect(port.finish.mock.calls).toEqual([['gui-message', 'om_out1'], ['assistant-message', 'om_out2'], ['card-reply', 'om_out3']])
  })

  it('answers a V2 button immediately but updates only the exact saved card via the delivery queue', async () => {
    const patch = Promise.withResolvers<{ code: number }>()
    installHttp(request => request.method === 'patch' ? patch.promise : receipt('om_card'))
    const queue: StudioFeishuDelivery[] = [{ id: 'card', kind: 'pending', pending: confirmation }]
    const { port } = harness(queue)
    const ws = await socket()
    ws.open()
    try {
      await vi.waitFor(() => expect(port.finish).toHaveBeenCalledWith('card', 'om_card'))
      const initial = JSON.parse(body(writes()[0]!).content)
      expect(initial).toMatchObject({ schema: '2.0', config: { update_multi: true, enable_forward: false } })
      expect(JSON.stringify(initial)).toContain('task-one')
      expect(JSON.stringify(initial)).toContain('Leader')
      expect(JSON.stringify(initial)).toContain('只检查修改过的文档')
      const value = initial.body.elements.find((entry: { tag: string }) => entry.tag === 'button').behaviors[0].value
      expect(value).toEqual({ studio: 'pending-answer', appId: binding.appId, pendingId: confirmation.id, value: confirmation.options[0] })
      const good = { operator: { open_id: binding.ownerOpenId }, context: { open_chat_id: binding.chatId, open_message_id: 'om_card' },
        action: { tag: 'button', value } }
      const trigger = (event = good, appId = binding.appId) => invoke(ws, envelope('card.action.trigger', event, appId))
      await expect(trigger(good, 'cli_unrelated')).resolves.toBeUndefined()
      await expect(trigger({ ...good, operator: { open_id: 'ou_unrelated' } })).resolves.toBeUndefined()
      await expect(trigger({ ...good, context: { ...good.context, open_chat_id: 'oc_other' } })).resolves.toBeUndefined()
      await expect(trigger({ ...good, action: { tag: 'button', value: { ...value, appId: 'cli_unrelated' } } })).resolves.toBeUndefined()
      await expect(invoke(ws, envelope('card.action.trigger', { ...good, context: undefined, ...good.context }))).resolves.toBeUndefined()
      expect(port.answer).not.toHaveBeenCalled()
      await expect(trigger({ ...good, context: { ...good.context, open_message_id: 'om_unbound' } })).resolves.toMatchObject({ toast: { type: 'warning' } })
      port.answer.mockImplementationOnce(() => {
        queue.push({ id: 'settled-card', kind: 'pending-update', cardMessageId: 'om_card',
          pending: { ...confirmation, state: 'resolved', answer: value.value, answeredBy: 'feishu' } })
        return true
      })
      await expect(trigger()).resolves.toMatchObject({ toast: { type: 'success' } })
      expect(port.answer).toHaveBeenLastCalledWith({ scope, messageId: 'om_card', pendingId: confirmation.id, value: value.value })
      await expect(trigger()).resolves.toMatchObject({ toast: { type: 'warning' } })
      await vi.waitFor(() => expect(writes()).toHaveLength(2))
      expect(port.finish).not.toHaveBeenCalledWith('settled-card', expect.anything())
      const update = writes()[1]!
      expect(update.method).toBe('patch')
      expect(path(update)).toBe('/open-apis/im/v1/messages/om_card')
      expect(body(update).content).toContain('已处理')
      expect(body(update).content).not.toContain('"tag":"button"')
      patch.resolve({ code: 0 })
      await vi.waitFor(() => expect(port.finish).toHaveBeenCalledWith('settled-card', 'om_card'))
    } finally { patch.resolve({ code: 0 }) }
  })

  it('has no choice buttons for expired, unsupported, or exact-card text questions', async () => {
    const { port } = harness([
      { id: 'unsupported', kind: 'pending', pending: { ...confirmation, mobile: 'unsupported' } },
      { id: 'expired', kind: 'pending', pending: { ...confirmation, state: 'expired' } },
      { id: 'question', kind: 'pending', pending: { ...confirmation, kind: 'question', mobile: 'topic', acceptsText: true } },
    ])
    ;(await socket()).open()
    await vi.waitFor(() => expect(port.finish).toHaveBeenCalledTimes(3))
    const cards = writes().map(request => body(request).content)
    expect(cards[0]).toContain('可直接回复这条消息说「批准」或「拒绝」')
    expect(cards[1]).toContain('已失效')
    expect(cards[2]).toContain('直接回复这张卡片')
    expect(cards.every(card => !card.includes('"tag":"button"'))).toBe(true)
  })

  it('bounds and drains input handlers; uncertain writes are neither resent nor flattened', async () => {
    installHttp(request => {
      if (request.method === 'patch') return { code: 123, msg: 'raw vendor diagnostics' }
      throw new Error('raw vendor diagnostics')
    })
    const input = Promise.withResolvers<void>()
    const { adapter, port, stop, done, warn } = harness([
      { id: 'uncertain-reply', kind: 'message', channel: 'studio', parentId: 'om_exact', text: 'Reply' },
      { id: 'uncertain-update', kind: 'pending-update', cardMessageId: 'om_card', pending: { ...confirmation, state: 'expired' } },
    ])
    port.receive.mockReturnValue(input.promise)
    const ws = await socket()
    ws.open()
    try {
      await vi.waitFor(() => expect(port.next.mock.calls.length).toBeGreaterThanOrEqual(3))
      expect(port.finish.mock.calls).toEqual([['uncertain-reply'], ['uncertain-update']])
      const calls = port.next.mock.calls.length
      adapter.wake()
      await vi.waitFor(() => expect(port.next.mock.calls.length).toBeGreaterThan(calls))
      expect(writes().map(path)).toEqual(['/open-apis/im/v1/messages/om_exact/reply', '/open-apis/im/v1/messages/om_card'])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('raw vendor diagnostics')
      for (let i = 0; i < 16; i++) await invoke(ws, message({ message_id: `om_input_${i}` }))
      await expect(invoke(ws, message({ message_id: 'om_overflow' }))).rejects.toThrow('event was not handled')
      expect(port.receive).toHaveBeenCalledTimes(16)
      let drained = false
      void done.then(() => { drained = true })
      stop.abort()
      await vi.waitFor(() => expect(adapter.state).toBe('offline'))
      expect(drained).toBe(false)
      expect(port.receive.mock.lastCall?.[1].aborted).toBe(true)
      input.resolve()
      await done
      expect(drained).toBe(true)
    } finally { input.resolve() }
  })
})
