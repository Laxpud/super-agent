/** Route one explicitly requested Feishu text task to the restricted Worker and preserve its result independently of delivery. */
import { isAbsolute } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { newStudioSessionId } from '../studio/source.ts'
import { draftOutput, type StudioAssistant } from './assistant.ts'
import { FEISHU_DRAFT_LIST_LIMIT } from './feishu-draft-store.ts'
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

/** Help the owner locate a task after an unconfirmed reply, without making a delivery or retry decision. */
export function feishuDraftsCommand(store: ManagedWorkerStore): { kind: 'success' | 'error'; text: string } {
  const result = store.recentFeishuDrafts()
  if (!result.ok) return { kind: 'error', text: result.reason === 'FEISHU_TEXT_SCOPE_REQUIRED'
    ? 'No Feishu text inbox is configured. If you know the task ID, use /studio-result <task-id>.'
    : `Could not confirm saved Feishu tasks (${result.reason}).` }
  if (!result.value.length) return { kind: 'success', text: 'No saved text tasks for the configured Feishu private chat. This does not confirm whether your message arrived. Do not resend based on this check alone.' }
  const lines = result.value.map(task => `${task.sentAt} | Feishu message ${task.messageId} | execution ${task.state} | /studio-result ${task.taskId}`)
  return { kind: 'success', text: [`Saved Feishu text tasks for the configured private chat (up to ${FEISHU_DRAFT_LIST_LIMIT}, newest message first, time in UTC):`,
    ...lines, 'Use the matching command to check the task or read its saved result. These records do not confirm Feishu reply delivery.'].join('\n') }
}

function resultReply(task: StudioFeishuDraftTask): string {
  const content = feishuDraftOutput(task)
  return Buffer.byteLength(content, 'utf8') <= REPLY_BYTES ? content
    : `Task ${task.taskId}: ${task.state}. The saved text exceeds this reply limit. Read it with /studio-result ${task.taskId} in a Studio Assistant Session.`
}

type Reply = (text: string, phase?: 'accepted' | 'final') => void
type FeishuTextCommand = { kind: 'draft' | 'result'; argument: string }

/** Reserve the explicit namespaces even for malformed arguments; they must not fall through as corrections. */
export function feishuTextCommand(text: string): FeishuTextCommand | undefined {
  const draft = /^(?:draft:|起草：)[ \t]*/u.exec(text)
  if (draft) return { kind: 'draft', argument: text.slice(draft[0].length) }
  if (/^result(?=\s|$)/u.test(text)) return { kind: 'result', argument: text.slice('result'.length).trim() }
}

/** A disconnected transport cannot erase running work or cause it to be relaunched. All work drains before the Store closes. */
export class StudioFeishuText {
  private readonly work = new Set<Promise<void>>()

  constructor(private readonly store: ManagedWorkerStore, private readonly workers: StudioAssistant,
    private readonly config: FeishuTextRoute, private readonly stopping: AbortSignal, private readonly allowed: () => boolean) {}

  async drain(): Promise<void> { await Promise.all(this.work) }

  /** Accept only the explicit text route, never a document correction or a guessed task. */
  receive(source: StudioFeishuInstruction, command: FeishuTextCommand | undefined, reply: Reply): void {
    if (this.stopping.aborted || !this.allowed()) return
    if (command) {
      // Persist the first route before interpreting arguments or checking whether work may start, even in text-only mode.
      const claim = this.store.claimFeishuTextDelivery(source, command.kind)
      if (!claim.ok) { reply('Studio could not confirm this message route. No text action was started.'); return }
      if (!claim.value.claimed) return
    }
    if (command?.kind === 'result') {
      const id = taskId.safeParse(source.text === null ? undefined : command.argument)
      if (!id.success) { reply('Expected result <task-id>. This message did not change a document.'); return }
      const saved = this.store.readFeishuDraft(id.data, source.sourceScope)
      reply(saved.ok ? resultReply(saved.value) : `Could not retrieve this task: ${saved.reason}.`)
      return
    }
    const request = command?.kind === 'draft' && source.text !== null ? command.argument : undefined
    if (!request || !request.trim() || request.length > DRAFT_TEXT_LIMIT) {
      reply('No task was started. Send draft: followed by a self-contained text request, or result <task-id>.')
      return
    }
    const denial = this.workers.providerDenial(this.config.provider)
    if (denial) { reply(`No text task was started. ${denial}`); return }
    const workerId = newStudioSessionId()
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
