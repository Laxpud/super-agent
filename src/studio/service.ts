/** Coordinate the owner-facing timeline, native sessions, and the verified private-chat transport. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { studioBlockTarget } from './domain.ts'
import type { ManagedWorkerStore } from '../managed-worker/store.ts'
import { confirmStudioModel, studioModelOptions } from './models.ts'
import { StudioError } from './pending.ts'
import { asksForActiveWork, asksForPending, asksForProjects, confirmationStatusQuery, namesConfirmation, readTextDecision, readRouteControl, readTaskUnblock,
  refersToThisConfirmation } from './owner-text.ts'
import { ASSISTANT_CONVERSATION, STUDIO_TEXT_LIMIT, type FeishuState, type StudioMessage, type StudioPending, type StudioSend, type StudioSettings } from './protocol.ts'
import { StudioSessions } from './sessions.ts'
import type { StudioFeishuInput, StudioFeishuPort } from './feishu.ts'
import type { StudioHttpOperations } from './http.ts'
import type { StudioConfigurationOp } from './settings-protocol.ts'

/** Offer the same Assistant and pending state to the authorized Web and Feishu entry points. */
export class StudioService {
  readonly sessions: StudioSessions

  constructor(private readonly ctx: Context, private readonly domain: ManagedWorkerStore, cwd: string,
    defaults: Pick<StudioSettings, 'assistant' | 'leader'>, ready: (agent: Agent, role: 'assistant' | 'leader') => boolean,
    private readonly stopping: AbortSignal, private readonly feishuState: () => FeishuState, private readonly wake: () => void,
    private readonly settingsScope?: string) {
    this.sessions = new StudioSessions(ctx, domain, cwd, defaults, ready, stopping, wake)
  }

  private get store() { return this.domain.studio }

  private conversation(id: string): void {
    if (id !== ASSISTANT_CONVERSATION && !this.domain.studioProject(id)) throw new StudioError('PROJECT_NOT_FOUND', 'This Studio project does not exist.', 404)
  }

  private send(input: StudioSend) {
    this.conversation(input.conversationId)
    if (this.domain.studioProject(input.conversationId)?.state === 'archived') throw new StudioError('PROJECT_ARCHIVED', 'This project is archived.', 409)
    const { message, created } = this.store.addUser({ ...input, channel: 'gui' })
    if (created) {
      this.ownerInput(message, message.replyTo ? this.store.pendingItem(message.replyTo) : undefined)
      this.wake()
    }
    return this.store.message(message.conversationId, message.id) ?? message
  }

