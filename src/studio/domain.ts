/** Read Studio conversation provenance and decisions from the existing managed ledgers without granting new authority. */
import type { DatabaseSync } from 'node:sqlite'
import { ASSISTANT_CONVERSATION, STUDIO_TEXT_LIMIT, isStudioInternalSession, type StudioArtifact, type StudioPending, type StudioProjectSummary, type StudioSessionRecord } from './protocol.ts'

const ASSISTANT = ASSISTANT_CONVERSATION
const at = (value: unknown) => typeof value === 'string' ? Date.parse(value) || 0 : 0
const clipped = (value: string, limit: number) => value.slice(0, limit).toWellFormed()

export type StudioWorkLink = { id: string; type: 'draft' | 'study' | 'work' | 'document' }
export interface StudioProjectRoute extends StudioProjectSummary { leaderSessionId: string; managementEpoch: number }

export function studioProjects(db: DatabaseSync): StudioProjectSummary[] {
  return db.prepare('SELECT project_id AS id, name, objective FROM studio_project ORDER BY name COLLATE NOCASE, project_id').all()
    .map(({ id, name, objective }) => ({ id: String(id), name: String(name), objective: String(objective) }))
}

/** Only explicitly bound native identities need a list; Studio-minted ones match the reserved ID namespace. */
export function studioHiddenIds(db: DatabaseSync): string[] {
  return db.prepare(`SELECT id FROM agent_studio_session
    UNION SELECT leader_session_id FROM studio_project_binding
    UNION SELECT session_id FROM studio_assistant_binding
    UNION SELECT session_id FROM managed_session_binding
    UNION SELECT worker_session_id FROM studio_project_dispatch
    UNION SELECT worker_session_id FROM studio_draft_task
    UNION SELECT worker_session_id FROM studio_study_step
    UNION SELECT advisor_session_id FROM studio_advice
    UNION SELECT worker_session_id FROM studio_feishu_draft ORDER BY 1`).all().flatMap(({ id }) =>
    typeof id === 'string' && !isStudioInternalSession(id) ? [id] : [])
}

export function studioProject(db: DatabaseSync, id: string): StudioProjectRoute | undefined {
  const row = db.prepare(`SELECT p.name, p.objective, p.management_epoch, b.leader_session_id
    FROM studio_project p JOIN studio_project_binding b USING (project_id, management_epoch) WHERE p.project_id = ?`).get(id)
  if (row && typeof row.leader_session_id === 'string') return { id, name: String(row.name), objective: String(row.objective),
    leaderSessionId: row.leader_session_id, managementEpoch: Number(row.management_epoch) }
}

/** Cross-room lookups are never used for replies. A reply to a published result follows its original request. */
export function studioRelatedWork(db: DatabaseSync, room: string, requestId: string, messageId: string): StudioWorkLink | undefined {
  const row = room === ASSISTANT
    ? db.prepare(`SELECT task_id AS id, 'draft' AS type FROM studio_draft_task WHERE source_request_id = ?1 AND source_message_id = ?2
      UNION ALL SELECT task_id, 'study' FROM studio_study WHERE source_request_id = ?1 AND source_message_id = ?2
      UNION ALL SELECT task_id, 'document' FROM studio_document_continuation_claim
        WHERE request_id = ?1 AND message_id = ?2 AND task_id IS NOT NULL LIMIT 1`).get({ '1': requestId, '2': messageId })
    : db.prepare(`SELECT coalesce(d.task_id,w.work_id) AS id, CASE WHEN d.task_id IS NOT NULL THEN 'document' ELSE 'work' END AS type
      FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      LEFT JOIN studio_project_document d USING (work_id)
      WHERE b.project_id = ? AND w.source_request_id = ? AND w.source_message_id = ? LIMIT 1`).get(room, requestId, messageId)
  if (!row || typeof row.id !== 'string') return
  const type = row.type
  if (type === 'draft' || type === 'study' || type === 'work' || type === 'document') return { id: row.id, type }
}

