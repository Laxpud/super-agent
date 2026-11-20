/** Durable requests, model routes, and outcomes for independent Studio Advisor consultations. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { StudioProjectBinding } from './project-store.js'
import type { ManagedResult, StudioDraftResult } from './store.js'
import { assistantSourceUsed } from './study-store.js'

const TEXT_LIMIT = 32_000
const INPUT_BYTE_LIMIT = 80_000
const INPUT_PREFIX = 'STUDIO_ADVISOR_INPUT\n'
const LIVE = "state IN ('reserved', 'running')"

/** The Host chooses this route; a replay or start cannot replace any of its coordinates. */
export interface AdvisorRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The original requester and Advisor execution remain attributable after handoff or restart. */
export interface Advice {
  adviceId: string
  advisorBotId: string
  advisorSessionId: string
  executionEpoch: number
  requesterSessionId: string
  requesterBotId: string
  role: 'assistant' | 'leader'
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
  question: string
  evidenceQuote?: string
  workId?: string
  projectId?: string
  managementEpoch?: number
  route: AdvisorRoute
  inputText: string
  state: 'reserved' | 'running' | 'completed' | 'failed' | 'interrupted'
  result?: StudioDraftResult
  failure?: string
}

export type AdviceInput = Pick<Advice, 'requesterSessionId' | 'role' | 'sourceMessageId' | 'sourceRequestId' | 'requestText'
  | 'question' | 'evidenceQuote' | 'workId' | 'route'> & { toolCallId: string }

type WorkEvidence = {
  workId: string
  workerSessionId: string
  workerBotId: string
  executionEpoch: number
  result: StudioDraftResult
}

interface AdvisorStoreAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  readonly runId: string
  sessionBound(sessionId: string): boolean
  assistantBinding(sessionId: string): string | undefined
  leaderBinding(sessionId: string): StudioProjectBinding | undefined
  adviceAuthority(sessionId: string): ManagedResult<StudioProjectBinding>
  workEvidence(projectId: string, workId: string): WorkEvidence | undefined
}

// Each consultation gets its own permanent Session on the singleton Bot, with no execution retry.
export const ADVISOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_advisor_bot (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    bot_id TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_advice (
    advice_id TEXT PRIMARY KEY NOT NULL,
    advisor_bot_id TEXT NOT NULL REFERENCES studio_advisor_bot (bot_id),
    advisor_session_id TEXT NOT NULL UNIQUE,
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch = 1),
    requester_session_id TEXT NOT NULL,
    requester_bot_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('assistant', 'leader')),
    source_message_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    question TEXT NOT NULL,
    evidence_quote TEXT,
    work_id TEXT REFERENCES studio_project_work (work_id),
    project_id TEXT,
    management_epoch INTEGER CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    reasoning_effort TEXT,
    input_text TEXT NOT NULL,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed', 'interrupted')),
    result_json TEXT,
    failure TEXT,
    UNIQUE (requester_session_id, source_message_id),
    UNIQUE (requester_session_id, source_request_id),
    UNIQUE (requester_session_id, tool_call_id),
    FOREIGN KEY (project_id, management_epoch, requester_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
    CHECK (requester_session_id <> advisor_session_id),
    CHECK ((role = 'assistant' AND project_id IS NULL AND management_epoch IS NULL AND work_id IS NULL)
      OR (role = 'leader' AND project_id IS NOT NULL AND management_epoch IS NOT NULL)),
    CHECK ((result_json IS NOT NULL) = (state = 'completed')),
    CHECK ((failure IS NOT NULL) = (state IN ('failed', 'interrupted')))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS studio_advice_one_live
    ON studio_advice ((1)) WHERE ${LIVE};
`

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= TEXT_LIMIT && value.isWellFormed()
const isBody = (value: unknown): value is string => isText(value) && !value.includes('\0') && value.trim().length > 0
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const isUuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value)

/** Check an exact UUID token, rather than a substring of another identifier. */
function mentionsWork(requestText: string, workId: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${workId}(?![\\p{L}\\p{N}_-])`, 'u').test(requestText)
}

