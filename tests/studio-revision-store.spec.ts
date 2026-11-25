import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ManagedWorkerStore, type ManagedResult } from '../src/managed-worker/store.ts'
import { ASSISTANT_CONVERSATION as assistant, type StudioMessage } from '../src/studio/protocol.ts'
import { StudioRevisionStore, type StudioRevisionInput, type StudioRevisionWork } from '../src/studio/revision-store.ts'
import { studioOwnerMessageId } from '../src/studio/source.ts'

let directory: string
let managed: ManagedWorkerStore
let db: DatabaseSync
let ledger: StudioRevisionStore
let active: boolean
let serial: number
const assistantSession = 'assistant-1'
const assertActive = () => { if (!active) throw new Error('The test run lost its fence') }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'agent-studio-revisions-'))
  const path = join(directory, 'managed.sqlite')
  managed = new ManagedWorkerStore(path)
  db = new DatabaseSync(path)
  active = true
  serial = 0
  ledger = new StudioRevisionStore(db, assertActive)
  bindAssistant(assistantSession)
})
afterEach(() => {
  db?.close()
  managed?.close()
  rmSync(directory, { recursive: true, force: true })
})

function unwrap<T>(result: ManagedResult<T>): T {
  if (!result.ok) throw new Error(result.reason)
  return result.value
}

function bindAssistant(sessionId: string): string {
  const bot = unwrap(managed.bindAssistant(sessionId))
  managed.studio.setAssistantSession(sessionId)
  return bot
}

function user(conversationId: string, body: string, replyTo?: string): StudioMessage {
  return managed.studio.addUser({ conversationId, requestId: `gui-${++serial}`, channel: 'gui', text: body, replyTo }).message
}

function correction(replyTo: StudioMessage, ownerSessionId: string, work: StudioRevisionWork, body = '  Make this tighter.  '): StudioRevisionInput {
  const input = user(replyTo.conversationId, body, replyTo.id)
  managed.studio.startMessage(input.id, ownerSessionId)
  return { conversationId: input.conversationId, ownerSessionId, requestId: input.id, messageId: studioOwnerMessageId(input.id),
    workerSessionId: `revision-worker-${serial}`, work }
}

function draft(origin: StudioMessage, output = 'Original draft', ownerSessionId = assistantSession): StudioRevisionWork {
  const { task } = unwrap(managed.startDraft({ assistantSessionId: ownerSessionId, sourceRequestId: origin.id,
    sourceMessageId: studioOwnerMessageId(origin.id), workerSessionId: `draft-worker-${serial}`, requestText: origin.text }))
  unwrap(managed.completeDraft(task, { text: output, messageId: `draft-output-${serial}`, eventSeq: 7, turn: 1 }))
  return { type: 'draft', id: task.taskId }
}

function currentRunId(): string {
  return db.prepare('SELECT run_id FROM managed_host_run WHERE singleton = 1').get()?.run_id as string
}

function project(leaderSessionId: string) {
  return unwrap(managed.projects.create({ leaderSessionId, commandId: `create-${leaderSessionId}`, name: 'Test project', objective: 'Compare evidence' }))
}

function startWork(origin: StudioMessage, leaderSessionId: string): StudioRevisionWork {
  const { work } = unwrap(managed.projects.recordWork({ leaderSessionId, sourceRequestId: origin.id,
    sourceMessageId: studioOwnerMessageId(origin.id), requestText: origin.text }))
  return { type: 'work', id: work.workId }
}

function completeWork(work: StudioRevisionWork, room: ReturnType<typeof project>, output = 'Original project result'): void {
  db.prepare(`INSERT INTO studio_project_dispatch (work_id, execution_epoch, project_id, leader_session_id, management_epoch,
    worker_session_id, worker_bot_id, run_id, state, result_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'completed', ?)`)
    .run(work.id, room.projectId, room.leaderSessionId, room.managementEpoch, `${work.id}-worker`, `${work.id}-bot`, currentRunId(),
      JSON.stringify({ text: output, messageId: `${work.id}-output`, eventSeq: 9, turn: 1 }))
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(expect.objectContaining({ code }))
}

