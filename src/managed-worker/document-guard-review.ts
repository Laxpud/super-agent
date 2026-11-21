/** Bind a scope refusal to its own native tool call, then recheck the recorded effect without issuing a permit. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import type { DocumentGuardCapture } from './document-guard-store.ts'
import type { ManagedWorkerStore } from './store.ts'

export const GUARD_REVIEW_HINT = 'guard-review <evidence-id> <authorization-version>'
export const DOCUMENT_WRITE_TOOL = 'studio_write_document'
const LIVE_TAIL = 128
const MAX_DOCUMENT_TEXT = 32_000
const MAX_ARGUMENTS = MAX_DOCUMENT_TEXT * 6 + 128
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const reviewArgs = z.tuple([z.uuid(), z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(version)])
export const documentWriteActionSchema = z.strictObject({
  expectedVersion: version.describe('The document revision approved for this task.'),
  text: z.string().max(MAX_DOCUMENT_TEXT),
})

type NativeCall = NonNullable<DocumentGuardCapture['nativeCall']>
type CommandResult = { kind: 'success' | 'error'; text: string }
const refused = (reason: string, detail = ''): CommandResult => ({ kind: 'error', text: `Document guard review not recorded: ${reason}. No write or approval changed.${detail}` })
const unconfirmed = (reason: string, evidenceId: string): CommandResult => ({ kind: 'error',
  text: `Document guard review unconfirmed: ${reason}. No new finding or permit can be inferred. Check /studio-doc guard ${evidenceId} for a saved finding. Do not resend the original write.`,
})

/** Explain why this comparison cannot start; never suggest resetting a hold just to run a review. */
export function guardReviewBlockHint(reason: string): string {
  switch (reason) {
    case 'GUARD_REVIEW_LIMIT_REACHED': return 'This task and authorization version already have a recorded review, even if it used another evidence ID.'
    case 'STALE_AUTHORIZATION': return 'This is historical evidence. Do not substitute a newer authorization version.'
    case 'TASK_PAUSED': return 'The task is paused. Reviewing this refusal is not a reason to resume the task.'
    case 'INSTRUCTION_PENDING': return 'First check the pending instruction in /studio-doc inbox; the old scope cannot be used for review.'
    case 'VERSION_CONFLICT': case 'SHARED_DOCUMENT_CONFLICT': return 'The original target is no longer current. Check /studio-doc status; do not review or replay the old write.'
    case 'STALE_EXECUTION': return 'The task is bound to a different execution. Check the evidence in the current Worker.'
    case 'INSTRUCTION_UNCONFIRMED': case 'PAUSE_UNCONFIRMED': return 'Current task controls could not be confirmed. Check /studio-doc status and /studio-doc inbox when available.'
    case 'GUARD_REVIEW_NOT_ELIGIBLE': return 'Use the evidence of an initial scope refusal for this execution, with a confirmed native call.'
    default: return ''
  }
}

/** Read the original JSON as data only. Scope and exact value checks also run inside the Store. */
function callAction(event: SessionEvent<'tool/call'>): z.infer<typeof documentWriteActionSchema> | undefined {
  const raw = event.data.arguments
  if (typeof raw !== 'string' || raw.length > MAX_ARGUMENTS) return
  try {
    const parsed = documentWriteActionSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
  } catch { /* A missing or malformed native payload is not a review source. */ }
}

/** Connect only an exact tool argument snapshot to an unambiguous call in the current own turn. */
export function observeDocumentGuardCall(agent: Agent, callId: string, action: unknown): NativeCall | undefined {
  const { session } = agent
  if (session.header.origin === 'subagent') return
  const first = Math.max(session.firstLiveSeq, session.inheritedEventCount, session.seq - LIVE_TAIL)
  let matched: SessionEvent<'tool/call'> | undefined
  for (let offset = session.seq - 1; offset >= first; offset--) {
    const event = session.eventAt(SessionSeq(offset))
    if (!event || event.type === 'turn/end') return
    if (event.type === 'turn/start') {
      if (!matched || event.data.turn !== matched.data.turn) return
      const recorded = callAction(matched)
      const actual = documentWriteActionSchema.safeParse(action)
      if (!recorded || !actual.success || actual.data.expectedVersion !== recorded.expectedVersion || actual.data.text !== recorded.text) return
      return { eventSeq: matched.seq, turn: matched.data.turn, step: matched.data.step }
    }
    if (event.type === 'tool/result' && event.data.message.toolCallId === callId) return
    if (event.type === 'tool/call' && event.data.callId === callId) {
      if (matched || event.data.name !== DOCUMENT_WRITE_TOOL) return
      matched = event as SessionEvent<'tool/call'>
    }
  }
}

