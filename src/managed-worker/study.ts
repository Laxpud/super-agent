/** Coordinate an unprojected text study and deliver the actual synthesis without feeding it back to the Assistant. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { startStudioRouterWork } from '../studio/router-work.ts'
import { DRAFT_TIMEOUT_MS, ownerRequest, type StudioAssistant } from './assistant.ts'
import { STUDY_DELEGATE as DELEGATE_STUDY, STUDY_READ as READ_STUDY } from './result-tool-names.ts'
import { DRAFT_TEXT_LIMIT, type ManagedResult, type ManagedWorkerStore } from './store.ts'
import { STUDY_MAX_PARTS, STUDY_MIN_PARTS, type Study, type StudyStep } from './study-store.ts'

const TOOL_TIMEOUT_MS = (STUDY_MAX_PARTS + 1) * DRAFT_TIMEOUT_MS + 10_000
const quote = z.string().min(1).max(DRAFT_TEXT_LIMIT)
const studyArgs = z.strictObject({
  instruction: quote.describe('Exact excerpt of the owner’s common assignment or question, occurring once in this message.'),
  excerpts: z.array(quote).min(STUDY_MIN_PARTS).max(STUDY_MAX_PARTS)
    .describe('One exact material excerpt per investigation. These must occur once each, not overlapping the assignment or one another.'),
})
const readArgs = z.strictObject({ taskId: z.uuid() })
const commandArgs = z.tuple([z.uuid(), z.string().regex(/^[1-9]\d*$/u).transform(Number)
  .pipe(z.number().int().max(STUDY_MAX_PARTS + 1)).optional()])
const presentation = z.strictObject({ title: z.string(), text: z.string() })
const studyOutputSchema: ToolDefinition['output']['schema'] = { type: 'object', additionalProperties: false,
  required: ['title', 'receipt', 'text'], properties: { title: { type: 'string' }, receipt: { type: 'string' }, text: { type: 'string' } } }
const output = presentation.extend({ receipt: z.string() })

export function isStudyTool(name: string): boolean { return name === DELEGATE_STUDY || name === READ_STUDY }

function stepReceipt(step: StudyStep): string {
  const source = step.result ? ` Worker message ${step.result.messageId} (turn ${step.result.turn}, event ${step.result.eventSeq}).` : ''
  return `Step ${step.ordinal} (${step.kind}), task ${step.taskId}: ${step.state}. Worker Bot ${step.workerBotId}; Session ${step.workerSessionId}; execution epoch ${step.executionEpoch}.${source}`
    + (step.failure ? ` Reason: ${step.failure}.` : '')
}

/** Keep a partial investigation visibly distinct from a final synthesis. Retrieve one step without rerunning it. */
export function studyOutput(study: Study, step?: StudyStep): z.infer<typeof output> {
  const synthesis = study.steps.find(entry => entry.kind === 'synthesis')
  const status = `Study ${study.taskId}: ${study.state}.${study.failure ? ` Reason: ${study.failure}.` : ''}`
  const source = `Owner source: message ${study.sourceMessageId} in Assistant Session ${study.assistantSessionId}.`
  const hint = `Use /studio-study ${study.taskId} [step-number] in a Studio Assistant Session.`
  const receipt = `${status}\n${hint}`
  if (step) {
    const excerpt = step.excerpt === undefined ? '' : `\n\nAssigned material:\n${step.excerpt}`
    const result = step.result ? `\n\nWorker result:\n${step.result.text}` : ''
    return { title: `Study step ${step.ordinal}`, receipt,
      text: `${status}\n${source}\n${stepReceipt(step)}\n\nOwner assignment:\n${study.instruction}${excerpt}${result}` }
  }
  const stages = study.steps.map(stepReceipt).join('\n')
  const result = study.state === 'completed' && synthesis?.result ? `\n\nSynthesis Worker result:\n${synthesis.result.text}` : ''
  return { title: result ? 'Study synthesis' : `Study ${study.state}`, receipt, text: `${status}\n${source}\n${stages}\n${hint}${result}` }
}

function unwrap<T>(value: ManagedResult<T>): T {
  if (!value.ok) throw new Error(`Studio study rejected: ${value.reason}`)
  return value.value
}

/** Own one bounded, dependency-ordered run; neither the Assistant nor a Worker provides the synthesis inputs. */
export class StudioStudy {
  private readonly active = new Set<Promise<Study>>()

  constructor(private readonly store: ManagedWorkerStore, private readonly workers: StudioAssistant,
    private readonly ready: (agent: Agent) => boolean, private readonly stopping: AbortSignal) {}

  async drain(): Promise<void> { await Promise.allSettled(this.active) }

