import { describe, expect, it, vi } from 'vitest'
import { installWorkspaceVisibility, visibleWorkspaceCatalog } from '../src/studio-web/workspaces.ts'

const implicit = 'agent-studio-11000000-2222-4333-8444-555555555555'
const adopted = 'older-managed-session'
const ordinary = 'user-session'
const similar = 'agent-studio-not-a-studio-id'

function nativeSnapshot() {
  const ids = [implicit, adopted, ordinary, similar]
  return { ids, byId: Object.fromEntries(ids.map((id, index) => [id, { id, index }])), phase: 'ready', projectionsBySession: {} }
}

describe('Agent Studio Workspace visibility', () => {
  it('filters implicit and bound Sessions from both grouped and flat inputs without modifying the native snapshot', () => {
    const source = nativeSnapshot()
    const projected = visibleWorkspaceCatalog(source, new Set([adopted]))
    expect(projected.ids).toEqual([ordinary, similar])
    expect(Object.keys(projected.byId)).toEqual([ordinary, similar])
    expect(projected.byId[ordinary]).toBe(source.byId[ordinary])
    expect(projected.projectionsBySession).toBe(source.projectionsBySession)
    expect(source.ids).toEqual([implicit, adopted, ordinary, similar])
    expect(source.byId[implicit]).toBeDefined()
  })

  it('applies before catalog additions, handles ownership updates, and publishes its unfiltered snapshot on teardown', () => {
    const initial = nativeSnapshot()
    let value = initial
    const set = vi.fn((next: typeof initial) => { value = next })
    const store = { getSnapshot: () => value, set }
    const visibility = installWorkspaceVisibility(store)!
    expect(value.ids).toEqual([adopted, ordinary, similar])
    visibility.update([adopted])
    expect(value.ids).toEqual([ordinary, similar])
    // Native retention changes update byId against the currently published list; the hidden canonical rows must survive.
    store.set({ ...value, byId: { ...value.byId, [ordinary]: { id: ordinary, index: 10 } } })
    visibility.update([])
    expect(value.ids).toEqual([adopted, ordinary, similar])
    expect(value.byId[ordinary]?.index).toBe(10)
    const newest = nativeSnapshot()
    store.set(newest)
    expect(value.ids).toEqual([adopted, ordinary, similar])
    visibility.dispose()
    expect(store.set).toBe(set)
    expect(value).toBe(newest)
  })

  it('does not replace unknown or immutable catalog implementations', () => {
    const read = () => ({ ids: [], byId: {} })
    expect(installWorkspaceVisibility({ getSnapshot: read })).toBeUndefined()
    expect(installWorkspaceVisibility(Object.freeze({ getSnapshot: read, set: () => {} }))).toBeUndefined()
  })
})