/** Prefer the permanent role/dispatch binding over a display title or transient Agent preset. */
export function studioSession(db: DatabaseSync, id: string): StudioSessionRecord | undefined {
  const row = db.prepare(`SELECT project_id AS room, 'leader' AS role, bound_at AS created FROM studio_project_binding WHERE leader_session_id = ?1
    UNION ALL SELECT project_id, 'draft-worker', NULL FROM studio_project_dispatch WHERE worker_session_id = ?1
    UNION ALL SELECT conversation_id, 'draft-worker', NULL FROM agent_studio_revision WHERE worker_session_id = ?1
    UNION ALL SELECT project_id, 'advisor', NULL FROM studio_advice WHERE advisor_session_id = ?1
    UNION ALL SELECT d.project_id, 'document-worker', NULL FROM managed_session_binding b
      LEFT JOIN studio_project_document d USING (task_id) WHERE b.session_id = ?1
    UNION ALL SELECT NULL, 'assistant', NULL FROM studio_assistant_binding WHERE session_id = ?1
    UNION ALL SELECT NULL, 'draft-worker', NULL FROM studio_draft_task WHERE worker_session_id = ?1
    UNION ALL SELECT NULL, 'draft-worker', NULL FROM studio_study_step WHERE worker_session_id = ?1
    UNION ALL SELECT NULL, 'draft-worker', NULL FROM studio_feishu_draft WHERE worker_session_id = ?1 LIMIT 1`).get({ '1': id })
  if (row && typeof row.role === 'string') return { id, conversationId: typeof row.room === 'string' ? row.room : ASSISTANT,
    role: row.role as StudioSessionRecord['role'], createdAt: at(row.created) }
}

function resultArtifact(title: string, sessionId: unknown, text: unknown, eventSeq: unknown): StudioArtifact | undefined {
  if (typeof sessionId !== 'string' || typeof text !== 'string' || !text.trim() || typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq)) return
  return { title, text: clipped(text, STUDIO_TEXT_LIMIT), source: { sessionId, eventSeq } }
}

function decodeResult(title: string, sessionId: unknown, json: unknown) {
  if (typeof json !== 'string' || json.length > 6 * STUDIO_TEXT_LIMIT + 16_384) return
  const data = JSON.parse(json) as { text?: unknown; eventSeq?: unknown }
  return resultArtifact(title, sessionId, data.text, data.eventSeq)
}

/** Only results explicitly handed to the owner belong here. Never forward a tool transcript or a protected evidence copy. */
export function studioArtifacts(db: DatabaseSync, room: string, requestId: string, messageId: string): StudioArtifact[] {
  if (room === ASSISTANT) {
    const draft = db.prepare(`SELECT worker_session_id, result_text, result_event_seq FROM studio_draft_task d
      WHERE d.source_request_id = ? AND d.source_message_id = ? AND d.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM studio_draft_preference p WHERE p.task_id = d.task_id)`).get(requestId, messageId)
    if (draft) {
      const artifact = resultArtifact('Worker result', draft.worker_session_id, draft.result_text, draft.result_event_seq)
      return artifact ? [artifact] : []
    }
    const study = db.prepare(`SELECT p.worker_session_id, p.result_json FROM studio_study s JOIN studio_study_step p ON p.study_task_id = s.task_id
      WHERE s.source_request_id = ? AND s.source_message_id = ? AND s.state = 'completed' AND p.kind = 'synthesis' AND p.state = 'completed'`)
      .get(requestId, messageId)
    if (study) {
      const artifact = decodeResult('Study result', study.worker_session_id, study.result_json)
      return artifact ? [artifact] : []
    }
  } else {
    const work = db.prepare(`SELECT d.worker_session_id, d.result_json FROM studio_project_work w JOIN studio_project_binding b USING (leader_session_id)
      JOIN studio_project_dispatch d USING (work_id)
      WHERE b.project_id = ? AND w.source_request_id = ? AND w.source_message_id = ? AND d.state = 'completed'
      AND NOT EXISTS (SELECT 1 FROM studio_project_work_fact f WHERE f.work_id = w.work_id)
      AND NOT EXISTS (SELECT 1 FROM studio_project_work_result_use r WHERE r.work_id = w.work_id)`).get(room, requestId, messageId)
    if (work) {
      const artifact = decodeResult('Project Worker result', work.worker_session_id, work.result_json)
      return artifact ? [artifact] : []
    }
  }
  const advice = db.prepare(`SELECT advisor_session_id, result_json FROM studio_advice
    WHERE source_request_id = ? AND source_message_id = ? AND state = 'completed' AND project_id IS ? AND evidence_quote IS NULL AND work_id IS NULL`)
    .get(requestId, messageId, room === ASSISTANT ? null : room)
  const opinion = advice && decodeResult('Advisor result', advice.advisor_session_id, advice.result_json)
  return opinion ? [opinion] : []
}

