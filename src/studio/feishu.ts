/** 在同一个已验证的机器人私聊中收发 Studio Assistant 消息与待办。 */
import { createHash } from 'node:crypto'
import { setImmediate as yieldToHost, setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { feishuSourceScope, validateFeishuInbox, type FeishuInboxConfig } from '../managed-worker/feishu-inbox.ts'
import type { StudioFeishuCardResponse, StudioFeishuSdk } from '../managed-worker/feishu-sdk.ts'
import { ASSISTANT_CONVERSATION, STUDIO_TEXT_LIMIT, type FeishuState, type StudioPending } from './protocol.ts'
import type { StudioFeishuDelivery, StudioFeishuInput } from './store.ts'
export type { StudioFeishuDelivery, StudioFeishuInput } from './store.ts'

const MAX_ACTIVE_INPUTS = 16
const MAX_CARD_CHOICES = 8
const HEALTH_POLL_MS = 1_000
const RETRY_MAX_MS = 60_000
const messageId = /^om_[a-zA-Z0-9_-]+$/
const threadId = /^omt?_[a-zA-Z0-9_-]+$/
const messageCoordinate = z.string().regex(messageId).or(z.literal('')).optional()

// Node SDK 1.76.0 将 V2 header 与 event 合并；保留应用和事件类型字段做精确校验。
const textEvent = z.object({
  schema: z.literal('2.0'), event_type: z.literal('im.message.receive_v1'), app_id: z.string(),
  sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string() }) }),
  message: z.object({
    message_id: z.string().regex(messageId), chat_id: z.string(), chat_type: z.literal('p2p'),
    create_time: z.string().regex(/^\d{13}$/), message_type: z.literal('text'),
    // 一个 UTF-16 单元最多占 6 个 JSON 转义字符；限制 JSON.parse 之前的输入大小。
    content: z.string().max(6 * STUDIO_TEXT_LIMIT + 1024),
    parent_id: messageCoordinate, root_id: messageCoordinate,
    thread_id: z.string().regex(threadId).or(z.literal('')).optional(),
  }),
})
const plainMessage = z.object({ text: z.string().max(STUDIO_TEXT_LIMIT) })
const callbackChoice = z.string().min(1).max(100).refine(value => !!value.trim() && value.isWellFormed() && !value.includes('\0'))
const cardEvent = z.object({
  schema: z.literal('2.0'), event_type: z.literal('card.action.trigger'), app_id: z.string(),
  operator: z.object({ open_id: z.string() }),
  // 卡片 V2 的坐标在 context 内；不使用旧版顶层别名，也不从按钮值读取坐标。
  context: z.object({ open_message_id: z.string().regex(messageId), open_chat_id: z.string() }),
  action: z.object({ tag: z.literal('button'), value: z.object({
    studio: z.literal('pending-answer'), appId: z.string(), pendingId: z.string().min(1).max(128), value: callbackChoice,
  }) }),
})

export interface StudioFeishuPort {
  /** 启用已验证的绑定，返回持久化的毫秒时间分界；重连不得改变同一绑定的分界。 */
  activate(scope: string, now: number): number
  /** 登记源消息并处理话题归属；只有直接关联到原卡片的文字回复可回答待办。 */
  receive(source: StudioFeishuInput, signal: AbortSignal): Promise<void>
  /** 同步核对已保存的卡片、有效待办与当前授权，在返回 true 前保存处理结果。 */
  answer(input: { scope: string; messageId: string; pendingId: string; value: string }): boolean
  /** 返回并持久认领下一条可见投递。未确认的认领不能再次被取出。 */
  next(scope: string): StudioFeishuDelivery | undefined
  /** 保存已验证的消息 ID；缺少 ID 表示未确认，不安排重发。 */
  finish(id: string, remoteId?: string): void
}

