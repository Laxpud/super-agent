/** Durable Studio project identity, management history, and work dispatch. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { isProjectFactKey } from './project-archive-store.js'
import { attachProjectDocument, projectDocumentAttached, projectDocumentCommandUsed, readProjectDocument,
  type ProjectDocumentAccess, type StudioProjectDocument } from './project-document-store.js'
import { parseProjectFactRequest } from './project-fact-request.js'
import { appendWorkFact, readWorkFact, type ProjectWorkFactUse, type WorkFactSource } from './project-fact-use-store.js'
import { captureProjectHandoff, readProjectHandoff, type ProjectHandoffReview } from './project-handoff-store.js'
import { armProjectJob, consumeJobAuto, consumedJobAuto, jobAutoPage, projectJobAutoCommandUsed, readAutoReservation,
  readJobRoute, sameJobRoute, type StudioJobAuto, type StudioJobRoute } from './project-job-auto-store.js'
import { attachProjectJob, isConfirmedJobState, isJobState, observeProjectJob, observeWatchedProjectJob, projectJobCommandUsed,
  readProjectJob, setProjectJobPaused, watchedJobPage, type StudioProjectJob } from './project-job-store.js'
import { appendWorkResultUse, PROJECT_RESULT_QUOTE_LIMIT, projectResultCommandUsed, readWorkResultUse,
  workResultFingerprint, workResultUseView, type ProjectWorkResultUse, type WorkResultSource } from './project-result-use-store.js'
import type { ManagedResult, StudioDraftResult } from './store.ts'
import { assistantSourceUsed } from './study-store.js'
import { appendWorkBlock, appendWorkBlockClear, isProjectWorkBlockText, latestWorkBlock, latestWorkBlockState,
  projectWorkBlockCommandUsed, type ProjectWorkBlockView } from './project-work-block-store.js'
import { appendWorkModel, appendWorkModelClear, appendWorkModelConsume, exactConsumedWorkModel, hasUnclearedWorkModel,
  isWorkModelSelectionId, latestWorkModel, projectWorkModelCommandUsed, readPinnedWorkModel, readWorkModelDispatch, sameWorkModel,
  workModelSourceUsed, workModelState, workModelView, type ProjectWorkModelDispatchIntent, type ProjectWorkModelSelection,
  type ProjectWorkModelSelectionView } from './project-work-model-store.js'
import { validSystemdJob, type SystemdJobRef, type SystemdJobState } from './systemd-job.js'
import type { PinnedTextWorkerModel } from './text-worker-model-policy.js'

export { sameJobRoute, type StudioJobAuto, type StudioJobRoute } from './project-job-auto-store.js'
export type { ProjectDocumentDecision, ProjectDocumentDecisionHistory } from './project-document-decision-store.js'
export type { StudioProjectDocument } from './project-document-store.js'
export type { StudioProjectJob } from './project-job-store.js'
export { PROJECT_RESULT_QUOTE_LIMIT, type ProjectWorkResultUse } from './project-result-use-store.js'
export { PROJECT_WORK_BLOCK_TEXT_LIMIT, type ProjectWorkBlockView } from './project-work-block-store.js'
export type { ProjectWorkModelDispatch, ProjectWorkModelDispatchIntent, ProjectWorkModelSelection,
  ProjectWorkModelSelectionView } from './project-work-model-store.js'

/** Maximum project name length in UTF-16 code units. */
export const PROJECT_NAME_LIMIT = 160
/** Maximum project objective or work request length in UTF-16 code units. */
export const PROJECT_TEXT_LIMIT = 32_000

/** A permanent Session role, not proof that the Session still manages the project. */
export interface StudioProjectBinding {
  projectId: string
  leaderBotId: string
  leaderSessionId: string
  managementEpoch: number
}

/** Project snapshot with the current Leader and the number of unclaimed work items, including jobs still waiting. */
export interface StudioProject extends StudioProjectBinding {
  name: string
  objective: string
  originTaskId?: string
  pendingCount: number
}

/** An Assistant's original proposal and the decision recorded by the Host, if any. */
export interface StudioProjectProposal {
  proposalId: string
  assistantSessionId: string
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
  intentQuote: string
  name: string
  objective: string
  originTaskId?: string
  leaderBotId?: string
  state: 'pending' | 'closed' | 'created'
  projectId?: string
}

/** Work retains the original Leader binding and source coordinates across handoffs. */
export interface StudioProjectWork extends StudioProjectBinding {
  workId: string
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
}

/** Immutable dispatch origin and the last confirmed outcome of this execution epoch. */
export interface StudioProjectRun {
  workId: string
  projectId: string
  leaderSessionId: string
  managementEpoch: number
  workerSessionId: string
  workerBotId: string
  executionEpoch: number
  state: 'reserved' | 'running' | 'completed' | 'failed' | 'interrupted' | 'released'
  result?: StudioDraftResult
  failure?: string
}

/** Registered work, its latest dispatch (including a release), and any external job or document attachment. */
export interface StudioProjectWorkView {
  work: StudioProjectWork
  run?: StudioProjectRun
  job?: StudioProjectJob
  document?: StudioProjectDocument
  fact?: ProjectWorkFactUse
  resultUse?: ProjectWorkResultUse
  modelSelection?: ProjectWorkModelSelectionView
  /** Only present while an owner hold is active. */
  blocked?: true
  /** Latest decision, including a clear when recorded; only current native owner detail may include it. */
  workBlock?: ProjectWorkBlockView
}

