/** Browser-safe contract for the owner-facing Studio. Session IDs are provenance, never conversation addresses. */
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

export interface StudioProjectSummary { id: string; name: string; objective: string }
export interface StudioModel { provider: string; model: string; reasoningEffort?: string }
export interface StudioModelOption { provider: string; model: string; label: string; reasoningEfforts: string[] }
export interface StudioSettings {
  revision: number
  assistant: StudioModel | null
  leader: StudioModel | null
}
export type FeishuState = 'disabled' | 'connecting' | 'online' | 'offline' | 'identity-mismatch'
export interface StudioState {
  projects: StudioProjectSummary[]
  pendingCount: number
  settings: StudioSettings
  feishu: FeishuState
  /** Implicit IDs are self-identifying. This list covers adopted native Sessions without a Studio-allocated ID. */
  hiddenSessionIds?: string[]
}

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
  role: 'assistant' | 'leader' | 'document-worker' | 'draft-worker' | 'advisor' | 'subagent'
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
  settings: { input: StudioSettings; result: StudioSettings }
  timeline: { input: { conversationId: string; topicId?: string; before?: number }; result: StudioPage<StudioMessage> }
  message: { input: { conversationId: string; id: string }; result: StudioMessage }
  send: { input: StudioSend; result: StudioMessage }
  pending: { input: { before?: number }; result: StudioPage<StudioPending> }
  answer: { input: { id: string; value: string }; result: StudioPending }
  records: { input: { query?: string; before?: number }; result: StudioPage<StudioSessionRecord> }
  record: { input: { sessionId: string; from?: number }; result: { record: StudioSessionRecord; events: StudioRecordEvent[]; next?: number } }
}
export type StudioOp = keyof StudioOperations
export type StudioInput<K extends StudioOp> = StudioOperations[K]['input']
export type StudioResult<K extends StudioOp> = StudioOperations[K]['result']