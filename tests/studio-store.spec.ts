import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  ASSISTANT_CONVERSATION as assistant, STUDIO_PAGE_SIZE, type StudioPending, type StudioSessionRecord, type StudioSettings,
} from '../src/studio/protocol.ts'
import { ManagedWorkerStore } from '../src/managed-worker/store.ts'
import { StudioStore } from '../src/studio/store.ts'

let db: DatabaseSync
let store: StudioStore
let active: boolean
const defaults: Pick<StudioSettings, 'assistant' | 'leader'> = { assistant: null, leader: { provider: 'p', model: 'leader' } }
const assertActive = () => { if (!active) throw new Error('Test Studio run is no longer active') }

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  active = true
  store = new StudioStore(db, assertActive)
})
afterEach(() => db.close())

function gui(requestId: string, fields: Partial<Parameters<StudioStore['addUser']>[0]> = {}) {
  return store.addUser({ channel: 'gui', conversationId: assistant, requestId, text: requestId, ...fields })
}

function feishu(scope: string, id: string, createdAt: number, threadId?: string, replyTo?: string) {
  return store.addUser({ channel: 'feishu', conversationId: assistant, requestId: id, text: id, createdAt,
    feishu: { scope, id, threadId }, replyTo })
}

function pending(id: string, fields: Partial<StudioPending> = {}): StudioPending {
  return { id, kind: 'question', conversationId: assistant, requester: 'Assistant', title: 'Which option?', detail: 'Context',
    options: ['First', 'Second'], acceptsText: true, mobile: 'topic', state: 'pending', createdAt: 500, ...fields }
}

it('checks the run fence for initialization and every storage entry point', () => {
  const message = gui('owner').message
  active = false
  const operations = [
    () => new StudioStore(db, assertActive), () => store.assistantSession(), () => store.setAssistantSession('s'),
    () => store.settings(defaults), () => store.saveSettings({ ...defaults, revision: 0 }), () => gui('blocked'),
    () => store.message(assistant, message.id), () => store.messages(assistant), () => store.startMessage(message.id, 's'),
    () => store.recordMessageSource(message.id, { sessionId: 's', eventSeq: 1 }), () => store.finishMessage(message.id, 'failed'),
    () => store.addReply(message.id, 'reply'), () => store.recover(),
    () => store.registerSession({ id: 's', conversationId: assistant, role: 'assistant', createdAt: 3 }),
    () => store.session('s'), () => store.records(), () => store.addPending(pending('confirm')), () => store.pendingItem('confirm'),
    () => store.pendingCount(), () => store.openBlockers(), () => store.pending(), () => store.settlePending('confirm', 'resolved'),
    () => store.activateFeishu('bound', 0), () => store.deactivateFeishu(),
    () => store.feishuMessage('bound', 'remote'), () => store.feishuThread('bound', 'remote'),
    () => store.feishuQuestion('bound', 'remote'), () => store.nextFeishu('bound'), () => store.finishFeishu('delivery'),
  ]
  for (const operation of operations) expect(operation).toThrow('no longer active')
  active = true
  expect(store.messages(assistant).items).toEqual([message])
  expect(store.assistantSession()).toBeUndefined()
  expect(store.settings(defaults)).toEqual({ ...defaults, revision: 0 })
  expect(store.pendingCount()).toBe(0)
})

it('does not nest writes and rechecks the run fence under the writer lock', () => {
  db.exec('BEGIN')
  expect(() => store.setAssistantSession('s')).toThrow('require a new transaction')
  expect(db.isTransaction).toBe(true)
  db.exec('ROLLBACK')
  const fenced = new StudioStore(db, () => {
    if (db.isTransaction && !active) throw new Error('Fence changed under lock')
  })
  active = false
  expect(() => fenced.setAssistantSession('s')).toThrow('Fence changed under lock')
  expect(db.isTransaction).toBe(false)
  active = true
  expect(store.assistantSession()).toBeUndefined()
})

