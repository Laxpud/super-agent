/** 只读投影不授予 Bot、会话或任务执行权限。 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { z } from 'zod'
import { ASSISTANT_CONVERSATION, isStudioInternalSession, STUDIO_ACTIVE_TASK_STATUSES, STUDIO_PAGE_SIZE, STUDIO_TEXT_LIMIT, type StudioArtifact, type StudioCheckResult, type StudioPage,
  type StudioPending, type StudioProjectSummary, type StudioRecordRole, type StudioSessionRecord, type StudioTaskScope, type StudioTaskStatus, type StudioTaskSummary } from './protocol.ts'

const at = (value: unknown) => typeof value === 'string' ? Date.parse(value) || 0 : 0
const nullable = (value: unknown) => typeof value === 'string' ? value : null
type Row = Record<string, SQLOutputValue>

export interface StudioProjectRoute extends StudioProjectSummary {
  leaderSessionId?: string
  leaderBotId?: string
  /** 旧库保留 Leader Bot 和分配历史，原会话只供查阅。 */
  readonlyLegacy?: boolean
}

function projectRow(row: Row): StudioProjectSummary {
  return { id: String(row.project_id), name: String(row.name), objective: String(row.objective), workspacePath: nullable(row.workspace_path),
    state: row.state === 'archived' ? 'archived' : 'active', managementEpoch: Number(row.management_epoch) }
}

export function studioProjects(db: DatabaseSync, state: StudioProjectSummary['state'] = 'active'): StudioProjectSummary[] {
  return db.prepare("SELECT * FROM studio_project WHERE state = ? ORDER BY name COLLATE NOCASE, project_id").all(state).map(projectRow)
}

export function studioProject(db: DatabaseSync, id: string): StudioProjectRoute | undefined {
  const row = db.prepare(`SELECT p.*, b.session_id, b.leader_bot_id, s.readonly_legacy FROM studio_project p
    LEFT JOIN studio_project_leader b ON b.project_id = p.project_id AND b.management_epoch = CASE WHEN p.state = 'active' THEN p.management_epoch
      ELSE (SELECT max(x.management_epoch) FROM studio_project_leader x WHERE x.project_id = p.project_id AND x.management_epoch < p.management_epoch) END
    LEFT JOIN studio_session s ON s.session_id = b.session_id WHERE p.project_id = ?`).get(id)
  if (row) return { ...projectRow(row), ...(typeof row.leader_bot_id === 'string' ? { leaderBotId: row.leader_bot_id } : {}),
    ...(row.state === 'active' && typeof row.session_id === 'string' ? { leaderSessionId: row.session_id } : {}),
    ...(row.readonly_legacy === 1 ? { readonlyLegacy: true } : {}) }
}

/** Workspace 已用同一规则隐藏保留格式的 ID；轮询只补充不符合该格式的受管 Session。 */
export function studioHiddenIds(db: DatabaseSync): string[] {
  const hidden: string[] = []
  const sessions = db.prepare('SELECT session_id AS id FROM studio_session UNION SELECT id FROM agent_studio_session ORDER BY id')
  for (const row of sessions.iterate()) {
    const id = String(row.id)
    if (!isStudioInternalSession(id)) hidden.push(id)
  }
  return hidden
}

export function studioRecordRole(value: unknown): StudioRecordRole {
  switch (value) {
    case 'assistant': case 'leader': case 'worker': case 'document-worker': case 'draft-worker':
    case 'study-worker': case 'advisor': case 'subagent': return value
    default: return 'legacy'
  }
}

function sessionRow(row: Row): StudioSessionRecord {
  return { id: String(row.session_id), conversationId: nullable(row.project_id) ?? ASSISTANT_CONVERSATION,
    role: studioRecordRole(row.role), createdAt: at(row.created_at), ...(row.readonly_legacy === 1 ? { readonlyLegacy: true } : {}) }
}

