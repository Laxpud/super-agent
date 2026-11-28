import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { ManagedWorkerStore } from '../src/managed-worker/store.ts'
import type { StudioProjectRoute } from '../src/studio/domain.ts'
import { ASSISTANT_CONVERSATION } from '../src/studio/protocol.ts'
import { StudioService } from '../src/studio/service.ts'

const assistant = ASSISTANT_CONVERSATION
const route = { provider: 'fixture', model: 'worker' }
const time = '2026-11-28T03:00:00.000Z'
const cutover = Date.parse(time)

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'studio-v1-store-'))
  const path = join(dir, 'managed-worker.sqlite')
  const close: Array<() => void> = []
  onTestFinished(() => {
    for (const release of close.reverse()) release()
    if (realpathSync(dir) !== dir) throw new Error('Refusing to clean up a different fixture path')
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, path,
    open() {
      const store = new ManagedWorkerStore(path)
      close.push(() => store.close())
      return store
    },
    sql() {
      const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
      close.push(() => { if (db.isOpen) db.close() })
      return db
    },
  }
}

function ownerTask(store: ManagedWorkerStore, key: string, project?: StudioProjectRoute) {
  return { projectId: project?.id ?? null, sourceMessageId: `message-${key}`, requestId: `request-${key}`,
    requesterBotId: project?.leaderBotId ?? store.assistantBotId, permission: 'read-only' as const,
    workspacePath: project?.workspacePath ?? null, requestText: `Work for ${key}`,
    ...(project && { leader: { sessionId: project.leaderSessionId!, managementEpoch: project.managementEpoch } }) }
}

function createProject(store: ManagedWorkerStore, leaderSessionId = 'leader-1', workspacePath?: string) {
  return store.projects.create({ name: 'Source review', objective: 'Verify the source', leaderSessionId, workspacePath })
}

