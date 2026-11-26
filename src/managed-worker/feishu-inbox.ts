/** Route the owner's verified direct chat to document review, text tasks, or both in an explicit composition. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { FeishuState } from '../studio/protocol.ts'
import { documentContinuationIntent, type DocumentContinuationIntent } from './document-continuation-intent.ts'
import type { StudioFeishuSdk } from './feishu-sdk.ts'
import { feishuTextCommand, type FeishuTextRoute, type StudioFeishuText } from './feishu-text.ts'
import type { ManagedResult, ManagedTask, ManagedWorkerStore, StudioFeishuInstruction } from './store.ts'

const appId = /^cli_[a-fA-F0-9]{16}$/
const openId = /^ou_[a-zA-Z0-9]+$/
const chatId = /^oc_[a-zA-Z0-9]+$/
const messageId = /^om_[a-zA-Z0-9_-]+$/
const threadId = /^omt?_[a-zA-Z0-9_-]+$/
const MAX_TEXT = 32_000
const MAX_REPLIES = 4

// The SDK dispatcher exposes the v2 header and event fields together. Do not decode content before the scope check.
const liveMessage = z.object({
  app_id: z.string().regex(appId),
  sender: z.object({ sender_type: z.string(), sender_id: z.object({ open_id: z.string().regex(openId) }) }),
  message: z.object({
    message_id: z.string().regex(messageId), chat_id: z.string().regex(chatId), chat_type: z.string(),
    create_time: z.string().regex(/^\d{13}$/), message_type: z.string(), content: z.string().optional(),
    parent_id: z.string().optional(), root_id: z.string().optional(), thread_id: z.string().optional(),
  }),
})
const plainText = z.object({ text: z.string() })

function decodeText(content: string | undefined): string | undefined {
  if (content === undefined) return
  try {
    const body = plainText.safeParse(JSON.parse(content))
    if (body.success) return body.data.text
  } catch { /* Malformed content is not an instruction body. */ }
}

/** Return a brief status without document content, or undefined to leave a duplicate unanswered. */
type FeishuDocumentContinuation = (source: StudioFeishuInstruction, intent: DocumentContinuationIntent, signal: AbortSignal) => Promise<string | undefined>

/** A local capability for an already verified bot and its configured owner, not a freely routed transport. */
export interface StudioFeishuNoticeDestination {
  scope: string
  send(text: string, key: string): Promise<string | undefined>
}

export interface FeishuInboxConfig {
  appId: string
  botOpenId: string
  ownerOpenId: string
  chatId: string
}

const inboxFields = {
  appId: s.string().pattern(appId).required().description('Feishu self-built application ID; provide its App Secret in STUDIO_FEISHU_APP_SECRET at startup.'),
  botOpenId: s.string().pattern(openId).required(),
  ownerOpenId: s.string().pattern(openId).required(),
  chatId: s.string().pattern(chatId).required(),
}
export const FeishuDocumentInboxConfig: s<FeishuInboxConfig> = s.object(inboxFields)
export const FeishuTextInboxConfig: s<FeishuInboxConfig & FeishuTextRoute & { documentCorrections: boolean }> = s.object({
  ...inboxFields,
  cwd: s.string().required(),
  provider: s.string().required(),
  model: s.string().required(),
  reasoningEffort: s.string().default(''),
  documentCorrections: s.boolean().default(false).description('Also route ordinary messages to the one explicitly linked document task for review.'),
})

export function feishuSourceScope(config: FeishuInboxConfig): string {
  return JSON.stringify(['feishu', config.appId, config.botOpenId, config.chatId, config.ownerOpenId])
}

/** Fail before opening the Studio database if this optional transport is misconfigured. */
export function validateFeishuInbox(config: FeishuInboxConfig): void {
  if (!appId.test(config.appId) || !openId.test(config.botOpenId) || !openId.test(config.ownerOpenId)
    || !chatId.test(config.chatId) || config.botOpenId === config.ownerOpenId) {
    throw new Error('Studio Feishu requires an exact application, separate bot and owner identities, and a private chat ID')
  }
}