  /** 两个可信入口共用这一分流。先处理读查询、确认与定向控制，不等任何模型轮次。 */
  private ownerInput(message: StudioMessage, direct?: StudioPending): void {
    const text = message.text.trim()
    if (asksForPending.test(text)) { this.publishPendingSummary(message.id); return }
    if (message.conversationId === ASSISTANT_CONVERSATION && asksForProjects.test(text)) {
      const projects = this.domain.studioProjects()
      this.reply(message.id, projects.length === 0 ? '目前没有登记的项目。'
        : [`目前有 ${projects.length} 个项目：`, ...projects.slice(0, 50).map(item => `- ${item.name}（${item.id}）`),
          ...(projects.length > 50 ? ['这里只列出前 50 项。'] : [])].join('\n'))
      return
    }
    if (message.conversationId === ASSISTANT_CONVERSATION && asksForActiveWork.test(text)) {
      const active = this.domain.tasks().items.filter(task => ['queued', 'running', 'waiting_approval', 'blocked'].includes(task.status))
        .map(task => `${task.title} · ${task.status}（${task.taskId}）`).concat(this.sessions.activeWork())
      this.reply(message.id, active.length ? `Assistant 当前正在处理：\n${active.map(item => `- ${item}`).join('\n')}`
        : 'Assistant 当前没有在处理的请求。')
      return
    }
    const query = confirmationStatusQuery(text)
    if (query) { this.publishDecisions(message.id, query.target, direct); return }
    const decision = this.textDecision(message, direct)
    if (decision !== undefined) { this.reply(message.id, decision); return }
    const unblocking = readTaskUnblock(text)
    if (unblocking) {
      this.refreshBlockers()
      const item = this.store.openBlockers().find(item => item.taskId === unblocking.taskId)
      if (!item || message.createdAt < item.createdAt) { this.reply(message.id, '找不到对应的当前阻塞。未改变任何任务。'); return }
      try {
        this.answerBlock(item.id, unblocking.detail, message.channel === 'feishu' ? 'feishu' : 'gui')
        this.reply(message.id, '已解除该任务的阻塞，原执行不会自动重启。')
      } catch (error) {
        if (!(error instanceof StudioError)) throw error
        this.reply(message.id, '该任务的阻塞已处理或失效。未重新派工。')
      }
      return
    }
    const control = readRouteControl(text)
    if (control) {
      const related = this.sessions.relatedWork(message)
      const target = control.target.replace(/^[#＃]/u, '')
      const task = target ? this.domain.task(target) : related && this.domain.task(related.taskId)
      const validRoom = message.conversationId === ASSISTANT_CONVERSATION || task?.projectId === message.conversationId
      if (task && validRoom) {
        if (this.sessions.stopTask(task.taskId)) {
          if (control.kind === 'redirect') this.reply(message.id, `任务 ${task.taskId} 已停止。请另发明确的新请求；不会沿用旧任务授权。`)
          else this.reply(message.id, `已停止任务 ${task.taskId}，其他任务不受影响。`)
        } else this.reply(message.id, '该任务不再运行，没有改变任何工作。')
        return
      }
      const result = this.sessions.control(message, control)
      if (result?.reply) { this.reply(message.id, result.reply); return }
      if (result?.redirectFrom) { this.sessions.enqueue(message, result.redirectFrom); return }
      this.reply(message.id, '没有唯一对应的在途事项；没有停止任何工作。请直接回复相关消息，或指定任务 ID。')
      return
    }
    this.sessions.enqueue(message)
  }

  private reply(id: string, text: string): void {
    this.store.addReply(id, text)
    this.store.finishMessage(id, 'completed')
  }

  private decisionsNamed(target: string): StudioPending[] {
    const exact = this.store.pendingItem(target.replace(/^[#＃]/u, ''))
    if (exact?.kind === 'confirmation') return [exact]
    return [...this.store.openConfirmations(), ...this.store.recentDecisions()].filter(item => namesConfirmation(target, item,
      item.conversationId === ASSISTANT_CONVERSATION ? undefined : this.domain.studioProject(item.conversationId)?.name))
  }

  private describeDecision(item: StudioPending): string {
    return item.state === 'pending' ? '待你确认' : item.state === 'expired' ? '已失效'
      : item.answer === item.options[0] ? '已记录批准（不等于动作已执行）' : '已记录拒绝'
  }

  private publishDecisions(id: string, target: string, direct?: StudioPending): void {
    const items = target ? this.decisionsNamed(target) : direct?.kind === 'confirmation' ? [direct]
      : this.store.recentDecisions().slice(0, 10)
    if (!items.length) { this.reply(id, target ? '没有找到对应的确认事项。' : '目前没有已处理的确认事项。'); return }
    this.reply(id, items.slice(0, 10).map(item => `${item.title}（${item.id}）：${this.describeDecision(item)}${items.length === 1 && item.detail ? `\n${item.detail}` : ''}`)
      .join('\n').slice(0, STUDIO_TEXT_LIMIT).toWellFormed())
  }

  /** 只能用认证用户的原文确定决定与对象。不能把其他文字、模型解释或旧答复当成当前授权。 */
  private textDecision(message: StudioMessage, direct?: StudioPending): string | undefined {
    const parsed = readTextDecision(message.text)
    if (!parsed) {
      return direct?.kind === 'confirmation' && /^(?:好|好的|可以|ok)[。！!\s]*$/iu.test(message.text.trim())
        ? '仍待确认：这条文字没有批准事项。请明确说「批准」或「拒绝」。' : undefined
    }
    const anchor = direct?.kind === 'confirmation' ? direct : undefined
    const mentionsAnchor = anchor && (refersToThisConfirmation(parsed.target) || namesConfirmation(parsed.target, anchor,
      anchor.conversationId === ASSISTANT_CONVERSATION ? undefined : this.domain.studioProject(anchor.conversationId)?.name))
    const matches = anchor ? mentionsAnchor ? [anchor] : [] : this.decisionsNamed(parsed.target)
    if (!anchor && !matches.length && parsed.ambiguous && parsed.target) return undefined
    if (matches.length !== 1) return matches.length > 1
      ? `没有作出决定：有多个匹配事项。请直接回复其中一条，或说清是哪项。\n${matches.slice(0, 6).map(item => `${item.title}（${item.id}）`).join('\n')}`
      : '没有作出决定：请明确是哪一项确认，可直接回复对应的确认消息。'
    const item = matches[0]!
    if (item.state !== 'pending') return `没有再次作出决定：${item.title}，${this.describeDecision(item)}。`
    if (message.createdAt < item.createdAt) return '这条消息早于当前确认，未作出决定。'
    const selected = item.options[parsed.approve ? 0 : 1]
    if (item.options.length !== 2 || selected === undefined) return '该事项没有可对应的批准或拒绝选项。'
    try {
      const settled = this.sessions.answer(item.id, selected, message.channel === 'feishu' ? 'feishu' : 'gui', 'text')
      return `${this.describeDecision(settled)}：${settled.title}。`
    } catch (error) {
      if (error instanceof StudioError) return '未作出决定：该事项已经处理、失效或当前不可确认。'
      throw error
    }
  }

  /** Refresh the status of managed blockers without invoking a model, changing a job, or clearing a hold. */
  refreshBlockers(): void {
    const current = new Map(this.domain.studioBlockingItems().map(item => [item.id, item]))
    const previous = new Map(this.store.openBlockers().map(item => [item.id, item]))
    for (const item of current.values()) if (!previous.has(item.id)) this.store.addPending(item)
    for (const item of previous.values()) if (!current.has(item.id)) this.store.settlePending(item.id, 'expired')
  }

  private publishPendingSummary(requestId: string): void {
    this.refreshBlockers()
    const count = this.store.pendingCount()
    const items = this.store.pending().items.filter(item => item.state === 'pending').slice(0, 10)
    const summary = !count ? '目前没有待你处理的事项。' : [`还有 ${count} 项待你处理：`, ...items.map((item, index) =>
      `${index + 1}. ${item.requester} — ${item.title.slice(0, 160)}${item.taskId ? `（任务 ${item.taskId}）` : ''}`
      + (item.kind === 'confirmation' ? ` · 待你确认（${item.id}）` : '')),
    ...(items.some(item => item.kind === 'confirmation') ? ['可直接回复对应的确认消息说「批准」或「拒绝」，也可以在私聊说清决定和事项。'] : []),
    ...(count > items.length ? ['这里只显示前 10 项；可说出要查询的确切事项。'] : [])].join('\n')
    this.reply(requestId, summary)
  }

  /** 仅解除指定版本的现役阻塞，不恢复执行授权或重派原任务。 */
  private answerBlock(id: string, value: string, channel: 'gui' | 'feishu'): StudioPending {
    const target = studioBlockTarget(id)
    const item = this.store.pendingItem(id)
    if (!target || !item || item.kind !== 'blocked' || item.state !== 'pending' || item.taskId !== target.taskId) {
      throw new StudioError('BLOCK_NOT_CURRENT', 'The task is no longer waiting on this block.', 409)
    }
    if (!value.trim() || value.length > 1_000 || !value.isWellFormed() || value.includes('\0')) {
      throw new StudioError('INVALID_ANSWER', 'Describe the condition you verified in at most 1000 characters.')
    }
    if (!this.domain.invalidateTask(target.taskId, 'interrupted', target.version)) {
      throw new StudioError('BLOCK_NOT_CURRENT', 'The blocking condition is no longer current.', 409)
    }
    this.sessions.terminateInvalidated([target.taskId])
    const settled = this.store.settlePending(id, 'resolved', value.trim(), channel)
    this.wake()
    return settled ?? item
  }

  private task(id: string) {
    const item = this.domain.task(id)
    if (!item) throw new StudioError('TASK_NOT_FOUND', 'Studio task not found.', 404)
    return item
  }

  private scoped(settings: StudioSettings): StudioSettings {
    return this.settingsScope ? { ...settings, scope: this.settingsScope } : settings
  }

  private async saveSettings(input: StudioSettings, request: AbortSignal): Promise<StudioSettings> {
    const signal = AbortSignal.any([request, this.stopping])
    if ((input.scope !== undefined && input.scope !== this.settingsScope) || input.revision !== this.sessions.settings.revision) {
      throw new StudioError('SETTINGS_CONFLICT', 'Studio settings changed. Reload them before saving.', 409)
    }
    await Promise.all([input.assistant, input.leader].map(route => route ? confirmStudioModel(this.ctx, route, signal) : undefined))
    signal.throwIfAborted()
    return this.scoped(this.store.saveSettings(input))
  }

  readonly operations: Omit<StudioHttpOperations, StudioConfigurationOp> = {
    state: () => {
      this.refreshBlockers()
      return { projects: this.domain.studioProjects(), pendingCount: this.store.pendingCount(), settings: this.scoped(this.sessions.settings),
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
    tasks: ({ conversationId, before }) => {
      if (conversationId !== undefined) this.conversation(conversationId)
      return this.domain.tasks(conversationId, before)
    },
    task: ({ taskId }) => this.task(taskId),
    stopTask: ({ taskId }) => {
      this.task(taskId)
      if (!this.sessions.stopTask(taskId)) throw new StudioError('TASK_NOT_ACTIVE', 'This task is no longer active.', 409)
      return this.task(taskId)
    },
    pending: ({ before }) => {
      this.refreshBlockers()
      const page = this.store.pending(before)
      return { ...page, items: page.items.map(item => {
        const recordSessionId = item.kind === 'blocked' ? this.domain.studioPendingRecord(item.id) : undefined
        return recordSessionId && (this.store.session(recordSessionId) || this.domain.studioSession(recordSessionId))
          ? { ...item, recordSessionId } : item
      }) }
    },
    answer: ({ id, value }) => studioBlockTarget(id) ? this.answerBlock(id, value, 'gui') : this.sessions.answer(id, value, 'gui', 'gui'),
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
    if (item?.kind === 'question' && item.conversationId !== conversationId) {
      // 兼容既有的问题卡片；项目消息不加入 Assistant 的时间线。
      if (item.mobile === 'topic' && item.state === 'pending') {
        try { this.sessions.answer(item.id, input.text, 'feishu', 'topic') }
        catch (error) { if (!(error instanceof StudioError)) throw error }
      }
      return Promise.resolve()
    }
    if ((anchors.length || input.threadId) && !item && !parent) return Promise.resolve()
    const replyTo = item?.conversationId === conversationId
      ? (item.kind === 'confirmation' && this.store.message(conversationId, item.id) ? item.id : item.messageId) ?? parent?.id
      : parent?.id
    const { message, created } = this.store.addUser({ requestId: input.id, conversationId, channel: 'feishu', text: input.text,
      createdAt: input.sourceTimeMs, ...(replyTo ? { replyTo } : {}), feishu: { scope: input.scope, id: input.id,
        ...(input.threadId ? { threadId: input.threadId } : {}) } })
    if (!created) return Promise.resolve()
    if (item?.kind === 'question') {
      // 旧记录里的澄清仍可在绑定的原卡片补充；新对话不会再创建这类阻塞问答。
      let accepted = false
      if (item.mobile === 'topic' && item.state === 'pending') {
        try { this.sessions.answer(item.id, input.text, 'feishu', 'topic'); accepted = true }
        catch (error) { if (!(error instanceof StudioError)) throw error }
      }
      if (!accepted) this.store.addReply(message.id, '这项问题已处理或失效。')
      this.store.finishMessage(message.id, 'completed')
    } else this.ownerInput(message, item)
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

}
