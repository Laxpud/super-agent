/** Route the owner's verified direct chat to document review, text tasks, or both in an explicit composition. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { resolveFeishuBot, type FeishuBot } from '../deployment.ts'
import { consumeFeishuEvents, consumerRetry } from '../sources/feishu-events.ts'
import { FeishuEventSchema } from '../sources/feishu-trigger.ts'
import { documentContinuationIntent, type DocumentContinuationIntent } from './document-continuation-intent.ts'
import { feishuTextCommand, type FeishuTextRoute, type StudioFeishuText } from './feishu-text.ts'
import type { ManagedResult, ManagedTask, ManagedWorkerStore, StudioFeishuInstruction } from './store.ts'

const appId = /^cli_[a-zA-Z0-9]+$/
const openId = /^ou_[a-zA-Z0-9]+$/
const chatId = /^oc_[a-zA-Z0-9]+$/
const messageId = /^om_[a-zA-Z0-9_-]+$/
const threadId = /^omt?_[a-zA-Z0-9_-]+$/
const MAX_TEXT = 32_000
const MAX_REPLIES = 4
const exec = promisify(execFile)
const noticeReceipt = z.object({ ok: z.literal(true), data: z.object({
  message_id: z.string().regex(messageId), chat_id: z.string().regex(chatId),
}) })

/** Return a brief status without document content, or undefined to leave a duplicate unanswered. */
type FeishuDocumentContinuation = (source: StudioFeishuInstruction, intent: DocumentContinuationIntent, signal: AbortSignal) => Promise<string | undefined>

/** A local capability for an already verified bot and its configured owner, not a freely routed transport. */
export interface StudioFeishuNoticeDestination {
  scope: string
  send(text: string, key: string): Promise<string | undefined>
}

export interface FeishuInboxConfig {
  cli: string
  appId: string
  botOpenId: string
  ownerOpenId: string
  chatId: string
}

const inboxFields = {
  cli: s.string().required().description('Absolute path to a trusted lark-cli executable restricted to the bot identity.'),
  appId: s.string().pattern(appId).required(),
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
  if (!isAbsolute(config.cli) || config.cli.includes('\0') || config.botOpenId === config.ownerOpenId) {
    throw new Error('Studio Feishu requires an absolute CLI path and a separate owner identity')
  }
}