export function studioSession(db: DatabaseSync, id: string): StudioSessionRecord | undefined {
  const row = db.prepare('SELECT * FROM studio_session WHERE session_id = ?').get(id)
  return row && sessionRow(row)
}

function page<T>(rows: Row[], decode: (row: Row) => T): StudioPage<T> {
  const items = rows.slice(0, STUDIO_PAGE_SIZE)
  return { items: items.map(decode), ...(rows.length > items.length ? { next: Number(items.at(-1)?.cursor) } : {}) }
}

export function studioRecords(db: DatabaseSync, query?: string, before?: number): StudioPage<StudioSessionRecord> {
  const term = query?.trim().toLowerCase() ?? ''
  return page(db.prepare(`SELECT rowid AS cursor, * FROM studio_session WHERE (?1 = '' OR instr(lower(session_id), ?1) > 0
    OR instr(lower(coalesce(project_id, 'assistant')), ?1) > 0 OR instr(lower(role), ?1) > 0)
    AND (?2 IS NULL OR rowid < ?2) ORDER BY rowid DESC LIMIT ${STUDIO_PAGE_SIZE + 1}`).all({ '1': term, '2': before ?? null }), sessionRow)
}

const TASK_SELECT = `SELECT t.rowid AS cursor, t.*, p.name AS project_name, e.session_id, e.result_event_seq FROM studio_task t
  LEFT JOIN studio_project p ON p.project_id = t.project_id
  LEFT JOIN studio_task_execution e ON e.task_id = t.task_id AND e.execution_epoch = (
    SELECT max(last.execution_epoch) FROM studio_task_execution last WHERE last.task_id = t.task_id)`

function json(value: unknown, fallback: unknown): unknown {
  if (typeof value === 'string') try { return JSON.parse(value) as unknown } catch { /* 扩展数据不影响基础任务读取。 */ }
  return fallback
}

const checkSchema = z.object({ version: z.literal(1),
  changedFiles: z.array(z.object({ path: z.string(), action: z.enum(['write', 'edit']) })),
  checks: z.array(z.object({ command: z.string(), workdir: z.string(), exitCode: z.int().nullable(), signal: z.string().nullable(),
    timedOut: z.boolean(), aborted: z.boolean(), status: z.enum(['passed', 'failed']), output: z.string() })),
  overallCheckStatus: z.enum(['passed', 'failed', 'not_run']),
  // 无省略时完全省去字段；宿主和 Web 都只接受正的安全整数。
  omittedChecks: z.int().positive().exactOptional(), omittedChangedFiles: z.int().positive().exactOptional(),
}) satisfies z.ZodType<StudioCheckResult>

/** 新版收据和旧文本共用 TEXT 列；未知格式不阻止读取已登记的任务。 */
function taskCheckResult(value: unknown): StudioTaskSummary['checkResult'] {
  if (typeof value !== 'string') return null
  const parsed = checkSchema.safeParse(json(value, null))
  return parsed.success ? parsed.data : value
}