it('appends exact topical revisions to the original draft and bases later revisions on the latest saved output', () => {
  const topic = user(assistant, 'A broad discussion')
  const origin = user(assistant, 'Original request created inside the topic', topic.id)
  const work = draft(origin)
  const answer = managed.studio.addReply(origin.id, 'Initial owner-visible readout')
  const first = correction(answer, assistantSession, work)
  const one = ledger.reserve(first)
  expect(one).toMatchObject({ ...first, previousText: 'Original draft', instruction: '  Make this tighter.  ', state: 'running' })
  expect(ledger.current(one)).toBe(true)
  expect(ledger.current(one.workerSessionId)).toBe(true)
  expect(ledger.current({ ...one, id: 'unrelated reservation' })).toBe(false)
  expect(ledger.link(assistant, one.requestId, one.messageId)).toEqual(work)
  expect(ledger.link(assistant, one.requestId, 'wrong message')).toBeUndefined()
  expect(ledger.artifact(assistant, one.requestId)).toBeUndefined()
  expectCode(() => ledger.reserve({ ...first, workerSessionId: 'duplicate-worker' }), 'REVISION_ALREADY_RESERVED')
  expectCode(() => ledger.finish(one.workerSessionId, { text: ' ', eventSeq: 12 }), 'REVISION_INVALID_RESULT')
  expectCode(() => ledger.finish(one.workerSessionId, { text: 'invalid proof', eventSeq: -1 }), 'REVISION_INVALID_RESULT')
  expect(ledger.current(one)).toBe(true)
  expect(ledger.finish(one.workerSessionId, { text: 'First revised result', eventSeq: 12 })?.state).toBe('completed')
  expect(ledger.finish(one.workerSessionId, { text: 'not an overwrite', eventSeq: 13 })).toBeUndefined()
  expect(ledger.artifact(assistant, one.requestId)).toEqual({ id: one.id, workerSessionId: one.workerSessionId, text: 'First revised result', eventSeq: 12 })
  expect(ledger.sourceBinding(one.workerSessionId)).toMatchObject({ id: one.id, state: 'completed', work })

  // The first correction was to a topic descendant, and a new reply can be deeper again without forking the task.
  const updatedAnswer = managed.studio.addReply(one.requestId, 'The first correction is ready')
  const failed = ledger.reserve(correction(updatedAnswer, assistantSession, work))
  expect(ledger.finish(failed.workerSessionId)?.state).toBe('failed')
  expect(ledger.link(assistant, failed.requestId, failed.messageId)).toEqual(work)
  expect(ledger.artifact(assistant, failed.requestId)).toBeUndefined()
  bindAssistant('assistant-replacement')
  const recovered = ledger.reserve(correction(managed.studio.message(assistant, failed.requestId)!, 'assistant-replacement', work))
  expect(recovered).toMatchObject({ previousText: 'First revised result', basedOnRevisionId: one.id, work })
  expect(db.prepare('SELECT task_id, result_text FROM studio_draft_task').all()).toEqual([{ task_id: work.id, result_text: 'Original draft' }])
})

