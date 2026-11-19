/** Capture owner input before the Worker reads it and expose the pending inbox to the owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ManagedWorkerStore } from './store.ts'

const TEXT_LIMIT = 32_000
const reviewArgs = z.tuple([
  z.uuid(), z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),
  z.enum(['unchanged', 'pause']),
])

/** The installed rc.3 loop appends this event before waking the driver. It is not a step or a model message. */
interface InboxSplice {
  seq: number
  time: number
  data: { inserted: readonly UserMessage[]; removedCount?: number }
}

interface CommandResult { kind: 'success' | 'error'; text: string }

/** Queue edits retain source IDs, not new authority. Persist only new owner submissions, and let the ledger deduplicate insertions. */
export function captureDocumentInstructions(ctx: Context, store: ManagedWorkerStore, eligible: (session: Session) => boolean): void {
  ctx.on('session/event', (session, event) => {
    if ((event.type as string) !== 'agent/inbox/spliced' || !eligible(session)) return
    const { seq, time, data } = event as unknown as InboxSplice
    if (data.removedCount) return
    for (const message of data.inserted) {
      const source: { kind: string; rpcId?: unknown; principal?: unknown } = message.source
      // On the supported single-owner Web host the controller supplies this RPC receipt. Trusted in-process relays must use their own source.
      // Plugin relays, summaries and empty continuation requests do not become control inputs.
      if (message.role !== 'user' || source.kind !== 'user' || typeof source.rpcId !== 'string' || source.principal !== undefined) continue
      const content = message.content
      const text = content.every(block => block.type === 'text') ? content.map(block => block.text).join('\n\n') : null
      // Keep a reference even when the first version cannot record the full input (for example, attachments).
      const retained = text !== null && text.length <= TEXT_LIMIT && text.isWellFormed() && !text.includes('\0') ? text : null
      // This listener must not await. The writer must observe either the committed pending row or the Store's in-memory failure block.
      const result = store.receiveGuiInstruction(session.id, { channel: 'gui', sourceScope: session.id,
        requestId: source.rpcId, messageId: message.id, eventSeq: seq, sourceTimeMs: time, text: retained })
      if (!result.ok) ctx.logger.warn('Studio could not confirm a document input: %s', result.reason)
    }
  })
}

/** A failed write or command does not acknowledge the new instruction as effective. */
export function documentHoldError(reason: string): CommandResult | undefined {
  if (reason === 'INSTRUCTION_PENDING') return { kind: 'error', text: `${reason}: Document writes are blocked while input awaits review. Run /studio-doc inbox in the current Worker.` }
  if (reason === 'INSTRUCTION_UNCONFIRMED') return { kind: 'error', text: `${reason}: A document input could not be confirmed. Writes remain blocked in this host. After recovering storage and restarting, inspect the original chat and the document status before resuming.` }
  if (reason === 'PAUSE_UNCONFIRMED') return { kind: 'error', text: 'Pause not saved; affected writes remain blocked in this host. Retry /studio-doc pause in the current Worker, or run /studio-doc status there after restart.' }
}

/** Process only the inbox subcommands. Neither the Worker nor the question of approval is delegated to a model. */
export function instructionCommand(store: ManagedWorkerStore, sessionId: string, commandId: string, verb: string | undefined,
  argument: string): CommandResult | undefined {
  if (verb !== 'inbox' && verb !== 'review') return
  const failure = (reason: string): CommandResult => documentHoldError(reason)
    ?? { kind: 'error', text: `Document instruction control rejected: ${reason}. Run /studio-doc inbox to check current input and authorization.` }
  if (verb === 'inbox') {
    if (argument !== '') return failure('UNEXPECTED_ARGUMENTS')
    const result = store.instructionInbox(sessionId)
    if (!result.ok) return failure(result.reason)
    const { task, pending, remaining } = result.value
    const state = `Task ${task.taskId}; authorization version ${task.authorizationVersion}; ${remaining} pending; ${task.paused ? 'paused' : 'not paused'}.`
    if (!pending) return { kind: 'success', text: state }
    const { source } = pending
    const original = source.text === null ? 'The input is not retained as text here. Read the original message in the Session before reviewing.' : source.text
    return { kind: 'success', text: `${state}\nWrites are blocked until all pending input is reviewed, even if the task is not paused.\n`
      + `Instruction ${pending.instructionId}; ${source.channel} message ${source.messageId}; event ${source.eventSeq ?? 'unavailable'}.\n`
      + `Review: /studio-doc review ${pending.instructionId} ${task.authorizationVersion} <unchanged|pause>\n\n${original}` }
  }
  const parsed = reviewArgs.safeParse(argument.split(/\s+/))
  if (!parsed.success) return failure('EXPECTED_INSTRUCTION_ID_VERSION_AND_DECISION')
  const [instructionId, expectedVersion, decision] = parsed.data
  const result = store.reviewInstruction(sessionId, instructionId, expectedVersion, decision, commandId)
  if (!result.ok) return failure(result.reason)
  const { task, remaining } = result.value
  const effect = decision === 'pause' ? 'Pause effective.' : 'Instruction reviewed; the existing write scope and pause state are unchanged.'
  const next = remaining ? 'Writes still await review: /studio-doc inbox.'
    : task.paused ? 'The task remains paused; it does not resume automatically.' : 'Any further write requires a fresh check against the existing scope.'
  return { kind: 'success', text: `${effect} Task ${task.taskId}; authorization version ${task.authorizationVersion}; ${remaining} pending. ${next}` }
}