  install(agent: Agent): () => void {
    // Only the user-facing card includes the exact Worker body. The next Assistant step sees a short status and ID.
    const view: Pick<ToolDefinition, 'output' | 'presentResult'> = {
      output: { schema: studyOutputSchema,
        render: (_args, value) => [{ type: 'text', text: output.parse(value).receipt }],
        presentationMeta: (_args, value) => { const { title, text } = output.parse(value); return { title, text } },
      },
      presentResult: (_args, result) => {
        const parsed = presentation.safeParse(result.meta)
        if (parsed.success) return { card: 'generic', title: parsed.data.title, content: [{ type: 'text', text: parsed.data.text }] }
      },
    }
    const removeDelegate = agent.ctx.tools.register({ ...view, name: DELEGATE_STUDY,
      description: 'Assign separate investigations and one technical synthesis for the current unprojected owner text request. Returns the recorded study and where to retrieve its results.',
      parameters: z.toJSONSchema(studyArgs), timeoutMs: TOOL_TIMEOUT_MS,
      presentCall: () => ({ card: 'generic', title: 'Delegate a text study' }),
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const parsed = studyArgs.safeParse(args)
        if (!parsed.success || exec.agent !== agent || exec.parent !== undefined || !this.ready(agent)) {
          throw new Error('Studio study rejected: INVALID_EXECUTION')
        }
        const source = ownerRequest(agent, exec.callId, DELEGATE_STUDY)
        if (!source) throw new Error('Studio study rejected: EXPECTED_CURRENT_OWNER_TEXT_REQUEST')
        const signal = AbortSignal.any([exec.signal, this.stopping])
        signal.throwIfAborted()
        const { cwd, model: { provider, model, reasoningEffort } } = this.workers.checkedRoute(agent)
        // Pin this run's route once. Later model picker changes must not change an assigned step.
        const route = { cwd, model: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) } }
        const { study, created } = unwrap(this.store.studies.create({ ...source, ...parsed.data, assistantSessionId: agent.id, toolCallId: exec.callId }))
        if (!created) return studyOutput(study)
        // Studio 保留编排和原任务的关联，不在前台工具调用中等待所有调查与综合。
        try {
          if (startStudioRouterWork(agent, { id: study.taskId, kind: 'study' }, async workerSignal => studyOutput(await this.run(agent, study, route, workerSignal)).receipt)) {
            ;(exec as typeof exec & { concludeTurn?(): void }).concludeTurn?.()
            return studyOutput(study)
          }
        } catch (error) {
          this.store.studies.stop(agent.id, study.taskId, 'ROUTER_HANDOFF_FAILED')
          throw error
        }
        const running = this.run(agent, study, route, signal)
        this.active.add(running)
        try { return studyOutput(await running) } finally { this.active.delete(running) }
      },
    })
    try {
      const removeRead = agent.ctx.tools.register({ ...view, name: READ_STUDY,
        description: 'Retrieve a study and its saved synthesis by exact ID without dispatching a Worker.',
        parameters: z.toJSONSchema(readArgs),
        presentCall: () => ({ card: 'generic', title: 'Retrieve a text study' }),
        execute: async (args, exec) => {
          exec.signal.throwIfAborted()
          const parsed = readArgs.safeParse(args)
          if (!parsed.success || exec.agent !== agent || exec.parent !== undefined || !this.ready(agent)) {
            throw new Error('Studio study rejected: INVALID_EXECUTION')
          }
          return studyOutput(unwrap(this.store.studies.read(agent.id, parsed.data.taskId)))
        },
      })
      return () => { try { removeRead() } finally { removeDelegate() } }
    } catch (error) { removeDelegate(); throw error }
  }

  command(agent: Agent, argument: string): { kind: 'success' | 'error'; text: string } {
    if (!this.ready(agent)) return { kind: 'error', text: 'Open a Studio Assistant Session to read a study.' }
    const parsed = commandArgs.safeParse(argument.trim().split(/\s+/u))
    if (!parsed.success) return { kind: 'error', text: 'Use /studio-study <task-id> [step-number].' }
    const [taskId, ordinal] = parsed.data
    const saved = this.store.studies.read(agent.id, taskId)
    if (!saved.ok) return { kind: 'error', text: `Cannot read Studio study: ${saved.reason}.` }
    const step = ordinal === undefined ? undefined : saved.value.steps.find(entry => entry.ordinal === ordinal)
    if (ordinal !== undefined && !step) return { kind: 'error', text: 'That study has no step with this number.' }
    return { kind: 'success', text: studyOutput(saved.value, step).text }
  }

  private async run(agent: Agent, initial: Study, route: ReturnType<StudioAssistant['checkedRoute']>, signal: AbortSignal): Promise<Study> {
    const { taskId, assistantSessionId } = initial
    const hold = () => signal.aborted ? 'STUDY_ABORTED' : !this.ready(agent) ? 'ASSISTANT_UNAVAILABLE'
      : this.workers.providerDenial(route.model.provider)
    const stop = (reason: string) => {
      const ended = this.store.studies.stop(assistantSessionId, taskId, reason)
      if (ended.ok) return ended.value
      // A reservation can reject after persisting a terminal state. Do not overwrite it, or claim an unknown outcome.
      const saved = this.store.studies.read(assistantSessionId, taskId)
      if (saved.ok && saved.value.state !== 'running') return saved.value
      throw new Error(`Studio could not confirm study ${taskId}: ${ended.reason}. Read /studio-study ${taskId}; do not resubmit the old request.`)
    }
    let study = initial
    while (study.state === 'running') {
      const denied = hold()
      if (denied) return stop(denied)
      // Persist the exact relay and reserve just this step before mounting its Worker.
      const prepared = this.store.studies.prepare(assistantSessionId, taskId)
      if (!prepared.ok) return stop(prepared.reason)
      const { step, inputText } = prepared.value
      const finished = await this.workers.runTextWorker(agent, SessionId(step.workerSessionId), route, inputText, signal, {
        beforeRelay: () => hold() ?? (this.store.studies.current(assistantSessionId, step) ? undefined : 'STUDY_STEP_UNAVAILABLE'),
        beforeEnter: () => {
          const denied = hold()
          if (denied) return denied
          const began = this.store.studies.begin(assistantSessionId, step)
          return began.ok ? undefined : began.reason
        },
      })
      const blocked = hold()
      const saved = this.store.studies.settle(assistantSessionId, step, blocked ? undefined : finished.result, blocked ?? finished.failure)
      if (!saved.ok) return stop(saved.reason)
      study = saved.value
    }
    return study
  }
}
