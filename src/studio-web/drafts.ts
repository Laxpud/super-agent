/** 每条对话、每个话题各自保留草稿；发送结果只更新原来的草稿。 */
import { STUDIO_TEXT_LIMIT, type StudioMessage, type StudioSend } from '../studio/protocol.ts'
import type { StudioCall } from './api.ts'

export interface Address { conversationId: string; topicId?: string }
interface Reference { id: string; text: string }
interface Draft {
  text: string
  quote?: Reference
  reply?: Reference
  sending?: boolean
  failure?: unknown
  attempt?: StudioSend
  version: number
}
const empty: Draft = { text: '', version: 0 }

export const addressKey = ({ conversationId, topicId }: Address) => JSON.stringify([conversationId, topicId ?? null])
export function snippet(text: string, length = 180) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized
}
export const reference = (message: StudioMessage): Reference => ({ id: message.id, text: snippet(message.text) })

export type Drafts = ReturnType<typeof createDrafts>
export function createDrafts() {
  const drafts = new Map<string, Draft>()
  const listeners = new Set<() => void>()
  let focusRequest: string | undefined
  const get = (address: Address): Draft => drafts.get(addressKey(address)) ?? empty
  const write = (address: Address, value: Draft) => {
    const key = addressKey(address)
    if (value === empty) drafts.delete(key)
    else drafts.set(key, value)
    for (const listener of listeners) listener()
  }
  const edit = (address: Address, patch: Partial<Pick<Draft, 'text' | 'quote' | 'reply'>>, focus = false) => {
    const previous = get(address)
    if (focus) focusRequest = addressKey(address)
    write(address, { ...previous, ...patch, failure: undefined, version: previous.version + 1 })
  }
  return {
    get, edit,
    // 引用/回复会要求聚焦目标输入框，但重新打开已有草稿不会再次弹出输入焦点。
    consumeFocus(address: Address): boolean {
      if (focusRequest !== addressKey(address)) return false
      focusRequest = undefined
      return true
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async send(address: Address, call: StudioCall): Promise<boolean> {
      const draft = get(address)
      // 保留换行、缩进等原文；只用 trim 判断内容是否为空。
      const text = draft.text
      if (draft.sending || !text.trim() || text.length > STUDIO_TEXT_LIMIT) return false
      const replyTo = draft.reply?.id ?? address.topicId
      const quoteId = draft.quote?.id
      // 同一草稿重试时沿用幂等键；请求可能写入后才丢失 HTTP 回执。
      const reuse = draft.attempt?.text === text && draft.attempt.replyTo === replyTo && draft.attempt.quoteId === quoteId
      const input: StudioSend = { conversationId: address.conversationId, requestId: reuse ? draft.attempt!.requestId : newRequestId(),
        text, replyTo, quoteId }
      write(address, { ...draft, sending: true, failure: undefined, attempt: input })
      try {
        await call('send', input)
        const current = get(address)
        // 用户可以在同一话题继续编辑，也可以切走。成功仅清空本次实际发送的内容。
        write(address, current.version === draft.version ? empty : { ...current, sending: false, attempt: undefined })
        return true
      } catch (failure) {
        write(address, { ...get(address), sending: false, failure })
        return false
      }
    },
  }
}

/** LAN 的 HTTP 页面不一定有 randomUUID；getRandomValues 在两种入口均可用。 */
function newRequestId(): string {
  const random = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
}