// The current epoch points to an immutable binding. Each binding also records the native command that created it.
// Work references the historical binding rather than the current project assignment, so a handoff never rewrites provenance.
export const PROJECT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_leader_bot (
    bot_id TEXT NOT NULL PRIMARY KEY
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project (
    project_id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    origin_task_id TEXT UNIQUE REFERENCES studio_draft_task (task_id),
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    FOREIGN KEY (project_id, management_epoch) REFERENCES studio_project_binding (project_id, management_epoch)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project_binding (
    leader_session_id TEXT NOT NULL PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES studio_project (project_id),
    leader_bot_id TEXT NOT NULL REFERENCES studio_leader_bot (bot_id),
    management_epoch INTEGER NOT NULL CHECK (management_epoch BETWEEN 1 AND 9007199254740991),
    command_id TEXT NOT NULL UNIQUE,
    bound_at TEXT NOT NULL,
    UNIQUE (project_id, management_epoch)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_project_proposal (
    seq INTEGER PRIMARY KEY,
    proposal_id TEXT NOT NULL UNIQUE,
    assistant_session_id TEXT NOT NULL REFERENCES studio_assistant_binding (session_id),
    source_message_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    intent_quote TEXT NOT NULL,
    name TEXT NOT NULL,
    objective TEXT NOT NULL,
    origin_task_id TEXT REFERENCES studio_draft_task (task_id),
    leader_bot_id TEXT REFERENCES studio_leader_bot (bot_id),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'closed', 'created')),
    project_id TEXT UNIQUE REFERENCES studio_project (project_id),
    proposed_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE (assistant_session_id, source_request_id),
    CHECK ((state = 'pending' AND project_id IS NULL AND decided_at IS NULL)
      OR (state = 'closed' AND project_id IS NULL AND decided_at IS NOT NULL)
      OR (state = 'created' AND project_id IS NOT NULL AND decided_at IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_project_proposal_session_latest
    ON studio_project_proposal (assistant_session_id, seq DESC);
  CREATE INDEX IF NOT EXISTS studio_project_proposal_source_message
    ON studio_project_proposal (assistant_session_id, source_message_id);
  CREATE TABLE IF NOT EXISTS studio_project_work (
    work_id TEXT NOT NULL PRIMARY KEY,
    leader_session_id TEXT NOT NULL REFERENCES studio_project_binding (leader_session_id),
    source_message_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL,
    request_text TEXT NOT NULL,
    UNIQUE (leader_session_id, source_request_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_binding_dispatch_origin
    ON studio_project_binding (project_id, management_epoch, leader_session_id);
  CREATE TABLE IF NOT EXISTS studio_project_dispatch (
    work_id TEXT NOT NULL REFERENCES studio_project_work (work_id),
    execution_epoch INTEGER NOT NULL CHECK (execution_epoch BETWEEN 1 AND 9007199254740991),
    project_id TEXT NOT NULL,
    leader_session_id TEXT NOT NULL,
    management_epoch INTEGER NOT NULL,
    worker_session_id TEXT NOT NULL UNIQUE,
    worker_bot_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'running', 'completed', 'failed', 'interrupted', 'released')),
    result_json TEXT,
    failure TEXT,
    PRIMARY KEY (work_id, execution_epoch),
    FOREIGN KEY (project_id, management_epoch, leader_session_id)
      REFERENCES studio_project_binding (project_id, management_epoch, leader_session_id),
    CHECK (leader_session_id <> worker_session_id),
    CHECK ((state = 'completed' AND result_json IS NOT NULL AND failure IS NULL)
      OR (state IN ('reserved', 'running') AND result_json IS NULL AND failure IS NULL)
      OR (state IN ('failed', 'interrupted', 'released') AND result_json IS NULL AND failure IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS studio_project_dispatch_once
    ON studio_project_dispatch (work_id) WHERE state <> 'released';
`

interface ProjectStoreAccess extends ProjectDocumentAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  ownsRun(): boolean
  readonly runId: string
  assistantBinding(sessionId: string): string | undefined
  nonProjectSessionBound(sessionId: string): boolean
  documentCommandUsed(commandId: string): boolean
  exactFactQuote(projectId: string, key: string, revision: number): string | undefined
}

interface CreateInput {
  leaderSessionId: string
  commandId: string
  name: string
  objective: string
  leaderBotId?: string
  originTaskId?: string
}

interface HandoffInput {
  projectId: string
  expectedEpoch: number
  nextSessionId: string
  commandId: string
  leaderBotId?: string
}

export interface WorkInput {
  leaderSessionId: string
  sourceMessageId: string
  sourceRequestId: string
  requestText: string
}

const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Extract<ManagedResult<never>, { ok: false }> => ({ ok: false, reason })
const isText = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length <= limit && value.isWellFormed() && !value.includes('\0') && value.trim().length > 0
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.isWellFormed() && !value.includes('\0')
const isEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isDraftText = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= PROJECT_TEXT_LIMIT && value.isWellFormed()
// Draft text is JSON-encoded; the failure reason is read directly as SQLite text and must not contain NUL.
const isFailure = (value: unknown): value is string => isDraftText(value) && !value.includes('\0')

const WORK_SELECT = `SELECT w.*, b.project_id, b.leader_bot_id, b.management_epoch
  FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)`
const EXACT_DISPATCH = `work_id = ? AND execution_epoch = ? AND project_id = ? AND leader_session_id = ?
  AND management_epoch = ? AND worker_session_id = ? AND worker_bot_id = ? AND run_id = ?`

type DispatchIdentity = Omit<StudioProjectRun, 'state' | 'result' | 'failure'>

/** Copy and validate the immutable identity before using it in a state transition. */
function dispatchIdentity(run: StudioProjectRun): DispatchIdentity | undefined {
  if (!run) return
  const { workId, executionEpoch, projectId, leaderSessionId, managementEpoch, workerSessionId, workerBotId } = run
  if (!isId(workId) || !isEpoch(executionEpoch) || !isId(projectId) || !isId(leaderSessionId)
    || !isEpoch(managementEpoch) || !isId(workerSessionId) || !isId(workerBotId)) return
  return { workId, executionEpoch, projectId, leaderSessionId, managementEpoch, workerSessionId, workerBotId }
}

/** Retain only the final message text and coordinates from the Host result. */
function draftResult(value: unknown): StudioDraftResult | undefined {
  if (!value || typeof value !== 'object') return
  const { text, messageId, eventSeq, turn } = value as Partial<StudioDraftResult>
  if (!isDraftText(text) || !isId(messageId) || (eventSeq !== 0 && !isEpoch(eventSeq)) || !isEpoch(turn)) return
  return { text, messageId, eventSeq, turn }
}

/** An ignored insert or update is not a successful write, even if SQLite did not raise an error. */
function requireWrite(changes: number | bigint): void {
  if (changes !== 1 && changes !== 1n) throw new Error('Studio project write did not affect exactly one row')
}

/** Decode a permanent binding before using it to classify a Session or check its authority. */
function readBinding(row: Record<string, SQLOutputValue>): StudioProjectBinding {
  const { project_id: projectId, leader_bot_id: leaderBotId, leader_session_id: leaderSessionId, management_epoch: managementEpoch } = row
  if (!isId(projectId) || !isId(leaderBotId) || !isId(leaderSessionId) || !isEpoch(managementEpoch)) {
    throw new Error('Invalid Studio project binding')
  }
  return { projectId, leaderBotId, leaderSessionId, managementEpoch }
}

/** Decode the original proposal; only a created decision has a project link. */
function readProposalRow(row: Record<string, SQLOutputValue>): StudioProjectProposal {
  const { proposal_id: proposalId, assistant_session_id: assistantSessionId, source_message_id: sourceMessageId,
    source_request_id: sourceRequestId, request_text: requestText, intent_quote: intentQuote, name, objective,
    origin_task_id: originTaskId, leader_bot_id: leaderBotId, state, project_id: projectId } = row
  if (!isId(proposalId) || !isId(assistantSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId)
    || !isText(requestText, PROJECT_TEXT_LIMIT) || !isText(intentQuote, PROJECT_TEXT_LIMIT) || !requestText.includes(intentQuote)
    || !isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT)
    || (originTaskId !== null && !isId(originTaskId)) || (leaderBotId !== null && !isId(leaderBotId))
    || (state !== 'pending' && state !== 'closed' && state !== 'created')
    || (state === 'created' ? !isId(projectId) : projectId !== null)) throw new Error('Invalid Studio project proposal')
  return { proposalId, assistantSessionId, sourceMessageId, sourceRequestId, requestText, intentQuote, name, objective,
    ...(originTaskId === null ? {} : { originTaskId }), ...(leaderBotId === null ? {} : { leaderBotId }), state,
    ...(isId(projectId) ? { projectId } : {}) }
}

/** Decode registered work with the Leader binding that originally recorded it. */
function readWorkRow(row: Record<string, SQLOutputValue>): StudioProjectWork {
  const { work_id: workId, source_message_id: sourceMessageId, source_request_id: sourceRequestId, request_text: requestText } = row
  if (!isId(workId) || !isId(sourceMessageId) || !isId(sourceRequestId) || !isText(requestText, PROJECT_TEXT_LIMIT)) {
    throw new Error('Invalid Studio project work')
  }
  return { ...readBinding(row), workId, sourceMessageId, sourceRequestId, requestText }
}

/** Decode the stored dispatch, never recovering origin or result from the caller's copy. */
function readRunRow(row: Record<string, SQLOutputValue>, omitResult = false): StudioProjectRun {
  const { work_id: workId, project_id: projectId, leader_session_id: leaderSessionId, management_epoch: managementEpoch,
    worker_session_id: workerSessionId, worker_bot_id: workerBotId, execution_epoch: executionEpoch,
    state, result_json: resultJson, failure } = row
  if (!isId(workId) || !isId(projectId) || !isId(leaderSessionId) || !isEpoch(managementEpoch) || !isId(workerSessionId)
    || !isId(workerBotId) || !isEpoch(executionEpoch) || !isId(row.run_id)
    || (state !== 'reserved' && state !== 'running' && state !== 'completed' && state !== 'failed'
      && state !== 'interrupted' && state !== 'released')) throw new Error('Invalid Studio project dispatch')
  const run: StudioProjectRun = { workId, projectId, leaderSessionId, managementEpoch, workerSessionId, workerBotId, executionEpoch, state }
  if (state === 'completed') {
    if (omitResult && resultJson === null && failure === null) return run
    const result = typeof resultJson === 'string' ? draftResult(JSON.parse(resultJson)) : undefined
    if (!result || failure !== null) throw new Error('Invalid Studio project result')
    run.result = result
  } else if (state === 'reserved' || state === 'running') {
    if (resultJson !== null || failure !== null) throw new Error('Invalid active Studio project dispatch')
  } else {
    if (resultJson !== null || !isFailure(failure)) throw new Error('Invalid Studio project failure')
    run.failure = failure
  }
  return run
}

/** Internal facet of ManagedWorkerStore. All writes use its transaction and run fence. */
export class ProjectStore {
  constructor(private readonly access: ProjectStoreAccess) {}

  private get db(): DatabaseSync { return this.access.db() }

  /** Read the durable role, including former Leaders. Invalid input or storage errors throw. */
  binding(sessionId: string): StudioProjectBinding | undefined {
    if (!isId(sessionId)) throw new Error('Invalid Studio project Leader session ID')
    const row = this.db.prepare('SELECT * FROM studio_project_binding WHERE leader_session_id = ?').get(sessionId)
    return row && readBinding(row)
  }

  /** Identify a permanently bound draft Worker, including one whose reservation was released. */
  workerBound(sessionId: string): boolean {
    if (!isId(sessionId)) throw new Error('Invalid Studio project Worker session ID')
    return !!this.db.prepare('SELECT 1 FROM studio_project_dispatch WHERE worker_session_id = ?').get(sessionId)
  }

  /** Classify a fact-linked Worker durably, even if its reservation was released or its execution failed. */
  hasWorkFactWorker(sessionId: string): boolean {
    if (!isId(sessionId)) throw new Error('Invalid Studio project Worker session ID')
    return !!this.db.prepare(`SELECT 1 FROM studio_project_dispatch d JOIN studio_project_work_fact f USING (work_id)
      WHERE d.worker_session_id = ?`).get(sessionId)
  }

  /** Recognize a result-linked Worker even after release, failure, restart, or source loss. */
  hasWorkResultWorker(sessionId: string): boolean {
    if (!isId(sessionId)) throw new Error('Invalid Studio project Worker session ID')
    return !!this.db.prepare(`SELECT 1 FROM studio_project_dispatch d JOIN studio_project_work_result_use r USING (work_id)
      WHERE d.worker_session_id = ?`).get(sessionId)
  }

  /** Read the current project only for its active Leader in the active host run. Writes still need their own check. */
  current(sessionId: string): ManagedResult<StudioProject> {
    if (!isId(sessionId)) return deny('INVALID_INPUT')
    try {
      if (!this.access.ownsRun()) return deny('STALE_HOST_RUN')
      const result = this.currentProject(sessionId)
      return this.access.ownsRun() ? result : deny('STALE_HOST_RUN')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Internal Advisor lookup. The caller holds the run-fenced read or write transaction. */
  adviceAuthority(sessionId: string): ManagedResult<StudioProjectBinding> {
    return this.currentProject(sessionId)
  }

  /** Internal Advisor and archive lookup. Only completed standalone text work in this project can supply evidence. */
  workEvidence(projectId: string, workId: string) {
    return this.readWorkEvidence(projectId, workId)
  }

  /** Read one standalone result. Result-use lookups cap JSON size and rechecks match the pinned execution. */
  private readWorkEvidence(projectId: string, workId: string, resultUse?: WorkResultSource | null):
    (Pick<StudioProjectRun, 'workId' | 'workerSessionId' | 'workerBotId' | 'executionEpoch'> & { result: StudioDraftResult }) | undefined {
    // Allow up to six JSON bytes per UTF-16 code unit, plus fixed room for message coordinates and field names.
    // The explicit state predicate lets SQLite use the existing partial dispatch index instead of scanning released attempts.
    const size = resultUse === undefined ? '' : "AND d.state <> 'released' AND length(CAST(d.result_json AS BLOB)) <= ?"
    const dispatch = resultUse ? 'AND d.execution_epoch = ? AND d.worker_session_id = ? AND d.worker_bot_id = ?' : ''
    const row = this.db.prepare(`SELECT d.* FROM studio_project_dispatch d
      JOIN studio_project_work w ON w.work_id = d.work_id
      JOIN studio_project_binding b ON b.leader_session_id = w.leader_session_id
      WHERE d.work_id = ? AND b.project_id = ? AND d.project_id = b.project_id AND d.state = 'completed'
        ${size} ${dispatch}
        AND NOT EXISTS (SELECT 1 FROM studio_project_document WHERE work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_job WHERE work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_work_fact WHERE work_id = w.work_id)
        AND NOT EXISTS (SELECT 1 FROM studio_project_work_result_use WHERE work_id = w.work_id)
      LIMIT 1`).get(workId, projectId, ...(size ? [6 * PROJECT_TEXT_LIMIT + 16_384] : []),
        ...(resultUse ? [resultUse.executionEpoch, resultUse.workerSessionId, resultUse.workerBotId] : []))
    if (!row) return
    // A malformed stored result cannot serve as evidence. Database query failures still propagate to the parent fence.
    try {
      const { workerSessionId, workerBotId, executionEpoch, result } = readRunRow(row)
      if (result) return { workId, workerSessionId, workerBotId, executionEpoch, result }
    } catch { /* The original result is no longer verifiable. */ }
  }

  /** Show current project state by ID or by the caller's durable Leader role. The Host authorizes this read. */
  status(sessionId: string, projectId?: string): ManagedResult<StudioProject> {
    if (!isId(sessionId) || (projectId !== undefined && !isId(projectId))) return deny('INVALID_INPUT')
    try {
      if (projectId !== undefined) {
        const project = this.project(projectId)
        return project ? accept(project) : deny('PROJECT_NOT_FOUND')
      }
      const binding = this.binding(sessionId)
      return binding ? accept(this.boundProject(binding)) : deny('SESSION_NOT_BOUND')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Start a project and reserve its first Leader Session with a single native user command. */
  create(input: CreateInput): ManagedResult<StudioProject> {
    if (!input) return deny('INVALID_INPUT')
    const { leaderSessionId, commandId, name, objective, leaderBotId, originTaskId } = input
    if (!isId(leaderSessionId) || !isId(commandId) || !isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT)
      || (leaderBotId !== undefined && !isId(leaderBotId)) || (originTaskId !== undefined && !isId(originTaskId))) {
      return deny('INVALID_INPUT')
    }
    return this.access.write(() => this.createInTransaction({ leaderSessionId, commandId, name, objective, leaderBotId, originTaskId }))
  }

  /** Record one proposal for a Host-supplied source message, without allocating a project, Bot, or model run. */
  proposeProject(input: Omit<StudioProjectProposal, 'proposalId' | 'state' | 'projectId'>):
    ManagedResult<{ proposal: StudioProjectProposal; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { assistantSessionId, sourceMessageId, sourceRequestId, requestText, intentQuote, name, objective, originTaskId, leaderBotId } = input
    if (!isId(assistantSessionId) || !isId(sourceRequestId)) return deny('INVALID_INPUT')
    return this.access.write<{ proposal: StudioProjectProposal; created: boolean }>(() => {
      if (!this.access.assistantBinding(assistantSessionId)) return deny('SESSION_NOT_BOUND')
      // A replay returns the first proposal and its current decision, not the replay's candidate data.
      const existing = this.db.prepare(`SELECT * FROM studio_project_proposal WHERE assistant_session_id = ? AND source_request_id = ?`)
        .get(assistantSessionId, sourceRequestId)
      if (existing) return accept({ proposal: readProposalRow(existing), created: false })
      // The Host supplies the original text. Literal occurrence is evidence, not an interpretation or authorization.
      if (!isId(sourceMessageId) || !isText(requestText, PROJECT_TEXT_LIMIT) || !isText(intentQuote, PROJECT_TEXT_LIMIT)
        || !requestText.includes(intentQuote) || !isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT)
        || (originTaskId !== undefined && !isId(originTaskId)) || (leaderBotId !== undefined && !isId(leaderBotId))) return deny('INVALID_INPUT')
      if (assistantSourceUsed(this.db, { assistantSessionId, sourceMessageId, sourceRequestId })) return deny('SOURCE_ALREADY_USED')
      if (originTaskId !== undefined && !this.completedOrigin(originTaskId, assistantSessionId)) return deny('ORIGIN_TASK_NOT_COMPLETED')
      if (leaderBotId !== undefined && !this.leaderBotExists(leaderBotId)) return deny('LEADER_BOT_NOT_FOUND')
      const proposalId = randomUUID()
      requireWrite(this.db.prepare(`INSERT INTO studio_project_proposal (proposal_id, assistant_session_id, source_message_id,
        source_request_id, request_text, intent_quote, name, objective, origin_task_id, leader_bot_id, run_id, state, proposed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(proposalId, assistantSessionId, sourceMessageId, sourceRequestId,
        requestText, intentQuote, name, objective, originTaskId ?? null, leaderBotId ?? null, this.access.runId, new Date().toISOString()).changes)
      const proposal: StudioProjectProposal = { proposalId, assistantSessionId, sourceMessageId, sourceRequestId, requestText,
        intentQuote, name, objective, ...(originTaskId === undefined ? {} : { originTaskId }),
        ...(leaderBotId === undefined ? {} : { leaderBotId }), state: 'pending' }
      return accept({ proposal, created: true })
    })
  }

  /** Host-only: materialize an exact pending proposal after a native user confirmation; never register this as a model tool. */
  confirmProposal(assistantSessionId: string, proposalId: string, leaderSessionId: string): ManagedResult<StudioProject> {
    if (!isId(assistantSessionId) || !isId(proposalId) || !isId(leaderSessionId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      if (!this.access.assistantBinding(assistantSessionId)) return deny('SESSION_NOT_BOUND')
      const row = this.proposalRow(assistantSessionId, proposalId)
      if (!row) return deny('PROPOSAL_NOT_FOUND')
      const proposal = readProposalRow(row)
      if (proposal.state === 'created') {
        // The Leader may have changed since confirmation. Return the current project without touching the new target.
        if (proposal.projectId === undefined) throw new Error('Missing Studio proposal project ID')
        const project = this.project(proposal.projectId)
        if (!project) throw new Error('Missing project for created Studio proposal')
        return accept(project)
      }
      if (proposal.state === 'closed') return deny('PROPOSAL_CLOSED')
      if (row.run_id !== this.access.runId) return deny('STALE_HOST_RUN')
      if (assistantSessionId === leaderSessionId) return deny('SESSION_ALREADY_BOUND')
      // Revalidate the stored references while creating the project; roll everything back if recording the decision fails.
      const { name, objective, originTaskId, leaderBotId } = proposal
      const project = this.createInTransaction({ leaderSessionId, commandId: `studio-project-proposal:${proposalId}`,
        name, objective, originTaskId, leaderBotId }, assistantSessionId)
      if (!project.ok) return project
      requireWrite(this.db.prepare(`UPDATE studio_project_proposal SET state = 'created', project_id = ?, decided_at = ?
        WHERE assistant_session_id = ? AND proposal_id = ? AND run_id = ? AND state = 'pending'`)
        .run(project.value.projectId, new Date().toISOString(), assistantSessionId, proposalId, this.access.runId).changes)
      return project
    })
  }

  /** Close an exact pending proposal without modifying the original request or an earlier decision. */
  closeProposal(assistantSessionId: string, proposalId: string): ManagedResult<StudioProjectProposal> {
    if (!isId(assistantSessionId) || !isId(proposalId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      if (!this.access.assistantBinding(assistantSessionId)) return deny('SESSION_NOT_BOUND')
      const row = this.proposalRow(assistantSessionId, proposalId)
      if (!row) return deny('PROPOSAL_NOT_FOUND')
      const proposal = readProposalRow(row)
      if (proposal.state === 'closed') return accept(proposal)
      if (proposal.state === 'created') return deny('PROPOSAL_ALREADY_CREATED')
      if (row.run_id !== this.access.runId) return deny('STALE_HOST_RUN')
      requireWrite(this.db.prepare(`UPDATE studio_project_proposal SET state = 'closed', decided_at = ?
        WHERE assistant_session_id = ? AND proposal_id = ? AND run_id = ? AND state = 'pending'`)
        .run(new Date().toISOString(), assistantSessionId, proposalId, this.access.runId).changes)
      return accept({ ...proposal, state: 'closed' })
    })
  }

  /** Read a proposal by exact ID, or the last one recorded for this Assistant Session, including previous runs. */
  readProposal(assistantSessionId: string, proposalId?: string): ManagedResult<StudioProjectProposal> {
    if (!isId(assistantSessionId) || (proposalId !== undefined && !isId(proposalId))) return deny('INVALID_INPUT')
    try {
      if (!this.access.assistantBinding(assistantSessionId)) return deny('SESSION_NOT_BOUND')
      const row = this.proposalRow(assistantSessionId, proposalId)
      return row ? accept(readProposalRow(row)) : deny('PROPOSAL_NOT_FOUND')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Create the project and its first binding inside the caller's fenced write transaction. */
  private createInTransaction(input: CreateInput, originAssistantSessionId?: string): ManagedResult<StudioProject> {
    const { leaderSessionId, commandId, name, objective, leaderBotId, originTaskId } = input
    if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
    if (this.sessionBound(leaderSessionId)) return deny('SESSION_ALREADY_BOUND')
    // Link the existing completed draft without taking ownership of its Session or creating a new execution.
    if (originTaskId !== undefined) {
      if (!this.completedOrigin(originTaskId, originAssistantSessionId)) return deny('ORIGIN_TASK_NOT_COMPLETED')
      if (this.db.prepare('SELECT 1 FROM studio_project WHERE origin_task_id = ?').get(originTaskId)) return deny('ORIGIN_TASK_ALREADY_LINKED')
    }
    const bot = this.resolveBot(leaderBotId)
    if (!bot.ok) return bot
    const projectId = randomUUID()
    requireWrite(this.db.prepare(`INSERT INTO studio_project (project_id, name, objective, origin_task_id, management_epoch)
      VALUES (?, ?, ?, ?, 1)`).run(projectId, name, objective, originTaskId ?? null).changes)
    const binding = { projectId, leaderBotId: bot.value, leaderSessionId, managementEpoch: 1 }
    this.insertBinding(binding, commandId)
    return accept({ ...binding, name, objective, ...(originTaskId === undefined ? {} : { originTaskId }), pendingCount: 0 })
  }

  /** Transfer management to a never-bound Session and optionally archive the state after releasing reservations. */
  handoff(input: HandoffInput, capture = false): ManagedResult<StudioProject> {
    if (!input || typeof capture !== 'boolean') return deny('INVALID_INPUT')
    const { projectId, expectedEpoch, nextSessionId, commandId, leaderBotId } = input
    if (!isId(projectId) || !isEpoch(expectedEpoch) || !isId(nextSessionId) || !isId(commandId)
      || (leaderBotId !== undefined && !isId(leaderBotId))) return deny('INVALID_INPUT')
    return this.access.write(() => {
      if (this.commandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const project = this.project(projectId)
      if (!project) return deny('PROJECT_NOT_FOUND')
      if (project.managementEpoch !== expectedEpoch) return deny('STALE_MANAGEMENT')
      const managementEpoch = expectedEpoch + 1
      if (!isEpoch(managementEpoch)) return deny('INVALID_INPUT')
      if (this.sessionBound(nextSessionId)) return deny('SESSION_ALREADY_BOUND')
      const bot = this.resolveBot(leaderBotId === 'new' ? undefined : leaderBotId ?? project.leaderBotId)
      if (!bot.ok) return bot
      const next = { ...project, leaderBotId: bot.value, leaderSessionId: nextSessionId, managementEpoch }
      this.insertBinding(next, commandId)
      requireWrite(this.db.prepare('UPDATE studio_project SET management_epoch = ? WHERE project_id = ? AND management_epoch = ?')
        .run(managementEpoch, projectId, expectedEpoch).changes)
      // Only release the previous Leader's reservations that never entered the model. Running Workers retain their origin.
      this.db.prepare(`UPDATE studio_project_dispatch SET state = 'released', failure = 'STALE_MANAGEMENT'
        WHERE project_id = ? AND management_epoch = ? AND state = 'reserved'`).run(projectId, expectedEpoch)
      if (this.db.prepare(`SELECT 1 FROM studio_project_dispatch
        WHERE project_id = ? AND management_epoch = ? AND state = 'reserved' LIMIT 1`).get(projectId, expectedEpoch)) {
        throw new Error('Cannot release Studio project reservations during handoff')
      }
      if (capture) captureProjectHandoff(this.db, this.access, project, next, commandId)
      const current = this.boundProject(next)
      if (current.managementEpoch !== managementEpoch || current.leaderSessionId !== nextSessionId || current.leaderBotId !== bot.value) {
        throw new Error('Cannot verify Studio project management after handoff')
      }
      return accept(current)
    })
  }

  /** Read the selected handoff and recheck its work IDs, only for the project's exact current Leader. */
  readHandoff(sessionId: string, managementEpoch?: number): ManagedResult<ProjectHandoffReview> {
    if (!isId(sessionId) || (managementEpoch !== undefined && !isEpoch(managementEpoch))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.currentProject(sessionId, true)
      if (!current.ok) return current
      const epoch = managementEpoch ?? current.value.managementEpoch
      if (epoch > current.value.managementEpoch) return deny('HANDOFF_NOT_RECORDED')
      const review = readProjectHandoff(this.db, this.access, current.value, epoch)
      return review ? accept(review) : deny('HANDOFF_NOT_RECORDED')
    })
  }

  /** Register work only for the current Leader. A repeated source request returns its original row without launching anything. */
  recordWork(input: WorkInput): ManagedResult<{ work: StudioProjectWork; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { leaderSessionId, sourceMessageId, sourceRequestId, requestText } = input
    if (!isId(leaderSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId) || !isText(requestText, PROJECT_TEXT_LIMIT)) {
      return deny('INVALID_INPUT')
    }
    if (parseProjectFactRequest(requestText).kind !== 'plain') return deny('INVALID_PROJECT_FACT_REQUEST')
    return this.access.write<{ work: StudioProjectWork; created: boolean }>(() => {
      // Check authority before deduplication, so replaying old work cannot succeed after a handoff.
      const current = this.currentProject(leaderSessionId)
      if (!current.ok) return current
      const { projectId, leaderBotId, managementEpoch } = current.value
      const binding = { projectId, leaderBotId, leaderSessionId, managementEpoch }
      // A fact or advice claim cannot be replayed as plain work using either native coordinate.
      if (this.adviceUsedWorkSource(leaderSessionId, sourceMessageId, sourceRequestId) || this.db.prepare(`SELECT 1
        FROM studio_project_work w JOIN studio_project_work_fact f USING (work_id) WHERE w.leader_session_id = ?
        AND (w.source_message_id = ? OR w.source_request_id = ?) LIMIT 1`).get(leaderSessionId, sourceMessageId, sourceRequestId)) {
        return deny('SOURCE_ALREADY_USED')
      }
      const existing = this.db.prepare(`SELECT work_id, source_message_id, request_text FROM studio_project_work
        WHERE leader_session_id = ? AND source_request_id = ?`).get(leaderSessionId, sourceRequestId)
      if (existing) {
        const { work_id: workId, source_message_id: messageId, request_text: text } = existing
        if (!isId(workId) || !isId(messageId) || !isText(text, PROJECT_TEXT_LIMIT)) throw new Error('Invalid Studio project work')
        return accept({ work: { ...binding, workId, sourceMessageId: messageId, sourceRequestId, requestText: text }, created: false })
      }
      return accept({ work: this.insertWork(binding, sourceMessageId, sourceRequestId, requestText), created: true })
    })
  }

  /** Host-only: pin the exact fact mentioned in a verified native owner event, without reserving a Worker. */
  recordFactWork(input: WorkInput & { sourceEventSeq: number; turn: number }): ManagedResult<{ work: StudioProjectWork; created: boolean }> {
    if (!input) return deny('INVALID_INPUT')
    const { leaderSessionId, sourceMessageId, sourceRequestId, requestText, sourceEventSeq, turn } = input
    if (!isId(leaderSessionId) || !isId(sourceMessageId) || !isId(sourceRequestId) || !isText(requestText, PROJECT_TEXT_LIMIT)
      || (sourceEventSeq !== 0 && !isEpoch(sourceEventSeq)) || !isEpoch(turn)) return deny('INVALID_INPUT')
    const reference = parseProjectFactRequest(requestText)
    if (reference.kind !== 'fact') return deny('INVALID_PROJECT_FACT_REQUEST')
    const { projectId, key, revision, taskText } = reference
    if (!isId(projectId) || !isProjectFactKey(key) || !isEpoch(revision) || !isText(taskText, PROJECT_TEXT_LIMIT)) {
      return deny('INVALID_PROJECT_FACT_REQUEST')
    }
    const source = { projectId, key, revision, sourceEventSeq, turn }
    return this.access.write<{ work: StudioProjectWork; created: boolean }>(() => {
      const current = this.currentProject(leaderSessionId, true)
      if (!current.ok) return current
      if (current.value.projectId !== projectId) return deny('FACT_PROJECT_MISMATCH')
      if (this.adviceUsedWorkSource(leaderSessionId, sourceMessageId, sourceRequestId)) return deny('SOURCE_ALREADY_USED')
      // Match each native coordinate independently. An exact replay returns its one original row, never a second binding.
      const matches = this.db.prepare(`${WORK_SELECT} LEFT JOIN studio_project_work_fact f ON f.work_id = w.work_id
        WHERE w.leader_session_id = ? AND (w.source_request_id = ? OR w.source_message_id = ? OR f.source_event_seq = ?)
        LIMIT 2`).all(leaderSessionId, sourceRequestId, sourceMessageId, sourceEventSeq)
      if (matches.length) {
        if (matches.length !== 1) return deny('SOURCE_ALREADY_USED')
        const work = readWorkRow(matches[0]!)
        const pinned = readWorkFact(this.db, work.workId)
        if (!pinned || work.sourceRequestId !== sourceRequestId || work.sourceMessageId !== sourceMessageId
          || work.requestText !== taskText || pinned.projectId !== projectId || pinned.key !== key || pinned.revision !== revision
          || pinned.sourceEventSeq !== sourceEventSeq || pinned.turn !== turn) return deny('SOURCE_ALREADY_USED')
        if (this.factQuote(pinned) === undefined) return deny('FACT_NOT_CURRENT')
        return accept({ work, created: false })
      }
      if (this.factQuote(source) === undefined) return deny('FACT_NOT_CURRENT')
      // Preserve the owner's task verbatim; neither the header nor the checked quote is copied into the work row.
      const work = this.insertWork(current.value, sourceMessageId, sourceRequestId, taskText)
      appendWorkFact(this.db, work.workId, source)
      return accept({ work, created: true })
    })
  }

  /** Host-only native owner command: pin an excerpt to standalone work that has never been dispatched. */
  bindWorkResult(leaderSessionId: string, workId: string, sourceWorkId: string, quote: string,
    commandId: string): ManagedResult<{ source: ProjectWorkResultUse; created: boolean }> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(sourceWorkId) || !isId(commandId)
      || !isDraftText(quote) || quote.length > PROJECT_RESULT_QUOTE_LIMIT) return deny('INVALID_INPUT')
    return this.access.write<{ source: ProjectWorkResultUse; created: boolean }>(() => {
      const current = this.currentProject(leaderSessionId, true)
      if (!current.ok) return current
      const { projectId } = current.value
      if (!this.work(projectId, workId)) return deny('WORK_NOT_FOUND')
      const pinned = readWorkResultUse(this.db, workId)
      // Only an exact replay of the same native command can return the original binding; no command rewrites it.
      if (pinned && pinned.commandId === commandId && pinned.leaderSessionId === leaderSessionId && pinned.sourceWorkId === sourceWorkId) {
        const text = this.currentWorkResult(pinned, projectId)
        if (text === undefined) return deny('RESULT_SOURCE_NOT_CURRENT')
        return text === quote ? accept({ source: workResultUseView(pinned, true), created: false }) : deny('DUPLICATE_COMMAND')
      }
      if (this.commandUsed(commandId) || this.access.documentCommandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      if (pinned) return deny('WORK_RESULT_ALREADY_LINKED')
      if (this.db.prepare('SELECT 1 FROM studio_project_dispatch WHERE work_id = ? LIMIT 1').get(workId)) {
        return deny('WORK_ALREADY_DISPATCHED')
      }
      if (readWorkFact(this.db, workId)) return deny('FACT_TEXT_WORK_ONLY')
      if (projectDocumentAttached(this.db, workId)) return deny('WORK_HAS_DOCUMENT_TASK')
      if (this.db.prepare('SELECT 1 FROM studio_project_job WHERE work_id = ?').get(workId)) return deny('RESULT_TEXT_WORK_ONLY')
      if (sourceWorkId === workId) return deny('RESULT_SOURCE_UNAVAILABLE')
      const evidence = this.readWorkEvidence(projectId, sourceWorkId, null)
      if (!evidence) return deny('RESULT_SOURCE_UNAVAILABLE')
      const { workerSessionId, workerBotId, executionEpoch, result: { text, messageId, turn, eventSeq } } = evidence
      // Search one UTF-16 code unit after the first match so overlapping matches also count.
      const offset = text.indexOf(quote)
      if (offset === -1 || text.indexOf(quote, offset + 1) !== -1) return deny('RESULT_QUOTE_NOT_UNIQUE')
      const source = { projectId, sourceWorkId, workerSessionId, workerBotId, executionEpoch, messageId, turn, eventSeq,
        leaderSessionId, commandId, offset, length: quote.length, fingerprint: workResultFingerprint(text) }
      appendWorkResultUse(this.db, workId, source)
      return accept({ source: workResultUseView(source, true), created: true })
    })
  }

  private adviceUsedWorkSource(leaderSessionId: string, sourceMessageId: string, sourceRequestId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM studio_advice WHERE role = 'leader' AND requester_session_id = ?
      AND (source_message_id = ? OR source_request_id = ?) LIMIT 1`).get(leaderSessionId, sourceMessageId, sourceRequestId)
  }

  /** Insert work with its original Leader binding inside the caller's write transaction. */
  private insertWork(binding: StudioProjectBinding, sourceMessageId: string, sourceRequestId: string, requestText: string): StudioProjectWork {
    const workId = randomUUID()
    requireWrite(this.db.prepare(`INSERT INTO studio_project_work (work_id, leader_session_id, source_message_id, source_request_id, request_text)
      VALUES (?, ?, ?, ?, ?)`).run(workId, binding.leaderSessionId, sourceMessageId, sourceRequestId, requestText).changes)
    return { ...binding, workId, sourceMessageId, sourceRequestId, requestText }
  }

  /** Host-only: hold standalone text work and release its still-unstarted reservation, if any. */
  blockWork(leaderSessionId: string, workId: string, reason: string, resumeWhen: string, commandId: string): ManagedResult<ProjectWorkBlockView> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId)
      || !isProjectWorkBlockText(reason) || !isProjectWorkBlockText(resumeWhen)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const actor = this.currentProject(leaderSessionId, true)
      if (!actor.ok) return actor
      if (!this.work(actor.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      if (this.commandUsed(commandId) || this.access.documentCommandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      if (latestWorkBlockState(this.db, workId) === 'active') return deny('PROJECT_WORK_BLOCK_ALREADY_ACTIVE')
      if (this.workHasDocumentOrJob(workId)) return deny('PROJECT_WORK_BLOCK_TEXT_ONLY')
      if (this.db.prepare(`SELECT 1 FROM studio_project_dispatch
        WHERE work_id = ? AND state <> 'released' AND state <> 'reserved'`).get(workId)) {
        return deny('WORK_ALREADY_DISPATCHED')
      }
      return accept(appendWorkBlock(this.db, actor.value, workId, reason, resumeWhen, commandId))
    })
  }

  /** Host-only: clear the exact active block, including one inherited across handoff, without granting dispatch authority. */
  unblockWork(leaderSessionId: string, workId: string, blockId: string, change: string, commandId: string): ManagedResult<ProjectWorkBlockView> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId) || !isProjectWorkBlockText(change)) return deny('INVALID_INPUT')
    if (!isId(blockId)) return deny('PROJECT_WORK_BLOCK_NOT_CURRENT')
    return this.access.write(() => {
      const actor = this.currentProject(leaderSessionId, true)
      if (!actor.ok) return actor
      if (!this.work(actor.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      if (this.commandUsed(commandId) || this.access.documentCommandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const block = latestWorkBlock(this.db, workId)
      if (!block || block.cleared || block.blockId !== blockId) return deny('PROJECT_WORK_BLOCK_NOT_CURRENT')
      return accept(appendWorkBlockClear(this.db, actor.value, block, change, commandId))
    })
  }

  /** Host-only: record a native owner's exact route without authorizing a dispatch. */
  bindWorkModel(leaderSessionId: string, workId: string, route: PinnedTextWorkerModel, commandId: string): ManagedResult<ProjectWorkModelSelection> {
    const pinned = readPinnedWorkModel(route)
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId) || !pinned) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const actor = this.currentProject(leaderSessionId, true)
      if (!actor.ok) return actor
      if (!this.work(actor.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      if (this.commandUsed(commandId) || this.access.documentCommandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      if (hasUnclearedWorkModel(this.db, workId)) return deny('WORK_MODEL_SELECTION_ALREADY_BOUND')
      if (this.hasNonreleasedDispatch(workId)) return deny('WORK_ALREADY_DISPATCHED')
      if (this.workHasDocumentOrJob(workId)) return deny('WORK_MODEL_TEXT_ONLY')
      const selection = { selectionId: randomUUID(), route: pinned }
      appendWorkModel(this.db, actor.value, workId, selection, commandId)
      return accept(selection)
    })
  }

  /** Host-only: withdraw the exact uncleared choice, even if a predecessor bound it or a released attempt spent it. */
  clearWorkModel(leaderSessionId: string, workId: string, selectionId: string, commandId: string): ManagedResult<void> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId)) return deny('INVALID_INPUT')
    if (!isWorkModelSelectionId(selectionId)) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    return this.access.write(() => {
      const actor = this.currentProject(leaderSessionId, true)
      if (!actor.ok) return actor
      if (!this.work(actor.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      if (this.commandUsed(commandId) || this.access.documentCommandUsed(commandId)) return deny('DUPLICATE_COMMAND')
      const model = latestWorkModel(this.db, workId)
      if (!model || model.cleared || model.selectionId !== selectionId) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
      if (this.hasNonreleasedDispatch(workId)) return deny('WORK_ALREADY_DISPATCHED')
      appendWorkModelClear(this.db, actor.value, selectionId, commandId)
      return accept(undefined)
    })
  }

  /** Preflight a manual dispatch; reserveWork must repeat the check under its write lock. */
  resolveWorkModel(leaderSessionId: string, workId: string, selectionId?: string, explicitPlain = false):
    ManagedResult<ProjectWorkModelSelection | undefined> {
    if (!isId(leaderSessionId) || !isId(workId) || typeof explicitPlain !== 'boolean') return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const actor = this.currentProject(leaderSessionId, true)
      if (!actor.ok) return actor
      if (!this.work(actor.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      return this.resolveWorkModelInTransaction(actor.value, workId, selectionId, explicitPlain)
    })
  }

  /** Check the hold before model lookup; neither a clear nor an invalid token can fall through to the ordinary route. */
  private resolveWorkModelInTransaction(actor: StudioProjectBinding, workId: string, selectionId: string | undefined,
    explicitPlain: boolean, automatic = false): ManagedResult<ProjectWorkModelSelection | undefined> {
    const block = latestWorkBlockState(this.db, workId)
    if (block === 'active') return deny('PROJECT_WORK_BLOCKED')
    // A separately armed future job still has to pass the existing grant checks in reserveWork.
    if (block === 'cleared' && !automatic && selectionId === undefined && !explicitPlain) {
      return deny('PROJECT_WORK_UNBLOCK_REQUIRES_OWNER')
    }
    const model = latestWorkModel(this.db, workId)
    if (automatic && (selectionId !== undefined || (model && !model.cleared))) return deny('PROJECT_MODEL_SELECTION_REQUIRES_OWNER')
    if (selectionId === undefined) {
      return model && (!model.cleared || (!explicitPlain && !automatic)) ? deny('PROJECT_MODEL_SELECTION_REQUIRES_OWNER') : accept(undefined)
    }
    if (!model || model.cleared || model.selectionId !== selectionId) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    const state = workModelState(model, actor)
    if (state === 'used') return deny('WORK_MODEL_SELECTION_USED')
    if (state !== 'pending') return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    if (this.workHasDocumentOrJob(workId)) return deny('WORK_MODEL_TEXT_ONLY')
    return accept({ selectionId, route: model.route })
  }

  private hasNonreleasedDispatch(workId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM studio_project_dispatch WHERE work_id = ? AND state <> 'released'").get(workId)
  }

  private workHasDocumentOrJob(workId: string): boolean {
    return projectDocumentAttached(this.db, workId) || !!this.db.prepare('SELECT 1 FROM studio_project_job WHERE work_id = ?').get(workId)
  }

  /** Host-only: link an existing version 1 task with an exact owner authorization version; neither grant nor start execution. */
  attachDocument(leaderSessionId: string, workId: string, taskId: string, expectedAuthorizationVersion: number,
    commandId: string): ManagedResult<StudioProjectDocument> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(taskId) || !isEpoch(expectedAuthorizationVersion) || !isId(commandId)) {
      return deny('INVALID_INPUT')
    }
    return this.access.write(() => {
      const current = this.currentProject(leaderSessionId)
      if (!current.ok) return current
      if (!this.work(current.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      if (latestWorkBlockState(this.db, workId) === 'active') return deny('PROJECT_WORK_BLOCKED')
      if (hasUnclearedWorkModel(this.db, workId)) return deny('WORK_MODEL_TEXT_ONLY')
      if (readWorkFact(this.db, workId)) return deny('FACT_TEXT_WORK_ONLY')
      if (readWorkResultUse(this.db, workId)) return deny('RESULT_TEXT_WORK_ONLY')
      return attachProjectDocument(this.db, this.access, current.value, workId, taskId, expectedAuthorizationVersion, commandId,
        () => this.commandUsed(commandId) || this.access.documentCommandUsed(commandId))
    })
  }

  /** Pin only an already observed invocation, without creating or controlling the external job. */
  attachJob(leaderSessionId: string, workId: string, commandId: string, ref: SystemdJobRef,
    state: Exclude<SystemdJobState, 'unknown'>): ManagedResult<StudioProjectJob> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId) || !isConfirmedJobState(state)
      || !ref || typeof ref !== 'object') return deny('INVALID_INPUT')
    const { unit, invocationId } = ref
    if (!isId(unit) || !isId(invocationId) || !validSystemdJob({ unit, invocationId })) return deny('INVALID_INPUT')
    return this.withCurrentJobWork(leaderSessionId, workId, actor => {
      if (latestWorkBlockState(this.db, workId) === 'active') return deny('PROJECT_WORK_BLOCKED')
      if (hasUnclearedWorkModel(this.db, workId)) return deny('WORK_MODEL_TEXT_ONLY')
      if (readWorkFact(this.db, workId)) return deny('FACT_TEXT_WORK_ONLY')
      if (readWorkResultUse(this.db, workId)) return deny('RESULT_TEXT_WORK_ONLY')
      if (projectDocumentAttached(this.db, workId)) return deny('WORK_HAS_DOCUMENT_TASK')
      return attachProjectJob(this.db, actor, workId, commandId, { unit, invocationId }, state, () => this.commandUsed(commandId))
    })
  }

  /** Read a pinned invocation for a current or historical Leader without granting control. */
  readJob(leaderSessionId: string, workId: string): ManagedResult<StudioProjectJob | undefined> {
    if (!isId(leaderSessionId) || !isId(workId)) return deny('INVALID_INPUT')
    try {
      const binding = this.binding(leaderSessionId)
      if (!binding) return deny('SESSION_NOT_BOUND')
      const work = this.work(binding.projectId, workId)
      return work ? accept(readProjectJob(this.db, work.projectId, workId)) : deny('WORK_NOT_FOUND')
    } catch {
      return deny('STORAGE_ERROR')
    }
  }

  /** Merge the Host's versioned observation; this does not grant or withdraw permission to continue. */
  observeJob(leaderSessionId: string, workId: string, expectedObservationVersion: number, state: SystemdJobState): ManagedResult<StudioProjectJob> {
    if (!isId(leaderSessionId) || !isId(workId) || !isEpoch(expectedObservationVersion) || !isJobState(state)) return deny('INVALID_INPUT')
    return this.withCurrentJobWork(leaderSessionId, workId, actor =>
      observeProjectJob(this.db, actor.projectId, workId, expectedObservationVersion, state))
  }

  /** Host-only: read one keyset page of nonterminal pinned jobs for polling, without allocating any Worker. */
  jobWatchBatch(afterWorkId?: string): ManagedResult<StudioProjectJob[]> {
    if (afterWorkId !== undefined && !isId(afterWorkId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => accept(watchedJobPage(this.db, afterWorkId ?? '')))
  }

  /** Host-only: merge facts for an exact pinned invocation, even if no Leader Session is live. */
  observeWatchedJob(workId: string, ref: SystemdJobRef, expectedObservationVersion: number,
    state: SystemdJobState): ManagedResult<StudioProjectJob> {
    if (!isId(workId) || !ref || typeof ref !== 'object' || !isEpoch(expectedObservationVersion) || !isJobState(state)) {
      return deny('INVALID_INPUT')
    }
    const { unit, invocationId } = ref
    if (!isId(unit) || !isId(invocationId) || !validSystemdJob({ unit, invocationId })) return deny('INVALID_INPUT')
    return this.access.write(() => observeWatchedProjectJob(this.db, workId, { unit, invocationId }, expectedObservationVersion, state))
  }

  /** Host-only: record an explicit owner grant for one automatic continuation under the current Leader and route. */
  armJob(leaderSessionId: string, workId: string, commandId: string, expectedAuthorizationVersion: number,
    route: StudioJobRoute): ManagedResult<StudioProjectJob> {
    const approvedRoute = readJobRoute(route)
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId) || !isEpoch(expectedAuthorizationVersion) || !approvedRoute) {
      return deny('INVALID_INPUT')
    }
    return this.withCurrentJobWork(leaderSessionId, workId, actor => {
      if (latestWorkBlockState(this.db, workId) === 'active') return deny('PROJECT_WORK_BLOCKED')
      const job = readProjectJob(this.db, actor.projectId, workId)
      return job ? armProjectJob(this.db, actor, job, commandId, expectedAuthorizationVersion, approvedRoute, () => this.commandUsed(commandId))
        : deny('EXTERNAL_JOB_NOT_FOUND')
    })
  }

  /** Host-only: read one keyset page of eligible grants; reserveWork still rechecks every authority predicate. */
  jobAutoBatch(afterWorkId?: string): ManagedResult<StudioJobAuto[]> {
    if (afterWorkId !== undefined && !isId(afterWorkId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => accept(jobAutoPage(this.db, afterWorkId ?? '')))
  }

  /** Set the owner pause independently of observation; resuming does not dispatch a Worker. */
  setJobPaused(leaderSessionId: string, workId: string, commandId: string, expectedAuthorizationVersion: number,
    paused: boolean): ManagedResult<StudioProjectJob> {
    if (!isId(leaderSessionId) || !isId(workId) || !isId(commandId) || !isEpoch(expectedAuthorizationVersion)
      || typeof paused !== 'boolean') return deny('INVALID_INPUT')
    return this.withCurrentJobWork(leaderSessionId, workId, actor =>
      setProjectJobPaused(this.db, actor, workId, commandId, expectedAuthorizationVersion, paused, () => this.commandUsed(commandId)))
  }

  /** Resolve current management and work membership under the same write lock as the job mutation. */
  private withCurrentJobWork(leaderSessionId: string, workId: string,
    operation: (actor: StudioProjectBinding) => ManagedResult<StudioProjectJob>): ManagedResult<StudioProjectJob> {
    return this.access.write(() => {
      const current = this.currentProject(leaderSessionId)
      if (!current.ok) return current
      if (!this.work(current.value.projectId, workId)) return deny('WORK_NOT_FOUND')
      return operation(current.value)
    })
  }

  /** Reserve an eligible Worker, atomically spending the exact native model selection or automatic job grant if required. */
  reserveWork(leaderSessionId: string, workId: string, workerSessionId: string, automatic?: { permitId: string; route: StudioJobRoute },
    allowFact = false, modelDispatch?: ProjectWorkModelDispatchIntent):
    ManagedResult<StudioProjectWorkView & { run: StudioProjectRun; created: boolean }> {
    const auto = automatic === undefined ? undefined : readAutoReservation(automatic)
    if (!isId(leaderSessionId) || !isId(workId) || !isId(workerSessionId) || (automatic !== undefined && !auto)) return deny('INVALID_INPUT')
    const intent = modelDispatch === undefined ? undefined : readWorkModelDispatch(modelDispatch)
    if (modelDispatch !== undefined && !intent) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    const proof = intent && 'selectionId' in intent ? intent : undefined
    const explicitPlain = intent !== undefined && 'explicitPlain' in intent
    return this.access.write<StudioProjectWorkView & { run: StudioProjectRun; created: boolean }>(() => {
      const current = this.currentProject(leaderSessionId)
      if (!current.ok) return current
      const { projectId, managementEpoch } = current.value
      const work = this.work(projectId, workId)
      if (!work) return deny('WORK_NOT_FOUND')
      const selected = this.resolveWorkModelInTransaction(current.value, workId, proof?.selectionId, explicitPlain, auto !== undefined)
      if (!selected.ok) return selected
      if (proof) {
        if (!selected.value || !sameWorkModel(selected.value.route, proof.route)) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
        if (workModelSourceUsed(this.db, leaderSessionId, proof)) return deny('SOURCE_ALREADY_USED')
      }
      const fact = readWorkFact(this.db, workId)
      if (fact && fact.projectId !== projectId) return deny('FACT_PROJECT_MISMATCH')
      // A fact is only for a fresh, explicit owner dispatch to a standalone text Worker.
      if (fact && auto) return deny('FACT_TEXT_WORK_ONLY')
      if (fact && allowFact !== true) return deny('PROJECT_FACT_USE_DISABLED')
      if (fact && this.factQuote(fact) === undefined) return deny('FACT_NOT_CURRENT')
      const pinnedResult = readWorkResultUse(this.db, workId)
      // The existing Host flag allows an explicit owner dispatch only; automatic continuations never qualify.
      if (pinnedResult && (auto || allowFact !== true)) return deny('PROJECT_RESULT_USE_REQUIRES_OWNER')
      if (pinnedResult && this.currentWorkResult(pinnedResult, projectId) === undefined) return deny('RESULT_SOURCE_NOT_CURRENT')
      // A document task keeps its own execution authority. Neither manual nor automatic dispatch may claim its work.
      if (projectDocumentAttached(this.db, workId)) return deny(fact ? 'FACT_TEXT_WORK_ONLY' : 'WORK_HAS_DOCUMENT_TASK')
      const job = readProjectJob(this.db, projectId, workId)
      if (fact && job) return deny('FACT_TEXT_WORK_ONLY')
      if (pinnedResult && job) return deny('RESULT_TEXT_WORK_ONLY')
      // Manual callers still get the existing attempt. An automatic caller cannot claim it with a grant.
      const resultUse = pinnedResult && workResultUseView(pinnedResult, true)
      const { run: previous, ...attempt } = this.workRunView(work, fact && { ...fact, current: true }, true, resultUse, true)
      const view = { work, ...attempt, ...(job ? { job } : {}) }
      if (previous && previous.state !== 'released') {
        return auto ? deny('WORK_ALREADY_DISPATCHED') : accept({ ...view, run: previous, created: false })
      }
      const blocked = this.jobDispatchBlock(job)
      if (blocked) return blocked
      const grant = auto ? job?.automatic : undefined
      if (auto && (!grant || grant.permitId !== auto.permitId || grant.executionEpoch !== undefined
        || grant.leaderSessionId !== leaderSessionId || grant.managementEpoch !== managementEpoch
        || !sameJobRoute(grant.route, auto.route))) return deny('STALE_JOB_AUTHORIZATION')
      // A release permits a new epoch, not reuse of the Worker Session or a spent grant.
      if (this.sessionBound(workerSessionId)) return deny('SESSION_ALREADY_BOUND')
      const executionEpoch = (previous?.executionEpoch ?? 0) + 1
      if (!isEpoch(executionEpoch)) return deny('INVALID_INPUT')
      const run: StudioProjectRun = { workId, projectId, leaderSessionId, managementEpoch, workerSessionId,
        workerBotId: randomUUID(), executionEpoch, state: 'reserved' }
      if (proof) appendWorkModelConsume(this.db, run, this.access.runId, proof)
      requireWrite(this.db.prepare(`INSERT INTO studio_project_dispatch (work_id, execution_epoch, project_id, leader_session_id,
        management_epoch, worker_session_id, worker_bot_id, run_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(...this.dispatchKeys(run)).changes)
      if (selected.value) return accept({ ...view, run, created: true,
        modelSelection: { ...selected.value, state: 'used', executionEpoch } })
      if (job && grant) {
        consumeJobAuto(this.db, grant, projectId, executionEpoch)
        return accept({ work, job: { ...job, automatic: { ...grant, executionEpoch } }, run, created: true })
      }
      return accept({ ...view, run, created: true })
    })
  }

  /** Check the exact reservation and job in one read snapshot, without consuming the reservation. */
  canStartWork(run: StudioProjectRun): ManagedResult<StudioProjectRun> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    // Unlike this preflight, beginWork also takes the write lock and consumes the reservation.
    return this.access.snapshot(() => {
      const reservation = this.startableReservation(identity)
      return reservation.ok ? accept(reservation.value.run) : reservation
    })
  }

  /** Consume the exact reservation before the Host lets the Worker enter the model. */
  beginWork(run: StudioProjectRun): ManagedResult<StudioProjectRun> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    return this.access.write(() => {
      // Read authority and change state under the same write lock as handoff and recovery.
      const reservation = this.startableReservation(identity)
      if (!reservation.ok) return reservation
      requireWrite(this.db.prepare(`UPDATE studio_project_dispatch SET state = 'running'
        WHERE ${EXACT_DISPATCH} AND state = 'reserved'`).run(...this.dispatchKeys(identity)).changes)
      return accept({ ...reservation.value.run, state: 'running' })
    })
  }

  /** Open the checked excerpt only for the exact reservation at the private relay boundary. */
  resolveWorkFact(run: StudioProjectRun): ManagedResult<{ text: string }> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const reservation = this.startableReservation(identity)
      if (!reservation.ok) return reservation
      return reservation.value.fact === undefined ? deny('WORK_FACT_NOT_LINKED') : accept(reservation.value.fact)
    })
  }

  /** Check a running fact Worker before a model stream; the fact and current management share one snapshot. */
  checkRunningWorkFact(run: StudioProjectRun): ManagedResult<void> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.dispatchAuthority(identity)
      if (!current.ok) return current
      const stored = this.exactRun(identity)
      if (!stored) return deny('STALE_EXECUTION')
      if (stored.state !== 'running') return deny('WORK_NOT_RUNNING')
      const fact = this.confirmWorkFact(stored)
      if (!fact.ok) return fact
      return fact.value === undefined ? deny('WORK_FACT_NOT_LINKED') : accept(undefined)
    })
  }

  /** Resolve just the excerpt for the exact reservation at the private relay boundary. */
  resolveWorkResult(run: StudioProjectRun): ManagedResult<{ text: string }> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const reservation = this.startableReservation(identity)
      if (!reservation.ok) return reservation
      return reservation.value.resultUse === undefined ? deny('WORK_RESULT_NOT_LINKED') : accept(reservation.value.resultUse)
    })
  }

  /** Recheck current management, the exact attempt, and its source in one snapshot before a model stream. */
  checkRunningWorkResult(run: StudioProjectRun): ManagedResult<void> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.dispatchAuthority(identity)
      if (!current.ok) return current
      const stored = this.exactRun(identity)
      if (!stored) return deny('STALE_EXECUTION')
      if (stored.state !== 'running') return deny('WORK_NOT_RUNNING')
      const source = this.confirmWorkResult(stored)
      if (!source.ok) return source
      return source.value === undefined ? deny('WORK_RESULT_NOT_LINKED') : accept(undefined)
    })
  }

  /** Check the exact consumed selection on its current, running attempt before the Host opens a model stream. */
  checkRunningWorkModel(run: StudioProjectRun, selectionId: string): ManagedResult<void> {
    const identity = dispatchIdentity(run)
    if (!identity) return deny('INVALID_INPUT')
    if (!isWorkModelSelectionId(selectionId)) return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    return this.access.snapshot(() => {
      const current = this.dispatchAuthority(identity)
      if (!current.ok) return current
      const stored = this.exactRun(identity)
      if (!stored) return deny('STALE_EXECUTION')
      if (stored.state !== 'running') return deny('WORK_NOT_RUNNING')
      return this.confirmWorkModelRun(stored, selectionId)
    })
  }

  /** Settle only this Worker's attempt. A pre-start failure releases it; a started attempt is always terminal. */
  settleWork(run: StudioProjectRun, result: StudioDraftResult | undefined, failure: string): ManagedResult<StudioProjectRun> {
    const identity = dispatchIdentity(run)
    const outcome = draftResult(result)
    if (!identity || (result === undefined ? !isFailure(failure) : !outcome)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      // A started Worker can settle across handoff, but it cannot publish a result against stale evidence.
      const stored = this.exactRun(identity)
      if (!stored) return deny('STALE_EXECUTION')
      if (stored.state === 'released' && stored.failure === 'PROJECT_WORK_BLOCKED') return deny('PROJECT_WORK_BLOCKED')
      if (stored.state !== 'running' && (stored.state !== 'reserved' || outcome)) return deny('WORK_NOT_RUNNING')
      const fact = outcome ? this.confirmWorkFact(stored) : undefined
      const source = this.confirmWorkResult(stored)
      const sourceFailure = fact?.ok === false ? fact.reason : source.ok === false ? source.reason : undefined
      const finalResult = sourceFailure ? undefined : outcome
      const finalFailure = sourceFailure ?? failure
      const state = finalResult ? 'completed' : stored.state === 'running' ? 'failed' : 'released'
      requireWrite(this.db.prepare(`UPDATE studio_project_dispatch SET state = ?, result_json = ?, failure = ?
        WHERE ${EXACT_DISPATCH} AND state = ?`).run(state, finalResult ? JSON.stringify(finalResult) : null,
        finalResult ? null : finalFailure, ...this.dispatchKeys(identity), stored.state).changes)
      if (!finalResult) return accept({ ...stored, state, failure: finalFailure })
      // Do not return the derived body to a former Leader; the current Leader can read it by work ID.
      if (source.ok && source.value && !this.dispatchAuthority(identity).ok) return accept({ ...stored, state })
      return accept({ ...stored, state, result: finalResult })
    })
  }

  /** Read exact project work. Only current native owner detail includes decision bodies or a result-use body. */
  readWork(sessionId: string, workId: string, ownerDetail = false): ManagedResult<StudioProjectWorkView> {
    if (!isId(sessionId) || !isId(workId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const binding = this.binding(sessionId)
      if (!binding) return deny('SESSION_NOT_BOUND')
      const work = this.work(binding.projectId, workId)
      if (!work) return deny('WORK_NOT_FOUND')
      const current = this.currentProject(sessionId, true)
      return accept(this.workView(work, true, current.ok, ownerDetail === true && current.ok ? current.value : undefined))
    })
  }

  /** Read up to 20 work summaries without document bodies or derived result bodies. */
  listWork(leaderSessionId: string): ManagedResult<StudioProjectWorkView[]> {
    if (!isId(leaderSessionId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const binding = this.binding(leaderSessionId)
      if (!binding) return deny('SESSION_NOT_BOUND')
      const rows = this.db.prepare(`${WORK_SELECT} WHERE b.project_id = ? ORDER BY w.rowid DESC LIMIT 20`).all(binding.projectId)
      return accept(rows.map(row => this.workView(readWorkRow(row), false, false)))
    })
  }

  private work(projectId: string, workId: string): StudioProjectWork | undefined {
    const row = this.db.prepare(`${WORK_SELECT} WHERE b.project_id = ? AND w.work_id = ?`).get(projectId, workId)
    return row && readWorkRow(row)
  }

  private workView(work: StudioProjectWork, full: boolean, includeFactResult: boolean, owner?: StudioProjectBinding): StudioProjectWorkView {
    const pinned = readWorkFact(this.db, work.workId)
    const pinnedResult = readWorkResultUse(this.db, work.workId)
    const job = readProjectJob(this.db, work.projectId, work.workId)
    const document = readProjectDocument(this.db, this.access, work, full, owner !== undefined)
    const model = owner && latestWorkModel(this.db, work.workId)
    const workBlock = owner && latestWorkBlock(this.db, work.workId)
    // The public status has no reason, condition, or change. Historical Leaders retain evidence provenance only.
    const blocked = owner ? workBlock !== undefined && !workBlock.cleared : latestWorkBlockState(this.db, work.workId) === 'active'
    const fact = pinned && { ...pinned, current: pinned.projectId === work.projectId && this.factQuote(pinned) !== undefined }
    const resultUse = pinnedResult && workResultUseView(pinnedResult, this.currentWorkResult(pinnedResult, work.projectId) !== undefined)
    return { work, ...this.workRunView(work, fact, includeFactResult, resultUse, owner !== undefined),
      ...(job ? { job } : {}), ...(document ? { document } : {}), ...(model && owner ? { modelSelection: workModelView(model, owner) } : {}),
      ...(blocked ? { blocked: true } : {}), ...(workBlock ? { workBlock } : {}) }
  }

  private factQuote({ projectId, key, revision }: WorkFactSource): string | undefined {
    return this.access.exactFactQuote(projectId, key, revision)
  }

  /** Join a stored dispatch to its own work and confirm the pinned scope and original evidence, not caller metadata. */
  private confirmWorkFact(run: StudioProjectRun): ManagedResult<{ text: string } | undefined> {
    const fact = readWorkFact(this.db, run.workId)
    if (!fact) return accept(undefined)
    if (fact.projectId !== run.projectId || !this.work(run.projectId, run.workId)) return deny('FACT_PROJECT_MISMATCH')
    const text = this.factQuote(fact)
    return text === undefined ? deny('FACT_NOT_CURRENT') : accept({ text })
  }

  /** Verify the exact result identity and complete source text before slicing at the pinned UTF-16 coordinates. */
  private currentWorkResult(source: WorkResultSource, projectId: string): string | undefined {
    if (source.projectId !== projectId) return
    const evidence = this.readWorkEvidence(projectId, source.sourceWorkId, source)
    if (!evidence) return
    const { text, messageId, turn, eventSeq } = evidence.result
    if (messageId !== source.messageId || turn !== source.turn || eventSeq !== source.eventSeq
      || source.offset + source.length > text.length || workResultFingerprint(text) !== source.fingerprint) return
    const quote = text.slice(source.offset, source.offset + source.length)
    // Reject malformed slice metadata instead of resolving an invalid or ambiguous excerpt.
    if (quote.isWellFormed() && text.indexOf(quote) === source.offset && text.indexOf(quote, source.offset + 1) === -1) return quote
  }

  /** Check the stored attempt and work membership, not evidence supplied by the caller. */
  private confirmWorkResult(run: StudioProjectRun): ManagedResult<{ text: string } | undefined> {
    const source = readWorkResultUse(this.db, run.workId)
    if (!source) return accept(undefined)
    if (!this.work(run.projectId, run.workId)) return deny('RESULT_SOURCE_NOT_CURRENT')
    const text = this.currentWorkResult(source, run.projectId)
    return text === undefined ? deny('RESULT_SOURCE_NOT_CURRENT') : accept({ text })
  }

  /** Pause takes precedence over observation; unpinned work follows the existing dispatch path. */
  private jobDispatchBlock(job: StudioProjectJob | undefined): Extract<ManagedResult<never>, { ok: false }> | undefined {
    if (job?.paused) return deny('EXTERNAL_JOB_PAUSED')
    if (job && job.state !== 'completed') return deny('EXTERNAL_JOB_NOT_COMPLETE')
  }

  /** Project only completion coordinates when reading summaries or when the derived body is not available. */
  private workRunView(work: StudioProjectWork, fact: ProjectWorkFactUse | undefined, includeFactResult: boolean,
    resultUse: ProjectWorkResultUse | undefined, includeWorkResult: boolean): Pick<StudioProjectWorkView, 'run' | 'fact' | 'resultUse'> {
    const sources = { ...(fact ? { fact } : {}), ...(resultUse ? { resultUse } : {}) }
    const omitResult = (fact !== undefined && (!fact.current || !includeFactResult))
      || (resultUse !== undefined && (!resultUse.current || !includeWorkResult))
    const columns = omitResult ? `work_id, execution_epoch, project_id, leader_session_id, management_epoch, worker_session_id,
      worker_bot_id, run_id, state, failure, NULL AS result_json,
      CASE WHEN state = 'completed' AND json_type(result_json, '$.messageId') = 'text'
        AND instr(json_extract(result_json, '$.messageId'), char(0)) = 0
        THEN json_extract(result_json, '$.messageId') END AS message_id,
      CASE WHEN state = 'completed' AND json_type(result_json, '$.turn') = 'integer'
        THEN json_extract(result_json, '$.turn') END AS result_turn,
      CASE WHEN state = 'completed' AND json_type(result_json, '$.eventSeq') = 'integer'
        THEN json_extract(result_json, '$.eventSeq') END AS event_seq` : '*'
    const row = this.db.prepare(`SELECT ${columns} FROM studio_project_dispatch WHERE work_id = ?
      ORDER BY execution_epoch DESC LIMIT 1`).get(work.workId)
    if (!row) return sources
    const run = readRunRow(row, omitResult)
    if (run.projectId !== work.projectId) throw new Error('Studio project dispatch belongs to another project')
    if ((fact || resultUse) && run.state === 'completed') {
      const { messageId, turn, eventSeq } = run.result ?? { messageId: row.message_id, turn: row.result_turn, eventSeq: row.event_seq }
      if (!isId(messageId) || !isEpoch(turn) || (eventSeq !== 0 && !isEpoch(eventSeq))) throw new Error('Invalid Studio project result source')
      const resultSource = { messageId, turn, eventSeq }
      return { run, ...(fact ? { fact: { ...fact, resultSource } } : {}), ...(resultUse ? { resultUse: { ...resultUse, resultSource } } : {}) }
    }
    return { run, ...sources }
  }

  private dispatchKeys(run: DispatchIdentity): [string, number, string, string, number, string, string, string] {
    return [run.workId, run.executionEpoch, run.projectId, run.leaderSessionId, run.managementEpoch,
      run.workerSessionId, run.workerBotId, this.access.runId]
  }

  /** State transitions check the exact attempt without reading a previously stored result body. */
  private exactRun(identity: DispatchIdentity): StudioProjectRun | undefined {
    const row = this.db.prepare(`SELECT work_id, execution_epoch, project_id, leader_session_id, management_epoch,
      worker_session_id, worker_bot_id, run_id, state, failure, NULL AS result_json
      FROM studio_project_dispatch WHERE ${EXACT_DISPATCH}`).get(...this.dispatchKeys(identity))
    return row && readRunRow(row, true)
  }

  private dispatchAuthority(identity: DispatchIdentity): ManagedResult<StudioProjectBinding> {
    const current = this.currentProject(identity.leaderSessionId, true)
    if (!current.ok) return current
    if (current.value.projectId !== identity.projectId || current.value.managementEpoch !== identity.managementEpoch) return deny('STALE_MANAGEMENT')
    return current
  }

  /** A selected attempt must match the exact spend row before entry; ordinary attempts have no active selection. */
  private confirmWorkModelRun(run: StudioProjectRun, selectionId?: string): ManagedResult<void> {
    const spent = exactConsumedWorkModel(this.db, run, this.access.runId)
    if ((selectionId !== undefined && spent !== selectionId) || (!spent && hasUnclearedWorkModel(this.db, run.workId))) {
      return deny('WORK_MODEL_SELECTION_NOT_CURRENT')
    }
    return spent && this.workHasDocumentOrJob(run.workId) ? deny('WORK_MODEL_TEXT_ONLY') : accept(undefined)
  }

  /** Recheck the exact stored reservation and its sources, regardless of the caller's copy of its state. */
  private startableReservation(identity: DispatchIdentity): ManagedResult<{ run: StudioProjectRun; fact?: { text: string }; resultUse?: { text: string } }> {
    const current = this.dispatchAuthority(identity)
    if (!current.ok) return current
    const stored = this.exactRun(identity)
    if (!stored) return deny('STALE_EXECUTION')
    if (!this.work(stored.projectId, stored.workId)) return deny('WORK_NOT_FOUND')
    // A clear never revives the exact attempt the hold released, even if a later reservation exists.
    if ((stored.state === 'released' && stored.failure === 'PROJECT_WORK_BLOCKED')
      || latestWorkBlockState(this.db, stored.workId) === 'active') return deny('PROJECT_WORK_BLOCKED')
    if (stored.state !== 'reserved') return deny('WORK_NOT_RESERVED')
    const model = this.confirmWorkModelRun(stored)
    if (!model.ok) return model
    const fact = this.confirmWorkFact(stored)
    if (!fact.ok) return fact
    const resultUse = this.confirmWorkResult(stored)
    if (!resultUse.ok) return resultUse
    if (projectDocumentAttached(this.db, stored.workId)) return deny(fact.value ? 'FACT_TEXT_WORK_ONLY' : 'WORK_HAS_DOCUMENT_TASK')
    const job = readProjectJob(this.db, stored.projectId, stored.workId)
    if (fact.value && job) return deny('FACT_TEXT_WORK_ONLY')
    if (resultUse.value && job) return deny('RESULT_TEXT_WORK_ONLY')
    const blocked = this.jobDispatchBlock(job)
    if (blocked) return blocked
    // A spent grant identifies the original automatic attempt even when a newer authorization hides it from the job view.
    const grant = consumedJobAuto(this.db, stored.workId, stored.executionEpoch)
    if (grant && (job?.automatic?.permitId !== grant.permitId || grant.authorizationVersion !== job.authorizationVersion
      || grant.leaderSessionId !== stored.leaderSessionId || grant.managementEpoch !== stored.managementEpoch)) {
      return deny('STALE_JOB_AUTHORIZATION')
    }
    return accept({ run: stored, ...(fact.value ? { fact: fact.value } : {}), ...(resultUse.value ? { resultUse: resultUse.value } : {}) })
  }

  private currentProject(sessionId: string): ManagedResult<StudioProject>
  private currentProject(sessionId: string, metadataOnly: true): ManagedResult<StudioProjectBinding>
  private currentProject(sessionId: string, metadataOnly = false): ManagedResult<StudioProjectBinding> {
    const binding = this.binding(sessionId)
    if (!binding) return deny('SESSION_NOT_BOUND')
    // Handoff review needs the same authority check without loading the project name or objective.
    const project = metadataOnly ? this.currentBinding(binding.projectId) : this.boundProject(binding)
    if (project.leaderSessionId !== sessionId || project.managementEpoch !== binding.managementEpoch) return deny('STALE_MANAGEMENT')
    if (this.access.nonProjectSessionBound(sessionId)) return deny('SESSION_ALREADY_BOUND')
    return accept(project)
  }

  private currentBinding(projectId: string): StudioProjectBinding {
    const row = this.db.prepare(`SELECT p.project_id, p.management_epoch, b.leader_bot_id, b.leader_session_id
      FROM studio_project p LEFT JOIN studio_project_binding b USING (project_id, management_epoch)
      WHERE p.project_id = ?`).get(projectId)
    if (!row) throw new Error('Missing project for Studio Leader binding')
    return readBinding(row)
  }

  private boundProject(binding: StudioProjectBinding): StudioProject {
    const project = this.project(binding.projectId)
    if (!project) throw new Error('Missing project for Studio Leader binding')
    return project
  }

  /** Count work with no active or terminal text attempt and no completed document, across all management epochs. */
  private project(projectId: string): StudioProject | undefined {
    const row = this.db.prepare(`SELECT p.project_id, p.name, p.objective, p.origin_task_id, p.management_epoch,
      b.leader_bot_id, b.leader_session_id,
      (SELECT count(*) FROM studio_project_binding h JOIN studio_project_work w USING (leader_session_id)
        WHERE h.project_id = p.project_id AND NOT EXISTS (
          SELECT 1 FROM studio_project_dispatch d WHERE d.work_id = w.work_id AND d.state <> 'released'
        ) AND NOT EXISTS (
          SELECT 1 FROM studio_project_document link JOIN managed_document d USING (task_id)
          WHERE link.work_id = w.work_id AND link.project_id = p.project_id AND d.document_version = 2
        )) AS pending_count
      FROM studio_project p LEFT JOIN studio_project_binding b USING (project_id, management_epoch)
      WHERE p.project_id = ?`).get(projectId)
    if (!row) return
    const binding = readBinding(row)
    const { name, objective, origin_task_id: originTaskId, pending_count: pendingCount } = row
    if (!isText(name, PROJECT_NAME_LIMIT) || !isText(objective, PROJECT_TEXT_LIMIT) || (originTaskId !== null && !isId(originTaskId))
      || typeof pendingCount !== 'number' || !Number.isSafeInteger(pendingCount) || pendingCount < 0) {
      throw new Error('Invalid Studio project state')
    }
    return { ...binding, name, objective, ...(originTaskId === null ? {} : { originTaskId }), pendingCount }
  }

  private sessionBound(sessionId: string): boolean {
    return !!this.binding(sessionId) || this.access.nonProjectSessionBound(sessionId)
  }

  private commandUsed(commandId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM studio_project_binding WHERE command_id = ?').get(commandId)
      || projectJobCommandUsed(this.db, commandId)
      || projectJobAutoCommandUsed(this.db, commandId)
      || projectDocumentCommandUsed(this.db, commandId)
      || projectResultCommandUsed(this.db, commandId)
      || projectWorkModelCommandUsed(this.db, commandId)
      || projectWorkBlockCommandUsed(this.db, commandId)
  }

  /** Scope exact IDs and latest lookups to the originating Session, not the shared Assistant Bot. */
  private proposalRow(assistantSessionId: string, proposalId?: string): Record<string, SQLOutputValue> | undefined {
    return proposalId === undefined
      ? this.db.prepare(`SELECT * FROM studio_project_proposal WHERE assistant_session_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(assistantSessionId)
      : this.db.prepare(`SELECT * FROM studio_project_proposal WHERE assistant_session_id = ? AND proposal_id = ?`)
        .get(assistantSessionId, proposalId)
  }

  /** Native creation can link any completed draft; a proposal can only link its Assistant Session's draft. */
  private completedOrigin(taskId: string, assistantSessionId?: string): boolean {
    const draft = this.db.prepare('SELECT state, assistant_session_id FROM studio_draft_task WHERE task_id = ?').get(taskId)
    return draft?.state === 'completed' && (assistantSessionId === undefined || draft.assistant_session_id === assistantSessionId)
  }

  private leaderBotExists(botId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM studio_leader_bot WHERE bot_id = ?').get(botId)
  }

  /** An explicit ID must already belong to a Leader Bot; only the allocation path inserts a Bot. */
  private resolveBot(botId?: string): ManagedResult<string> {
    if (botId !== undefined) return this.leaderBotExists(botId) ? accept(botId) : deny('LEADER_BOT_NOT_FOUND')
    const created = randomUUID()
    requireWrite(this.db.prepare('INSERT INTO studio_leader_bot (bot_id) VALUES (?)').run(created).changes)
    return accept(created)
  }

  private insertBinding(binding: StudioProjectBinding, commandId: string): void {
    const { leaderSessionId, projectId, leaderBotId, managementEpoch } = binding
    requireWrite(this.db.prepare(`INSERT INTO studio_project_binding
      (leader_session_id, project_id, leader_bot_id, management_epoch, command_id, bound_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(leaderSessionId, projectId, leaderBotId, managementEpoch, commandId, new Date().toISOString()).changes)
  }
}
