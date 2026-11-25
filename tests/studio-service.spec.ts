import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ManagedWorkerStore } from '../src/managed-worker/store.ts'
import { StudioPendingBroker } from '../src/studio/pending.ts'
import { ASSISTANT_CONVERSATION } from '../src/studio/protocol.ts'
import { StudioService } from '../src/studio/service.ts'

const assistant = ASSISTANT_CONVERSATION
const scope = 'verified-fixture-inbox'
const fixtures: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup() })

function fixture() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'agent-studio-service-'))
  const domain = new ManagedWorkerStore(join(path, 'studio.sqlite'))
  const stop = new AbortController()
  const { signal } = stop
  const fakeHost = { on: () => () => {} } as unknown as Context
  const service = new StudioService(fakeHost, domain, path, { assistant: null, leader: null }, () => true, signal, () => 'online', () => {})
  // Keep native execution out of this transport test. The installed-Host smoke independently exercises Agent admission and results.
  const enqueue = vi.spyOn(service.sessions, 'enqueue').mockImplementation(() => {})
  fixtures.push(async () => {
    stop.abort()
    await service.sessions.drain()
    try { domain.finishRun() } finally { domain.close() }
    if (realpathSync(path) !== path) throw new Error('Refusing to clean up a different fixture path')
    rmSync(path, { recursive: true, force: true })
  })
  const api = service.operations
  return { domain, store: domain.studio, service, enqueue, signal, api,
    send: (requestId: string, text: string, replyTo?: string) => api.send({ conversationId: assistant, requestId, text, ...(replyTo ? { replyTo } : {}) }, signal),
    timeline: (topicId?: string) => api.timeline({ conversationId: assistant, ...(topicId ? { topicId } : {}) }, signal),
    receive: (id: string, text: string, parentId?: string) => service.feishu.receive({ scope, id, text, sourceTimeMs: Date.now() + 10,
      ...(parentId ? { parentId } : {}) }, signal) }
}

