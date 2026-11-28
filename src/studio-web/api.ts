/** 浏览器只调用同源 Studio API；会话身份由宿主 Cookie 验证。 */
import { STUDIO_API, STUDIO_HEADER, STUDIO_TASK_STATUSES, type StudioInput, type StudioOp, type StudioRecordRole, type StudioResult } from '../studio/protocol.ts'
import type { en, T } from './locales.ts'

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
const boolean = (value: unknown) => typeof value === 'boolean'
const nullableText = (value: unknown) => value === null || text(value)
const whole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const choice = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value)
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const items = (value: unknown, check: (value: unknown) => boolean) => Array.isArray(value) && value.every(check)
const positiveWhole = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const page = (value: Record<string, unknown>, check: (value: unknown) => boolean) => items(value.items, check) && optional(value.next, positiveWhole)
const source = (value: unknown) => object(value) && text(value.sessionId) && whole(value.eventSeq)
const model = (value: unknown) => object(value) && text(value.provider) && text(value.model) && optional(value.reasoningEffort, text)
const nullableModel = (value: unknown) => value === null || model(value)
const settings = (value: unknown) => object(value) && whole(value.revision) && optional(value.scope, revision)
  && nullableModel(value.assistant) && nullableModel(value.leader)
const feishuState = (value: unknown) => choice(value, ['disabled', 'connecting', 'online', 'offline', 'identity-mismatch', 'credential-missing'])
const binding = (value: unknown) => object(value) && [value.appId, value.botOpenId, value.ownerOpenId, value.chatId].every(text)
const feishu = (value: unknown) => object(value) && (value.mode === 'disabled' ? value.binding === undefined
  : value.mode === 'conversation' && binding(value.binding))
const permission = (value: unknown) => choice(value, ['read-only', 'workspace-write'])
const revision = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const route = (value: unknown) => object(value) && text(value.id) && model(value)
const defaults = (value: unknown) => object(value) && optional(value.assistant, text) && optional(value.leader, text)
const configuration = (value: unknown) => object(value) && text(value.stateDir) && text(value.studioCwd) && feishu(value.feishu)
  && nullableModel(value.assistantModel) && nullableModel(value.leaderModel) && items(value.workerModelRoutes, route)
  && defaults(value.workerModelDefaults) && permission(value.defaultWorkerPermission)
const roles = ['assistant', 'leader', 'worker', 'document-worker', 'draft-worker', 'study-worker', 'advisor', 'subagent', 'legacy'] as const satisfies readonly StudioRecordRole[]
const session = (value: unknown) => object(value) && text(value.id) && text(value.conversationId) && whole(value.createdAt)
  && choice(value.role, roles) && optional(value.readonlyLegacy, boolean)
const project = (value: unknown) => object(value) && text(value.id) && text(value.name) && text(value.objective)
  && nullableText(value.workspacePath) && choice(value.state, ['active', 'archived']) && positiveWhole(value.managementEpoch)
const dateText = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const archive = (value: Record<string, unknown>) => [value.projectId, value.decisions, value.progress, value.openIssues].every(text)
  && (value.updatedAt === null || dateText(value.updatedAt)) && boolean(value.readonly)
const preference = (value: unknown) => object(value) && [value.preferenceId, value.key, value.text].every(text) && dateText(value.updatedAt)
  && nullableText(value.projectId) && choice(value.state, ['active', 'forgotten']) && positiveWhole(value.version)
const forward = (value: unknown) => value === null || (object(value)
  && [value.forwardId, value.projectId, value.projectName, value.projectMessageId].every(text)
  && choice(value.status, ['registered', 'running', 'delegated', 'delivered', 'failed', 'interrupted']))
