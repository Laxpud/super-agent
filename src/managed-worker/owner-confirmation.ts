/** Ask the active owner UI for one bounded decision; no model argument or free-text message can replace it. */
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

interface OwnerConfirmation {
  id: string
  question: string
  detail: string
  approve: string
  /** Only an explicitly supported, Host-owned action can offer a Feishu approval button. */
  allowMobile?: boolean
}
type StudioAnswerer = (fields: OwnerConfirmation, signal: AbortSignal) => Promise<boolean>
const studioAnswerers = new WeakMap<Agent, StudioAnswerer>()

/** Install the shared GUI/Feishu answerer for one exact Studio conversation turn; legacy Sessions retain the native dialog. */
export function installStudioOwnerAnswerer(agent: Agent, answer: StudioAnswerer): () => void {
  studioAnswerers.set(agent, answer)
  return () => { if (studioAnswerers.get(agent) === answer) studioAnswerers.delete(agent) }
}

export function ownerConfirmationAvailable(agent: Agent): boolean {
  return studioAnswerers.has(agent) || nativeQuestions(agent.ctx) !== undefined
}

/** Only the selected approval on this exact foreground question counts. Cancelled questions never become delayed authority. */
export async function confirmWithOwner(agent: Agent, signal: AbortSignal, fields: OwnerConfirmation): Promise<boolean> {
  signal.throwIfAborted()
  const shared = studioAnswerers.get(agent)
  if (shared) {
    const answer = await shared(fields, signal)
    signal.throwIfAborted()
    return answer
  }
  const { id, question, detail, approve } = fields
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