/** Project blocks and document reviews remain owned by their original ledger. These are status views, not new grants. */
export function studioBlockingItems(db: DatabaseSync): StudioPending[] {
  const blocked = db.prepare(`SELECT b.block_id, b.work_id, b.project_id, b.reason, b.resume_when, b.recorded_at, p.name
    FROM studio_project_work_block b JOIN studio_project p USING (project_id)
    WHERE NOT EXISTS (SELECT 1 FROM studio_project_work_block_clear c WHERE c.block_id = b.block_id)
    ORDER BY b.seq DESC`).all()
  const docs = db.prepare(`SELECT i.instruction_id, i.task_id, i.received_at, d.project_id, p.name
    FROM studio_document_effective_pending i JOIN managed_document x USING (task_id)
    LEFT JOIN studio_project_document d USING (task_id) LEFT JOIN studio_project p USING (project_id)
    WHERE x.document_version = 1 ORDER BY i.seq DESC`).all()
  const jobs = db.prepare(`SELECT c.candidate_id, c.project_id, c.work_id, c.recorded_at, p.name
    FROM studio_project_job_candidate c JOIN studio_project p USING (project_id)
    WHERE c.seq = (SELECT MAX(other.seq) FROM studio_project_job_candidate other WHERE other.work_id = c.work_id)
      AND NOT EXISTS (SELECT 1 FROM studio_project_job j WHERE j.work_id = c.work_id) ORDER BY c.seq DESC`).all()
  const holds = db.prepare(`SELECT incident_id, pool_id, session_id, noticed_at FROM studio_quota_incident
    WHERE cleared_at IS NULL ORDER BY noticed_at DESC`).all()
  return [
    ...holds.map(row => {
      const subject = typeof row.session_id === 'string' ? studioSession(db, row.session_id) : undefined
      return { id: `quota-hold:${String(row.incident_id)}`, conversationId: subject?.conversationId ?? ASSISTANT,
        requester: 'Agent Studio', title: `Model quota pool stopped: ${String(row.pool_id)}`,
        detail: 'The pool remains stopped until the owner verifies recovery. Check the quota status and record independent recovery evidence; this notice does not restart model calls.',
        createdAt: at(row.noticed_at), acceptsText: false }
    }),
    ...blocked.map(row => ({ id: `work-block:${String(row.block_id)}`, conversationId: String(row.project_id),
      taskId: String(row.work_id), requester: `Leader · ${String(row.name)}`, title: 'Project work is blocked',
      detail: `${String(row.reason)}\n\nResume when: ${String(row.resume_when)}`, createdAt: at(row.recorded_at),
      acceptsText: true })),
    ...docs.map(row => ({ id: `document-review:${String(row.instruction_id)}`, conversationId: String(row.project_id ?? ASSISTANT),
      taskId: String(row.task_id), requester: row.name ? `Document Worker · ${String(row.name)}` : 'Document Worker',
      title: 'Review a pending document instruction', detail: 'A document write is held for review. Use the document review controls; replying here does not change authorization.',
      createdAt: at(row.received_at), acceptsText: false })),
    ...jobs.map(row => ({ id: `job-check:${String(row.candidate_id)}`, conversationId: String(row.project_id),
      taskId: String(row.work_id), requester: `Leader · ${String(row.name)}`, title: 'Verify the external job reference',
      detail: 'Studio has a saved clue but has not confirmed the external job. Review the exact reference before allowing dispatch.',
      createdAt: at(row.recorded_at), acceptsText: false })),
  ].map(item => ({ ...item, kind: 'blocked', mobile: 'unsupported', state: 'pending', options: [] }))
}

/** Link a diagnosed item to an actual native log, which must still be opened read-only by the record endpoint. */
export function studioPendingRecord(db: DatabaseSync, pendingId: string): string | undefined {
  const separator = pendingId.indexOf(':')
  if (separator < 0) return
  const kind = pendingId.slice(0, separator)
  const key = pendingId.slice(separator + 1)
  const row = kind === 'document-review' ? db.prepare(`SELECT b.session_id FROM studio_document_instruction i
    JOIN managed_task t USING (task_id) JOIN managed_session_binding b USING (task_id, execution_epoch) WHERE i.instruction_id = ?`).get(key)
    : kind === 'work-block' ? db.prepare(`SELECT leader_session_id AS session_id FROM studio_project_work_block WHERE block_id = ?`).get(key)
      : kind === 'job-check' ? db.prepare(`SELECT leader_session_id AS session_id FROM studio_project_job_candidate WHERE candidate_id = ?`).get(key)
        : kind === 'quota-hold' ? db.prepare(`SELECT session_id FROM studio_quota_incident WHERE incident_id = ?`).get(key) : undefined
  return typeof row?.session_id === 'string' ? row.session_id : undefined
}