/** The command contains a challenge to the authorization comparison, never substitute text or an effect to execute. */
export async function documentGuardReviewCommand(ctx: Context, store: ManagedWorkerStore, agent: Agent, commandId: string,
  argument: string, signal: AbortSignal, ready: () => boolean): Promise<CommandResult> {
  const parsed = reviewArgs.safeParse(argument.split(/\s+/u))
  if (!parsed.success) return refused('EXPECTED_EVIDENCE_ID_AND_AUTHORIZATION_VERSION', ` Use /studio-doc ${GUARD_REVIEW_HINT}.`)
  const [evidenceId, authorizationVersion] = parsed.data
  const blocked = (reason: string): CommandResult => {
    if (reason === 'STORAGE_ERROR' || reason === 'STALE_HOST_RUN' || reason === 'GUARD_REVIEW_SOURCE_UNCONFIRMED') return unconfirmed(reason, evidenceId)
    const hint = guardReviewBlockHint(reason)
    return refused(reason, hint ? ` ${hint}` : '')
  }
  const idle = () => ready() && agent.session.header.origin !== 'subagent' && agent.status === 'idle'
    && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length
  if (signal.aborted) return refused('GUARD_REVIEW_CANCELLED')
  if (!idle()) return refused('DOCUMENT_WORKER_NOT_IDLE', ' Wait for the current Worker to be idle and check its status.')
  const preview = store.previewDocumentGuardReview(agent.id, evidenceId, authorizationVersion)
  if (!preview.ok) return blocked(preview.reason)
  const { nativeCall: { eventSeq, turn, step }, toolCallId } = preview.value

  try {
    // The call recorded at the original Guard is the only input. Do not search later model history for a replacement.
    await ctx.sessionPersistence.flush()
    signal.throwIfAborted()
    await using handle = await ctx.sessionPersistence.open(agent.id, 'read', { signal })
    if (eventSeq < handle.inheritedEventCount) return unconfirmed('GUARD_REVIEW_SOURCE_UNCONFIRMED', evidenceId)
    const { events: [event] } = await handle.read(eventSeq, 1, { signal })
    signal.throwIfAborted()
    if (!event || event.seq !== eventSeq || event.type !== 'tool/call' || event.data.callId !== toolCallId
      || event.data.name !== DOCUMENT_WRITE_TOOL || event.data.turn !== turn || event.data.step !== step) {
      return unconfirmed('GUARD_REVIEW_SOURCE_UNCONFIRMED', evidenceId)
    }
    const action = callAction(event as SessionEvent<'tool/call'>)
    if (!action) return unconfirmed('GUARD_REVIEW_SOURCE_UNCONFIRMED', evidenceId)
    if (!idle()) return refused('DOCUMENT_WORKER_NOT_IDLE')
    const review = store.reviewDocumentGuard(agent.id, evidenceId, authorizationVersion, commandId, { eventSeq, turn, step, toolCallId, action })
    if (!review.ok) return blocked(review.reason)
    const { reviewId, outcome } = review.value
    const finding = outcome === 'refusal-confirmed' ? 'Original refusal confirmed: the proposed replacement differs from the approved text.'
      : 'Comparison inconsistent: the original call matches the approved text, but the earlier Guard refused it. Check the recorded evidence; do not replay the old call.'
    return { kind: 'success', text: `Document guard review ${reviewId}, authorization v${authorizationVersion}. ${finding}\nEvidence ${evidenceId}; native call event ${eventSeq}. This did not issue a permit, change authorization, or run a write.` }
  } catch {
    return unconfirmed(signal.aborted ? 'GUARD_REVIEW_CANCELLED' : 'GUARD_REVIEW_SOURCE_UNCONFIRMED', evidenceId)
  }
}