it('uses only the completed synthesis of an Assistant study as the revision base', () => {
  const request = user(assistant, 'Compare the supplied materials')
  const bot = unwrap(managed.bindAssistant(assistantSession))
  db.prepare(`INSERT INTO studio_study (task_id, assistant_bot_id, assistant_session_id, source_message_id, source_request_id, tool_call_id,
    request_text, instruction, run_id, state) VALUES ('study', ?, ?, ?, ?, 'study-tool', ?, 'Compare', ?, 'completed')`)
    .run(bot, assistantSession, studioOwnerMessageId(request.id), request.id, request.text, currentRunId())
  const step = db.prepare(`INSERT INTO studio_study_step (task_id, study_task_id, ordinal, kind, excerpt, worker_bot_id, worker_session_id,
    execution_epoch, state, input_text, result_json) VALUES (?, 'study', ?, ?, ?, ?, ?, 1, 'completed', 'source', ?)`)
  step.run('part', 1, 'investigation', 'Excerpt', 'part-bot', 'part-worker', JSON.stringify({ text: 'Internal finding', eventSeq: 1 }))
  const input = correction(request, assistantSession, { type: 'study', id: 'study' })
  expectCode(() => ledger.reserve(input), 'REVISION_WORK_NOT_ELIGIBLE')
  step.run('synthesis', 2, 'synthesis', null, 'synthesis-bot', 'synthesis-worker', JSON.stringify({ text: 'Final synthesis', eventSeq: 12 }))
  const revision = ledger.reserve(input)
  expect(revision.previousText).toBe('Final synthesis')
  expect(ledger.finish(revision.workerSessionId, { text: 'Updated study synthesis', eventSeq: 0 })?.state).toBe('completed')
  expect(ledger.artifact(assistant, input.requestId)).toMatchObject({ text: 'Updated study synthesis', eventSeq: 0 })
})

it('rejects cross-room tasks, wrong same-room topics, quotes alone, and spoofed native input coordinates', () => {
  const a = project('leader-a')
  const b = project('leader-b')
  const origin = user(a.projectId, 'A work item')
  const work = startWork(origin, a.leaderSessionId)
  completeWork(work, a)
  const bOrigin = user(b.projectId, 'Different project')
  expectCode(() => ledger.reserve(correction(bOrigin, b.leaderSessionId, work)), 'REVISION_WORK_NOT_ELIGIBLE')
  const wrongTopic = user(a.projectId, 'Independent discussion in A')
  expectCode(() => ledger.reserve(correction(wrongTopic, a.leaderSessionId, work)), 'REVISION_WRONG_TOPIC')
  const quoteOnly = managed.studio.addUser({ conversationId: a.projectId, channel: 'gui', requestId: 'quote-only',
    text: 'Quote without an explicit reply', quoteId: origin.id }).message
  managed.studio.startMessage(quoteOnly.id, a.leaderSessionId)
  expectCode(() => ledger.reserve({ conversationId: a.projectId, ownerSessionId: a.leaderSessionId, work,
    requestId: quoteOnly.id, messageId: studioOwnerMessageId(quoteOnly.id), workerSessionId: 'quote-worker' }), 'REVISION_SOURCE_NOT_CURRENT')
  const input = correction(origin, a.leaderSessionId, work)
  expectCode(() => ledger.reserve({ ...input, messageId: studioOwnerMessageId(origin.id) }), 'REVISION_INVALID_INPUT')
  const wrongOwner = correction(origin, b.leaderSessionId, work)
  expectCode(() => ledger.reserve({ ...wrongOwner, ownerSessionId: a.leaderSessionId }), 'REVISION_SOURCE_NOT_CURRENT')
  expect(ledger.reserve(input).previousText).toBe('Original project result')
  expect(ledger.finish(input.workerSessionId, { text: 'Project A only', eventSeq: 9 })?.state).toBe('completed')
  expect(ledger.link(b.projectId, input.requestId, input.messageId)).toBeUndefined()
  expect(ledger.artifact(b.projectId, input.requestId)).toBeUndefined()
})

it('fences parallel corrections and refuses a Worker Session already spent by any task', () => {
  const origin = user(assistant, 'Original input')
  const work = draft(origin)
  const first = correction(origin, assistantSession, work)
  const second = correction(origin, assistantSession, work)
  const previousWorker = db.prepare('SELECT worker_session_id FROM studio_draft_task WHERE task_id = ?').get(work.id)?.worker_session_id as string
  expectCode(() => ledger.reserve({ ...first, workerSessionId: previousWorker }), 'REVISION_WORKER_BOUND')
  expectCode(() => ledger.reserve({ ...first, workerSessionId: assistantSession }), 'REVISION_WORKER_BOUND')
  expect(ledger.reserve(first).state).toBe('running')
  expectCode(() => ledger.reserve(second), 'REVISION_IN_PROGRESS')
  expect(ledger.finish(first.workerSessionId)?.state).toBe('failed')
  expectCode(() => ledger.reserve({ ...second, workerSessionId: first.workerSessionId }), 'REVISION_WORKER_BOUND')
  expect(ledger.reserve(second).previousText).toBe('Original draft')
})

