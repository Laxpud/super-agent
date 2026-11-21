/** Verify a new standalone owner input before the model, and publish a history-only receipt tied to that input. */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'

const SOURCE_TAIL_LIMIT = 128
export interface OwnerInboxStep {
  agent: Agent
  messages: readonly UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

export interface OwnerInboxInput {
  assistantSessionId: string
  sourceRequestId: string
  sourceMessageId: string
  sourceEventSeq: SessionSeq
  turn: number
  text: string
  boundary: number
}

interface InboxSplice { target?: unknown; removedCount?: unknown; inserted?: readonly UserMessage[] }
type ReceiptName = 'studio-memory-query' | 'studio-memory-correction' | 'studio-memory-restrict' | 'studio-memory-forget' | 'studio-memory-scope-change'
  | 'studio-project-fact-work' | 'studio-document-continuation'
type ReceiptResult = { kind: 'success' | 'error'; text: string }
interface ReceiptSource { kind: ReceiptName; messageId: string; requestId: string; sourceEventSeq: SessionSeq }
// rc.3 adds these log-only records and atomic batch append. The development declarations predate this lifecycle.
type ReceiptEvents = readonly [
  readonly ['command/run', { commandId: string; name: ReceiptName; source: ReceiptSource }],
  readonly ['command/done', { commandId: string; kind: 'success' | 'error'; text: string; sourceEventSeq?: SessionSeq }],
]

function ownerText(message: UserMessage): { sourceRequestId: string; text: string } | undefined {
  const source: { kind: string; rpcId?: unknown; principal?: unknown } = message.source
  const block = message.content[0]
  if (source.kind === 'user' && source.principal === undefined && typeof source.rpcId === 'string' && source.rpcId
    && message.content.length === 1 && block?.type === 'text') return { sourceRequestId: source.rpcId, text: block.text }
}

/** Check the original queue insertion, not a subsequent edit that reuses the message or request ID. */
export function isOwnerInboxInsertion(event: SessionEvent | undefined, input: Pick<OwnerInboxInput, 'sourceMessageId' | 'sourceRequestId' | 'text'>): boolean {
  if (!event || (event.type as string) !== 'agent/inbox/spliced') return false
  const splice = event.data as unknown as InboxSplice
  const inserted = splice.inserted?.find(value => value.id === input.sourceMessageId)
  const recorded = inserted && ownerText(inserted)
  return splice.target === 'next-turn' && splice.removedCount === undefined
    && recorded?.sourceRequestId === input.sourceRequestId && recorded.text === input.text
}

/** Find one newly logged owner prompt in a live turn. Never consume a batch or strand pending business input. */
export function currentOwnerInboxInput({ agent, messages, step, turn }: OwnerInboxStep): OwnerInboxInput | undefined {
  if (agent.session.header.origin === 'subagent' || step !== 1 || messages.length !== 1
    || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) return
  const [message] = messages
  const request = message && ownerText(message)
  if (!request) return
  const session = agent.session
  const boundary = session.seq
  const first = Math.max(session.firstLiveSeq, session.inheritedEventCount, boundary - SOURCE_TAIL_LIMIT)
  const exact = { ...request, sourceMessageId: message.id }
  let currentTurn = false
  for (let offset = boundary - 1; offset >= first; offset--) {
    const event = session.eventAt(SessionSeq(offset))
    if (!event) return
    if (!currentTurn && event.type === 'turn/end') return
    if (!currentTurn && event.type === 'turn/start') {
      if (event.data.turn !== turn) return
      currentTurn = true
    }
    if (event.type === 'user/message' && event.data.id === exact.sourceMessageId) return
    if ((event.type as string) !== 'agent/inbox/spliced') continue
    const splice = event.data as unknown as InboxSplice
    if (!splice.inserted?.some(value => value.id === exact.sourceMessageId)) continue
    if (currentTurn && isOwnerInboxInsertion(event, exact)) {
      return { ...exact, assistantSessionId: agent.id, sourceEventSeq: event.seq, turn, boundary }
    }
    return
  }
}

/** Any new input or lifecycle event makes an async confirmation's original turn snapshot stale. */
export function isSameOwnerInboxTurn(agent: Agent, input: OwnerInboxInput): boolean {
  return agent.id === input.assistantSessionId && agent.session.seq === input.boundary
    && agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
}

/** Use the native card lifecycle for display, not commands.execute (which attributes a slash command to a human). */
export function publishOwnerInboxReceipt(agent: Agent, input: OwnerInboxInput, name: ReceiptName, result: ReceiptResult): void {
  const commandId = `${name}:${randomUUID()}`
  const { sourceMessageId: messageId, sourceRequestId: requestId, sourceEventSeq } = input
  const source: ReceiptSource = { kind: name, messageId, requestId, sourceEventSeq }
  const batch: ReceiptEvents = [
    ['command/run', { commandId, name, source }],
    ['command/done', { commandId, ...result, ...(result.kind === 'success' ? { sourceEventSeq } : {}) }],
  ]
  const log = agent.session as unknown as { append(batch: ReceiptEvents): readonly unknown[] }
  log.append(batch)
}
