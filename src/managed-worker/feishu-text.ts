/** Route one explicitly requested Feishu text task to the restricted Worker and preserve its result independently of delivery. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { draftOutput, type StudioAssistant } from './assistant.ts'
import { DRAFT_TEXT_LIMIT, type ManagedWorkerStore, type StudioFeishuDraftTask, type StudioFeishuInstruction } from './store.ts'

export interface FeishuTextRoute {
  cwd: string
  provider: string
  model: string
  reasoningEffort: string
}

export const validateFeishuTextRoute = (config: FeishuTextRoute): void => {
  if (!isAbsolute(config.cwd) || [config.cwd, config.provider, config.model, config.reasoningEffort].some(value => !value.isWellFormed() || value.includes('\0'))
    || !config.provider.trim() || !config.model.trim()) throw new Error('Studio Feishu text requires an absolute workspace and an explicit model route')
}

/** Use short Feishu replies; the full stored result is returned verbatim by the Web result command. */
const REPLY_BYTES = 12_000
const taskId = z.uuid()

export function feishuDraftOutput(task: StudioFeishuDraftTask): string {
  return `From Feishu message ${task.source.messageId}.\n${draftOutput(task).text}`
}

function resultReply(task: StudioFeishuDraftTask): string {
  const content = feishuDraftOutput(task)
  return Buffer.byteLength(content, 'utf8') <= REPLY_BYTES ? content
    : `Task ${task.taskId}: ${task.state}. The saved text exceeds this reply limit. Read it with /studio-result ${task.taskId} in a Studio Assistant Session.`
}

type Reply = (text: string, phase?: 'accepted' | 'final') => void

/** A disconnected transport cannot erase running work or cause it to be relaunched. All work drains before the Store closes. */
export class StudioFeishuText {
  private readonly work = new Set<Promise<void>>()

  constructor(private readonly store: ManagedWorkerStore, private readonly workers: StudioAssistant,
    private readonly config: FeishuTextRoute, private readonly stopping: AbortSignal, private readonly allowed: () => boolean) {}

  async drain(): Promise<void> { await Promise.all(this.work) }

  /** Accept only the explicit text route, never a document correction or a guessed task. */
  receive(source: StudioFeishuInstruction, reply: Reply): void {
    if (this.stopping.aborted || !this.allowed() || !this.store.feishuDraftScopeAvailable(source.sourceScope)) return
    const text = source.text
    const result = text === null ? undefined : /^result[ \t]+(\S+)\s*$/u.exec(text)
    if (result) {
      const id = taskId.safeParse(result[1])
      if (!id.success) { reply('Expected result <task-id>.'); return }
      const saved = this.store.readFeishuDraft(id.data, source.sourceScope)
      reply(saved.ok ? resultReply(saved.value) : `Could not retrieve this task: ${saved.reason}.`)
      return
    }
    const request = text === null ? undefined : /^(?:draft:|起草：)[ \t]*([\s\S]+)$/u.exec(text)?.[1]
    if (!request || !request.trim() || request.length > DRAFT_TEXT_LIMIT) {
      reply('No task was started. Send draft: followed by a self-contained text request, or result <task-id>.')
      return
    }
    const workerId = SessionId(randomUUID())
    const reserved = this.store.startFeishuDraft(source, request, workerId)
    if (!reserved.ok) { reply(`No new task was confirmed: ${reserved.reason}.`); return }
    const { task, created } = reserved.value
    if (!created) return
    reply(`Text task ${task.taskId} registered. Retrieve the same task with result ${task.taskId} in this chat or /studio-result ${task.taskId} in Web.`, 'accepted')
    const running = this.run(task, workerId, request).then(saved => {
      reply(saved ?? `The result of task ${task.taskId} could not be confirmed. Check it from Web; do not resubmit the old request.`, 'final')
    }).catch(() => { reply(`Could not confirm task ${task.taskId}. Check its recorded state in Web.`, 'final') })
      .finally(() => { this.work.delete(running) })
    this.work.add(running)
  }

  private async run(task: StudioFeishuDraftTask, workerId: SessionId, text: string): Promise<string | undefined> {
    const { cwd, provider, model, reasoningEffort } = this.config
    const route = { cwd, model: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) } }
    const check = () => this.allowed() && this.store.feishuDraftCurrent(task) ? undefined : 'FEISHU_TEXT_EXECUTION_UNAVAILABLE'
    // No live Web Assistant or chat model is needed to route this already classified request.
    const { result, failure } = await this.workers.runTextWorker(undefined, workerId, route, text, this.stopping,
      { beforeRelay: check, beforeEnter: check })
    const saved = this.store.settleFeishuDraft(task, result, result ? '' : failure)
    return saved.ok ? resultReply(saved.value) : undefined
  }
}