/** 在真实旧表中同时登记可交付结果、三种受保护的派工、活动执行和各类会话索引。 */
function seedV0(db: DatabaseSync) {
  db.exec(readFileSync(new URL('./fixtures/studio-v0.sql', import.meta.url), 'utf8'))
  db.exec(`BEGIN;
    INSERT INTO managed_task VALUES ('document', 1, 1, 0, 'Legacy document');
    INSERT INTO managed_session_binding VALUES ('old-document', 'document', 1);
    INSERT INTO studio_assistant_bot VALUES (1, 'assistant-bot');
    INSERT INTO studio_assistant_binding VALUES ('old-assistant', 'assistant-bot');
    INSERT INTO studio_leader_bot VALUES ('leader-bot');
    INSERT INTO studio_project VALUES ('old-project', 'Prior project', 'Prior objective', NULL, 2);
    INSERT INTO studio_project_binding VALUES
      ('old-leader-1', 'old-project', 'leader-bot', 1, 'bind-1', '${time}'),
      ('old-leader-2', 'old-project', 'leader-bot', 2, 'bind-2', '${time}');
    COMMIT;`)
  const draft = db.prepare(`INSERT INTO studio_draft_task (task_id, assistant_bot_id, assistant_session_id, source_message_id,
    source_request_id, request_text, worker_bot_id, worker_session_id, execution_epoch, run_id, state,
    result_text, result_message_id, result_event_seq, result_turn)
    VALUES (?, 'assistant-bot', 'old-assistant', ?, ?, ?, ?, ?, 1, 'old-run', ?, ?, ?, ?, ?)`)
  for (const [id, text] of [['plain-draft', 'Ordinary draft output'], ['private-draft', 'Private preference-derived output'], ['live-draft', null]] as const) {
    draft.run(id, `source-${id}`, `request-${id}`, `Input to ${id}`, `bot-${id}`, `session-${id}`,
      text ? 'completed' : 'running', text, text ? `answer-${id}` : null, text ? 0 : null, text ? 1 : null)
  }
  const work = db.prepare("INSERT INTO studio_project_work VALUES (?, 'old-leader-2', ?, ?, ?)")
  const dispatch = db.prepare(`INSERT INTO studio_project_dispatch VALUES
    (?, ?, 'old-project', 'old-leader-2', 2, ?, ?, 'old-run', ?, ?, ?)`)
  for (const [id, text] of [['plain-work', 'Ordinary project result'], ['private-fact', 'Private fact-derived output'],
    ['private-use', 'Private result-derived output'], ['live-work', null]] as const) {
    work.run(id, `source-${id}`, `request-${id}`, `Input to ${id}`)
    if (id === 'plain-work') dispatch.run(id, 1, 'session-released', 'bot-released', 'released', null, 'setup did not finish')
    dispatch.run(id, 2, `session-${id}`, `bot-${id}`, text ? 'completed' : 'running',
      text ? JSON.stringify({ text, eventSeq: 17, messageId: `result-${id}`, turn: 1 }) : null, null)
  }
  db.exec(`INSERT INTO studio_memory_revision VALUES
      ('format', 1, 'active', 'remember', NULL, 'Old format', 'old-assistant', 'remember-format', 31, '${time}'),
      ('format', 2, 'active', 'correct', 'old-project', 'Current project format', 'old-assistant', 'correct-format', 32, '${time}'),
      ('secret', 1, 'active', 'remember', NULL, 'Forgotten old value', 'old-assistant', 'remember-secret', 33, '${time}'),
      ('secret', 2, 'forgotten', 'forget', NULL, NULL, 'old-assistant', 'forget-secret', 34, '${time}'),
      ('stale', 1, 'active', 'remember', NULL, 'Stale value', 'old-assistant', 'remember-stale', 35, '${time}'),
      ('stale', 2, 'forgotten', 'forget', NULL, NULL, 'old-assistant', 'forget-stale', 36, '${time}'),
      ('unindexed', 1, 'active', 'remember', NULL, 'Journal only', 'old-assistant', 'remember-unindexed', 37, '${time}');
    INSERT INTO studio_memory_head VALUES ('format', 2, 'active', 'old-project'), ('secret', 2, 'forgotten', NULL), ('stale', 1, 'active', NULL);
    INSERT INTO studio_memory_citation VALUES ('citation', 'format', 1, NULL, 'old-assistant', 'cite-format', 38, '${time}');
    INSERT INTO studio_draft_preference VALUES ('private-draft', 'citation');
    INSERT INTO studio_project_fact VALUES ('old-project', 'evidence', 1, 'old-leader-2', 2, 'fact-command', '${time}',
      'plain-work', 2, 'session-plain-work', 'bot-plain-work', 'result-plain-work', 1, 17, 0, 8, '${'a'.repeat(64)}');
    INSERT INTO studio_project_work_fact VALUES ('private-fact', 'old-project', 'evidence', 1, 39, 1);
    INSERT INTO studio_project_work_result_use VALUES ('private-use', 'old-project', 'old-leader-2', 'use-command', 'plain-work', 2,
      'session-plain-work', 'bot-plain-work', 'result-plain-work', 1, 17, 0, 8, '${'b'.repeat(64)}');
    INSERT INTO studio_study VALUES ('study', 'assistant-bot', 'old-assistant', 'study-message', 'study-request', 'study-tool',
      'Investigate', 'Investigate this part', 'old-run', 'running', NULL);
    INSERT INTO studio_study_step VALUES ('study-step', 'study', 1, 'investigation', 'Part one', 'study-bot', 'old-study', 1,
      'running', 'Investigate part one', NULL, NULL);
    INSERT INTO studio_advisor_bot VALUES (1, 'advisor-bot');
    INSERT INTO studio_advice (advice_id, advisor_bot_id, advisor_session_id, execution_epoch, requester_session_id, requester_bot_id,
      role, source_message_id, source_request_id, tool_call_id, request_text, question, provider, model, input_text, run_id, state)
    VALUES ('advice', 'advisor-bot', 'old-advisor', 1, 'old-assistant', 'assistant-bot', 'assistant', 'advice-message',
      'advice-request', 'advice-tool', 'Ask for advice', 'What next?', 'fixture', 'advisor', 'Give advice', 'old-run', 'running');
    INSERT INTO agent_studio_session (id, conversation_id, role, created_at) VALUES ('old-session-index', '${assistant}', 'subagent', ${cutover});
    INSERT INTO agent_studio_settings VALUES (1, 7, '{"provider":"fixture","model":"assistant"}', '{"provider":"fixture","model":"leader","reasoningEffort":"low"}');
    INSERT INTO agent_studio_feishu_binding VALUES (1, 'old-feishu-scope', 4, ${cutover});
    INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, status, request_id,
      feishu_scope, feishu_id, feishu_thread_id, feishu_generation)
    VALUES ('published-user', '${assistant}', 'user', 'feishu', 'Published request', ${cutover + 1}, 'completed', 'published-request',
      'old-feishu-scope', 'om-user', 'om-thread', 4),
      ('revision-request', '${assistant}', 'user', 'gui', 'Prior request to revise', ${cutover + 2}, 'completed', 'old-revision-request', NULL, NULL, NULL, NULL);
    INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, reply_to, topic_id, source_session_id, source_event_seq)
    VALUES ('published-answer', '${assistant}', 'assistant', 'studio', 'Published answer', ${cutover + 3}, 'published-user', 'published-user', 'old-assistant', 21),
      ('claimed-answer', '${assistant}', 'assistant', 'studio', 'Answer awaiting receipt', ${cutover + 4}, 'published-user', 'published-user', 'old-assistant', 22);
    INSERT INTO agent_studio_feishu_outbox (id, generation, kind, message_id, parent_message_id, state, remote_id)
    VALUES ('sent', 4, 'message', 'published-answer', 'published-user', 'sent', 'om-answer'),
      ('claim', 4, 'message', 'claimed-answer', 'published-user', 'claimed', NULL);
    INSERT INTO agent_studio_revision (id, conversation_id, owner_session_id, request_id, message_id, worker_session_id,
      work_type, work_id, origin_request_id, origin_message_id, state, created_at, result_text, result_event_seq)
    VALUES ('revision', '${assistant}', 'old-assistant', 'revision-request', 'revision-source', 'old-private-revision',
      'draft', 'private-draft', 'published-user', 'source-private-draft', 'completed', ${cutover + 5}, 'Private revision output', 0);`)
}