const artifact = (value: unknown) => object(value) && text(value.title) && text(value.text) && source(value.source)
const checkReceipt = (value: unknown) => nullableText(value) || (object(value) && value.version === 1
  && choice(value.overallCheckStatus, ['passed', 'failed', 'not_run'])
  && items(value.changedFiles, file => object(file) && text(file.path) && choice(file.action, ['write', 'edit']))
  && items(value.checks, check => object(check) && [check.command, check.workdir, check.output].every(text) && nullableText(check.signal)
    && (check.exitCode === null || Number.isSafeInteger(check.exitCode)) && boolean(check.timedOut) && boolean(check.aborted)
    && choice(check.status, ['passed', 'failed']))
  && optional(value.omittedChecks, positiveWhole) && optional(value.omittedChangedFiles, positiveWhole))
const task = (value: unknown) => object(value) && [value.taskId, value.conversationId, value.title, value.requestText].every(text)
  && [value.projectId, value.projectName, value.sourceSessionId, value.workerSessionId, value.sourceMessageId,
    value.requesterBotId, value.assigneeBotId, value.workspacePath, value.resultSummary].every(nullableText)
  && checkReceipt(value.checkResult) && permission(value.permission) && whole(value.authorizationVersion)
  && whole(value.createdAt) && whole(value.updatedAt) && choice(value.status, STUDIO_TASK_STATUSES)
  && items(value.artifacts, artifact) && Object.hasOwn(value, 'externalJob') && optional(value.source, source)
const intake = (value: Record<string, unknown>) => boolean(value.accepted) && nullableText(value.messageId) && forward(value.forward)
  && (value.messageStatus === null || choice(value.messageStatus, ['queued', 'running', 'completed', 'failed', 'interrupted'])) && items(value.tasks, task)
const pending = (value: unknown) => object(value) && [value.id, value.conversationId, value.title, value.detail, value.requester].every(text)
  && [value.messageId, value.topicId, value.taskId, value.recordSessionId, value.answer].every(field => optional(field, text))
  && whole(value.createdAt) && typeof value.acceptsText === 'boolean' && items(value.options, text)
  && choice(value.kind, ['confirmation', 'question', 'blocked']) && choice(value.mobile, ['card', 'topic', 'unsupported'])
  && choice(value.state, ['pending', 'resolved', 'expired']) && optional(value.answeredBy, field => choice(field, ['gui', 'feishu']))
const message = (value: unknown) => object(value) && [value.id, value.conversationId, value.text].every(text)
  && [value.topicId, value.replyTo, value.error].every(field => optional(field, text)) && whole(value.sequence) && whole(value.createdAt) && whole(value.replyCount)
  && choice(value.role, ['user', 'assistant', 'leader']) && choice(value.channel, ['gui', 'feishu', 'studio'])
  && optional(value.status, field => choice(field, ['queued', 'running', 'completed', 'failed', 'interrupted']))
  && optional(value.feishuDelivery, field => choice(field, ['pending', 'sent', 'unconfirmed'])) && optional(value.source, source)
  && optional(value.quote, quote => object(quote) && text(quote.messageId) && text(quote.text))
  && optional(value.artifacts, list => items(list, artifact))

