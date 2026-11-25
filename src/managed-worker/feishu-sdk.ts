import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent } from 'node:https'
import { setTimeout as delay } from 'node:timers/promises'
import { AppType, Client, DefaultCache, Domain, EventDispatcher, LoggerLevel, WSClient, defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk'

const REQUEST_TIMEOUT_MS = 15_000
const CONNECTION_CHECK_MS = 250
const chatIdPattern = /^oc_[a-zA-Z0-9]+$/
const messageIdPattern = /^om_[a-zA-Z0-9_-]+$/
const openIdPattern = /^ou_[a-zA-Z0-9]+$/
const noLog = () => {}
const quiet = { logger: { error: noLog, warn: noLog, info: noLog, debug: noLog, trace: noLog }, loggerLevel: LoggerLevel.fatal }

/** Keep credentials out of inherited proxies and redirects without changing the SDK's shared HTTP defaults. */
function directHttp(agent: Agent, signal: () => AbortSignal | undefined): HttpInstance {
  const http = defaultHttpInstance.create({ proxy: false, httpsAgent: agent, maxRedirects: 0 })
  http.interceptors.request.use(config => {
    config.signal = signal() ?? AbortSignal.abort()
    return config
  }, undefined, { synchronous: true })
  // Match the SDK's default response body, which Axios's instance type does not infer from an interceptor.
  http.interceptors.response.use(response => response.data)
  return http as unknown as HttpInstance
}

/** The SDK only stores the socket after it opens; an owned agent also lets us close a pending handshake. */
class ConnectionAgent extends Agent {
  readonly #signal: AbortSignal

  constructor(signal: AbortSignal) {
    super()
    this.#signal = signal
  }

  override createConnection(...args: Parameters<Agent['createConnection']>) {
    // Abort may land after endpoint discovery but before the SDK starts the handshake.
    if (this.#signal.aborted) throw new Error('Studio Feishu connection was cancelled')
    return super.createConnection(...args)
  }
}

/** Count a successful receipt only when Feishu returns a message ID for the configured chat. */
function messageReceipt(result: { code?: number; data?: { chat_id?: string; message_id?: string } }, chatId: string): string | undefined {
  const id = result?.data?.message_id
  if (result?.code === 0 && result.data?.chat_id === chatId && typeof id === 'string' && messageIdPattern.test(id)) return id
}

export interface StudioFeishuCardResponse {
  toast: { type: 'success' | 'warning'; content: string }
}

export interface StudioFeishuCallbacks {
  ready(): void
  problem(): void
  receive(value: unknown): void
  /** 同步返回长连接应答；后续通过普通消息 API 更新卡片。 */
  card?(value: unknown): StudioFeishuCardResponse | undefined
}

/** Transport for one Studio self-built application; the caller authorizes and normalizes received events. */
export class StudioFeishuSdk {
  readonly #restSignal = new AsyncLocalStorage<AbortSignal>()
  readonly #client: Client
  readonly #credentials: { appId: string; appSecret: string }

  constructor(appId: string, appSecret: string) {
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId) || !appSecret) throw new Error('Studio Feishu application credentials are invalid')
    this.#credentials = { appId, appSecret }
    this.#client = new Client({ ...this.#credentials, ...quiet, appType: AppType.SelfBuild, domain: Domain.Feishu,
      cache: new DefaultCache(), httpInstance: directHttp(new Agent(), () => this.#restSignal.getStore()) })
  }

  /** Apply one deadline and cancellation signal to token acquisition as well as the SDK operation itself. */
  private async rest<T>(signal: AbortSignal, failure: string, request: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error(failure)
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    try {
      const value = await this.#restSignal.run(deadline, request)
      if (!deadline.aborted) return value
    } catch { /* SDK errors can contain URLs, credentials or response bodies. */ }
    throw new Error(failure)
  }

  /** Read the bot's open ID from a successful bot info response. */
  async botOpenId(signal: AbortSignal): Promise<string> {
    const failure = 'Studio Feishu bot identity was not confirmed'
    const result = await this.rest(signal, failure, () => this.#client.request<{ code?: number; bot?: { open_id?: string } }>({
      method: 'GET', url: '/open-apis/bot/v3/info',
    }))
    const id = result?.bot?.open_id
    if (result?.code !== 0 || typeof id !== 'string' || !openIdPattern.test(id)) throw new Error(failure)
    return id
  }

  /** Own one connection attempt. Report handshake success, then let the caller reverify before retrying a disconnect. */
  async listen(signal: AbortSignal, callbacks: StudioFeishuCallbacks): Promise<void> {
    if (signal.aborted) return
    const stop = new AbortController()
    const active = AbortSignal.any([signal, stop.signal])
    const agent = new ConnectionAgent(active)
    let ws: WSClient | undefined
    let ready = false
    try {
      const dispatcher = new EventDispatcher(quiet).unregister('app_ticket').register({
        'im.message.receive_v1': data => {
          if (!ready || active.aborted) return
          try { callbacks.receive(data) } catch { throw new Error('Studio Feishu event was not handled') }
        },
      })
      // 1.76.0 将 V2 header 和 event 铺在同一个对象上，并把处理器返回值写回长连接。
      // 旧 Inbox 不传 card 回调，因此仍只订阅原有的文本事件。
      if (callbacks.card) dispatcher.register({
        'card.action.trigger': (data: unknown) => {
          if (!ready || active.aborted) return
          try { return callbacks.card?.(data) } catch { throw new Error('Studio Feishu card event was not handled') }
        },
      })
      const discovery = AbortSignal.any([active, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      ws = new WSClient({ ...this.#credentials, ...quiet, domain: Domain.Feishu, agent,
        httpInstance: directHttp(agent, () => discovery), autoReconnect: false, handshakeTimeoutMs: REQUEST_TIMEOUT_MS,
        onReady: () => {
          if (active.aborted) return
          ready = true
          try { callbacks.ready() } catch { stop.abort() }
        },
        onError: () => stop.abort(),
      })
      await ws.start({ eventDispatcher: dispatcher })
      // In 1.76.0 start returns before the handshake; with autoReconnect off there is no disconnect hook.
      while (!active.aborted && ws.getConnectionStatus().state === (ready ? 'connected' : 'connecting')) {
        await delay(CONNECTION_CHECK_MS, undefined, { signal: active, ref: false })
      }
    } catch {
      // Timeout, abort and SDK failures all close the attempt without exposing SDK diagnostics.
    } finally {
      stop.abort()
      try { ws?.close({ force: true }) } catch { /* Still destroy the agent. */ }
      agent.destroy()
    }
    if (!signal.aborted) {
      try { callbacks.problem() } catch { throw new Error('Studio Feishu listener failed') }
    }
  }

  /** Address the configured owner directly, never a chat ID that might refer to a group; confirm the intended DM in the receipt. */
  private async send(ownerOpenId: string, chatId: string, msgType: 'text' | 'interactive', body: object, key: string,
    signal: AbortSignal): Promise<string | undefined> {
    if (!openIdPattern.test(ownerOpenId) || !chatIdPattern.test(chatId)) return
    const result = await this.rest(signal, 'Studio Feishu notice was not confirmed', () => this.#client.im.v1.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: ownerOpenId, msg_type: msgType, content: JSON.stringify(body), uuid: key },
    }))
    return messageReceipt(result, chatId)
  }

  sendText(ownerOpenId: string, chatId: string, text: string, key: string, signal: AbortSignal): Promise<string | undefined> {
    return this.send(ownerOpenId, chatId, 'text', { text }, key, signal)
  }

  /** 直接以机器人身份向配置的所有者发送卡片，返回指定私聊的消息 ID。 */
  sendCard(ownerOpenId: string, chatId: string, card: object, key: string, signal: AbortSignal): Promise<string | undefined> {
    return this.send(ownerOpenId, chatId, 'interactive', card, key, signal)
  }

  /** 只回复已经归属到当前私聊的消息；由飞书在该消息的话题中投递并返回回执。 */
  private async reply(chatId: string, messageId: string, msgType: 'text' | 'interactive', body: object, key: string,
    signal: AbortSignal, inThread = true): Promise<string> {
    const failure = 'Studio Feishu reply was not confirmed'
    if (!chatIdPattern.test(chatId) || !messageIdPattern.test(messageId)) throw new Error(failure)
    const result = await this.rest(signal, failure, () => this.#client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: msgType, content: JSON.stringify(body), reply_in_thread: inThread, uuid: key },
    }))
    const receipt = messageReceipt(result, chatId)
    if (!receipt) throw new Error(failure)
    return receipt
  }

  /** 保留旧 Inbox 的纯文本回复契约；它只关心投递确认，不保存消息 ID。 */
  async replyText(chatId: string, messageId: string, text: string, key: string, signal: AbortSignal): Promise<void> {
    await this.replyTextReceipt(chatId, messageId, text, key, signal)
  }

  /** 返回原生话题回复的远端消息 ID，供 Studio 将两端的消息位置绑定起来。 */
  replyTextReceipt(chatId: string, messageId: string, text: string, key: string, signal: AbortSignal, inThread = true): Promise<string> {
    return this.reply(chatId, messageId, 'text', { text }, key, signal, inThread)
  }

  /** 在指定的原生话题内发送卡片，并确认卡片回执也属于配置的私聊。 */
  replyCard(chatId: string, messageId: string, card: object, key: string, signal: AbortSignal): Promise<string> {
    return this.reply(chatId, messageId, 'interactive', card, key, signal)
  }

  /** 更新已绑定的原卡片。此 API 不返回新消息 ID，仅用业务状态码确认成功。 */
  async patchCard(messageId: string, card: object, signal: AbortSignal): Promise<void> {
    const failure = 'Studio Feishu card update was not confirmed'
    if (!messageIdPattern.test(messageId)) throw new Error(failure)
    const result = await this.rest(signal, failure, () => this.#client.im.v1.message.patch({
      path: { message_id: messageId }, data: { content: JSON.stringify(card) },
    }))
    if (result?.code !== 0) throw new Error(failure)
  }
}