it('persists Assistant Session changes and protects settings with revision-zero CAS', () => {
  expect(store.assistantSession()).toBeUndefined()
  expect(store.settings(defaults)).toEqual({ ...defaults, revision: 0 })
  expect(() => store.saveSettings({ ...defaults, revision: 1 })).toThrow(expect.objectContaining({ code: 'SETTINGS_CONFLICT' }))
  const assistantModel = { provider: 'p', model: 'assistant', reasoningEffort: 'high' }
  expect(store.saveSettings({ ...defaults, assistant: assistantModel, revision: 0 })).toEqual({ ...defaults, assistant: assistantModel, revision: 1 })
  const second = new StudioStore(db, assertActive)
  expect(() => second.saveSettings({ ...defaults, revision: 0 })).toThrow('revision conflict')
  expect(second.saveSettings({ assistant: null, leader: null, revision: 1 })).toEqual({ assistant: null, leader: null, revision: 2 })
  expect(store.settings(defaults)).toEqual({ assistant: null, leader: null, revision: 2 })
  store.setAssistantSession('original')
  second.setAssistantSession('replacement')
  expect(store.assistantSession()).toBe('replacement')
})

it('rolls back both user insertion and pending settlement if their outbox writes fail', () => {
  store.activateFeishu('one', 10)
  const installFailure = () => db.exec(`CREATE TEMP TRIGGER reject_outbox BEFORE INSERT ON agent_studio_feishu_outbox
    BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END`)
  installFailure()
  expect(() => gui('retry')).toThrow('test outbox failure')
  expect(store.messages(assistant).items).toEqual([])
  expect(store.nextFeishu('one')).toBeUndefined()
  db.exec('DROP TRIGGER reject_outbox')
  expect(gui('retry').created).toBe(true)
  store.finishFeishu(store.nextFeishu('one')!.id, 'remote-message')
  store.addPending(pending('ask'))
  store.finishFeishu(store.nextFeishu('one')!.id, 'remote-card')
  installFailure()
  expect(() => store.settlePending('ask', 'resolved', 'First', 'gui')).toThrow('test outbox failure')
  expect(store.pendingItem('ask')?.state).toBe('pending')
  db.exec('DROP TRIGGER reject_outbox')
  expect(store.settlePending('ask', 'resolved', 'First', 'gui')?.state).toBe('resolved')
  expect(store.nextFeishu('one')).toMatchObject({ kind: 'pending-update', cardMessageId: 'remote-card' })
})

it('deduplicates GUI requests without rewriting their input or crossing conversations', () => {
  const original = gui('request', { text: '  original text  ', createdAt: 11 })
  expect(original.created).toBe(true)
  const duplicate = gui('request', { text: 'replacement', quoteId: 'missing', replyTo: 'missing', createdAt: 12 })
  expect(duplicate).toEqual({ message: original.message, created: false })
  expect(original.message).toMatchObject({ role: 'user', status: 'queued', text: '  original text  ', createdAt: 11 })
  expect(() => gui('request', { conversationId: 'different' })).toThrow('another conversation')
  expect(() => gui('empty', { text: '\n ' })).toThrow('non-blank text')
  expect(store.messages(assistant).items).toEqual([original.message])
  expect(store.messages('different').items).toEqual([])
})

it('keeps quotes independent of topics and validates parent and quote conversation boundaries', () => {
  const root = gui('root').message
  const unicode = gui('unicode', { text: 'a'.repeat(279) + '🦜 rest of message' }).message
  const outside = gui('different request', { conversationId: 'project' }).message
  const quoteOnly = gui('quote without reply', { quoteId: unicode.id }).message
  const reply = gui('reply', { quoteId: unicode.id, replyTo: root.id }).message
  const nested = gui('reply to reply', { replyTo: reply.id, quoteId: root.id }).message
  expect(quoteOnly).toMatchObject({ quote: { messageId: unicode.id, text: 'a'.repeat(279) } })
  expect(quoteOnly.topicId).toBeUndefined()
  expect(quoteOnly.replyTo).toBeUndefined()
  expect(reply).toMatchObject({ topicId: root.id, replyTo: root.id, quote: quoteOnly.quote })
  expect(nested).toMatchObject({ topicId: root.id, replyTo: reply.id, quote: { messageId: root.id, text: 'root' } })
  expect(store.message(assistant, root.id)?.replyCount).toBe(2)
  expect(store.message(assistant, reply.id)?.replyCount).toBe(0)
  expect(store.message('project', root.id)).toBeUndefined()
  expect(store.messages(assistant).items.map(message => message.id)).toEqual([root.id, unicode.id, quoteOnly.id])
  expect(store.messages(assistant, root.id).items.map(message => message.id)).toEqual([reply.id, nested.id])
  expect(store.messages('project', root.id).items).toEqual([])
  expect(() => gui('illegal-parent', { replyTo: outside.id })).toThrow('reply parent not found')
  expect(() => gui('illegal-quote', { quoteId: outside.id })).toThrow('quote not found')
  expect(() => gui('unknown-parent', { replyTo: 'missing' })).toThrow('reply parent not found')
})