/** 先核对视图要使用的数据。旧版宿主返回的有效 JSON 若不符合契约，也不能替换已显示的快照。 */
function readable(op: StudioOp, value: unknown): boolean {
  if (op === 'models') return items(value, option => object(option) && text(option.provider) && text(option.model)
    && text(option.label) && items(option.reasoningEfforts, text))
  if (op === 'preferences') return items(value, preference)
  if (!object(value)) return false
  switch (op) {
    case 'state': return whole(value.pendingCount) && settings(value.settings) && feishuState(value.feishu)
      && items(value.projects, project) && optional(value.archivedProjects, list => items(list, project))
      && optional(value.hiddenSessionIds, list => items(list, text))
    case 'configuration': return revision(value.revision) && optional(value.profile, text) && typeof value.writable === 'boolean'
      && typeof value.credentialsWritable === 'boolean' && configuration(value.config) && object(value.feishu)
      && feishuState(value.feishu.state) && choice(value.feishu.credential, ['none', 'startup', 'stored', 'missing'])
    case 'saveConfiguration': return revision(value.revision) && optional(value.credentialCleanup, state => state === 'unconfirmed')
    case 'feishuCheck': return text(value.id) && ((value.state === 'connecting' || value.state === 'waiting') ? text(value.phrase) && whole(value.expiresAt)
      : value.state === 'verified' ? binding(value.binding) && whole(value.expiresAt) : value.state === 'failed'
        ? choice(value.reason, ['FEISHU_BOT_UNCONFIRMED', 'FEISHU_BOT_MISMATCH', 'FEISHU_CONNECTION_UNCONFIRMED'])
        : value.state === 'cancelled' || value.state === 'expired')
    case 'settings': return settings(value)
    case 'timeline': return page(value, message)
    case 'message': case 'send': return message(value)
    case 'messageStatus': return intake(value)
    case 'feishuMessageStatus': case 'resubmitFeishuMessage': return text(value.feishuMessageId) && intake(value)
    case 'createProject': case 'updateProject': case 'replaceProjectLeader': case 'archiveProject': case 'reopenProject': return project(value)
    case 'projectArchive': case 'updateProjectArchive': return archive(value)
    case 'savePreference': case 'updatePreference': case 'forgetPreference': return preference(value)
    case 'tasks': return page(value, task)
    case 'task': case 'stopTask': return task(value)
    case 'pending': return page(value, pending)
    case 'answer': return pending(value)
    case 'records': return page(value, session)
    case 'record': return session(value.record) && items(value.events, event => object(event) && whole(event.seq) && text(event.kind) && text(event.text))
      && optional(value.next, positiveWhole)
  }
}

// 建项、换任和重开需验证模型并准备原生 Leader，会和其他长请求一样使用较长的等待上限。
const longRequests = new Set<StudioOp>(['send', 'answer', 'settings', 'stopTask', 'feishuMessageStatus', 'resubmitFeishuMessage',
  'createProject', 'replaceProjectLeader', 'reopenProject'])

export const callStudio: StudioCall = async (op, input, signal) => {
  // 请求有上限，避免网络挂起后阻塞轮询，也避免写入未应答时自动重发。
  const timeout = AbortSignal.timeout(op === 'saveConfiguration' ? 120_000 : longRequests.has(op) ? 35_000 : 15_000)
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

const operationErrors = {
  PREFERENCE_CONFLICT: 'domainError.PREFERENCE_CONFLICT',
  PROJECT_EPOCH_CONFLICT: 'domainError.PROJECT_EPOCH_CONFLICT',
  PROJECT_ARCHIVED: 'domainError.PROJECT_ARCHIVED',
  PROJECT_NOT_ARCHIVED: 'domainError.PROJECT_NOT_ARCHIVED',
  PROJECT_NOT_FOUND: 'domainError.PROJECT_NOT_FOUND',
  STUDIO_WORKSPACE_INVALID: 'configError.STUDIO_WORKSPACE_INVALID',
  MODEL_UNAVAILABLE: 'configError.MODEL_UNAVAILABLE',
  TASK_NOT_ACTIVE: 'domainError.TASK_NOT_ACTIVE',
  TASK_NOT_FOUND: 'domainError.TASK_NOT_FOUND',
  INVALID_INPUT: 'domainError.INVALID_INPUT',
  STUDIO_UNAVAILABLE: 'unavailable',
} as const satisfies Record<string, keyof typeof en>

/** 已知操作错误给出本地化说明；未知业务拒绝仍以字面文本显示宿主返回的原因。 */
export function failureText(t: T, failure: unknown): string {
  if (failure instanceof StudioApiError) {
    if (failure.code && Object.hasOwn(operationErrors, failure.code)) return t(operationErrors[failure.code as keyof typeof operationErrors])
    return failure.detail || t(failure.kind, { status: failure.status })
  }
  return failure instanceof Error ? failure.message : t('badResponse')
}