/** Own the private bot listener and its limited best-effort receipts, without starting the GitHub-backed Runtime. */
export class StudioFeishuInbox {
  private listening = false
  private state = 'waiting for the bot connection'
  connectionState: FeishuState = 'connecting'
  private readonly scope: string
  private readonly replies = new Set<Promise<void>>()
  private readonly continuations = new Set<Promise<void>>()
  private noticeChannel: { signal: AbortSignal } | undefined

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly sdk: StudioFeishuSdk,
    private readonly config: FeishuInboxConfig, private readonly allowed: () => boolean, private readonly text: StudioFeishuText | undefined,
    private readonly documentCorrections: boolean, private readonly onNoticeReady?: () => void,
    private readonly onDocumentContinuation?: FeishuDocumentContinuation, private readonly verificationMessage?: (value: unknown) => boolean) {
    this.scope = feishuSourceScope(config)
  }

  status(): string {
    const mode = this.text ? (this.documentCorrections ? 'text tasks and document review' : 'text tasks') : 'document review'
    return `Studio Feishu inbox: ${this.state}. Mode: ${mode}.`
  }

  /** Notices can go only to the configured private chat, never to a destination from incoming content. */
  noticeDestination(): StudioFeishuNoticeDestination | undefined {
    const channel = this.noticeChannel
    if (!channel || channel.signal.aborted || !this.allowed()) return
    return { scope: this.scope, send: async (text, key) => {
      if (this.noticeChannel !== channel || channel.signal.aborted || !this.allowed()) return
      return this.sdk.sendText(this.config.ownerOpenId, this.config.chatId, text, key, channel.signal)
    } }
  }

  /** The command authorizes one link, not a change to the task or permission to send another action. */
  bind(sessionId: string, commandId: string): ManagedResult<ManagedTask> {
    if (this.text && !this.documentCorrections) return { ok: false, reason: 'FEISHU_TEXT_MODE' }
    if (!this.listening || !this.allowed()) return { ok: false, reason: 'FEISHU_NOT_READY' }
    return this.store.linkFeishuDocument(sessionId, this.scope, commandId)
  }

  /** Reverify bot identity each time the consumer reconnects. No incoming event can select a bot, chat or task. */
  async run(signal: AbortSignal): Promise<void> {
    let retry: number | undefined
    while (!signal.aborted) {
      if (!this.allowed()) {
        this.state = 'waiting for the local owner Web host'
        this.connectionState = 'offline'
        await delay(1_000, undefined, { signal }).catch(() => {})
        continue
      }
      const began = Date.now()
      const connection = new AbortController()
      const active = AbortSignal.any([signal, connection.signal])
      try {
        this.state = 'checking bot identity'
        this.connectionState = 'connecting'
        const bot = await this.sdk.botOpenId(active)
        active.throwIfAborted()
        if (bot !== this.config.botOpenId) {
          this.state = 'the verified bot does not match the configured Feishu identity'
          this.connectionState = 'identity-mismatch'
          return
        }
        if (!this.allowed()) continue
        this.state = 'waiting for the bot connection'
        await this.sdk.listen(active, {
          ready: () => {
            if (active.aborted || !this.allowed()) return
            this.listening = true
            this.noticeChannel = { signal: active }
            this.state = 'listening for the configured private chat'
            this.connectionState = 'online'
            this.onNoticeReady?.()
          },
          problem: () => {
            this.listening = false
            this.noticeChannel = undefined
            this.state = 'the Feishu long connection is unavailable; will retry'
            this.ctx.logger.warn('Studio Feishu long connection is unavailable')
          },
          receive: value => this.receive(value, active),
        })
      } catch {
        if (!signal.aborted) {
          this.state = 'bot verification or connection failed; will retry'
          this.ctx.logger.warn('Studio Feishu could not verify or connect to the configured bot')
        }
      } finally {
        this.listening = false
        this.noticeChannel = undefined
        if (this.connectionState !== 'identity-mismatch') this.connectionState = 'offline'
        connection.abort()
        // An aborted connection cannot start more replies, but its continuation callbacks may still be settling.
        await Promise.all([...this.continuations, ...this.replies])
      }
      // A stable connection resets the delay; a failing endpoint must not be called in a tight loop.
      retry = retry === undefined || Date.now() - began >= 60_000 ? 1000 : Math.min(retry * 2, 60_000)
      await delay(retry, undefined, { signal }).catch(() => {})
    }
  }

  /** Record synchronously, before starting any outbound receipt or allowing the next event to run. */
  private receive(value: unknown, signal: AbortSignal): void {
    if (signal.aborted || !this.listening || !this.allowed() || this.verificationMessage?.(value)) return
    const event = liveMessage.safeParse(value)
    if (!event.success) return
    const { app_id: app, sender, message: data } = event.data
    const senderId = sender.sender_id.open_id
    if (app !== this.config.appId || data.chat_type !== 'p2p' || data.chat_id !== this.config.chatId
      || sender.sender_type !== 'user' || senderId !== this.config.ownerOpenId) return
    // Only original text is a command body. Keep non-text coordinates for manual document review, when enabled.
    const sourceTimeMs = Number(data.create_time)
    const content = data.message_type === 'text' ? decodeText(data.content) : undefined
    if (content === undefined && !this.documentCorrections) return
    const text = content !== undefined && content.length <= MAX_TEXT && content.isWellFormed() && !content.includes('\0') ? content : null
    const parentId = data.parent_id
    const source: StudioFeishuInstruction = { channel: 'feishu', sourceScope: this.scope,
      requestId: data.message_id, messageId: data.message_id, eventSeq: null, sourceTimeMs, text, senderId,
      ...(parentId && messageId.test(parentId) ? { parentId } : {}),
      ...(data.root_id && messageId.test(data.root_id) ? { rootId: data.root_id } : {}),
      ...(data.thread_id && threadId.test(data.thread_id) ? { threadId: data.thread_id } : {}),
    }
    if (this.documentCorrections && this.onDocumentContinuation && text !== null) {
      const intent = documentContinuationIntent(text)
      if (intent) {
        this.receiveDocumentContinuation(source, intent, signal, this.onDocumentContinuation)
        return
      }
    }
    // Classify the reserved namespace even if the original text is too large to retain. Never turn a malformed text command into a correction.
    const command = this.text && content !== undefined ? feishuTextCommand(content) : undefined
    if (this.text && (command || !this.documentCorrections)) {
      if (!command) {
        // Explicit commands check all prior routes in their claim transaction. Keep old continuations silent even without a command.
        const seen = this.store.feishuDocumentContinuationSeen(this.scope, source.requestId)
        if (!seen.ok) {
          this.ctx.logger.warn('Studio could not confirm the Feishu message route')
          return
        }
        if (seen.value) return
      }
      this.text.receive(source, command, (message, phase) => this.reply(data.message_id, message, signal, phase))
      return
    }
    const result = this.store.receiveFeishuInstruction(source)
    if (!result.ok) {
      this.ctx.logger.warn('Studio could not confirm a Feishu document input: %s', result.reason)
      this.reply(data.message_id, 'Studio could not confirm registration. Do not treat this message as an effective instruction; check the Web inbox and document status.', signal)
      return
    }
    const { disposition, late, taskId } = result.value
    if (disposition === 'duplicate') return
    if (disposition === 'unbound') {
      this.reply(data.message_id, 'Not registered: this chat is not linked to a document task. Link the intended task in Studio Web before sending a new instruction.', signal)
    } else if (disposition === 'finished') {
      this.reply(data.message_id, 'Not registered: the linked document has already been written. This message did not change the result or create work.', signal)
    } else {
      const ordering = late ? ' An older Feishu timestamp was detected; check the order before deciding.' : ''
      this.reply(data.message_id, `Received for task ${taskId}: document writes are held for review. This is not an effective change.${ordering} Open /studio-doc inbox in Studio Web.`, signal)
    }
  }

  /** Start the callback synchronously so it can claim the source before the next event; drain its completion on shutdown. */
  private receiveDocumentContinuation(source: StudioFeishuInstruction, intent: DocumentContinuationIntent,
    signal: AbortSignal, handle: FeishuDocumentContinuation): void {
    const target = source.messageId
    const pending = (async () => {
      try {
        const receipt = await handle(source, intent, signal)
        if (receipt !== undefined) this.reply(target, receipt, signal)
      } catch {
        this.reply(target, 'Studio could not confirm document continuation. Check the task status in Studio Web.', signal)
      }
    })().finally(() => { this.continuations.delete(pending) })
    this.continuations.add(pending)
  }

  /** Do not make a later instruction wait behind a notification. Drop surplus receipts, not their ledger records. */
  private reply(target: string, text: string, signal: AbortSignal, phase?: 'accepted' | 'final'): void {
    if (signal.aborted || !this.listening || !this.allowed() || this.replies.size >= MAX_REPLIES) return
    const hash = createHash('sha256').update(this.scope).update('\0').update(target)
    if (phase) hash.update('\0').update(phase)
    const key = hash.digest('hex').slice(0, 32)
    // Send plain text using the original message coordinate and keep the accepted/final idempotency keys separate.
    const pending = this.sdk.replyText(this.config.chatId, target, text, `studio-${key}`, signal)
      .catch(() => { if (!signal.aborted) this.ctx.logger.warn('Studio Feishu receipt was not confirmed; check the saved state in Studio Web') })
      .finally(() => { this.replies.delete(pending) })
    this.replies.add(pending)
  }
}