describe('Studio V1 SQLite ledger', () => {
  it('installs the V1 schema, enforces foreign keys on Host writes and uses one seven-state task table', () => {
    const f = fixture(), store = f.open(), db = f.sql()
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    db.exec(`CREATE TRIGGER reject_orphan_probe AFTER INSERT ON studio_task WHEN NEW.source_message_id = 'message-orphan'
      BEGIN UPDATE studio_task SET project_id = 'does-not-exist' WHERE task_id = NEW.task_id; END`)
    expect(() => store.registerTask(ownerTask(store, 'orphan'))).toThrow(/FOREIGN KEY constraint failed/)
    expect(store.tasks().items).toEqual([])

    const input = ownerTask(store, 'shared')
    const { taskId, created } = store.registerTask(input)
    expect(created).toBe(true)
    expect(store.registerTask({ ...input })).toEqual({ taskId, created: false })
    expect(() => store.registerTask({ ...input, requestText: 'New body for the same key' })).toThrow('Studio task source conflict')
    expect(() => store.registerTask({ ...input, sourceMessageId: 'different-source' })).toThrow('Studio task source conflict')
    expect(store.taskFromMessage(assistant, input.requestId, input.sourceMessageId)).toMatchObject({ taskId, status: 'queued', artifacts: [], externalJob: null })
    expect(store.taskFromMessage(assistant, input.requestId, 'different-source')).toBeUndefined()
    expect(db.prepare('SELECT artifacts, external_job FROM studio_task WHERE task_id = ?').get(taskId)).toEqual({ artifacts: '[]', external_job: null })
    const project = createProject(store)
    const projectTask = store.registerTask(ownerTask(store, 'shared', project))
    expect(projectTask.created).toBe(true)
    expect(projectTask.taskId).not.toBe(taskId)
    expect(store.tasks(assistant).items.map(task => task.taskId)).toEqual([taskId])
    expect(store.tasks(project.id).items.map(task => task.taskId)).toEqual([projectTask.taskId])

    // 直接检验 CHECK，而不把尚未启用的 waiting_approval 当成可执行产品流程。
    const writeStatus = db.prepare('UPDATE studio_task SET status = ? WHERE task_id = ?')
    for (const status of ['queued', 'running', 'waiting_approval', 'blocked', 'interrupted', 'cancelled', 'delivered']) {
      writeStatus.run(status, taskId)
      expect(store.task(taskId)?.status).toBe(status)
    }
    expect(() => writeStatus.run('completed', taskId)).toThrow(/CHECK constraint failed/)
  })

  it('fences one live execution, stale authorizations and optimistic block transitions', () => {
    const f = fixture(), store = f.open(), db = f.sql()
    const { taskId } = store.registerTask(ownerTask(store, 'running'))
    expect(store.beginExecution(taskId, 'wrong-scope', 1, route)).toBeUndefined()
    const exec = store.beginExecution(taskId, 'worker', null, route)!
    expect(store.task(taskId)).toMatchObject({ status: 'running', authorizationVersion: 1 })
    expect(store.executionCurrent(exec)).toBe(true)
    expect(store.beginExecution(taskId, 'duplicate-worker', null, route)).toBeUndefined()
    expect(store.studioSession('duplicate-worker')).toBeUndefined()
    const insert = db.prepare(`INSERT INTO studio_task_execution
      (task_id, execution_epoch, session_id, run_id, started_at) VALUES (?, 2, ?, ?, ?)`)
    expect(() => insert.run(taskId, 'duplicate-worker', exec.runId, time)).toThrow(/UNIQUE constraint failed: studio_task_execution.task_id/)
    const { taskId: other } = store.registerTask(ownerTask(store, 'other'))
    expect(() => insert.run(other, exec.sessionId, exec.runId, time)).toThrow(/UNIQUE constraint failed: studio_task_execution.session_id/)
    for (const changed of [{ taskId: other }, { executionEpoch: 2 }, { authorizationVersion: 2 }, { sessionId: 'other' }, { runId: 'older-host' }, { managementEpoch: 1 }]) {
      expect(store.executionCurrent({ ...exec, ...changed })).toBe(false)
    }

    expect(store.markTaskBlocked(taskId, 2, 'stale write')).toBe(false)
    expect(store.executionCurrent(exec)).toBe(true)
    expect(store.invalidateTask(taskId, 'cancelled')).toBe(true)
    expect(store.executionCurrent(exec)).toBe(false)
    expect(store.finishExecution(exec, { text: 'late answer', eventSeq: 2 }, 'delivered')).toBe(false)
    expect(store.task(taskId)).toMatchObject({ status: 'cancelled', authorizationVersion: 2, resultSummary: null, checkResult: null })
    expect(db.prepare('SELECT ended_at, outcome, result_event_seq FROM studio_task_execution WHERE task_id = ?').get(taskId))
      .toEqual({ ended_at: expect.any(String), outcome: 'cancelled', result_event_seq: null })

    const active = store.beginExecution(other, 'worker-2', null, route)!
    expect(store.markTaskBlocked(other, active.authorizationVersion, 'Wait for owner input')).toBe(true)
    expect(store.executionCurrent(active)).toBe(false)
    expect(store.markTaskBlocked(other, active.authorizationVersion, 'overwrite')).toBe(false)
    expect(store.task(other)).toMatchObject({ status: 'blocked', authorizationVersion: 2, checkResult: 'Wait for owner input' })
    const [pending] = store.studioBlockingItems()
    expect(pending).toMatchObject({ taskId: other, detail: 'Wait for owner input' })
    expect(store.studioPendingRecord(pending!.id)).toBe(active.sessionId)
    expect(store.invalidateTask(other, 'interrupted', 1)).toBe(false)
    expect(store.invalidateTask(other, 'interrupted', 2)).toBe(true)
    expect(store.task(other)).toMatchObject({ status: 'interrupted', authorizationVersion: 3 })
    expect(store.studioPendingRecord(pending!.id)).toBeUndefined()
    expect(store.studioBlockingItems()).toEqual([])
    expect(store.beginExecution(other, 'unexpected-replay', null, route)).toBeUndefined()
  })
})

