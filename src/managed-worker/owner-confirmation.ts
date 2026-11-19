/** Ask the native rc.3 Web answerer for one bounded owner decision; no tool argument or chat reply can replace it. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

const DECLINE = 'Not now'

interface NativeQuestions {
  ask(request: { agent: Agent; signal: AbortSignal; questions: Array<{
    id: string; question: string; detail: string; options: Array<{ label: string }>;
    intent: { kind: 'approval'; approve: string; reject: string };
  }> }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>
}

function nativeQuestions(ctx: Context): NativeQuestions | undefined {
  const questions = (ctx as unknown as { get(name: string): unknown }).get('userQuestions') as Partial<NativeQuestions> | undefined
  return typeof questions?.ask === 'function' ? questions as NativeQuestions : undefined
}

export function ownerConfirmationAvailable(agent: Agent): boolean { return nativeQuestions(agent.ctx) !== undefined }

/** Only the selected approval on this exact foreground question counts. Cancelled questions never become delayed authority. */
export async function confirmWithOwner(agent: Agent, signal: AbortSignal,
  { id, question, detail, approve }: { id: string; question: string; detail: string; approve: string }): Promise<boolean> {
  signal.throwIfAborted()
  const questions = nativeQuestions(agent.ctx)
  if (!questions) throw new Error('OWNER_CONFIRMATION_UNAVAILABLE')
  const answer = await questions.ask({ agent, signal, questions: [{ id, question, detail,
    options: [{ label: DECLINE }, { label: approve }], intent: { kind: 'approval', approve, reject: DECLINE },
  }] })
  signal.throwIfAborted()
  const choice = answer.answers[0]
  return answer.answers.length === 1 && choice?.id === id && choice.custom === undefined
    && choice.selected.length === 1 && choice.selected[0] === approve
}
