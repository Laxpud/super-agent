/** Coordinate the owner-facing timeline, native sessions, and the verified private-chat transport. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ManagedWorkerStore } from '../managed-worker/store.ts'
import { confirmStudioModel, studioModelOptions } from './models.ts'
import { StudioError } from './pending.ts'
import { ASSISTANT_CONVERSATION, type FeishuState, type StudioPending, type StudioSend, type StudioSessionRecord, type StudioSettings } from './protocol.ts'
import { StudioSessions } from './sessions.ts'
import type { StudioFeishuInput, StudioFeishuPort } from './feishu.ts'
import type { StudioHttpOperations } from './http.ts'

const pendingQuestion = /^(?:还有什么(?:需要我|要我|待我)处理(?:的吗|的|吗)?|还有什么待办(?:吗)?|待我处理|what(?:'s| is) (?:waiting for|pending for) me|\/studio-pending)[?？。.!！\s]*$/iu

/** Offer the same Assistant and pending state to the authorized Web and Feishu entry points. */
export class StudioService {
  readonly sessions: StudioSessions

  constructor(private readonly ctx: Context, private readonly domain: ManagedWorkerStore, cwd: string,
    defaults: Pick<StudioSettings, 'assistant' | 'leader'>, ready: (agent: Agent, role: 'assistant' | 'leader') => boolean,
    private readonly stopping: AbortSignal, private readonly feishuState: () => FeishuState, private readonly wake: () => void) {
    this.sessions = new StudioSessions(ctx, domain, cwd, defaults, ready, stopping, wake)
  }

  private get store() { return this.domain.studio }

  private conversation(id: string): void {
    if (id !== ASSISTANT_CONVERSATION && !this.domain.studioProject(id)) throw new StudioError('PROJECT_NOT_FOUND', 'This Studio project does not exist.', 404)
  }

  private send(input: StudioSend) {
    this.conversation(input.conversationId)
    const { message, created } = this.store.addUser({ ...input, channel: 'gui' })
    if (created) {
      if (pendingQuestion.test(message.text.trim())) this.publishPendingSummary(message.id)
      else this.sessions.enqueue(message)
      this.wake()
    }
    return this.store.message(message.conversationId, message.id) ?? message
  }

  /** Refresh the status of managed blockers without invoking a model, changing a job, or clearing a hold. */
  refreshBlockers(): void {
    const current = new Map(this.domain.studioBlockingItems().map(item => [item.id, item]))
    const previous = new Map(this.store.openBlockers().map(item => [item.id, item]))
    for (const item of current.values()) if (!previous.has(item.id)) this.store.addPending(item)
    for (const item of previous.values()) if (!current.has(item.id)) this.store.settlePending(item.id, 'resolved')
  }

  private publishPendingSummary(requestId: string): void {
    this.refreshBlockers()
    const count = this.store.pendingCount()
    const items = this.store.pending().items.filter(item => item.state === 'pending').slice(0, 10)
    const summary = !count ? '目前没有待你处理的事项。' : [`还有 ${count} 项待你处理：`, ...items.map((item, index) =>
      `${index + 1}. ${item.requester} — ${item.title.slice(0, 160)}${item.taskId ? `（任务 ${item.taskId}）` : ''}${item.mobile === 'unsupported' ? ' · 仍待确认，请到 Studio 处理' : ''}`),
    ...(count > items.length ? ['更多事项可在 Studio 的「待我处理」查看。'] : [])].join('\n')
    this.store.addReply(requestId, summary)
    this.store.finishMessage(requestId, 'completed')
  }

  /** Clearing a block records the owner's checked condition on that exact active block. It never dispatches. */
  private answerGui(id: string, value: string): StudioPending {
    if (!id.startsWith('work-block:')) return this.sessions.answer(id, value, 'gui', 'gui')
    const item = this.store.pendingItem(id)
    const project = item && this.domain.studioProject(item.conversationId)
    if (!item || item.kind !== 'blocked' || item.state !== 'pending' || !item.taskId || !project) {
      throw new StudioError('BLOCK_NOT_CURRENT', 'The task is no longer waiting on this block.', 409)
    }
    if (value.length > 1_000) throw new StudioError('INVALID_ANSWER', 'Describe the condition you verified in at most 1000 characters.')
    const result = this.domain.projects.unblockWork(project.leaderSessionId, item.taskId, id.slice('work-block:'.length), value,
      `agent-studio:${randomUUID()}`)
    if (!result.ok) throw new StudioError('BLOCK_NOT_CURRENT', 'The block could not be cleared. Check the current project state.', 409)
    this.wake()
    return this.store.settlePending(id, 'resolved', value, 'gui') ?? this.store.pendingItem(id) ?? item
  }

  private async saveSettings(input: StudioSettings, request: AbortSignal): Promise<StudioSettings> {
    const signal = AbortSignal.any([request, this.stopping])
    if (input.revision !== this.sessions.settings.revision) throw new StudioError('SETTINGS_CONFLICT', 'Studio settings changed. Reload them before saving.', 409)
    await Promise.all([input.assistant, input.leader].map(route => route ? confirmStudioModel(this.ctx, route, signal) : undefined))
    signal.throwIfAborted()
    return this.store.saveSettings(input)
  }