async function runCli(file: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await exec(file, args, { signal, timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  return stdout
}

/** Own the private bot listener and its limited best-effort receipts, without starting the GitHub-backed Runtime. */
export class StudioFeishuInbox {
  private listening = false
  private state = 'waiting for the bot connection'
  private readonly scope: string
  private readonly replies = new Set<Promise<void>>()
  private readonly continuations = new Set<Promise<void>>()
  private noticeChannel: { bot: FeishuBot; signal: AbortSignal } | undefined

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore, private readonly stateDir: string,
    private readonly config: FeishuInboxConfig, private readonly allowed: () => boolean, private readonly text: StudioFeishuText | undefined,
    private readonly documentCorrections: boolean, private readonly onNoticeReady?: () => void,
    private readonly onDocumentContinuation?: FeishuDocumentContinuation) {
    this.scope = feishuSourceScope(config)
  }

  status(): string {
    const mode = this.text ? (this.documentCorrections ? 'text tasks and document review' : 'text tasks') : 'document review'
    return `Studio Feishu inbox: ${this.state}. Mode: ${mode}.`
  }

  /** Notices are DM-only, use the configured owner's open_id, and cannot inherit a recipient from the inbox. */
  noticeDestination(): StudioFeishuNoticeDestination | undefined {
    const channel = this.noticeChannel
    if (!channel || channel.signal.aborted || !this.allowed()) return
    return { scope: this.scope, send: async (text, key) => {
      if (this.noticeChannel !== channel || channel.signal.aborted || !this.allowed()) return
      const output = await runCli(channel.bot.cli, ['im', '+messages-send', '--user-id', this.config.ownerOpenId,
        '--text', text, '--idempotency-key', key, '--as', 'bot', '--format', 'json'], channel.signal)
      const result = noticeReceipt.safeParse(JSON.parse(output))
      if (result.success && result.data.data.chat_id === this.config.chatId) return result.data.data.message_id
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
        await delay(1_000, undefined, { signal }).catch(() => {})
        continue
      }
      const began = Date.now()
      const connection = new AbortController()
      const active = AbortSignal.any([signal, connection.signal])
      try {
        this.state = 'checking bot identity'
        const bot = await resolveFeishuBot({ stateDir: this.stateDir }, { cli: this.config.cli }, ([file, ...args]) => runCli(file!, args, active))
        active.throwIfAborted()
        if (!bot || bot.brand !== 'feishu' || bot.appId !== this.config.appId || bot.botId !== this.config.botOpenId) {
          this.state = 'the verified bot does not match the configured Feishu identity'
          return
        }
        if (!this.allowed()) continue
        this.state = 'waiting for the bot connection'
        await consumeFeishuEvents(bot.cli, active, {
          ready: () => {
            this.listening = true
            this.noticeChannel = { bot, signal: active }
            this.state = 'listening for the configured private chat'
            this.onNoticeReady?.()
          },
          problem: () => {
            this.noticeChannel = undefined
            this.state = 'the bot listener reported a problem'
            this.ctx.logger.warn('Studio Feishu listener reported a problem')
          },
          receive: value => this.receive(bot, value, active),
        })
      } catch {
        if (!signal.aborted) {
          this.state = 'bot verification or connection failed; will retry'
          this.ctx.logger.warn('Studio Feishu could not verify or connect to the configured bot')
        }
      } finally {
        this.listening = false
        this.noticeChannel = undefined
        connection.abort()
        // An aborted connection cannot start more replies, but its continuation callbacks may still be settling.
        await Promise.all([...this.continuations, ...this.replies])
      }
      retry = consumerRetry(retry, Date.now() - began)
      await delay(retry, undefined, { signal }).catch(() => {})
    }
  }

  /** Record synchronously, before starting any outbound receipt or allowing the next event to run. */
  private receive(bot: FeishuBot, value: unknown, signal: AbortSignal): void {
    if (signal.aborted || !this.allowed()) return
    const event = FeishuEventSchema.safeParse(value)
    if (!event.success) throw new Error('Unrecognized Feishu message event')
    const data = event.data
    if (data.chat_type !== 'p2p' || data.chat_id !== this.config.chatId || data.sender_type !== 'user' || data.sender_id !== this.config.ownerOpenId) return
    // Accept only millisecond timestamps from the live CLI stream, not local-time history values.
    const sourceTimeMs = Number(data.create_time)
    if (!messageId.test(data.message_id) || !/^\d{13}$/.test(data.create_time) || !Number.isSafeInteger(sourceTimeMs)) {
      throw new Error('Invalid Feishu source coordinates')
    }
    const text = data.content.length <= MAX_TEXT && data.content.isWellFormed() && !data.content.includes('\0') ? data.content : null
    const source: StudioFeishuInstruction = { channel: 'feishu', sourceScope: this.scope,
      requestId: data.message_id, messageId: data.message_id, eventSeq: null, sourceTimeMs, text, senderId: data.sender_id,
      ...(data.parent_id && messageId.test(data.parent_id) ? { parentId: data.parent_id } : {}),
      ...(data.root_id && messageId.test(data.root_id) ? { rootId: data.root_id } : {}),
      ...(data.thread_id && threadId.test(data.thread_id) ? { threadId: data.thread_id } : {}),
    }
    if (this.documentCorrections && this.onDocumentContinuation && text !== null) {
      const intent = documentContinuationIntent(text)
      if (intent) {
        this.receiveDocumentContinuation(bot, source, intent, signal, this.onDocumentContinuation)
        return
      }
    }
    // Classify the reserved namespace even if the body is too large to retain. Never turn a malformed command into a correction.
    const command = this.text ? feishuTextCommand(data.content) : undefined
    if (this.text && (command || !this.documentCorrections)) {
      if (!this.documentCorrections) {
        // Standalone text skips the combined route claim. A continuation from a previous configuration must stay claimed.
        const seen = this.store.feishuDocumentContinuationSeen(this.scope, source.requestId)
        if (!seen.ok) {
          this.ctx.logger.warn('Studio could not confirm the Feishu message route')
          return
        }
        if (seen.value) return
      }
      this.text.receive(source, command, (message, phase) => this.reply(bot, data.message_id, message, signal, phase))
      return
    }
    const result = this.store.receiveFeishuInstruction(source)
    if (!result.ok) {
      this.ctx.logger.warn('Studio could not confirm a Feishu document input: %s', result.reason)
      this.reply(bot, data.message_id, 'Studio could not confirm registration. Do not treat this message as an effective instruction; check the Web inbox and document status.', signal)
      return
    }
    const { disposition, late, taskId } = result.value
    if (disposition === 'duplicate') return
    if (disposition === 'unbound') {
      this.reply(bot, data.message_id, 'Not registered: this chat is not linked to a document task. Link the intended task in Studio Web before sending a new instruction.', signal)
    } else if (disposition === 'finished') {
      this.reply(bot, data.message_id, 'Not registered: the linked document has already been written. This message did not change the result or create work.', signal)
    } else {
      const ordering = late ? ' An older Feishu timestamp was detected; check the order before deciding.' : ''
      this.reply(bot, data.message_id, `Received for task ${taskId}: document writes are held for review. This is not an effective change.${ordering} Open /studio-doc inbox in Studio Web.`, signal)
    }
  }

  /** Start the callback synchronously so it can claim the source before the next event; drain its completion on shutdown. */
  private receiveDocumentContinuation(bot: FeishuBot, source: StudioFeishuInstruction, intent: DocumentContinuationIntent,
    signal: AbortSignal, handle: FeishuDocumentContinuation): void {
    const target = source.messageId
    const pending = (async () => {
      try {
        const receipt = await handle(source, intent, signal)
        if (receipt !== undefined) this.reply(bot, target, receipt, signal)
      } catch {
        this.reply(bot, target, 'Studio could not confirm document continuation. Check the task status in Studio Web.', signal)
      }
    })().finally(() => { this.continuations.delete(pending) })
    this.continuations.add(pending)
  }

  /** Do not make a later instruction wait behind a notification. Drop surplus receipts, not their ledger records. */
  private reply(bot: FeishuBot, target: string, text: string, signal: AbortSignal, phase?: 'accepted' | 'final'): void {
    if (signal.aborted || !this.allowed() || this.replies.size >= MAX_REPLIES) return
    const hash = createHash('sha256').update(this.scope).update('\0').update(target)
    if (phase) hash.update('\0').update(phase)
    const key = hash.digest('hex').slice(0, 32)
    // Plain text preserves the worker's output and cannot make the CLI fetch a Markdown image URL.
    const pending = runCli(bot.cli, ['im', '+messages-reply', '--message-id', target, '--text', text,
      '--reply-in-thread', '--idempotency-key', `studio-${key}`, '--as', 'bot', '--format', 'json'], signal).then(output => {
      if (!z.object({ ok: z.literal(true) }).safeParse(JSON.parse(output)).success) throw new Error('Feishu reply was not confirmed')
    }).catch(() => { if (!signal.aborted) this.ctx.logger.warn('Studio Feishu receipt was not confirmed; consult the Web inbox') })
      .finally(() => { this.replies.delete(pending) })
    this.replies.add(pending)
  }
}
