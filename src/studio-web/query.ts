/** 查看的请求可取消；由调用方选择需要持续刷新的最新页。 */
import { useSyncExternalStore } from 'react'

export interface QuerySnapshot<T> { data?: T; failure?: unknown }
export interface StudioQuery<T> {
  getSnapshot: () => QuerySnapshot<T>
  subscribe: (listener: () => void) => () => void
  reload: () => void
}

/** 同一个查询共用一个请求；失去最后一个订阅者时停止轮询。 */
export function createQuery<T>(load: (signal: AbortSignal) => Promise<T>, interval?: number): StudioQuery<T> {
  const listeners = new Set<() => void>()
  let snapshot: QuerySnapshot<T> = {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let refreshQueued = false
  const publish = (value: QuerySnapshot<T>) => {
    snapshot = value
    for (const listener of listeners) listener()
  }
  const run = async () => {
    if (!listeners.size) return
    clearTimeout(timer)
    const controller = request = new AbortController()
    try {
      const data = await load(controller.signal)
      if (!controller.signal.aborted && !refreshQueued) publish({ data })
    } catch (failure) {
      if (!controller.signal.aborted && !refreshQueued) publish({ ...snapshot, failure })
    } finally {
      if (!controller.signal.aborted) {
        request = undefined
        if (refreshQueued) {
          refreshQueued = false
          void start()
        } else if (interval !== undefined && listeners.size) {
          timer = setTimeout(start, document.hidden ? interval * 4 : interval)
        }
      }
    }
  }
  const start = () => { if (!request) void run() }
  const visibility = () => { if (!document.hidden) start() }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      const first = listeners.size === 0
      listeners.add(listener)
      if (first) {
        if (interval !== undefined) document.addEventListener('visibilitychange', visibility)
        start()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          clearTimeout(timer)
          request?.abort()
          request = undefined
          refreshQueued = false
          if (interval !== undefined) document.removeEventListener('visibilitychange', visibility)
        }
      }
    },
    reload() {
      // 丢弃写入完成前发出的旧快照；合并多个刷新请求，等这一轮结束再读。
      if (request) refreshQueued = true
      else start()
    },
  }
}

export function useQuery<T>(query: StudioQuery<T>) {
  return useSyncExternalStore(query.subscribe, query.getSnapshot, query.getSnapshot)
}

/** 拒绝服务端发回的无效或已访问过的分页游标。游标本身不用于客户端推算。 */
export function nextPage(cursors: readonly number[], next: number | undefined): number | undefined {
  return typeof next === 'number' && Number.isSafeInteger(next) && next >= 0 && !cursors.includes(next) ? next : undefined
}