  readonly operations: StudioHttpOperations = {
    state: () => {
      this.refreshBlockers()
      return { projects: this.domain.studioProjects(), pendingCount: this.store.pendingCount(), settings: this.sessions.settings,
        feishu: this.feishuState(), hiddenSessionIds: this.domain.studioHiddenIds() }
    },
    models: (_input, signal) => studioModelOptions(this.ctx, AbortSignal.any([signal, this.stopping])),
    settings: (input, signal) => this.saveSettings(input, signal),
    timeline: ({ conversationId, topicId, before }) => {
      this.conversation(conversationId)
      if (topicId && !this.store.message(conversationId, topicId)) throw new StudioError('TOPIC_NOT_FOUND', 'Studio topic not found.', 404)
      return this.store.messages(conversationId, topicId, before)
    },
    message: ({ conversationId, id }) => {
      this.conversation(conversationId)
      const message = this.store.message(conversationId, id)
      if (!message) throw new StudioError('MESSAGE_NOT_FOUND', 'Studio message not found.', 404)
      return message
    },
    send: input => this.send(input),
    pending: ({ before }) => {
      this.refreshBlockers()
      const page = this.store.pending(before)
      return { ...page, items: page.items.map(item => {
        const recordSessionId = item.kind === 'blocked' ? this.domain.studioPendingRecord(item.id) : undefined
        return recordSessionId && (this.store.session(recordSessionId) || this.domain.studioSession(recordSessionId))
          ? { ...item, recordSessionId } : item
      }) }
    },
    answer: ({ id, value }) => this.answerGui(id, value),
    records: ({ query, before }) => this.store.records(query, before),
    record: ({ sessionId, from }, signal) => this.sessions.record(sessionId, from ?? 0, signal),
  }

  /** Card identity and owner identity are separate checks: the adapter checked the latter before calling here. */
  private answerCard({ scope, messageId, pendingId, value }: Parameters<StudioFeishuPort['answer']>[0]): boolean {
    const item = this.store.feishuQuestion(scope, messageId)
    if (!item || item.id !== pendingId || item.state !== 'pending' || item.mobile !== 'card' || !item.options.includes(value)) return false
    try { return this.sessions.answer(item.id, value, 'feishu', 'card').state === 'resolved' }
    catch (error) { if (error instanceof StudioError) return false; throw error }
  }

  private receiveFeishu(input: StudioFeishuInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // A callback must point to the exact bound conversation/card; old-history replies are never new assignments.
    const anchors = [...new Set([input.parentId, input.rootId].filter((id): id is string => !!id))]
    const card = input.parentId ?? input.rootId
    const item = card ? this.store.feishuQuestion(input.scope, card) : undefined
    const conversationId = ASSISTANT_CONVERSATION
    const parent = anchors.map(id => this.store.feishuMessage(input.scope, id)).find(value => value !== undefined)
      ?? (input.threadId ? this.store.feishuThread(input.scope, input.threadId) : undefined)
    if (item?.conversationId !== undefined && item.conversationId !== conversationId) {
      // The question can resume its live Leader, but project messages are never added to Assistant's timeline.
      if (item.mobile === 'topic' && item.state === 'pending') {
        try { this.sessions.answer(item.id, input.text, 'feishu', 'topic') }
        catch (error) { if (!(error instanceof StudioError)) throw error }
      }
      return Promise.resolve()
    }
    if ((anchors.length || input.threadId) && !item && !parent) return Promise.resolve()
    const replyTo = item?.messageId ?? parent?.id
    const { message, created } = this.store.addUser({ requestId: input.id, conversationId, channel: 'feishu', text: input.text,
      createdAt: input.sourceTimeMs, ...(replyTo ? { replyTo } : {}), feishu: { scope: input.scope, id: input.id,
        ...(input.threadId ? { threadId: input.threadId } : {}) } })
    if (!created) return Promise.resolve()
    if (item) {
      let accepted = false
      // Plain text (even an affirmative answer) cannot approve a decision. It can only answer a scoped, live text question.
      if (item.mobile === 'topic' && item.state === 'pending') {
        try { this.sessions.answer(item.id, input.text, 'feishu', 'topic'); accepted = true }
        catch (error) { if (!(error instanceof StudioError)) throw error }
      }
      if (!accepted) this.store.addReply(message.id, item.state === 'pending' ? '仍待确认：这条文字没有批准事项。请用有效卡片或在 Studio 处理。' : '这项事项已处理或失效。')
      this.store.finishMessage(message.id, 'completed')
    } else if (pendingQuestion.test(input.text.trim())) this.publishPendingSummary(message.id)
    else this.sessions.enqueue(message)
    this.wake()
    return Promise.resolve()
  }

  readonly feishu: StudioFeishuPort = {
    activate: (scope, at) => this.store.activateFeishu(scope, at),
    receive: (input, signal) => this.receiveFeishu(input, signal),
    answer: input => this.answerCard(input),
    next: scope => { this.refreshBlockers(); return this.store.nextFeishu(scope) },
    finish: (id, remoteId) => this.store.finishFeishu(id, remoteId),
  }

  /** Record live native Sessions owned by Studio without making a raw Session part of the main timeline. */
  observeSession(agent: Agent, role: StudioSessionRecord['role']): void {
    const record = this.domain.studioSession(agent.id)
    if (!record) return
    const current = this.store.session(agent.id)
    if (current) return
    const stamp = agent.session.header.createdAt
    this.store.registerSession({ ...record, role: record.role ?? role, createdAt: typeof stamp === 'number' ? stamp : record.createdAt || Date.now() })
  }
}
