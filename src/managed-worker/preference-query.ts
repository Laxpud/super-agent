/** Answer one native owner preference query before any model request, without joining the model surface. */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { memoryQuery } from './memory.ts'
import { preferenceQueryIntent } from './preference-query-intent.ts'
import type { ManagedWorkerStore } from './store.ts'

const QUERY_NAME = 'studio-memory-query'
const SOURCE_TAIL_LIMIT = 128
interface QueryStep {
  agent: Agent
  messages: readonly UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}
interface InboxSplice { target?: unknown; removedCount?: unknown; inserted?: readonly UserMessage[] }
interface QuerySource { kind: typeof QUERY_NAME; messageId: string; requestId: string; sourceEventSeq: SessionSeq }
// rc.3 adds these log-only records and atomic batch append. The development declarations predate this lifecycle.
type QueryReceipt = readonly [
  readonly ['command/run', { commandId: string; name: typeof QUERY_NAME; source: QuerySource }],
  readonly ['command/done', { commandId: string; kind: 'success' | 'error'; text: string; sourceEventSeq?: SessionSeq }],
]

function ownerText(message: UserMessage): { requestId: string; text: string } | undefined {
  const source: { kind: string; rpcId?: unknown; principal?: unknown } = message.source
  const block = message.content[0]
  if (source.kind === 'user' && source.principal === undefined && typeof source.rpcId === 'string' && source.rpcId
    && message.content.length === 1 && block?.type === 'text') return { requestId: source.rpcId, text: block.text }
}

/** Find the exact first-turn input in this live Session's own native inbox log; edits and inherited inputs cannot supply it. */
function originalInput(step: QueryStep, message: UserMessage, input: { requestId: string; text: string }): SessionSeq | undefined {
  const session = step.agent.session
  const first = Math.max(session.firstLiveSeq, session.inheritedEventCount, session.seq - SOURCE_TAIL_LIMIT)
  let currentTurn = false
  for (let offset = session.seq - 1; offset >= first; offset--) {
    const event = session.eventAt(SessionSeq(offset))
    if (!event) return
    if (!currentTurn && event.type === 'turn/end') return
    if (!currentTurn && event.type === 'turn/start') {
      if (event.data.turn !== step.turn) return
      currentTurn = true
    }
    if (event.type === 'user/message' && event.data.id === message.id) return
    if ((event.type as string) !== 'agent/inbox/spliced') continue
    const splice = event.data as unknown as InboxSplice
    const inserted = splice.inserted?.find(value => value.id === message.id)
    if (!inserted) continue
    const recorded = ownerText(inserted)
    if (currentTurn && splice.target === 'next-turn' && splice.removedCount === undefined
      && recorded?.requestId === input.requestId && recorded.text === input.text) return event.seq
    return
  }
}

/** The caller has already checked the exact ordinary Assistant's binding, preset, and single-owner Web Host. */
export function answerPreferenceQuery(store: ManagedWorkerStore, step: QueryStep): boolean {
  const { agent, messages, signal } = step
  // Descheduling this otherwise empty turn must not consume a business input or strand another queued prompt.
  if (agent.session.header.origin === 'subagent' || step.step !== 1 || messages.length !== 1
    || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return false
  const message = messages[0]!
  const input = ownerText(message)
  const query = input && preferenceQueryIntent(input.text)
  if (!input || !query) return false
  const sourceEventSeq = originalInput(step, message, input)
  if (sourceEventSeq === undefined) return false
  signal.throwIfAborted()

  // Resolve and publish synchronously so neither the queried revision nor the exact Session changes in an await gap.
  const result = memoryQuery(store, query)
  const commandId = `studio-memory-query:${randomUUID()}`
  const source: QuerySource = { kind: QUERY_NAME, messageId: message.id, requestId: input.requestId, sourceEventSeq }
  const batch: QueryReceipt = [
    ['command/run', { commandId, name: QUERY_NAME, source }],
    ['command/done', { commandId, kind: result.kind, text: result.text, ...(result.kind === 'success' ? { sourceEventSeq } : {}) }],
  ]
  // Use the native command card lifecycle for delivery, not commands.execute (which attributes a slash command to a human).
  const log = agent.session as unknown as { append(batch: QueryReceipt): readonly unknown[] }
  log.append(batch)
  return true
}
