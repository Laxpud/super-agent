/** Project Studio ownership out of the browser's Workspace catalog, not out of the Host index. */
import { isStudioInternalSession } from '../studio/protocol.ts'

export interface WorkspaceCatalogSnapshot {
  ids: readonly string[]
  byId: Readonly<Record<string, unknown>>
  phase?: unknown
  projectionsBySession?: unknown
}
interface SnapshotStore {
  getSnapshot(): WorkspaceCatalogSnapshot
  set(value: WorkspaceCatalogSnapshot): void
}
export interface WorkspaceVisibility { update(ids: readonly string[]): void; dispose(): void }

export function visibleWorkspaceCatalog<T extends WorkspaceCatalogSnapshot>(snapshot: T, adopted: ReadonlySet<string>): T {
  const hidden = (id: string) => isStudioInternalSession(id) || adopted.has(id)
  const ids = snapshot.ids.filter(id => !hidden(id))
  const entries = Object.entries(snapshot.byId).filter(([id]) => !hidden(id))
  if (ids.length === snapshot.ids.length && entries.length === Object.keys(snapshot.byId).length) return snapshot
  // Other native projections and metadata retain the exact values the Controller published.
  return { ...snapshot, ids, byId: Object.fromEntries(entries) }
}

/**
 * rc.5 的 Workspace Browser 没有单独的过滤扩展点。限制改动到浏览器 Session 列表的发布边界，
 * 保留同一个 observable、订阅与快照生命周期；不会归档、删除、改写身份或改变已存日志。
 * 只适配带可写 set 和读快照的实例，卸载时恢复该实例原本的发布方法。
 */
export function installWorkspaceVisibility(candidate: unknown): WorkspaceVisibility | undefined {
  if (!candidate || typeof candidate !== 'object') return
  const store = candidate as Partial<SnapshotStore>
  if (typeof store.getSnapshot !== 'function' || typeof store.set !== 'function') return
  const descriptor = Object.getOwnPropertyDescriptor(store, 'set')
  if (!descriptor || !('value' in descriptor) || !descriptor.writable) return
  const set = store.set
  let raw = store.getSnapshot()
  if (!Array.isArray(raw?.ids) || !raw.byId || typeof raw.byId !== 'object') return
  let adopted: ReadonlySet<string> = new Set()
  let dropped = false
  const project = () => { set.call(store, visibleWorkspaceCatalog(raw, adopted)) }
  const publish = (next: WorkspaceCatalogSnapshot) => {
    if (dropped) { set.call(store, next); return }
    // ClientSessions 的保留计数更新复用已投影快照的 ids。只合并这次可见更新，避免卸载或改筛选时丢失原行。
    const shown = store.getSnapshot!()
    if (next.ids === shown.ids && next.phase === shown.phase && next.projectionsBySession === shown.projectionsBySession && raw !== shown) {
      raw = { ...next, ids: raw.ids, byId: { ...raw.byId, ...next.byId } }
    }
    else raw = next
    project()
  }
  Object.defineProperty(store, 'set', { ...descriptor, value: publish })
  if (store.set !== publish) return
  project()
  return {
    update(ids) {
      if (dropped || (ids.length === adopted.size && ids.every(id => adopted.has(id)))) return
      adopted = new Set(ids)
      project()
    },
    dispose() {
      dropped = true
      if (store.set !== publish) return
      Object.defineProperty(store, 'set', descriptor)
      set.call(store, raw)
    },
  }
}