it('rejects a stale Leader before work and interrupts late results after a project handoff', () => {
  const room = project('leader-1')
  const origin = user(room.projectId, 'Prepare project result')
  const work = startWork(origin, room.leaderSessionId)
  completeWork(work, room)
  const first = ledger.reserve(correction(origin, room.leaderSessionId, work))
  expect(ledger.current(first)).toBe(true)
  const next = unwrap(managed.projects.handoff({ projectId: room.projectId, expectedEpoch: room.managementEpoch,
    nextSessionId: 'leader-2', commandId: 'handoff-2' }))
  expect(ledger.current(first)).toBe(false)
  expectCode(() => ledger.reserve(correction(origin, room.leaderSessionId, work)), 'REVISION_STALE_OWNER')
  expect(ledger.finish(first.workerSessionId, { text: 'Stale Leader result', eventSeq: 20 })?.state).toBe('interrupted')
  expect(ledger.artifact(room.projectId, first.requestId)).toBeUndefined()
  const second = ledger.reserve(correction(origin, next.leaderSessionId, work))
  expect(second.previousText).toBe('Original project result')
  const last = unwrap(managed.projects.handoff({ projectId: room.projectId, expectedEpoch: next.managementEpoch,
    nextSessionId: 'leader-3', commandId: 'handoff-3' }))
  const final = ledger.reserve(correction(origin, last.leaderSessionId, work))
  expect(final.previousText).toBe('Original project result')
  expect(ledger.sourceBinding(second.workerSessionId)?.state).toBe('interrupted')
  expect(ledger.finish(second.workerSessionId, { text: 'Too late', eventSeq: 99 })).toBeUndefined()
  expect(ledger.current(final)).toBe(true)
  expect(db.prepare('SELECT COUNT(*) AS total FROM studio_project_work').get()?.total).toBe(1)
})

it('excludes referenced preferences even when the Assistant draft has a completed result', () => {
  const origin = user(assistant, 'Write a draft')
  const work = draft(origin, 'Contains protected preference context')
  // The fixture pins a citation without having to make a real memory entry; the presence of the pin is sufficient to deny revision.
  db.exec('PRAGMA foreign_keys = OFF')
  db.prepare('INSERT INTO studio_draft_preference VALUES (?, ?)').run(work.id, 'test-citation')
  db.exec('PRAGMA foreign_keys = ON')
  expectCode(() => ledger.reserve(correction(origin, assistantSession, work)), 'REVISION_WORK_NOT_ELIGIBLE')
})