/** Locate the unmodified spans, rejecting repeats even when their occurrences overlap. */
function validQuotes(requestText: string, question: string, evidenceQuote?: string): boolean {
  const q = requestText.indexOf(question)
  if (q < 0 || requestText.indexOf(question, q + 1) !== -1) return false
  if (evidenceQuote === undefined) return true
  const e = requestText.indexOf(evidenceQuote)
  return e >= 0 && requestText.indexOf(evidenceQuote, e + 1) === -1
    && (q + question.length <= e || e + evidenceQuote.length <= q)
}

/** Decode only the validated coordinates and final message supplied by the Host. */
function draftResult(value: unknown): StudioDraftResult | undefined {
  if (!value || typeof value !== 'object') return
  const { text, messageId, eventSeq, turn } = value as Partial<StudioDraftResult>
  if (!isText(text) || !text.trim() || !isBody(messageId) || (eventSeq !== 0 && !isEpoch(eventSeq)) || !isEpoch(turn)) return
  return { text, messageId, eventSeq, turn }
}

function readRoute(value: unknown): AdvisorRoute | undefined {
  if (!value || typeof value !== 'object') return
  const { provider, model, reasoningEffort } = value as Partial<AdvisorRoute>
  if (!isBody(provider) || !isBody(model) || (reasoningEffort !== undefined && !isBody(reasoningEffort))) return
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function sameRoute(a: AdvisorRoute, b: AdvisorRoute): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/** Fail closed on any ignored insert/update so the Host cannot admit an unconfirmed consultation. */
function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio advice write did not affect exactly one row')
}

/** Abandon both unstarted and entered consultations at startup, while retaining their source claims and Session roles. */
export function interruptAdvice(db: DatabaseSync): void {
  db.exec(`UPDATE studio_advice SET state = 'interrupted', failure = 'HOST_RESTARTED' WHERE ${LIVE}`)
  if (db.prepare(`SELECT 1 FROM studio_advice WHERE ${LIVE} LIMIT 1`).get()) {
    throw new Error('Cannot interrupt previous Studio advice')
  }
}

/** Decode the saved input and outcome without rebuilding the bytes sent to the Advisor. */
function readRow(row: Record<string, SQLOutputValue>): Advice {
  const { advice_id: adviceId, advisor_bot_id: advisorBotId, advisor_session_id: advisorSessionId,
    requester_session_id: requesterSessionId, requester_bot_id: requesterBotId, execution_epoch: executionEpoch,
    role, source_message_id: sourceMessageId, source_request_id: sourceRequestId, request_text: requestText, question,
    evidence_quote: evidenceQuote, work_id: workId, project_id: projectId, management_epoch: managementEpoch,
    input_text: inputText, state, result_json: resultJson, failure } = row
  const route = readRoute({ provider: row.provider, model: row.model, reasoningEffort: row.reasoning_effort ?? undefined })
  if (!isUuid(adviceId) || !isUuid(advisorBotId) || !isUuid(advisorSessionId) || executionEpoch !== 1
    || !isBody(requesterSessionId) || !isBody(requesterBotId) || !isBody(sourceMessageId) || !isBody(sourceRequestId)
    || !isBody(requestText) || !isBody(question) || (evidenceQuote !== null && !isBody(evidenceQuote))
    || (workId !== null && !isUuid(workId)) || (projectId !== null && !isBody(projectId))
    || (managementEpoch !== null && !isEpoch(managementEpoch)) || (role !== 'assistant' && role !== 'leader')
    || (role === 'assistant' ? projectId !== null || managementEpoch !== null || workId !== null
      : projectId === null || managementEpoch === null)
    || !route || typeof inputText !== 'string' || !inputText.isWellFormed() || !inputText.startsWith(INPUT_PREFIX)
    || Buffer.byteLength(inputText) > INPUT_BYTE_LIMIT
    || (state !== 'reserved' && state !== 'running' && state !== 'completed' && state !== 'failed' && state !== 'interrupted')) {
    throw new Error('Invalid Studio advice row')
  }
  const advice: Advice = { adviceId, advisorBotId, advisorSessionId, executionEpoch, requesterSessionId, requesterBotId,
    role, sourceMessageId, sourceRequestId, requestText, question, route, inputText, state,
    ...(evidenceQuote === null ? {} : { evidenceQuote }), ...(workId === null ? {} : { workId }),
    ...(projectId === null ? {} : { projectId }), ...(managementEpoch === null ? {} : { managementEpoch }) }
  if (state === 'completed') {
    const result = typeof resultJson === 'string' ? draftResult(JSON.parse(resultJson)) : undefined
    if (!result || failure !== null) throw new Error('Invalid Studio advice result')
    advice.result = result
  } else if (state === 'failed' || state === 'interrupted') {
    if (resultJson !== null || !isBody(failure)) throw new Error('Invalid Studio advice failure')
    advice.failure = failure
  } else if (resultJson !== null || failure !== null) {
    throw new Error('Invalid active Studio advice')
  }
  return advice
}