it('pages main and topic timelines in ascending sequence below exclusive cursors', () => {
  const root = gui('root').message
  const main = [root]
  const topic = []
  for (let i = 0; i < STUDIO_PAGE_SIZE + 2; i++) {
    main.push(gui(`main-${i}`, { createdAt: 1000 - i }).message)
    topic.push(gui(`topic-${i}`, { replyTo: root.id }).message)
  }
  for (const [expected, topicId] of [[main, undefined], [topic, root.id]] as const) {
    const recent = store.messages(assistant, topicId)
    expect(recent.items.map(item => item.id)).toEqual(expected.slice(-STUDIO_PAGE_SIZE).map(item => item.id))
    expect(recent.next).toBe(recent.items[0]!.sequence)
    expect(store.messages(assistant, topicId, recent.next)).toMatchObject({ items: expected.slice(0, -STUDIO_PAGE_SIZE).map(
      ({ id }) => ({ id }),
    ) })
    expect(store.messages(assistant, topicId, recent.next).next).toBeUndefined()
  }
})

it('tracks turn lifecycle, stable native provenance, and replies across Session changes', () => {
  const root = gui('initial').message
  const input = gui('in topic', { replyTo: root.id }).message
  const nativeInput = { sessionId: 'old', eventSeq: 20 }
  const nativeOutput = { sessionId: 'replacement', eventSeq: 5 }
  const artifact = { title: 'Delivery', text: 'Result', source: { sessionId: 'worker', eventSeq: 19 } }
  store.setAssistantSession(nativeInput.sessionId)
  store.startMessage(input.id, nativeInput.sessionId)
  expect(store.message(assistant, input.id)?.status).toBe('running')
  expect(() => store.startMessage(input.id, 'replacement')).toThrow('not queued')
  store.recordMessageSource(input.id, nativeInput)
  store.recordMessageSource(input.id, nativeInput)
  expect(() => store.recordMessageSource(input.id, { ...nativeInput, eventSeq: 21 })).toThrow('already bound')
  store.setAssistantSession(nativeOutput.sessionId)
  const reply = store.addReply(input.id, 'visible response', nativeOutput, [artifact])
  expect(reply).toMatchObject({ conversationId: assistant, role: 'assistant', channel: 'studio', replyTo: input.id, topicId: root.id,
    source: nativeOutput, artifacts: [artifact] })
  expect(store.addReply(input.id, 'duplicate ignored', nativeOutput)).toEqual(reply)
  expect(() => store.addReply(root.id, 'misrouted native output', nativeOutput)).toThrow('belongs to another message')
  const mainOutput = store.addReply(root.id, 'main output')
  expect(mainOutput).toMatchObject({ replyTo: root.id })
  expect(mainOutput.topicId).toBeUndefined()
  expect(store.messages(assistant).items.map(item => item.id)).toEqual([root.id, mainOutput.id])
  expect(store.message(assistant, root.id)?.replyCount).toBe(2)
  store.finishMessage(input.id, 'completed')
  expect(store.message(assistant, input.id)).toMatchObject({ status: 'completed', source: nativeInput })
  expect(() => store.finishMessage(input.id, 'failed', 'late')).toThrow('not live')
  const project = gui('project request', { conversationId: 'project' }).message
  expect(store.addReply(project.id, 'leader output')).toMatchObject({ conversationId: 'project', role: 'leader', replyTo: project.id })
  store.finishMessage(project.id, 'failed', 'Could not start')
  expect(store.message('project', project.id)).toMatchObject({ status: 'failed', error: 'Could not start' })
})

