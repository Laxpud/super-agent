/** One human decision across channels. Only a still-live caller can consume a confirmation. */
import { randomUUID } from 'node:crypto'
import type { StudioMessage, StudioPending } from './protocol.ts'
import type { StudioStore } from './store.ts'

export const ASK_STUDIO_OWNER = 'studio_ask_owner'

/** A bounded, owner-visible Studio failure that may cross the HTTP boundary. */
export class StudioError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

export interface StudioQuestion {
  title: string
  detail: string
  options: string[]
  acceptsText: boolean
  mobile: StudioPending['mobile']
  kind: 'question' | 'confirmation'
  taskId?: string
}

interface LiveQuestion {
  signal: AbortSignal
  current(): boolean
  accept(value: string): void
  expire(): void
}

/** Persist the question once and deliver a matching human answer to its exact live waiter. */
export class StudioPendingBroker {
  private readonly live = new Map<string, LiveQuestion>()

  constructor(private readonly store: StudioStore, private readonly wake: () => void) {}

  /** Start a bounded question. An abort expires the saved item, but cannot turn into an affirmative answer. */
  ask(message: StudioMessage, requester: string, fields: StudioQuestion, signal: AbortSignal, current: () => boolean): Promise<string> {
    signal.throwIfAborted()
    const id = randomUUID()
    const { kind, title, detail, options, acceptsText, mobile, taskId } = fields
    const item: StudioPending = { id, kind, conversationId: message.conversationId, topicId: message.topicId ?? message.id,
      messageId: message.id, requester, title, detail, options, acceptsText, mobile, state: 'pending', createdAt: Date.now(),
      ...(taskId === undefined ? {} : { taskId }) }
    const result = Promise.withResolvers<string>()
    const expire = () => {
      if (!this.live.delete(id)) return
      try { this.store.settlePending(id, 'expired'); this.wake() }
      catch { /* The next Host run expires any undecided ephemeral question before serving requests. */ }
      finally { result.reject(new StudioError('QUESTION_EXPIRED', 'This question is no longer waiting for an answer.', 409)) }
    }
    this.store.addPending(item)
    this.live.set(id, { signal, current, accept: result.resolve, expire })
    signal.addEventListener('abort', expire, { once: true })
    this.wake()
    return result.promise.finally(() => { signal.removeEventListener('abort', expire); this.live.delete(id) })
  }

  /** A scoped card answer is distinct from a text supplement. Approval only accepts an offered button value. */
  answer(id: string, value: string, channel: 'gui' | 'feishu', via: 'card' | 'topic' | 'gui'): StudioPending {
    const item = this.store.pendingItem(id)
    if (!item) throw new StudioError('PENDING_NOT_FOUND', 'Pending item not found.', 404)
    const live = this.live.get(id)
    if (item.state !== 'pending' || !live || live.signal.aborted || !live.current()) {
      live?.expire()
      throw new StudioError('QUESTION_EXPIRED', 'This item has already been handled or is no longer waiting.', 409)
    }
    if (channel === 'feishu' && (via === 'gui' || via !== item.mobile)) {
      throw new StudioError('MOBILE_UNSUPPORTED', 'This item still needs confirmation in Studio.', 409)
    }
    const text = value.trim()
    if (!item.options.includes(value) && (!item.acceptsText || !text || text.length > 4_000
      || !text.isWellFormed() || text.includes('\0'))) {
      throw new StudioError('INVALID_ANSWER', 'Choose an offered answer or enter a supported text reply.')
    }
    const answer = item.options.includes(value) ? value : text
    // No await between authority check, state transition and delivery to the exact waiter.
    const settled = this.store.settlePending(id, 'resolved', answer, channel)
    if (!settled) throw new StudioError('QUESTION_EXPIRED', 'This item has already been handled.', 409)
    this.live.delete(id)
    live.accept(answer)
    this.wake()
    return settled
  }

  expireAll(): void { for (const question of this.live.values()) question.expire() }
}