/** Internal facet sharing the Host's SQLite connection, transactions, and run fence. */
export class AdvisorStore {
  constructor(private readonly access: AdvisorStoreAccess) {}

  private get db(): DatabaseSync { return this.access.db() }

  /** A reserved, interrupted, or completed consultation permanently classifies its Advisor Session. */
  binding(advisorSessionId: string): boolean {
    if (!isId(advisorSessionId)) throw new Error('Invalid Studio Advisor Session ID')
    return !!this.db.prepare('SELECT 1 FROM studio_advice WHERE advisor_session_id = ?').get(advisorSessionId)
  }

  /** Claim the original owner message and reserve an isolated Advisor Session without launching it. */
  reserve(input: AdviceInput): ManagedResult<{ advice: Advice; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { requesterSessionId, role, sourceMessageId, sourceRequestId, requestText, question, evidenceQuote, workId, toolCallId } = input
    const route = readRoute(input.route)
    if (!isBody(requesterSessionId) || (role !== 'assistant' && role !== 'leader') || !isBody(sourceMessageId)
      || !isBody(sourceRequestId) || !isBody(toolCallId) || !isBody(requestText) || !isBody(question) || !route
      || (evidenceQuote !== undefined && !isBody(evidenceQuote))
      || (workId !== undefined && (role !== 'leader' || !isUuid(workId)))) return deny('INVALID_INPUT')
    return this.access.write<{ advice: Advice; created: boolean }>(() => {
      const actor = this.requester(role, requesterSessionId, true)
      if (!actor.ok) return actor
      const { requesterBotId, projectId, managementEpoch } = actor.value

      // An exact replay returns the first row unchanged. A shared coordinate is not enough to match that row.
      const existing = this.db.prepare(`SELECT * FROM studio_advice WHERE requester_session_id = ?
        AND (source_request_id = ? OR source_message_id = ? OR tool_call_id = ?) LIMIT 2`)
        .all(requesterSessionId, sourceRequestId, sourceMessageId, toolCallId)
      if (existing.length) {
        const advice = readRow(existing[0]!)
        if (existing.length !== 1 || advice.role !== role || advice.requesterBotId !== requesterBotId || advice.projectId !== projectId
          || advice.managementEpoch !== managementEpoch || advice.sourceRequestId !== sourceRequestId || advice.sourceMessageId !== sourceMessageId
          || advice.requestText !== requestText || advice.question !== question || advice.evidenceQuote !== evidenceQuote
          || advice.workId !== workId || !sameRoute(advice.route, route)) return deny('SOURCE_ALREADY_USED')
        return accept({ advice, created: false })
      }
      const sourceUsed = role === 'assistant'
        ? assistantSourceUsed(this.db, { assistantSessionId: requesterSessionId, sourceMessageId, sourceRequestId })
        : !!this.db.prepare(`SELECT 1 FROM studio_project_work WHERE leader_session_id = ?
            AND (source_message_id = ? OR source_request_id = ?) LIMIT 1`).get(requesterSessionId, sourceMessageId, sourceRequestId)
      if (sourceUsed) return deny('SOURCE_ALREADY_USED')
      if (!validQuotes(requestText, question, evidenceQuote) || (workId !== undefined && !mentionsWork(requestText, workId))) {
        return deny('INVALID_INPUT')
      }

      // Resolve only same-project completed text. Never load a document or job output to assemble the relay.
      const evidence = projectId !== undefined && workId !== undefined ? this.access.workEvidence(projectId, workId) : undefined
      if (workId !== undefined && !evidence) return deny('WORK_EVIDENCE_UNAVAILABLE')
      const inputText = INPUT_PREFIX + JSON.stringify({ question, evidenceQuote, evidence, projectId })
      if (Buffer.byteLength(inputText) > INPUT_BYTE_LIMIT) return deny('ADVICE_INPUT_TOO_LARGE')
      // The shared Advisor admits at most one live consultation, including across a Leader handoff.
      if (this.db.prepare(`SELECT 1 FROM studio_advice WHERE ${LIVE} LIMIT 1`).get()) return deny('ADVICE_BUSY')
      const advisorSessionId = randomUUID()
      if (this.access.sessionBound(advisorSessionId)) return deny('SESSION_ALREADY_BOUND')
      const bot = this.db.prepare('SELECT bot_id FROM studio_advisor_bot WHERE singleton = 1').get()
      const advisorBotId = bot ? bot.bot_id : randomUUID()
      if (!isUuid(advisorBotId)) throw new Error('Invalid Studio Advisor Bot ID')
      if (!bot) requireWrite(this.db.prepare('INSERT INTO studio_advisor_bot VALUES (1, ?)').run(advisorBotId).changes)
      const adviceId = randomUUID()
      requireWrite(this.db.prepare(`INSERT INTO studio_advice (advice_id, advisor_bot_id, advisor_session_id, execution_epoch,
        requester_session_id, requester_bot_id, role, source_message_id, source_request_id, tool_call_id, request_text, question,
        evidence_quote, work_id, project_id, management_epoch, provider, model, reasoning_effort, input_text, run_id, state)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(adviceId, advisorBotId, advisorSessionId, requesterSessionId, requesterBotId, role, sourceMessageId, sourceRequestId,
          toolCallId, requestText, question, evidenceQuote ?? null, workId ?? null, projectId ?? null, managementEpoch ?? null,
          route.provider, route.model, route.reasoningEffort ?? null, inputText, this.access.runId).changes)
      const row = this.db.prepare('SELECT * FROM studio_advice WHERE advice_id = ?').get(adviceId)
      if (!row) throw new Error('Missing Studio advice reservation')
      return accept({ advice: readRow(row), created: true })
    })
  }

  /** Check the exact reservation in a read snapshot; only begin can admit an execution. */
  canStart(advice: Advice): ManagedResult<Advice> {
    if (!advice || !isUuid(advice.adviceId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => this.startable(advice))
  }

  /** Consume the reservation and recheck management in the same write transaction as handoff. */
  begin(advice: Advice): ManagedResult<Advice> {
    if (!advice || !isUuid(advice.adviceId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const current = this.startable(advice)
      if (!current.ok) return current
      const stored = current.value
      requireWrite(this.db.prepare(`UPDATE studio_advice SET state = 'running'
        WHERE advice_id = ? AND run_id = ? AND state = 'reserved'`).run(stored.adviceId, this.access.runId).changes)
      return accept({ ...stored, state: 'running' })
    })
  }

  /** Save the exact origin's final result once, even after a handoff. Never save a result for an unstarted reservation. */
  settle(advice: Advice, result: StudioDraftResult | undefined, failure: string): ManagedResult<Advice> {
    const outcome = draftResult(result)
    if (!advice || !isUuid(advice.adviceId) || (result === undefined ? !isBody(failure) : !outcome)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const stored = this.exact(advice)
      if (!stored) return deny('STALE_EXECUTION')
      // Compare the permanent role, not current management, to let the original attempt drain after a handoff.
      const actor = this.requester(stored.role, stored.requesterSessionId, false)
      if (!actor.ok) return actor
      if (!this.sameRequester(stored, actor.value)) return deny('STALE_EXECUTION')
      if (stored.state !== 'running' && (stored.state !== 'reserved' || outcome)) return deny('ADVICE_NOT_RUNNING')
      const state = outcome ? 'completed' : 'failed'
      requireWrite(this.db.prepare(`UPDATE studio_advice SET state = ?, result_json = ?, failure = ?
        WHERE advice_id = ? AND run_id = ? AND state = ?`).run(state, outcome ? JSON.stringify(outcome) : null,
        outcome ? null : failure, stored.adviceId, this.access.runId, stored.state).changes)
      return accept({ ...stored, state, ...(outcome ? { result: outcome } : { failure }) })
    })
  }

  /** Look up one exact ID, scoped to the Assistant Bot or the Leader's project (including former Leaders). */
  read(requesterSessionId: string, adviceId: string): ManagedResult<Advice> {
    if (!isBody(requesterSessionId) || !isUuid(adviceId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const bot = this.access.assistantBinding(requesterSessionId)
      const leader = this.access.leaderBinding(requesterSessionId)
      if (bot && leader) return deny('SESSION_ALREADY_BOUND')
      if (!bot && !leader) return deny('SESSION_NOT_BOUND')
      const row = bot
        ? this.db.prepare(`SELECT * FROM studio_advice WHERE advice_id = ? AND role = 'assistant' AND requester_bot_id = ?`).get(adviceId, bot)
        : this.db.prepare(`SELECT * FROM studio_advice WHERE advice_id = ? AND role = 'leader' AND project_id = ?`)
          .get(adviceId, leader!.projectId)
      return row ? accept(readRow(row)) : deny('ADVICE_NOT_FOUND')
    })
  }

  /** Work under the caller's transaction so requester changes cannot race the start-state transition. */
  private startable(advice: Advice): ManagedResult<Advice> {
    const stored = this.exact(advice)
    if (!stored) return deny('STALE_EXECUTION')
    const actor = this.requester(stored.role, stored.requesterSessionId, true)
    if (!actor.ok) return actor
    if (!this.sameRequester(stored, actor.value)) return deny(stored.role === 'leader' ? 'STALE_MANAGEMENT' : 'STALE_EXECUTION')
    return stored.state === 'reserved' ? accept(stored) : deny('ADVICE_NOT_RESERVED')
  }

  /** The caller's state and result are not authority; resolve the immutable origin and payload in this Host run. */
  private exact(advice: Advice): Advice | undefined {
    const row = this.db.prepare('SELECT * FROM studio_advice WHERE advice_id = ? AND run_id = ?')
      .get(advice.adviceId, this.access.runId)
    if (!row) return
    const stored = readRow(row)
    const route = readRoute(advice.route)
    if (route && sameRoute(stored.route, route)
      && stored.advisorSessionId === advice.advisorSessionId && stored.advisorBotId === advice.advisorBotId
      && stored.executionEpoch === advice.executionEpoch && stored.requesterSessionId === advice.requesterSessionId
      && stored.role === advice.role && this.sameRequester(stored, advice)
      && stored.sourceMessageId === advice.sourceMessageId && stored.sourceRequestId === advice.sourceRequestId
      && stored.requestText === advice.requestText && stored.question === advice.question && stored.evidenceQuote === advice.evidenceQuote
      && stored.workId === advice.workId && stored.inputText === advice.inputText) return stored
  }

  private sameRequester(advice: Advice, actor: Pick<Advice, 'requesterBotId' | 'projectId' | 'managementEpoch'>): boolean {
    return advice.requesterBotId === actor.requesterBotId && advice.projectId === actor.projectId
      && advice.managementEpoch === actor.managementEpoch
  }

  /** Resolve either current write authority or the exact historical origin, as required by the operation. */
  private requester(role: Advice['role'], sessionId: string, current: boolean):
    ManagedResult<Pick<Advice, 'requesterBotId' | 'projectId' | 'managementEpoch'>> {
    if (role === 'assistant') {
      const bot = this.access.assistantBinding(sessionId)
      return bot ? accept({ requesterBotId: bot }) : deny('SESSION_NOT_BOUND')
    }
    const binding = current ? this.access.adviceAuthority(sessionId) : accept(this.access.leaderBinding(sessionId))
    if (!binding.ok) return binding
    const actor = binding.value
    if (!actor) return deny('SESSION_NOT_BOUND')
    const { leaderBotId: requesterBotId, projectId, managementEpoch } = actor
    return accept({ requesterBotId, projectId, managementEpoch })
  }
}
