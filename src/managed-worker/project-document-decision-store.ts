/** Owner-only metadata projection of applied document narrowing receipts. */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import type { ManagedTask } from './store.ts'

export interface ProjectDocumentDecision {
  instructionId: string
  source: { channel: 'gui'; messageId: string; sessionId: string; eventSeq: number } | { channel: 'feishu'; messageId: string }
  executionEpoch: number
  previousAuthorizationVersion: number
  authorizationVersion: number
  reviewedAt: string
  reviewSessionId: string
  keptLines: number[]
  keptCount: number
}

export interface ProjectDocumentDecisionHistory {
  entries: ProjectDocumentDecision[]
  more: boolean
  unconfirmed?: boolean
}

const DECISION_LIMIT = 4
const LINE_PREVIEW_LIMIT = 12
const LINE_LIMIT = 32_000
const KEPT_LINES_BYTES = LINE_LIMIT * (String(LINE_LIMIT).length + 1) + 1
const ID_LIMIT = 256
const ISO_TIME_LIMIT = 27
const isId = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= ID_LIMIT && value.isWellFormed() && !/[\s\p{Cc}\p{Cf}]/u.test(value)
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= ISO_TIME_LIMIT
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value

type Row = Record<string, SQLOutputValue>

/** Select bounded metadata without truncating a value or letting an embedded NUL hide trailing bytes. */
function boundedText(column: string, maxBytes: number): string {
  return `CASE WHEN length(CAST(${column} AS BLOB)) <= ${maxBytes} AND instr(${column}, char(0)) = 0 THEN ${column} END`
}

/** Check the receipt's sorted 1-based line coordinates and count all of them, but return only a short preview. */
function keptLineSummary(value: unknown): Pick<ProjectDocumentDecision, 'keptLines' | 'keptCount'> | undefined {
  // Receipts serialize integer arrays without whitespace. Reject nested or free-form JSON before parsing.
  if (typeof value !== 'string' || value.length > KEPT_LINES_BYTES || !/^\[[0-9,]+\]$/u.test(value)) return
  let lines: unknown
  try { lines = JSON.parse(value) }
  catch { return }
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > LINE_LIMIT) return
  let previous = 0
  const keptLines: number[] = []
  for (const line of lines) {
    if (!isVersion(line) || line <= previous || line > LINE_LIMIT) return
    if (keptLines.length < LINE_PREVIEW_LIMIT) keptLines.push(line)
    previous = line
  }
  return { keptLines, keptCount: lines.length }
}

/** Verify the original source and exact historical review Worker before constructing an allowlisted result. */
function readDecision(row: Row): ProjectDocumentDecision | undefined {
  const { instruction_id: instructionId, message_id: messageId, execution_epoch: executionEpoch, reviewed_at: reviewedAt,
    review_session_id: reviewSessionId, pre_authorization_version: previousAuthorizationVersion,
    post_authorization_version: authorizationVersion, event_seq: eventSeq, channel } = row
  if (row.document_version !== 1 || row.state !== 'pending' || row.review_worker_matches !== 1
    || !isId(instructionId) || !isId(messageId) || !isId(reviewSessionId) || !isTimestamp(reviewedAt)
    || !isVersion(executionEpoch) || !isVersion(previousAuthorizationVersion) || !isVersion(authorizationVersion)
    || authorizationVersion !== previousAuthorizationVersion + 1) return
  let source: ProjectDocumentDecision['source']
  if (channel === 'gui' && row.gui_scope_matches === 1 && (eventSeq === 0 || isVersion(eventSeq))) {
    source = { channel, messageId, sessionId: reviewSessionId, eventSeq }
  } else if (channel === 'feishu' && row.feishu_scope_matches === 1 && row.feishu_request_matches === 1
    && row.late === 0 && eventSeq === null) {
    source = { channel, messageId }
  } else return
  const lines = keptLineSummary(row.kept_lines)
  if (!lines) return
  return { instructionId, source, executionEpoch, previousAuthorizationVersion, authorizationVersion, reviewedAt,
    reviewSessionId, ...lines }
}

/** Read at most four recent decisions plus one lookahead under the caller's authorized work snapshot. */
export function readProjectDocumentDecisions(db: DatabaseSync, task: ManagedTask, anchoredEpoch: number,
  anchoredAuthorization: number): ProjectDocumentDecisionHistory {
  // Bound the receipt window before joining evidence. A missing join must be distinguishable from no receipt.
  // The receipt's version is historical; a subsequent transfer or commit does not erase an applied narrowing.
  const rows = db.prepare(`WITH recent AS MATERIALIZED (
    SELECT n.task_id, n.execution_epoch, n.document_version, n.pre_authorization_version, n.post_authorization_version,
      ${boundedText('n.instruction_id', ID_LIMIT * 3)} AS instruction_id,
      ${boundedText('n.review_session_id', ID_LIMIT * 3)} AS review_session_id,
      ${boundedText('n.reviewed_at', ISO_TIME_LIMIT)} AS reviewed_at,
      ${boundedText('n.kept_lines', KEPT_LINES_BYTES)} AS kept_lines
    FROM studio_document_narrowing n WHERE n.task_id = ? AND n.pre_authorization_version >= ?
      AND n.execution_epoch BETWEEN ? AND ? AND n.post_authorization_version <= ?
    ORDER BY n.post_authorization_version DESC LIMIT ${DECISION_LIMIT + 1}
  ) SELECT n.instruction_id, ${boundedText('i.message_id', ID_LIMIT * 3)} AS message_id,
    n.review_session_id, n.reviewed_at, n.kept_lines, n.execution_epoch, n.document_version,
    n.pre_authorization_version, n.post_authorization_version,
    i.channel, i.state, i.event_seq, f.late, b.session_id IS NOT NULL AS review_worker_matches,
    i.source_scope = b.session_id AS gui_scope_matches, i.request_id = i.message_id AS feishu_request_matches,
    s.task_id IS NOT NULL AS feishu_scope_matches
  FROM recent n LEFT JOIN studio_document_instruction i ON i.instruction_id = n.instruction_id
    AND i.task_id = n.task_id AND i.observed_execution_epoch = n.execution_epoch
  LEFT JOIN managed_session_binding b ON b.task_id = n.task_id AND b.execution_epoch = n.execution_epoch
    AND b.session_id = n.review_session_id
  LEFT JOIN studio_document_feishu_instruction f ON i.channel = 'feishu' AND f.instruction_id = i.instruction_id
  LEFT JOIN studio_document_feishu_binding s ON i.channel = 'feishu' AND s.task_id = i.task_id AND s.source_scope = i.source_scope
  ORDER BY n.post_authorization_version DESC`).all(task.taskId, anchoredAuthorization, anchoredEpoch, task.executionEpoch,
    task.authorizationVersion)

  // Do not scan farther to replace invalid receipts. Report uncertainty without treating a bad candidate as applied.
  const history: ProjectDocumentDecisionHistory = { entries: [], more: rows.length > DECISION_LIMIT }
  for (const row of rows) {
    const entry = readDecision(row)
    if (!entry) history.unconfirmed = true
    else if (history.entries.length < DECISION_LIMIT) history.entries.push(entry)
  }
  return history
}
