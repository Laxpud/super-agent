/** Verify a bot and one exact private chat without adding test messages to history, dispatching or posting a reply. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { StudioFeishuSdk } from './feishu-sdk.ts'
import { StudioError } from './pending.ts'
import { sameBinding, type FeishuBinding, type FeishuCheck, type FeishuCheckResult } from './settings-protocol.ts'

const LIFETIME_MS = 120_000
const CHECK_PREFIX = '/studio-feishu-check '
const checkMessage = /^\/studio-feishu-check [0-9a-f-]{36}$/u
const source = z.object({ schema: z.literal('2.0'), event_type: z.literal('im.message.receive_v1'), app_id: z.string(),
  sender: z.object({ sender_type: z.literal('user'), sender_id: z.object({ open_id: z.string().max(256).regex(/^ou_[a-zA-Z0-9]+$/u) }) }),
  message: z.object({ message_type: z.literal('text'), chat_type: z.literal('p2p'), chat_id: z.string().max(256).regex(/^oc_[a-zA-Z0-9]+$/u),
    create_time: z.string().regex(/^\d{13}$/u), content: z.string().max(1024) }),
})
const body = z.object({ text: z.string() })
type CheckStart = Extract<FeishuCheck, { action: 'start' }>
interface Check {
  id: string
  phrase: string
  revision: string
  startedAt: number
  expiresAt: number
  expected: Omit<CheckStart, 'secret'>
  secret: string | undefined
  botOpenId?: string
  result: FeishuCheckResult
  stop: AbortController
  timer: ReturnType<typeof setTimeout>
}

/** 启动、观察、取消一条有限期的私聊验证，且不处理同一连接收到的业务请求。 */
export class StudioFeishuSetup {
  #current?: Check
  #listening?: Promise<void>

  /** Only the owner can start a challenge. An active same-app listener is reused instead of competing for Feishu events. */
  start({ secret: _secret, ...expected }: CheckStart, secret: string, reuseListener: boolean): FeishuCheckResult {
    if (this.#current) this.#end(this.#current, 'cancelled')
    if (this.#listening) throw new StudioError('FEISHU_CHECK_CLOSING', 'The previous verification connection is closing. Try again in a moment.', 409)
    const id = randomUUID()
    const phrase = `${CHECK_PREFIX}${randomUUID()}`
    const startedAt = Date.now()
    const expiresAt = startedAt + LIFETIME_MS
    const entry: Check = { id, phrase, revision: expected.revision, startedAt, expiresAt, expected, secret,
      result: { id, state: 'connecting', phrase, expiresAt }, stop: new AbortController(),
      timer: setTimeout(() => this.#end(entry, 'expired'), LIFETIME_MS).unref() }
    this.#current = entry
    const listening = this.#run(entry, secret, reuseListener).finally(() => {
      if (this.#listening === listening) this.#listening = undefined
    })
    this.#listening = listening
    return entry.result
  }

  async #run(entry: Check, secret: string, reuseListener: boolean) {
    const { signal } = entry.stop
    let stage: 'FEISHU_BOT_UNCONFIRMED' | 'FEISHU_CONNECTION_UNCONFIRMED' = 'FEISHU_BOT_UNCONFIRMED'
    const fail = (reason: Extract<FeishuCheckResult, { state: 'failed' }>['reason']) => {
      if (signal.aborted) return
      entry.secret = undefined
      entry.result = { id: entry.id, state: 'failed', reason }
      entry.stop.abort()
      clearTimeout(entry.timer)
    }
    try {
      const sdk = new StudioFeishuSdk(entry.expected.appId, secret)
      const bot = await sdk.botOpenId(signal)
      if (signal.aborted) return
      if (entry.expected.botOpenId && entry.expected.botOpenId !== bot) return fail('FEISHU_BOT_MISMATCH')
      entry.botOpenId = bot
      stage = 'FEISHU_CONNECTION_UNCONFIRMED'
      const waitForMessage = () => { entry.result = { id: entry.id, state: 'waiting', phrase: entry.phrase, expiresAt: entry.expiresAt } }
      if (reuseListener) waitForMessage()
      else await sdk.listen(signal, { ready: waitForMessage, receive: value => { this.receive(value) }, problem: () => fail(stage) })
    } catch { fail(stage) }
  }

  status(id: string, cancel: boolean): FeishuCheckResult {
    const entry = this.#current
    if (!entry || entry.id !== id) return { id, state: 'expired' }
    if (cancel) this.#end(entry, 'cancelled')
    return entry.result
  }

  #end(entry: Check, state: 'expired' | 'cancelled') {
    clearTimeout(entry.timer)
    entry.secret = undefined
    entry.result = { id: entry.id, state }
    entry.stop.abort()
  }

  /** Exact, unexpired evidence may be used only with the settings revision and private chat it verified. */
  checkedSecret(id: string, revision: string, binding: FeishuBinding): string {
    const entry = this.#current
    if (!entry || entry.id !== id || entry.revision !== revision || entry.result.state !== 'verified'
      || entry.expiresAt <= Date.now() || !sameBinding(binding, entry.result.binding) || !entry.secret) {
      throw new StudioError('FEISHU_VERIFICATION_REQUIRED', 'Verify the exact Feishu binding before saving.', 409)
    }
    return entry.secret
  }

  /** A reserved challenge never falls through to the normal channel, even if it was stale or did not match. */
  receive(value: unknown): boolean {
    const result = source.safeParse(value)
    if (!result.success) return false
    const event = result.data
    let text: string
    try { text = body.parse(JSON.parse(event.message.content)).text.trim() } catch { return false }
    if (!checkMessage.test(text)) return false
    const entry = this.#current
    if (!entry || entry.result.state !== 'waiting' || entry.stop.signal.aborted || entry.expiresAt <= Date.now()
      || text !== entry.phrase || !entry.botOpenId || entry.expected.appId !== event.app_id
      || Number(event.message.create_time) < entry.startedAt) return true
    const ownerOpenId = event.sender.sender_id.open_id
    const chatId = event.message.chat_id
    if (ownerOpenId === entry.botOpenId || (entry.expected.ownerOpenId && entry.expected.ownerOpenId !== ownerOpenId)
      || (entry.expected.chatId && entry.expected.chatId !== chatId)) return true
    entry.result = { id: entry.id, state: 'verified', expiresAt: entry.expiresAt,
      binding: { appId: event.app_id, botOpenId: entry.botOpenId, ownerOpenId, chatId } }
    // The short-lived socket is closed; the evidence is held only until deadline, cancellation, or Host remount.
    entry.stop.abort()
    return true
  }

  async stop(): Promise<void> {
    if (this.#current) this.#end(this.#current, 'cancelled')
    await this.#listening
  }
}