/** 保留原始纯文本，独立保存坐标；不尝试把无效回复重新解释为主时间线消息。 */
function readTextEvent(raw: unknown, config: FeishuInboxConfig, scope: string, cutover: number): StudioFeishuInput | undefined {
  const event = textEvent.safeParse(raw)
  if (!event.success) return
  const { app_id, sender, message } = event.data
  const sourceTimeMs = Number(message.create_time)
  if (app_id !== config.appId || sender.sender_id.open_id !== config.ownerOpenId || message.chat_id !== config.chatId
    || sourceTimeMs <= cutover) return
  try {
    const body = plainMessage.safeParse(JSON.parse(message.content))
    if (!body.success) return
    const { text } = body.data
    if (!text.trim() || !text.isWellFormed() || text.includes('\0')) return
    return { scope, id: message.message_id, sourceTimeMs, text,
      ...(message.parent_id ? { parentId: message.parent_id } : {}),
      ...(message.root_id ? { rootId: message.root_id } : {}),
      ...(message.thread_id ? { threadId: message.thread_id } : {}),
    }
  } catch { /* 格式错误的消息体不构成指令。 */ }
}

const plain = (content: string) => ({ tag: 'plain_text', content })
const block = (content: string) => ({ tag: 'div', text: plain(content) })

/** 限制通知的显示长度；用码点而非字节截断，不拆开代理对。 */
function excerpt(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length <= limit ? text : `${characters.slice(0, limit).join('')}…`
}

/** 卡片只使用事项摘要；自由文本不作为 Markdown，交互控件保留全部原始选项或完全不展示。 */
function renderPending(pending: StudioPending, appId: string): object {
  const choices = pending.state === 'pending' && pending.mobile === 'card'
    && pending.options.length <= MAX_CARD_CHOICES && pending.options.every(choice => callbackChoice.safeParse(choice).success)
    ? pending.options : []
  const textReply = pending.state === 'pending' && pending.mobile === 'topic' && pending.kind === 'question' && pending.acceptsText
  const context = pending.conversationId === ASSISTANT_CONVERSATION ? 'Assistant 对话' : `项目对话：${excerpt(pending.conversationId, 120)}`
  const who = `发起人：${excerpt(pending.requester, 120)}`
  const where = pending.taskId ? `${context}\n任务：${excerpt(pending.taskId, 120)}` : context
  const status = pending.state === 'expired' ? '已失效' : pending.state === 'resolved' ? '已处理'
    : choices.length || textReply ? '待你处理' : '仍待确认'
  const resolution = pending.state === 'resolved'
    ? `${status}${pending.answeredBy ? ` · 来自 ${pending.answeredBy === 'gui' ? 'GUI' : '飞书'}` : ''}`
      + (pending.answer ? `\n答复：${excerpt(pending.answer, 800)}` : '')
    : pending.state === 'expired' ? '此事项已失效，不能再处理。'
      : textReply ? '请在话题里直接回复这张卡片，Studio 才能将文字登记到此问题。'
        : choices.length ? '请选择明确的答复。' : '仍待确认：此事项不支持在飞书处理，请在 Studio 查看。'
  return {
    schema: '2.0', config: { update_multi: true, enable_forward: false },
    header: {
      title: plain(excerpt(pending.title || '待我处理', 100)), subtitle: plain(status),
      template: pending.state === 'resolved' ? 'green' : pending.state === 'expired' ? 'grey' : 'blue',
      icon: { tag: 'standard_icon', token: 'todo_colorful' },
    },
    body: { direction: 'vertical', vertical_spacing: 'medium', elements: [
      { tag: 'column_set', background_style: 'grey-50', columns: [
        { tag: 'column', width: 'weighted', weight: 1, padding: '8px', elements: [block(where), block(who)] },
      ] },
      ...(pending.detail ? [block(excerpt(pending.detail, 2_000))] : []),
      block(resolution),
      ...choices.map((value, index) => ({
        tag: 'button', text: plain(value), type: index === 0 ? 'primary_filled' : 'default', width: 'fill',
        behaviors: [{ type: 'callback', value: { studio: 'pending-answer', appId, pendingId: pending.id, value } }],
      })),
    ] },
  }
}