it.each(['fact', 'result', 'job', 'document'] as const)('excludes completed project work with a %s link', kind => {
  const room = project('project-leader')
  const origin = user(room.projectId, 'Write a project result')
  const work = startWork(origin, room.leaderSessionId)
  // These rows reproduce the protection pointers. Where no real document/fact fixture is needed, omit only their unrelated foreign records.
  db.exec('PRAGMA foreign_keys = OFF')
  if (kind === 'fact') {
    db.prepare(`INSERT INTO studio_project_work_fact VALUES (?, ?, 'test-fact', 1, 2, 1)`).run(work.id, room.projectId)
  } else if (kind === 'result') {
    const source = startWork(user(room.projectId, 'Source work for a pinned result'), room.leaderSessionId)
    completeWork(source, room)
    db.prepare(`INSERT INTO studio_project_work_result_use (work_id, project_id, leader_session_id, command_id, source_work_id,
      execution_epoch, worker_session_id, worker_bot_id, message_id, turn, event_seq, quote_offset, quote_length, source_fingerprint)
      VALUES (?, ?, ?, 'use-result', ?, 1, ?, ?, ?, 1, 9, 0, 3, ?)`).run(work.id, room.projectId, room.leaderSessionId,
      source.id, `${source.id}-worker`, `${source.id}-bot`, `${source.id}-output`, '1'.repeat(64))
  } else if (kind === 'job') {
    db.prepare(`INSERT INTO studio_project_job (work_id, unit, invocation_id, attached_project_id, attached_leader_session_id,
      attached_management_epoch, attach_command_id, attached_at, attached_state, state, observed_at, observation_version, paused, authorization_version)
      VALUES (?, 'test.service', 'invocation', ?, ?, 1, 'job-link', '2026-11-25', 'completed', 'completed', '2026-11-25', 1, 0, 1)`)
      .run(work.id, room.projectId, room.leaderSessionId)
  } else {
    db.prepare(`INSERT INTO studio_project_document VALUES (?, 'document-task', ?, ?, 1, 'doc-link', '2026-11-25', 1, 1)`)
      .run(work.id, room.projectId, room.leaderSessionId)
  }
  db.exec('PRAGMA foreign_keys = ON')
  completeWork(work, room, 'Protected project result')
  expectCode(() => ledger.reserve(correction(origin, room.leaderSessionId, work)), 'REVISION_WORK_NOT_ELIGIBLE')
})

it('recovers pending revisions without losing completed results, topic links, or historical Worker roles', () => {
  const origin = user(assistant, 'Original input')
  const work = draft(origin)
  const first = ledger.reserve(correction(origin, assistantSession, work))
  ledger.finish(first.workerSessionId, { text: 'Saved output', eventSeq: 11 })
  const second = ledger.reserve(correction(origin, assistantSession, work))
  const path = join(directory, 'managed.sqlite')
  db.close()
  managed.close()
  managed = new ManagedWorkerStore(path)
  db = new DatabaseSync(path)
  // A freshly opened connection sees the same ledger. The Host constructor also runs recovery.
  const restarted = new StudioRevisionStore(db, assertActive)
  restarted.recover()
  restarted.recover()
  expect(restarted.sourceBinding(second.workerSessionId)).toMatchObject({ state: 'interrupted', work })
  expect(restarted.current(second)).toBe(false)
  expect(restarted.finish(second.workerSessionId, { text: 'Cannot revive', eventSeq: 12 })).toBeUndefined()
  expect(restarted.link(assistant, second.requestId, second.messageId)).toEqual(work)
  expect(restarted.artifact(assistant, second.requestId)).toBeUndefined()
  expect(restarted.artifact(assistant, first.requestId)).toMatchObject({ text: 'Saved output', eventSeq: 11 })
  expectCode(() => restarted.reserve(second), 'REVISION_ALREADY_RESERVED')
  const third = restarted.reserve(correction(origin, assistantSession, work))
  expect(third).toMatchObject({ work, previousText: 'Saved output', basedOnRevisionId: first.id })
})

it('fences every entry point and allows metadata checks without nesting a managed transaction', () => {
  const origin = user(assistant, 'Original input')
  const work = draft(origin)
  const input = correction(origin, assistantSession, work)
  const revision = ledger.reserve(input)
  db.exec('BEGIN IMMEDIATE')
  try {
    expect(ledger.current(revision)).toBe(true)
    expect(ledger.sourceBinding(input.workerSessionId)?.id).toBe(revision.id)
    expect(() => ledger.recover()).toThrow('require a new transaction')
    expect(db.isTransaction).toBe(true)
  } finally { db.exec('ROLLBACK') }
  active = false
  for (const operation of [() => new StudioRevisionStore(db, assertActive), () => ledger.reserve(input), () => ledger.current(revision),
    () => ledger.sourceBinding(input.workerSessionId), () => ledger.finish(input.workerSessionId),
    () => ledger.link(assistant, input.requestId, input.messageId), () => ledger.artifact(assistant, input.requestId), () => ledger.recover()]) {
    expect(operation).toThrow('lost its fence')
  }
})
