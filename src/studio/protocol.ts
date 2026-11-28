/** Browser-safe contract for the owner-facing Studio. Session IDs are provenance, never conversation addresses. */
import type { ConfigurationChange, ConfigurationReceipt, ConfigurationSnapshot, FeishuCheck, FeishuCheckResult } from './settings-protocol.ts'

export const ASSISTANT_CONVERSATION = 'assistant'
export const STUDIO_API = '/agent-studio/api'
export const STUDIO_HEADER = 'x-agent-studio-request'
export const STUDIO_TEXT_LIMIT = 32_000
export const STUDIO_PAGE_SIZE = 40
const INTERNAL_SESSION = /^agent-studio-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Studio-allocated native identities can be omitted from presentation before their first catalog event. */
export const isStudioInternalSession = (id: string): boolean => INTERNAL_SESSION.test(id)

export interface StudioSource { sessionId: string; eventSeq: number }
export interface StudioArtifact { title: string; text: string; source: StudioSource }
export interface StudioQuote { messageId: string; text: string }
export interface StudioMessage {
  id: string
  sequence: number
  conversationId: string
  role: 'user' | 'assistant' | 'leader'
  channel: 'gui' | 'feishu' | 'studio'
  text: string
  createdAt: number
  /** The root message ID. The root itself stays on the main timeline. */
  topicId?: string
  replyTo?: string
  quote?: StudioQuote
  replyCount: number
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  error?: string
  source?: StudioSource
  artifacts?: StudioArtifact[]
  feishuDelivery?: 'pending' | 'sent' | 'unconfirmed'
}

export const WORKER_DELEGATE = 'studio_delegate_task'
export const WORKER_READ = 'studio_read_task'
export const LIST_PROJECTS = 'studio_list_projects'
export const PROPOSE_PROJECT = 'studio_propose_project'
/** 仅供只读记录渲染旧 Worker 工具调用；宿主不再注册这些工具。 */
export const DRAFT_DELEGATE = 'studio_delegate_draft'
export const DRAFT_READ = 'studio_read_draft'

export type StudioRole = 'assistant' | 'leader' | 'worker'
export type StudioRecordRole = StudioRole | 'document-worker' | 'draft-worker' | 'study-worker' | 'advisor' | 'subagent' | 'legacy'
export type StudioWorkerPermission = 'read-only' | 'workspace-write'
export type StudioTaskStatus = 'queued' | 'running' | 'waiting_approval' | 'blocked' | 'interrupted' | 'cancelled' | 'delivered'
export interface StudioChangedFile { path: string; action: 'write' | 'edit' }
export interface StudioCommandCheck {
  command: string
  workdir: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  status: 'passed' | 'failed'
  output: string
}
export interface StudioCheckResult {
  version: 1
  changedFiles: StudioChangedFile[]
  checks: StudioCommandCheck[]
  overallCheckStatus: 'passed' | 'failed' | 'not_run'
  /** 达到收据容量后仍统计省略条数，并用全部检查计算总体状态。 */
  omittedChecks?: number
  omittedChangedFiles?: number
}
export interface StudioTaskSummary {
  taskId: string
  projectId: string | null
  sourceMessageId: string | null
  requesterBotId: string | null
  assigneeBotId: string | null
  workspacePath: string | null
  permission: StudioWorkerPermission
  authorizationVersion: number
  status: StudioTaskStatus
  title: string
  requestText: string
  resultSummary: string | null
  /** 新收据采用结构化格式；旧阻塞说明和历史检查仍可能是纯文本。 */
  checkResult: StudioCheckResult | string | null
  artifacts: StudioArtifact[]
  externalJob: unknown
  createdAt: number
  updatedAt: number
  source?: StudioSource
}

export interface StudioProjectSummary {
  id: string; name: string; objective: string; workspacePath: string | null; state: 'active' | 'archived'; managementEpoch: number
}
export interface StudioModel { provider: string; model: string; reasoningEffort?: string }
export interface StudioModelOption { provider: string; model: string; label: string; reasoningEfforts: string[] }
export interface StudioSettings {
  revision: number
  /** 数据目录或缺省设置改变时，旧数据库版本不能用于保存当前对话模型。 */
  scope?: string
  assistant: StudioModel | null
  leader: StudioModel | null
}
export type FeishuState = 'disabled' | 'connecting' | 'online' | 'offline' | 'identity-mismatch' | 'credential-missing'
export interface StudioState {
  projects: StudioProjectSummary[]
  pendingCount: number
  settings: StudioSettings
  feishu: FeishuState
  /** Implicit IDs are self-identifying. This list covers adopted native Sessions without a Studio-allocated ID. */
  hiddenSessionIds?: string[]
}

export const GUARD_PENDING_PREFIX = 'guard-intercept:'
export const GUARD_PENDING_CHOICES = ['取消任务', '仅解除等待（不重放被拒动作）'] as const
export const GUARD_PENDING_TEXT_HINT = '直接回复确认消息，或在私聊发送「取消任务 <待办 ID>」或「仅解除等待 <待办 ID>」。解除等待不会重放被拒动作。'

export interface StudioPending {
  id: string
  kind: 'confirmation' | 'question' | 'blocked'
  conversationId: string
  topicId?: string
  messageId?: string
  taskId?: string
  /** Read-only native task record when the action has no Studio timeline message. */
  recordSessionId?: string
  requester: string
  title: string
  detail: string
  options: string[]
  acceptsText: boolean
  mobile: 'card' | 'topic' | 'unsupported'
  state: 'pending' | 'resolved' | 'expired'
  createdAt: number
  answer?: string
  answeredBy?: 'gui' | 'feishu'
}

export interface StudioSessionRecord {
  id: string
  conversationId: string
  role: StudioRecordRole
  readonlyLegacy?: boolean
  createdAt: number
}
export interface StudioRecordEvent {
  seq: number
  kind: string
  text: string
}
export interface StudioPage<T> { items: T[]; next?: number }
export interface StudioSend {
  conversationId: string
  requestId: string
  text: string
  replyTo?: string
  quoteId?: string
}

export interface StudioOperations {
  state: { input: Record<string, never>; result: StudioState }
  models: { input: Record<string, never>; result: StudioModelOption[] }
  configuration: { input: Record<string, never>; result: ConfigurationSnapshot }
  saveConfiguration: { input: ConfigurationChange; result: ConfigurationReceipt }
  feishuCheck: { input: FeishuCheck; result: FeishuCheckResult }
  settings: { input: StudioSettings; result: StudioSettings }
  timeline: { input: { conversationId: string; topicId?: string; before?: number }; result: StudioPage<StudioMessage> }
  message: { input: { conversationId: string; id: string }; result: StudioMessage }
  send: { input: StudioSend; result: StudioMessage }
  tasks: { input: { conversationId?: string; before?: number }; result: StudioPage<StudioTaskSummary> }
  task: { input: { taskId: string }; result: StudioTaskSummary }
  stopTask: { input: { taskId: string }; result: StudioTaskSummary }
  pending: { input: { before?: number }; result: StudioPage<StudioPending> }
  answer: { input: { id: string; value: string }; result: StudioPending }
  records: { input: { query?: string; before?: number }; result: StudioPage<StudioSessionRecord> }
  record: { input: { sessionId: string; from?: number }; result: { record: StudioSessionRecord; events: StudioRecordEvent[]; next?: number } }
}
export type StudioOp = keyof StudioOperations
export type StudioInput<K extends StudioOp> = StudioOperations[K]['input']
export type StudioResult<K extends StudioOp> = StudioOperations[K]['result']