describe('Studio V0 to V1 migration', () => {
  it('preserves published state, snapshots legacy Sessions and never projects a protected result', async () => {
    const f = fixture(), db = f.sql()
    seedV0(db)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0)
    const rows = (sql: string) => db.prepare(sql).all()
    const messagesBefore = rows('SELECT * FROM agent_studio_message ORDER BY sequence')
    const bindingBefore = rows('SELECT * FROM agent_studio_feishu_binding')
    const outboxBefore = rows('SELECT * FROM agent_studio_feishu_outbox ORDER BY sequence')
    const store = f.open()
    expect(rows('PRAGMA user_version')).toEqual([{ user_version: 1 }])
    expect(rows('PRAGMA foreign_key_check')).toEqual([])
    expect(rows('SELECT * FROM agent_studio_message ORDER BY sequence')).toEqual(messagesBefore)
    expect(rows('SELECT * FROM agent_studio_feishu_binding')).toEqual(bindingBefore)
    expect(bindingBefore).toEqual([{ singleton: 1, scope: 'old-feishu-scope', generation: 4, cutover }])
    expect(rows('SELECT * FROM agent_studio_feishu_outbox ORDER BY sequence')).toEqual(outboxBefore.map(row => ({
      ...row, state: row.state === 'claimed' ? 'unconfirmed' : row.state,
    })))
    expect(store.studio.message(assistant, 'published-answer')).toMatchObject({ text: 'Published answer', topicId: 'published-user',
      replyTo: 'published-user', source: { sessionId: 'old-assistant', eventSeq: 21 } })
    const storedSettings = { revision: 7, assistant: { provider: 'fixture', model: 'assistant' },
      leader: { provider: 'fixture', model: 'leader', reasoningEffort: 'low' } }
    expect(store.studio.settings({ assistant: null, leader: null })).toEqual(storedSettings)
    expect(store.assistantBotId).toBe('assistant-bot')
    expect(store.projects.get('old-project')).toMatchObject({ leaderBotId: 'leader-bot', leaderSessionId: 'old-leader-2', managementEpoch: 2, readonlyLegacy: true })
    expect(store.projects.currentLeader('old-leader-2')).toBeUndefined()
    expect(store.projectArchive.get('old-project')).toBeUndefined()

    const sessionRoles = { 'old-document': 'document-worker', 'old-study': 'study-worker', 'old-advisor': 'advisor',
      'session-plain-draft': 'draft-worker', 'session-released': 'draft-worker', 'old-assistant': 'assistant', 'old-leader-1': 'leader',
      'old-leader-2': 'leader', 'old-session-index': 'subagent' } as const
    for (const [id, role] of Object.entries(sessionRoles)) expect(store.studioSession(id)).toMatchObject({ id, role, readonlyLegacy: true })
    expect(store.studioHiddenIds()).toEqual(rows('SELECT session_id FROM studio_session ORDER BY session_id').map(row => row.session_id))
    expect(rows('SELECT session_id FROM studio_session WHERE readonly_legacy <> 1')).toEqual([])
    expect(() => store.registerSession('old-document', 'worker', null, null)).toThrow('already belongs to a different binding')

    const ordinary = [['plain-draft', assistant, 'Ordinary draft output', 0], ['plain-work', 'old-project', 'Ordinary project result', 17]] as const
    for (const [id, room, text, eventSeq] of ordinary) {
      const source = { sessionId: `session-${id}`, eventSeq }
      expect(store.task(id)).toMatchObject({ status: 'delivered', resultSummary: text, source })
      expect(store.studioArtifacts(room, `source-${id}`)).toEqual([{ title: 'Worker result', text, source }])
    }
    for (const [id, room] of [['live-draft', assistant], ['live-work', 'old-project']] as const) {
      expect(store.task(id)).toMatchObject({ status: 'interrupted', resultSummary: null })
      expect(store.task(id)).not.toHaveProperty('source')
      expect(store.studioArtifacts(room, `source-${id}`)).toEqual([])
    }
    expect(rows(`SELECT task_id, outcome, result_event_seq FROM studio_task_execution WHERE task_id LIKE 'live-%' AND ended_at IS NOT NULL ORDER BY task_id`))
      .toEqual(['live-draft', 'live-work'].map(task_id => ({ task_id, outcome: 'interrupted', result_event_seq: null })))
    expect(rows('SELECT task_id FROM studio_task_execution WHERE ended_at IS NULL')).toEqual([])
    const openLog = vi.fn()
    const host = { on: () => () => {}, sessionPersistence: { open: openLog } } as unknown as Context
    const signal = new AbortController().signal
    const service = new StudioService(host, store, f.dir, { assistant: null, leader: null }, () => true, signal, () => 'disabled', () => {})
    for (const [id, room] of [['private-draft', assistant], ['private-fact', 'old-project'], ['private-use', 'old-project']] as const) {
      const sessionId = `session-${id}`
      expect(store.task(id)).toBeUndefined()
      expect(store.taskFromMessage(room, `request-${id}`, `source-${id}`)).toBeUndefined()
      expect(store.studioArtifacts(room, `source-${id}`)).toEqual([])
      expect(store.studioSession(sessionId)?.readonlyLegacy).toBe(true)
      expect(store.isProtectedLog(sessionId)).toBe(true)
      await expect(service.operations.record({ sessionId }, signal)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    }
    expect(store.isProtectedLog('old-private-revision')).toBe(true)
    await expect(service.operations.record({ sessionId: 'old-private-revision' }, signal)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
    expect(openLog).not.toHaveBeenCalled()
    expect(store.isProtectedLog('session-plain-work')).toBe(false)
    await service.sessions.drain()
    expect(store.tasks().items.map(task => task.taskId).sort()).toEqual(['live-draft', 'live-work', 'plain-draft', 'plain-work'])

    expect(store.memory.list('old-project', true)).toMatchObject([{ prefKey: 'format', projectId: 'old-project', text: 'Current project format', version: 2 }])
    expect(store.memory.list()).toEqual([])
    expect(store.memory.list(null, true)).toMatchObject([{ prefKey: 'secret', state: 'forgotten', text: '', version: 2 }])
    expect(store.memory.get('stale')).toBeUndefined()
    expect(store.memory.get('unindexed')).toBeUndefined()
    expect(() => db.exec("DELETE FROM studio_draft_preference WHERE task_id = 'private-draft'")).toThrow('Legacy Studio snapshot is read-only')

    // 新宿主每次有新 run_id；其余事务数据、索引和只读快照必须保持逐行相同。
    const snapshot = () => {
      const schema = rows('SELECT type, name, sql FROM sqlite_schema ORDER BY name')
      const tables = schema.filter(row => row.type === 'table' && row.name !== 'studio_host_run')
      return { schema, data: tables.map(({ name }) => rows(`SELECT * FROM "${String(name)}" ORDER BY rowid`)) }
    }
    const once = snapshot()
    store.close()
    const reopened = f.open()
    expect(reopened.recoveredTasks).toBe(0)
    expect(snapshot()).toEqual(once)
  })

  it('rejects a future user_version without changing its schema or data', () => {
    const f = fixture(), db = f.sql()
    db.exec("PRAGMA user_version=99; CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('leave intact')")
    expect(() => f.open()).toThrow('Unsupported Studio SQLite user_version: 99')
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(99)
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
    expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([{ name: 'future' }])
    expect(db.prepare('SELECT value FROM future').all()).toEqual([{ value: 'leave intact' }])
  })
})

describe('Studio V1 project and owner data', () => {
  it('fences workspace changes, Leader replacement, archive and reopen by epoch', () => {
    const f = fixture(), store = f.open()
    const workspace = join(f.dir, 'work'), nextWorkspace = join(f.dir, 'next-work')
    mkdirSync(workspace); mkdirSync(nextWorkspace)
    const initial = createProject(store, 'first-leader', workspace)
    expect(initial).toMatchObject({ state: 'active', managementEpoch: 1, workspacePath: workspace })
    expect(store.projects.currentLeader('first-leader')).toEqual(initial)
    expect(() => createProject(store, 'first-leader')).toThrow(/UNIQUE constraint failed/)
    expect(store.projects.list().map(project => project.id)).toEqual([initial.id])
    const request = ownerTask(store, 'workspace', initial)
    const firstTask = store.registerTask(request).taskId
    const first = store.beginExecution(firstTask, 'first-worker', 1, route)!
    expect(() => store.projects.update(initial.id, 0, { objective: 'stale' })).toThrow('Studio project state changed')
    expect(store.projects.update(initial.id, 1, { objective: 'Revised objective' })).toMatchObject({
      project: { objective: 'Revised objective', managementEpoch: 1, workspacePath: workspace }, invalidatedTaskIds: [],
    })
    expect(store.executionCurrent(first)).toBe(true)
    const scoped = store.projects.update(initial.id, 1, { workspacePath: nextWorkspace })
    expect(scoped).toMatchObject({ project: { managementEpoch: 2, workspacePath: nextWorkspace, leaderSessionId: 'first-leader' }, invalidatedTaskIds: [firstTask] })
    expect(store.executionCurrent(first)).toBe(false)
    expect(() => store.registerTask(request)).toThrow('Studio project authority changed')

    const handoffRequest = ownerTask(store, 'handoff', scoped.project)
    const handoffTask = store.registerTask(handoffRequest).taskId
    expect(store.beginExecution(handoffTask, 'stale-epoch', 1, route)).toBeUndefined()
    const handoff = store.beginExecution(handoffTask, 'handoff-worker', 2, route)!
    expect(store.executionCurrent(handoff)).toBe(true)
    expect(store.executionCurrent({ ...handoff, managementEpoch: 1 })).toBe(false)
    expect(() => store.projects.replaceLeader(initial.id, 1, 'stale-leader')).toThrow('Studio project state changed')
    // 即便复用同一个 Bot，旧 Session 也不会继续持有项目管理权。
    const replaced = store.projects.replaceLeader(initial.id, 2, 'second-leader', initial.leaderBotId)
    expect(replaced).toMatchObject({ project: { managementEpoch: 3, leaderSessionId: 'second-leader', leaderBotId: initial.leaderBotId }, invalidatedTaskIds: [handoffTask] })
    expect(store.executionCurrent(handoff)).toBe(false)
    expect(store.task(handoffTask)).toMatchObject({ status: 'interrupted', authorizationVersion: 2 })
    expect(store.projects.currentLeader('first-leader')).toBeUndefined()
    expect(() => store.registerTask({ ...handoffRequest, leader: { sessionId: 'first-leader', managementEpoch: 3 } })).toThrow('Studio project authority changed')

    const archiveRequest = ownerTask(store, 'archive', replaced.project)
    const archiveTask = store.registerTask(archiveRequest).taskId
    const inFlight = store.beginExecution(archiveTask, 'archive-worker', 3, route)!
    expect(() => store.projects.archive(initial.id, 2)).toThrow('Studio project state changed')
    expect(store.executionCurrent(inFlight)).toBe(true)
    expect(store.projects.archive(initial.id, 3)).toMatchObject({ project: { state: 'archived', managementEpoch: 4 }, invalidatedTaskIds: [archiveTask] })
    expect(store.projects.get(initial.id)?.leaderSessionId).toBeUndefined()
    expect(store.projects.list()).toEqual([])
    expect(store.projects.currentLeader('second-leader')).toBeUndefined()
    expect(() => store.registerTask(archiveRequest)).toThrow('Studio project authority changed')
    expect(store.executionCurrent(inFlight)).toBe(false)
    expect(store.finishExecution(inFlight, { text: 'late result', eventSeq: 1 }, 'delivered')).toBe(false)
    expect(store.task(archiveTask)).toMatchObject({ status: 'interrupted', authorizationVersion: 2, resultSummary: null })
    expect(() => store.projects.update(initial.id, 4, { objective: 'archived edit' })).toThrow('Studio project state changed')
    expect(() => store.projects.reopen(initial.id, 3, 'third-leader')).toThrow('Studio project state changed')
    expect(() => store.projects.reopen(initial.id, 4, 'second-leader')).toThrow(/UNIQUE constraint failed/)
    expect(store.projects.get(initial.id)).toMatchObject({ state: 'archived', managementEpoch: 4 })
    const reopened = store.projects.reopen(initial.id, 4, 'third-leader')
    expect(reopened).toMatchObject({ project: { state: 'active', managementEpoch: 5, leaderSessionId: 'third-leader', leaderBotId: initial.leaderBotId }, invalidatedTaskIds: [] })
    expect(store.projects.currentLeader('second-leader')).toBeUndefined()
    expect(store.projects.currentLeader('third-leader')).toEqual(reopened.project)
    expect(store.registerTask(ownerTask(store, 'after-reopen', reopened.project)).created).toBe(true)
    expect(store.beginExecution(archiveTask, 'must-not-replay', 5, route)).toBeUndefined()
  })

  it('keeps archived projects readable and preference CAS and tombstones isolated per scope', () => {
    const store = fixture().open(), project = createProject(store), other = createProject(store, 'other-leader')
    const archive = store.projectArchive, memory = store.memory
    expect(archive.get(project.id)).toBeUndefined()
    expect(archive.delete(project.id)).toBe(false)
    expect(archive.update(project.id, { decisions: 'Keep the source' })).toMatchObject({ projectId: project.id, decisions: 'Keep the source', progress: '', openIssues: '' })
    const saved = archive.update(project.id, { progress: 'Reviewed', openIssues: 'Check units' })
    expect(saved).toMatchObject({ decisions: 'Keep the source', progress: 'Reviewed', openIssues: 'Check units' })
    expect(archive.get(other.id)).toBeUndefined()

    memory.save('format', 'Global default')
    const p = memory.save('format', 'Project original', project.id)
    memory.save('format', 'Other project default', other.id)
    expect(() => memory.save('format', 'Global duplicate')).toThrow(/UNIQUE constraint failed/)
    expect(() => memory.save('format', 'Project duplicate', project.id)).toThrow(/UNIQUE constraint failed/)
    expect(memory.update('format', 2, 'Stale update', project.id)).toBeUndefined()
    expect(memory.update('format', p.version, 'Project correction', project.id)).toMatchObject({ preferenceId: p.preferenceId, version: 2 })
    expect(memory.forget('format', p.version, project.id)).toBeUndefined()
    expect(memory.get('format', project.id)?.text).toBe('Project correction')
    expect(memory.forget('format', 2, project.id)).toMatchObject({ preferenceId: p.preferenceId, state: 'forgotten', version: 3, text: '' })
    expect(memory.get('format', project.id)).toMatchObject({ state: 'forgotten', text: '' })
    expect(memory.list(project.id)).toEqual([])
    expect(memory.list(project.id, true)).toMatchObject([{ state: 'forgotten', text: '' }])
    expect(memory.update('format', 3, 'Restore old content', project.id)).toBeUndefined()
    expect(() => memory.save('format', 'Reactivate tombstone', project.id)).toThrow(/UNIQUE constraint failed/)
    expect(memory.get('format')?.text).toBe('Global default')
    expect(memory.get('format', other.id)?.text).toBe('Other project default')

    store.projects.archive(project.id, project.managementEpoch)
    expect(archive.get(project.id)).toEqual(saved)
    expect(() => archive.update(project.id, { decisions: 'Rewrite' })).toThrow('only change while its project is active')
    expect(() => archive.delete(project.id)).toThrow('only change while its project is active')
    expect(() => memory.save('new', 'Write to archive', project.id)).toThrow('require an active project')
    expect(() => memory.update('format', 3, 'Write to archive', project.id)).toThrow('require an active project')
    expect(() => memory.forget('format', 3, project.id)).toThrow('require an active project')
    expect(memory.list(project.id, true)).toMatchObject([{ state: 'forgotten', text: '' }])
    store.projects.reopen(project.id, 2, 'reopened-leader')
    expect(archive.delete(project.id)).toBe(true)
    expect(archive.get(project.id)).toBeUndefined()
  })
})