/** 为一个已配置的所有者私聊管理长连接；输入和投递结果均由宿主账本登记。 */
export class StudioFeishuConversation {
  readonly scope: string
  private readonly config: FeishuInboxConfig
  private status: FeishuState = 'connecting'
  private running = false
  private wakeDelivery: (() => void) | undefined

  constructor(private readonly sdk: StudioFeishuSdk, config: FeishuInboxConfig, private readonly port: StudioFeishuPort,
    private readonly ready: () => boolean, private readonly warn: (message: string) => void) {
    validateFeishuInbox(config)
    this.config = { ...config }
    this.scope = feishuSourceScope(this.config)
  }

  get state(): FeishuState { return this.status }

  /** 仅唤醒等待中的投递循环；离线积压继续由持久队列保管。 */
  wake(): void { this.wakeDelivery?.() }

  /** 每次重连先验证机器人身份。断开或停止后，不接收新输入，等本次工作全部退出。 */
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('Studio Feishu conversation is already running')
    this.running = true
    let backoff = 0
    try {
      while (!signal.aborted) {
        if (!this.ready()) {
          this.status = 'offline'
          await delay(HEALTH_POLL_MS, undefined, { signal }).catch(() => {})
          continue
        }
        const started = Date.now()
        const connection = new AbortController()
        const active = AbortSignal.any([signal, connection.signal])
        const inputs = new Set<Promise<void>>()
        let cutover: number | undefined
        let delivery: Promise<void> | undefined
        try {
          this.status = 'connecting'
          const bot = await this.sdk.botOpenId(active)
          if (active.aborted) break
          if (bot !== this.config.botOpenId) {
            this.status = 'identity-mismatch'
            return
          }
          if (!this.ready()) continue
          await this.sdk.listen(active, {
            ready: () => {
              if (active.aborted || cutover !== undefined) return
              if (!this.ready()) { connection.abort(); return }
              try {
                const bindingTime = this.port.activate(this.scope, Date.now())
                if (!Number.isSafeInteger(bindingTime) || bindingTime < 0) throw new Error('Invalid Feishu binding time')
                cutover = bindingTime
                this.status = 'online'
                delivery = this.deliver(active, connection).catch(() => {
                  if (!active.aborted) this.warn('Studio Feishu could not confirm the delivery queue')
                  connection.abort()
                })
              } catch {
                this.warn('Studio Feishu could not activate the owner binding')
                connection.abort()
              }
            },
            problem: () => {
              if (active.aborted) return
              this.status = 'offline'
              connection.abort()
              this.warn('Studio Feishu long connection is unavailable')
            },
            receive: raw => {
              if (cutover !== undefined && !active.aborted && this.ready()) this.receive(raw, cutover, active, inputs)
            },
            card: raw => cutover !== undefined && !active.aborted && this.ready() ? this.answer(raw) : undefined,
          })
        } catch {
          if (!active.aborted) this.warn('Studio Feishu could not verify or connect to the configured bot')
        } finally {
          connection.abort()
          if (this.status !== 'identity-mismatch') this.status = 'offline'
          await Promise.all([delivery, ...inputs])
        }
        if (signal.aborted) break
        // 只重连，不重发未确认写入；短时间故障使用有上限的退避。
        backoff = Date.now() - started >= RETRY_MAX_MS ? HEALTH_POLL_MS
          : Math.min(Math.max(HEALTH_POLL_MS, backoff * 2), RETRY_MAX_MS)
        await delay(backoff, undefined, { signal }).catch(() => {})
      }
    } finally {
      this.running = false
      if (this.status !== 'identity-mismatch') this.status = 'offline'
    }
  }

  private receive(raw: unknown, cutover: number, signal: AbortSignal, inputs: Set<Promise<void>>): void {
    const source = readTextEvent(raw, this.config, this.scope, cutover)
    if (!source) return
    if (inputs.size >= MAX_ACTIVE_INPUTS) {
      // 尚未登记，不发送成功回执；SDK 将处理器失败应答给飞书。
      this.warn('Studio Feishu input capacity was reached')
      throw new Error('Studio Feishu input capacity was reached')
    }
    const handle = (async () => {
      try { await this.port.receive(source, signal) }
      catch { if (!signal.aborted) this.warn('Studio Feishu input registration was not confirmed') }
      finally { this.wake() }
    })().finally(() => { inputs.delete(handle) })
    inputs.add(handle)
  }

  /** 在长连接的应答时限内只做本地核对和登记；更新原卡片由持久队列接续。 */
  private answer(raw: unknown): StudioFeishuCardResponse | undefined {
    const event = cardEvent.safeParse(raw)
    if (!event.success) return
    const { app_id, operator, context, action: { value } } = event.data
    if (app_id !== this.config.appId || value.appId !== this.config.appId || operator.open_id !== this.config.ownerOpenId
      || context.open_chat_id !== this.config.chatId) return
    try {
      if (this.port.answer({ scope: this.scope, messageId: context.open_message_id, pendingId: value.pendingId, value: value.value })) {
        this.wake()
        return { toast: { type: 'success', content: '已记录答复。' } }
      }
    } catch { this.warn('Studio Feishu card answer was not confirmed') }
    return { toast: { type: 'warning', content: '未确认此答复。请在 Studio 查看当前状态。' } }
  }

  /** 单条认领、投递并确认，避免后续回复/更新抢在原消息的回执之前。 */
  private async deliver(signal: AbortSignal, connection: AbortController): Promise<void> {
    while (!signal.aborted) {
      if (!this.ready()) { connection.abort(); return }
      const delivery = this.port.next(this.scope)
      if (!delivery) {
        const wake = new AbortController()
        this.wakeDelivery = () => wake.abort()
        try { await delay(HEALTH_POLL_MS, undefined, { signal: AbortSignal.any([signal, wake.signal]) }).catch(() => {}) }
        finally { this.wakeDelivery = undefined }
        continue
      }
      let receipt: string | undefined
      try {
        if (!signal.aborted && this.ready()) receipt = await this.send(delivery, signal)
      } catch { /* 远端写入可能已生效；保留未确认状态，不换地址、降级或重发。 */ }
      if (receipt) this.port.finish(delivery.id, receipt)
      else {
        this.port.finish(delivery.id)
        if (!signal.aborted) this.warn('Studio Feishu delivery was not confirmed; check Studio')
      }
      // 即使 SDK 或存储立即返回，也要让连接回调和取消信号获得执行机会。
      await yieldToHost(undefined, { signal }).catch(() => {})
    }
  }

  private async send(delivery: StudioFeishuDelivery, signal: AbortSignal): Promise<string | undefined> {
    const { appId, ownerOpenId, chatId } = this.config
    const { id, parentId, cardMessageId, pending } = delivery
    const key = `studio-${createHash('sha256').update(this.scope).update('\0').update(id).digest('hex').slice(0, 32)}`
    if (delivery.kind === 'message') {
      if (delivery.text === undefined) return
      const label = delivery.channel === 'gui' ? '你 · 来自 GUI' : 'Assistant'
      const text = `${label}\n${delivery.text}`
      if (parentId === undefined) return this.sdk.sendText(ownerOpenId, chatId, text, key, signal)
      // Match the Studio timeline: a plain turn replies in the conversation, an explicit topic replies in its thread.
      return delivery.inThread === false ? this.sdk.replyTextReceipt(chatId, parentId, text, key, signal, false)
        : this.sdk.replyTextReceipt(chatId, parentId, text, key, signal)
    }
    if (!pending) return
    const card = renderPending(pending, appId)
    if (delivery.kind === 'pending-update') {
      if (!cardMessageId) return
      await this.sdk.patchCard(cardMessageId, card, signal)
      return cardMessageId
    }
    return parentId !== undefined ? this.sdk.replyCard(chatId, parentId, card, key, signal)
      : this.sdk.sendCard(ownerOpenId, chatId, card, key, signal)
  }
}