it('finds immutable Session records through filtered, exclusive pages', () => {
  const records: StudioSessionRecord[] = []
  for (let i = 0; i < STUDIO_PAGE_SIZE + 3; i++) {
    const record: StudioSessionRecord = { id: `id-${i}`, conversationId: 'Alpha_%', role: 'leader', createdAt: 3 }
    records.unshift(record)
    store.registerSession(record)
  }
  store.registerSession({ id: 'unrelated', conversationId: assistant, role: 'assistant', createdAt: 4 })
  const original = records[0]!
  store.registerSession({ ...original, createdAt: 100 })
  expect(store.session(original.id)).toEqual(original)
  expect(() => store.registerSession({ ...original, conversationId: 'other' })).toThrow('different conversation or role')
  expect(() => store.registerSession({ ...original, role: 'advisor' })).toThrow('different conversation or role')
  expect(store.records('unRELATED').items).toMatchObject([{ id: 'unrelated' }])
  expect(store.records('ASSISTANT').items).toMatchObject([{ id: 'unrelated' }])
  const recent = store.records(' ALPHA_% ')
  expect(recent.items).toEqual(records.slice(0, STUDIO_PAGE_SIZE))
  expect(store.records('alpha_%', recent.next)).toEqual({ items: records.slice(STUDIO_PAGE_SIZE) })
  expect(store.records('no match')).toEqual({ items: [] })

  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-session-migration-'))
  const path = join(directory, 'studio.sqlite')
  const historical: StudioSessionRecord[] = (['document-worker', 'draft-worker', 'advisor'] as const).map(role => ({
    id: `former-${role}`, conversationId: assistant, role, createdAt: 11,
  }))
  let managed: ManagedWorkerStore | undefined
  try {
    const legacy = new DatabaseSync(path)
    try {
      const writer = new StudioStore(legacy, assertActive)
      for (const record of historical) writer.registerSession(record)
    } finally { legacy.close() }
    managed = new ManagedWorkerStore(path)
    managed.registerSession('current-worker', 'worker', null, null)
    expect(managed.studio.records().items).toEqual([
      { id: 'current-worker', conversationId: assistant, role: 'worker', createdAt: expect.any(Number) },
      ...historical.toReversed().map(record => ({ ...record, readonlyLegacy: true })),
    ])
    for (const record of historical) {
      expect(managed.studio.session(record.id)).toEqual({ ...record, readonlyLegacy: true })
      expect(() => managed!.registerSession(record.id, 'worker', null, null)).toThrow('different binding')
    }
  } finally {
    managed?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('prioritizes pending items, pages history, and settles each item only once', () => {
  const open: StudioPending[] = []
  const history: StudioPending[] = []
  for (let i = 0; i < STUDIO_PAGE_SIZE + 3; i++) {
    open.unshift(store.addPending(pending(`open-${i}`)))
    const item = store.addPending(pending(`closed-${i}`, { conversationId: 'project', kind: 'confirmation' }))
    history.unshift(store.settlePending(item.id, i % 2 ? 'resolved' : 'expired', i % 2 ? 'First' : undefined, i % 2 ? 'feishu' : undefined)!)
  }
  const first = store.pending()
  expect(first.items).toEqual(open.slice(0, STUDIO_PAGE_SIZE))
  const second = store.pending(first.next)
  expect(second.items).toEqual([...open.slice(STUDIO_PAGE_SIZE), ...history].slice(0, STUDIO_PAGE_SIZE))
  const third = store.pending(second.next)
  expect(third).toEqual({ items: history.slice(STUDIO_PAGE_SIZE - 3) })
  expect(store.pendingCount()).toBe(open.length)
  const closed = history[0]!
  expect(store.settlePending(closed.id, 'resolved', 'An unauthorized overwrite', 'gui')).toBeUndefined()
  expect(store.settlePending('unknown', 'resolved')).toBeUndefined()
  expect(store.addPending(pending(closed.id, { conversationId: 'project' }))).toEqual(closed)
  expect(store.pendingItem(closed.id)).toEqual(closed)
  expect(() => store.addPending(pending(closed.id))).toThrow('another conversation')
})

it('mirrors only new Assistant GUI input and visible Assistant responses, preserving exact Feishu parent IDs', () => {
  const before = gui('prebinding', { createdAt: 1 }).message
  store.addPending(pending('prebinding-card', { createdAt: 1 }))
  expect(store.activateFeishu('one', 100)).toBe(100)
  expect(store.activateFeishu('one', 300)).toBe(100)
  expect(store.nextFeishu('one')).toBeUndefined()
  const oldImport = gui('late history', { createdAt: 99 }).message
  const orphan = gui('reply to prebinding input', { replyTo: before.id }).message
  const remote = feishu('one', 'native-user-id', 101).message
  expect(remote.feishuDelivery).toBeUndefined()
  expect(feishu('one', 'native-user-id', 102)).toEqual({ message: remote, created: false })
  expect(() => feishu('one', 'prebind-inbound', 100)).toThrow('not newer')
  expect(() => feishu('two', 'wrong scope', 300)).toThrow('active Assistant binding')
  store.addReply(remote.id, '  ')
  const withText = store.addReply(remote.id, 'assistant text with source', { sessionId: 's', eventSeq: 3 })
  const project = gui('project', { conversationId: 'project' }).message
  store.addReply(project.id, 'leader text stays in Studio')
  const user = gui('Assistant GUI input').message
  expect(store.nextFeishu('two')).toBeUndefined()
  const assistantSend = store.nextFeishu('one')!
  expect(assistantSend).toMatchObject({ kind: 'message', text: 'assistant text with source', channel: 'studio', parentId: 'native-user-id' })
  store.finishFeishu(assistantSend.id, 'assistant-remote')
  const userSend = store.nextFeishu('one')!
  expect(userSend).toMatchObject({ kind: 'message', channel: 'gui', text: 'Assistant GUI input' })
  expect(userSend.parentId).toBeUndefined()
  store.finishFeishu(userSend.id, 'gui-remote')
  expect(store.nextFeishu('one')).toBeUndefined()
  expect(store.feishuMessage('one', 'assistant-remote')).toMatchObject({ id: withText.id, feishuDelivery: 'sent' })
  expect(store.feishuMessage('one', 'gui-remote')?.id).toBe(user.id)
  expect(store.feishuMessage('one', 'native-user-id')?.id).toBe(remote.id)
  expect(store.feishuMessage('two', 'native-user-id')).toBeUndefined()
  expect(store.message(assistant, oldImport.id)?.feishuDelivery).toBeUndefined()
  expect(store.message(assistant, orphan.id)?.feishuDelivery).toBe('unconfirmed')
})

it('waits for claimed parent messages, allows independent work, and never flattens an uncertain reply', () => {
  store.activateFeishu('one', 100)
  const root = gui('root').message
  const child = gui('child', { replyTo: root.id }).message
  const grandchild = gui('grandchild', { replyTo: child.id }).message
  gui('independent')
  const parentSend = store.nextFeishu('one')!
  expect(parentSend).toMatchObject({ text: 'root' })
  const independent = store.nextFeishu('one')!
  expect(independent).toMatchObject({ text: 'independent' })
  expect(store.nextFeishu('one')).toBeUndefined()
  store.finishFeishu(parentSend.id, 'root-remote')
  const childSend = store.nextFeishu('one')!
  expect(childSend).toMatchObject({ text: 'child', parentId: 'root-remote' })
  expect(store.nextFeishu('one')).toBeUndefined()
  store.finishFeishu(childSend.id)
  store.finishFeishu(childSend.id, 'late-child-remote')
  store.finishFeishu(independent.id, 'root-remote') // Conflicting receipts also remain unconfirmed.
  expect(store.nextFeishu('one')).toBeUndefined()
  expect(store.feishuMessage('one', 'late-child-remote')).toBeUndefined()
  expect(store.feishuMessage('one', 'root-remote')?.id).toBe(root.id)
  for (const message of [child, grandchild]) expect(store.message(assistant, message.id)?.feishuDelivery).toBe('unconfirmed')
})

it('resolves exact native messages and first-observed Feishu thread IDs to their Studio roots', () => {
  store.activateFeishu('one', 100)
  const root = gui('gui root').message
  store.finishFeishu(store.nextFeishu('one')!.id, 'remote-root')
  const first = feishu('one', 'native-reply', 101, 'opaque-thread', root.id).message
  const next = feishu('one', 'native-followup', 102, 'opaque-thread').message
  expect(first).toMatchObject({ topicId: root.id, replyTo: root.id })
  expect(next).toMatchObject({ topicId: root.id, replyTo: root.id })
  expect(store.feishuMessage('one', 'native-reply')?.id).toBe(first.id)
  for (const target of ['opaque-thread', 'remote-root', 'native-reply']) expect(store.feishuThread('one', target)?.id).toBe(root.id)
  expect(store.feishuThread('one', 'unknown')).toBeUndefined()
})

it('retires outbox work and remote mappings when binding changes, even if an old scope returns', () => {
  store.activateFeishu('one', 100)
  const oldRemote = feishu('one', 'same-remote-id', 101, 'old-thread').message
  store.addPending(pending('old-project', { conversationId: 'project' }))
  store.finishFeishu(store.nextFeishu('one')!.id, 'old-project-card')
  const claimed = gui('old claimed').message
  const inFlight = store.nextFeishu('one')!
  const queued = gui('old queued').message
  expect(store.activateFeishu('two', 102)).toBe(102)
  store.finishFeishu(inFlight.id, 'late-receipt')
  expect(store.message(assistant, claimed.id)?.feishuDelivery).toBe('unconfirmed')
  expect(store.message(assistant, queued.id)?.feishuDelivery).toBe('unconfirmed')
  expect(store.feishuMessage('one', 'late-receipt')).toBeUndefined()
  expect(store.feishuMessage('one', 'same-remote-id')).toBeUndefined()
  expect(store.feishuQuestion('one', 'old-project-card')).toBeUndefined()
  expect(store.nextFeishu('two')).toBeUndefined()
  const currentRemote = feishu('two', 'same-remote-id', 103).message
  expect(currentRemote.id).not.toBe(oldRemote.id)
  expect(store.feishuMessage('two', 'same-remote-id')?.id).toBe(currentRemote.id)
  const crossScope = store.addReply(oldRemote.id, 'must not leak across binding')
  expect(store.nextFeishu('two')).toBeUndefined()
  expect(store.message(assistant, crossScope.id)?.feishuDelivery).toBe('unconfirmed')
  expect(store.activateFeishu('one', 104)).toBe(104)
  expect(store.feishuMessage('one', 'same-remote-id')).toBeUndefined()
  expect(store.feishuThread('one', 'old-thread')).toBeUndefined()
  expect(store.feishuQuestion('one', 'old-project-card')).toBeUndefined()
  expect(feishu('one', 'same-remote-id', 101)).toEqual({ message: oldRemote, created: false })
  expect(store.settlePending('old-project', 'resolved', 'done', 'gui')?.state).toBe('resolved')
  expect(store.nextFeishu('one')).toBeUndefined()
})

it('retires a disabled or differently configured binding without queuing work in the unbound window', () => {
  store.activateFeishu('one', 100)
  const input = feishu('one', 'old-inbound', 101).message
  store.deactivateFeishu('one')
  expect(store.activateFeishu('one', 500)).toBe(100)
  expect(store.feishuMessage('one', 'old-inbound')?.id).toBe(input.id)
  const claimed = gui('old claim').message
  const delivery = store.nextFeishu('one')!
  const queued = gui('old queue').message
  store.deactivateFeishu('different-config')
  const unbound = gui('unbound window').message
  store.addPending(pending('unbound-card'))
  expect(store.feishuMessage('one', 'old-inbound')).toBeUndefined()
  expect(store.nextFeishu('one')).toBeUndefined()
  expect(() => feishu('one', 'not-bound', 502)).toThrow('active Assistant binding')
  store.finishFeishu(delivery.id, 'late-receipt')
  expect(store.activateFeishu('one', 600)).toBe(600)
  expect(store.nextFeishu('one')).toBeUndefined()
  expect(store.feishuMessage('one', 'old-inbound')).toBeUndefined()
  expect(store.message(assistant, unbound.id)?.feishuDelivery).toBeUndefined()
  expect(store.message(assistant, claimed.id)?.feishuDelivery).toBe('unconfirmed')
  expect(store.message(assistant, queued.id)?.feishuDelivery).toBe('unconfirmed')
  store.deactivateFeishu()
  expect(store.activateFeishu('one', 700)).toBe(700)
})

it('sends project pending cards and patches only the exact confirmed card for each decision', () => {
  store.activateFeishu('one', 10)
  const initial = store.addPending(pending('project-approval', { kind: 'confirmation', conversationId: 'project', taskId: 'task',
    messageId: 'project-message', mobile: 'card', acceptsText: false }))
  const card = store.nextFeishu('one')!
  expect(card).toMatchObject({ kind: 'pending', pending: initial })
  expect(card.parentId).toBeUndefined()
  expect(store.feishuQuestion('one', 'remote-card')).toBeUndefined()
  const resolved = store.settlePending(initial.id, 'resolved', 'First', 'feishu')
  expect(resolved).toMatchObject({ state: 'resolved', answeredBy: 'feishu', answer: 'First' })
  expect(store.nextFeishu('one')).toBeUndefined()
  store.finishFeishu(card.id, 'remote-card')
  expect(store.feishuQuestion('one', 'remote-card')).toEqual(resolved)
  expect(store.feishuQuestion('two', 'remote-card')).toBeUndefined()
  const patch = store.nextFeishu('one')!
  expect(patch).toMatchObject({ kind: 'pending-update', cardMessageId: 'remote-card', pending: resolved })
  expect(patch.parentId).toBeUndefined()
  store.finishFeishu(patch.id, 'remote-card')
  expect(store.settlePending(initial.id, 'expired')).toBeUndefined()
  expect(store.nextFeishu('one')).toBeUndefined()
  expect(store.feishuQuestion('one', 'remote-card')).toEqual(resolved)
})

it('renders an expired card directly if its initial send was never claimed', () => {
  store.activateFeishu('one', 10)
  store.addPending(pending('offline'))
  expect(store.settlePending('offline', 'expired')?.state).toBe('expired')
  const card = store.nextFeishu('one')!
  expect(card).toMatchObject({ kind: 'pending', pending: { id: 'offline', state: 'expired' } })
  store.finishFeishu(card.id, 'remote-expired')
  expect(store.feishuQuestion('one', 'remote-expired')?.state).toBe('expired')
  expect(store.nextFeishu('one')).toBeUndefined()
})

it('recovers a reopened database without replaying claimed sends, live turns, or volatile approvals', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-store-'))
  const path = join(directory, 'studio.sqlite')
  let persisted = new DatabaseSync(path)
  try {
    store = new StudioStore(persisted, assertActive)
    store.setAssistantSession('remembered')
    store.activateFeishu('one', 10)
    store.addPending(pending('question'))
    store.finishFeishu(store.nextFeishu('one')!.id, 'remote-question')
    store.addPending(pending('confirmation', { kind: 'confirmation', mobile: 'card' }))
    const unconfirmedCard = store.nextFeishu('one')!
    store.addPending(pending('durable-block', { kind: 'blocked', mobile: 'unsupported' }))
    store.finishFeishu(store.nextFeishu('one')!.id, 'remote-durable-block')
    const running = gui('running').message
    store.startMessage(running.id, 'remembered')
    const unconfirmedMessage = store.nextFeishu('one')!
    const queued = gui('queued').message
    const complete = feishu('one', 'already-completed', 15).message
    store.finishMessage(complete.id, 'completed')

    persisted.close()
    persisted = new DatabaseSync(path)
    store = new StudioStore(persisted, assertActive)
    store.recover()
    store.recover()
    expect(store.assistantSession()).toBe('remembered')
    expect(store.activateFeishu('one', 20)).toBe(10)
    expect(store.message(assistant, running.id)).toMatchObject({ status: 'interrupted', feishuDelivery: 'unconfirmed' })
    expect(store.message(assistant, queued.id)).toMatchObject({ status: 'interrupted', feishuDelivery: 'pending' })
    expect(store.message(assistant, complete.id)?.status).toBe('completed')
    expect(feishu('one', 'already-completed', 15).created).toBe(false)
    expect(store.pendingItem('confirmation')?.state).toBe('expired')
    expect(store.pendingItem('question')?.state).toBe('expired')
    expect(store.pendingItem('durable-block')?.state).toBe('pending')
    expect(store.openBlockers()).toMatchObject([{ id: 'durable-block', state: 'pending' }])
    expect(store.pendingCount()).toBe(1)
    store.finishFeishu(unconfirmedCard.id, 'late-card')
    store.finishFeishu(unconfirmedMessage.id, 'late-message')
    expect(store.feishuQuestion('one', 'late-card')).toBeUndefined()
    expect(store.feishuMessage('one', 'late-message')).toBeUndefined()
    const restoredQueue = store.nextFeishu('one')!
    expect(restoredQueue).toMatchObject({ kind: 'message', text: 'queued' })
    store.finishFeishu(restoredQueue.id, 'remote-queued')
    const expiryUpdate = store.nextFeishu('one')!
    expect(expiryUpdate).toMatchObject({ kind: 'pending-update', cardMessageId: 'remote-question', pending: { state: 'expired' } })
    store.finishFeishu(expiryUpdate.id, 'remote-question')
    expect(store.nextFeishu('one')).toBeUndefined()
  } finally {
    persisted.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
