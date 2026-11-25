/** 浏览器只调用同源 Studio API；会话身份由宿主 Cookie 验证。 */
import { STUDIO_API, STUDIO_HEADER, type StudioInput, type StudioOp, type StudioResult } from '../studio/protocol.ts'
import type { T } from './locales.ts'

export type StudioCall = <K extends StudioOp>(op: K, input: StudioInput<K>, signal?: AbortSignal) => Promise<StudioResult<K>>

type Failure = 'network' | 'timeout' | 'badResponse' | 'requestFailed' | 'unavailable'

/** 保留请求失败的类别、HTTP 状态和已知业务原因，供界面给出对应反馈；未收到响应时状态是 0。 */
export class StudioApiError extends Error {
  constructor(readonly kind: Failure, readonly status: number, readonly detail?: string, readonly code?: string) {
    super(detail ?? kind)
  }
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string'
const whole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const choice = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value)
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const items = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value) && value.every(check)
const source = (value: unknown) => object(value) && text(value.sessionId) && whole(value.eventSeq)
const model = (value: unknown) => object(value) && text(value.provider) && text(value.model) && optional(value.reasoningEffort, text)
const settings = (value: unknown) => object(value) && whole(value.revision)
  && (value.assistant === null || model(value.assistant)) && (value.leader === null || model(value.leader))
const session = (value: unknown) => object(value) && text(value.id) && text(value.conversationId) && whole(value.createdAt)
  && choice(value.role, ['assistant', 'leader', 'document-worker', 'draft-worker', 'advisor', 'subagent'])
const pending = (value: unknown) => object(value) && [value.id, value.conversationId, value.title, value.detail, value.requester].every(text)
  && [value.messageId, value.topicId, value.taskId, value.recordSessionId, value.answer].every(field => optional(field, text))
  && whole(value.createdAt) && typeof value.acceptsText === 'boolean' && items(value.options, text)
  && choice(value.kind, ['confirmation', 'question', 'blocked']) && choice(value.mobile, ['card', 'topic', 'unsupported'])
  && choice(value.state, ['pending', 'resolved', 'expired']) && optional(value.answeredBy, field => choice(field, ['gui', 'feishu']))
const message = (value: unknown) => object(value) && [value.id, value.conversationId, value.text].every(text)
  && [value.topicId, value.replyTo, value.error].every(field => optional(field, text)) && whole(value.createdAt) && whole(value.replyCount)
  && choice(value.role, ['user', 'assistant', 'leader']) && choice(value.channel, ['gui', 'feishu', 'studio'])
  && optional(value.status, field => choice(field, ['queued', 'running', 'completed', 'failed', 'interrupted']))
  && optional(value.feishuDelivery, field => choice(field, ['pending', 'sent', 'unconfirmed'])) && optional(value.source, source)
  && optional(value.quote, quote => object(quote) && text(quote.messageId) && text(quote.text))
  && optional(value.artifacts, list => items(list, artifact => object(artifact) && text(artifact.title) && text(artifact.text) && source(artifact.source)))

/** 先核对视图要使用的数据。旧版宿主返回的有效 JSON 若不符合契约，也不能替换已显示的快照。 */
function readable(op: StudioOp, value: unknown): boolean {
  if (op === 'models') return items(value, option => object(option) && text(option.provider) && text(option.model)
    && text(option.label) && items(option.reasoningEfforts, text))
  if (!object(value)) return false
  switch (op) {
    case 'state': return whole(value.pendingCount) && settings(value.settings) && choice(value.feishu, ['disabled', 'connecting', 'online', 'offline', 'identity-mismatch'])
      && items(value.projects, project => object(project) && text(project.id) && text(project.name) && text(project.objective))
      && optional(value.hiddenSessionIds, list => items(list, text))
    case 'settings': return settings(value)
    case 'timeline': return items(value.items, message)
    case 'message': case 'send': return message(value)
    case 'pending': return items(value.items, pending)
    case 'answer': return pending(value)
    case 'records': return items(value.items, session)
    case 'record': return session(value.record) && items(value.events, event => object(event) && whole(event.seq) && text(event.kind) && text(event.text))
  }
}

export const callStudio: StudioCall = async (op, input, signal) => {
  // 请求有上限，避免网络挂起后阻塞轮询，也避免写入未应答时自动重发。
  const timeout = AbortSignal.timeout(op === 'send' || op === 'answer' || op === 'settings' ? 30_000 : 15_000)
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response | undefined
  let data: unknown
  try {
    response = await fetch(STUDIO_API, { method: 'POST', credentials: 'same-origin', signal: bounded,
      headers: { 'content-type': 'application/json', [STUDIO_HEADER]: '1' }, body: JSON.stringify({ op, input }) })
    data = await response.json()
  } catch (cause) {
    if (signal?.aborted) throw cause
    if (timeout.aborted) throw new StudioApiError('timeout', response?.status ?? 0)
    if (!response) throw new StudioApiError('network', 0)
    if (response.ok) throw new StudioApiError('badResponse', response.status)
  }
  // 消息也可能有 error 字段，它与只含 error/code 的 API 错误对象不是同一回事。
  const failure = object(data) && typeof data.error === 'string' ? data : undefined
  if (!response.ok || (failure && Object.keys(failure).every(key => key === 'error' || key === 'code'))) {
    const detail = failure?.error as string | undefined
    const code = failure && 'code' in failure && typeof failure.code === 'string' ? failure.code : undefined
    throw new StudioApiError(response.status === 404 && !detail ? 'unavailable' : 'requestFailed', response.status, detail, code)
  }
  if (!readable(op, data)) throw new StudioApiError('badResponse', response.status)
  return data as StudioResult<typeof op>
}

/** 网络和协议故障按界面语言说明；业务拒绝保留宿主返回的具体原因。 */
export function failureText(t: T, failure: unknown): string {
  if (failure instanceof StudioApiError) return failure.detail || t(failure.kind, { status: failure.status })
  return failure instanceof Error ? failure.message : t('badResponse')
}