const excerpt = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1).toWellFormed()}…` : text

/** 交付先给出宿主事实，再区分 Worker 原文。跨端摘要截取有限条目；任务 API 保留结构化明细。 */
export function studioDeliverySummary(task: Pick<StudioTaskSummary, 'workspacePath' | 'permission'>, evidence: StudioCheckResult,
  workerText?: string): string {
  const omittedFiles = (evidence.omittedChangedFiles ?? 0) + Math.max(0, evidence.changedFiles.length - 16)
  const omittedChecks = (evidence.omittedChecks ?? 0) + Math.max(0, evidence.checks.length - 8)
  const host = [
    `宿主执行收据｜工作区：${excerpt(JSON.stringify(task.workspacePath), 4_096)}｜权限：${task.permission}`,
    `检查总体状态：${evidence.overallCheckStatus}`,
    '已观测的文件工具改动（相对于工作区）：',
    ...(evidence.changedFiles.length ? evidence.changedFiles.slice(0, 16).map(file => `- ${file.action} ${excerpt(JSON.stringify(file.path), 512)}`) : ['- 无']),
    ...(omittedFiles ? [`- 另有 ${omittedFiles} 项未在摘要中列出。`] : []),
    '宿主命令收据：',
    ...(evidence.checks.length ? evidence.checks.slice(0, 8).map(check => {
      const flags = [check.signal && `信号 ${check.signal}`, check.timedOut && '超时', check.aborted && '已中止'].filter(Boolean)
      return `- ${check.status}｜退出码 ${check.exitCode ?? '未知'}${flags.length ? `｜${flags.join('、')}` : ''}｜${check.command}`
        + `\n  workdir: ${excerpt(JSON.stringify(check.workdir), 512)}${check.output ? `\n  输出：${excerpt(check.output, 600)}` : ''}`
    }) : ['- 未运行']),
    ...(omittedChecks ? [`- 另有 ${omittedChecks} 项检查未在摘要中列出；总体状态计算包含所有已观测检查。`] : []),
  ].join('\n')
  const label = '\n\nWorker 正文（不作为宿主证据）：\n'
  return workerText ? host + label + excerpt(workerText, Math.min(10_000, STUDIO_TEXT_LIMIT - host.length - label.length)) : host
}

/** 从统一账本显示状态与已保存的交付，兼容没有收据的历史任务。 */
export function studioTaskText(task: StudioTaskSummary): string {
  const detail = task.resultSummary ?? (typeof task.checkResult === 'object' && task.checkResult
    ? studioDeliverySummary(task, task.checkResult) : task.checkResult)
  return `${task.taskId}: ${task.status}${detail ? `\n\n${detail}` : ''}`
}

function taskRow(row: Row): StudioTaskSummary {
  const summary = nullable(row.result_summary)
  const source = typeof row.session_id === 'string' && typeof row.result_event_seq === 'number'
    ? { sessionId: row.session_id, eventSeq: row.result_event_seq } : undefined
  const saved = json(row.artifacts, [])
  const artifacts = Array.isArray(saved) ? saved.filter((item: unknown): item is StudioArtifact => {
    const artifact = item as Partial<StudioArtifact> | null
    return typeof artifact?.title === 'string' && typeof artifact.text === 'string' && typeof artifact.source?.sessionId === 'string'
      && Number.isSafeInteger(artifact.source.eventSeq)
  }) : []
  return { taskId: String(row.task_id), projectId: nullable(row.project_id), projectName: nullable(row.project_name),
    conversationId: nullable(row.project_id) ?? ASSISTANT_CONVERSATION, sourceSessionId: nullable(row.source_session_id),
    workerSessionId: nullable(row.session_id), sourceMessageId: nullable(row.source_message_id),
    requesterBotId: nullable(row.requester_bot_id), assigneeBotId: nullable(row.assignee_bot_id), workspacePath: nullable(row.workspace_path),
    permission: row.permission as StudioTaskSummary['permission'], authorizationVersion: Number(row.authorization_version),
    status: row.status as StudioTaskSummary['status'], title: String(row.title), requestText: String(row.request_text),
    resultSummary: summary, checkResult: taskCheckResult(row.check_result), artifacts, externalJob: json(row.external_job, null),
    createdAt: at(row.created_at), updatedAt: at(row.updated_at), ...(source ? { source } : {}) }
}

export function studioTask(db: DatabaseSync, id: string): StudioTaskSummary | undefined {
  const row = db.prepare(`${TASK_SELECT} WHERE t.task_id = ?`).get(id)
  return row && taskRow(row)
}

const activeStatuses = `(${STUDIO_ACTIVE_TASK_STATUSES.map(status => `'${status}'`).join(', ')})`
export function studioTasks(db: DatabaseSync, room?: string, before?: number, scope: StudioTaskScope = 'all', status?: StudioTaskStatus): StudioPage<StudioTaskSummary> {
  const scoped = scope === 'all' ? '' : `AND t.status ${scope === 'terminal' ? 'NOT ' : ''}IN ${activeStatuses}`
  return page(db.prepare(`${TASK_SELECT} WHERE (? = 0 OR t.project_id IS ?) AND (? IS NULL OR t.rowid < ?)
    AND (? IS NULL OR t.status = ?) ${scoped} ORDER BY t.rowid DESC LIMIT ${STUDIO_PAGE_SIZE + 1}`)
    .all(Number(room !== undefined), room === ASSISTANT_CONVERSATION ? null : room ?? null, before ?? null, before ?? null, status ?? null, status ?? null), taskRow)
}

export const studioTaskStatusLabel: Record<StudioTaskStatus, string> = {
  queued: '排队中', running: '执行中', waiting_approval: '等待确认', blocked: '受阻', interrupted: '已中断', cancelled: '已取消', delivered: '已交付',
}

/** 直接读取全部在途任务的摘要所需字段，不受历史任务列表分页的影响。 */
export function studioActiveTasks(db: DatabaseSync): Array<Pick<StudioTaskSummary, 'taskId' | 'title' | 'status'>> {
  return db.prepare(`SELECT task_id, title, status FROM studio_task
    WHERE status IN ${activeStatuses} ORDER BY rowid DESC`).all()
    .map(row => ({ taskId: String(row.task_id), title: String(row.title), status: row.status as StudioTaskSummary['status'] }))
}

/** 这里只读取已经交付的当前任务输出，不读取旧工作表，也不把内部日志当成结果转发。 */
export function studioArtifacts(db: DatabaseSync, room: string, messageId: string): StudioArtifact[] {
  return db.prepare(`${TASK_SELECT} WHERE t.project_id IS ? AND t.source_message_id = ? AND t.status = 'delivered'`)
    .all(room === ASSISTANT_CONVERSATION ? null : room, messageId).map(taskRow).flatMap(task => [
      ...(task.resultSummary && task.source ? [{ title: 'Worker result', text: task.resultSummary.slice(0, STUDIO_TEXT_LIMIT).toWellFormed(), source: task.source }] : []),
      ...task.artifacts,
    ])
}

const BLOCK_PREFIX = 'task-block:'
export function studioBlockingItems(db: DatabaseSync): StudioPending[] {
  return db.prepare("SELECT * FROM studio_task WHERE status = 'blocked' ORDER BY rowid DESC").all().map(row => ({
    id: `${BLOCK_PREFIX}${String(row.task_id)}:${String(row.authorization_version)}`, kind: 'blocked', taskId: String(row.task_id),
    conversationId: nullable(row.project_id) ?? ASSISTANT_CONVERSATION, requester: 'Agent Studio', title: String(row.title || 'Studio task is blocked'),
    detail: nullable(row.check_result) ?? 'Confirm the blocking condition has been resolved. Clearing does not rerun the task.',
    options: [], acceptsText: true, mobile: 'unsupported', state: 'pending', createdAt: at(row.updated_at),
  }))
}

export function studioBlockTarget(id: string): { taskId: string; version: number } | undefined {
  const match = /^task-block:([^:]+):([1-9]\d*)$/u.exec(id)
  if (match?.[1] && Number.isSafeInteger(Number(match[2]))) return { taskId: match[1], version: Number(match[2]) }
}

export function studioPendingRecord(db: DatabaseSync, pendingId: string): string | undefined {
  const target = studioBlockTarget(pendingId)
  if (!target) return
  const row = db.prepare(`SELECT e.session_id FROM studio_task t JOIN studio_task_execution e USING (task_id)
    WHERE t.task_id = ? AND t.authorization_version = ? AND t.status = 'blocked' ORDER BY e.execution_epoch DESC LIMIT 1`)
    .get(target.taskId, target.version)
  return typeof row?.session_id === 'string' ? row.session_id : undefined
}