describe('Studio owner conversation and Feishu port', () => {
  it('shares one timeline in both directions, binds native parents to one topic, and never replays prebinding history', async () => {
    const f = fixture()
    const old = await f.send('gui-old', 'Existing unbound history')
    f.store.addReply(old.id, 'Old Assistant answer')
    f.store.finishMessage(old.id, 'completed')
    f.service.feishu.activate(scope, Date.now())
    expect(f.service.feishu.next(scope)).toBeUndefined()

    const base = await f.send('gui-root', 'New from GUI')
    const mirrored = f.service.feishu.next(scope)!
    expect(mirrored).toMatchObject({ kind: 'message', text: 'New from GUI', channel: 'gui' })
    f.service.feishu.finish(mirrored.id, 'om_root')
    await f.receive('om_followup', 'Continue in this topic from Feishu', 'om_root')
    await f.receive('om_followup', 'Duplicate must not rerun', 'om_root')
    const [inbound] = (await f.timeline(base.id)).items
    expect(inbound).toMatchObject({ topicId: base.id, replyTo: base.id, channel: 'feishu', text: 'Continue in this topic from Feishu' })
    expect(f.enqueue).toHaveBeenCalledTimes(3)

    const response = f.store.addReply(inbound!.id, 'Assistant response in the shared topic')
    f.store.finishMessage(inbound!.id, 'completed')
    const delivery = f.service.feishu.next(scope)!
    expect(delivery).toMatchObject({ parentId: 'om_followup', channel: 'studio', text: response.text })
    f.service.feishu.finish(delivery.id, 'om_assistant')
    await f.send('gui-topic', 'GUI continues the same topic', response.id)
    expect(f.service.feishu.next(scope)).toMatchObject({ channel: 'gui', parentId: 'om_assistant' })
    expect((await f.timeline()).items.map(item => item.text)).toEqual(['Existing unbound history', 'Old Assistant answer', 'New from GUI'])
    expect((await f.timeline(base.id)).items.map(item => item.channel)).toEqual(['feishu', 'studio', 'gui'])
  })

  it('answers only an exact live item and updates its original card across channels', async () => {
    const f = fixture()
    f.service.feishu.activate(scope, Date.now())
    const owner = await f.send('gui-confirm', 'Create a project with my confirmation.')
    f.service.feishu.finish(f.service.feishu.next(scope)!.id, 'om_owner')
    const broker = new StudioPendingBroker(f.store, () => {})
    vi.spyOn(f.service.sessions, 'answer').mockImplementation((id, value, channel, via) => broker.answer(id, value, channel, via))
    const waiting = broker.ask(owner, 'Assistant', { kind: 'confirmation', title: 'Create project?', detail: 'Exact objective',
      options: ['Create project', 'Not now'], acceptsText: false, mobile: 'card' }, f.signal, () => true)
    const notify = f.service.feishu.next(scope)!
    expect(notify.kind).toBe('pending')
    expect(notify.parentId).toBeUndefined()
    f.service.feishu.finish(notify.id, 'om_card')
    const id = notify.pending!.id
    await f.receive('om_plain_ok', '好', 'om_card')
    expect(f.store.pendingItem(id)?.state).toBe('pending')
    expect(f.service.feishu.answer({ scope, messageId: 'om_card', pendingId: 'other', value: 'Create project' })).toBe(false)
    expect(f.service.feishu.answer({ scope: 'unbound', messageId: 'om_card', pendingId: id, value: 'Create project' })).toBe(false)
    await f.receive('om_approve', '批准', 'om_card')
    await expect(waiting).resolves.toBe('Create project')
    expect(() => f.api.answer({ id, value: 'Create project' }, f.signal)).toThrow('already been handled')
    expect(f.service.feishu.answer({ scope, messageId: 'om_card', pendingId: id, value: 'Create project' })).toBe(false)
    const refusal = f.service.feishu.next(scope)!
    expect(refusal.text).toContain('仍待确认')
    f.service.feishu.finish(refusal.id, 'om_not_approval')
    expect(f.service.feishu.next(scope)).toMatchObject({ kind: 'pending-update', cardMessageId: 'om_card',
      pending: { state: 'resolved', answeredBy: 'feishu' } })
  })

  it('expires or patches the same question card when the GUI settles its exact waiter', async () => {
    const f = fixture()
    f.service.feishu.activate(scope, Date.now())
    const owner = await f.send('gui-question', 'Help me understand the results.')
    f.service.feishu.finish(f.service.feishu.next(scope)!.id, 'om_question_anchor')
    const broker = new StudioPendingBroker(f.store, () => {})
    const request = new AbortController()
    vi.spyOn(f.service.sessions, 'answer').mockImplementation((id, value, channel, via) => broker.answer(id, value, channel, via))
    const fields = { kind: 'question', title: 'What unit?', detail: 'Supply the unit to continue.', options: [],
      acceptsText: true, mobile: 'topic' } as const
    const waiting = broker.ask(owner, 'Assistant', { ...fields, options: [] }, request.signal, () => true)
    const card = f.service.feishu.next(scope)!
    f.service.feishu.finish(card.id, 'om_question_card')
    // A reply to another message inside the card's thread is not a direct answer.
    await f.service.feishu.receive({ scope, id: 'om_nested', text: 'Do not accept this', sourceTimeMs: Date.now() + 10,
      rootId: 'om_question_card', parentId: 'om_a_different_message' }, f.signal)
    expect(f.store.pendingItem(card.pending!.id)?.state).toBe('pending')
    expect(await f.api.answer({ id: card.pending!.id, value: 'metres' }, f.signal)).toMatchObject({ answeredBy: 'gui', answer: 'metres' })
    await expect(waiting).resolves.toBe('metres')
    const patch = f.service.feishu.next(scope)!
    expect(patch).toMatchObject({ kind: 'pending-update', cardMessageId: 'om_question_card', pending: { state: 'resolved', answer: 'metres' } })
    f.service.feishu.finish(patch.id, 'om_question_card')

    const expired = broker.ask(owner, 'Assistant', { ...fields, options: [] }, request.signal, () => true)
    const expiredCard = f.service.feishu.next(scope)!
    f.service.feishu.finish(expiredCard.id, 'om_expiring_card')
    request.abort()
    await expect(expired).rejects.toThrow('no longer waiting')
    expect(f.service.feishu.next(scope)).toMatchObject({ kind: 'pending-update', cardMessageId: 'om_expiring_card', pending: { state: 'expired' } })
  })

  it('routes a durable project block to the exact task and records the owner clearance without dispatching', async () => {
    const f = fixture()
    const created = f.domain.projects.create({ commandId: 'create-test-project', leaderSessionId: 'exact-leader', name: 'Source review', objective: 'Verify the source' })
    if (!created.ok) throw Error(created.reason)
    const added = f.domain.projects.recordWork({ leaderSessionId: 'exact-leader', sourceMessageId: 'source-1', sourceRequestId: 'request-1', requestText: 'Prepare an annotated copy.' })
    if (!added.ok) throw Error(added.reason)
    f.service.feishu.activate(scope, Date.now())
    const block = f.domain.projects.blockWork('exact-leader', added.value.work.workId, 'Missing source', 'Owner provides the source', 'block-test-project')
    if (!block.ok) throw Error(block.reason)
    const [item] = (await f.api.pending({}, f.signal)).items
    expect(item).toMatchObject({ kind: 'blocked', state: 'pending', mobile: 'unsupported', conversationId: created.value.projectId,
      taskId: added.value.work.workId, recordSessionId: 'exact-leader' })
    expect(f.service.feishu.next(scope)).toMatchObject({ kind: 'pending', pending: { id: item!.id, mobile: 'unsupported' } })
    const settled = await f.api.answer({ id: item!.id, value: 'The source is now verified.' }, f.signal)
    expect(settled).toMatchObject({ state: 'resolved', answeredBy: 'gui' })
    expect(f.enqueue).not.toHaveBeenCalled()
    expect((await f.api.state({}, f.signal)).pendingCount).toBe(0)
    expect(() => f.api.answer({ id: item!.id, value: 'Try the same stale block again.' }, f.signal)).toThrow('no longer waiting')
  })

  it('lists pending work from the private chat without waking a native Session', async () => {
    const f = fixture()
    f.service.feishu.activate(scope, Date.now())
    await f.receive('om_pending', '还有什么待我处理？')
    expect(f.enqueue).not.toHaveBeenCalled()
    expect((await f.timeline()).items.map(item => item.text)).toEqual(['还有什么待我处理？', '目前没有待你处理的事项。'])
    expect(f.service.feishu.next(scope)).toMatchObject({ parentId: 'om_pending', text: '目前没有待你处理的事项。' })
  })
})
