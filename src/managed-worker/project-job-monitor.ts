/** Check already attached external jobs without keeping an Agent alive, and consume explicit continuation permits. */
import { setTimeout as delay } from 'node:timers/promises'
import type { StudioJobAuto } from './project-store.ts'
import type { ManagedWorkerStore } from './store.ts'
import { observeSystemdJob } from './systemd-job.ts'

/** A serial, bounded watcher. At most one automatic Worker is active, independent of other checks. */
export class StudioProjectJobMonitor {
  private watchCursor: string | undefined
  private dispatchCursor: string | undefined
  private running: Promise<void> | undefined

  constructor(private readonly store: ManagedWorkerStore, private readonly intervalMs: number,
    private readonly allowed: () => boolean, private readonly resume: (permit: StudioJobAuto, signal: AbortSignal) => Promise<void> | undefined,
    private readonly onError: () => void) {}

  /** The Host aborts pending queries and drains any Worker owned by this monitor before closing the Store. */
  async run(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        // The delay follows each bounded batch. Slow manager queries never create overlapping timers or unbounded work.
        try {
          await delay(this.intervalMs, undefined, { signal, ref: false })
          if (!signal.aborted && this.allowed()) await this.poll(signal)
        } catch {
          if (!signal.aborted) this.onError()
        }
      }
    } finally { await this.running }
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const store = this.store.projects
    let watched = store.jobWatchBatch(this.watchCursor)
    if (this.watchCursor && watched.ok && !watched.value.length) {
      this.watchCursor = undefined
      watched = store.jobWatchBatch()
    }
    if (!watched.ok) return
    for (const job of watched.value) {
      if (signal.aborted || !this.allowed()) return
      this.watchCursor = job.workId
      const state = await observeSystemdJob(job.ref, signal)
      if (signal.aborted || !this.allowed()) return
      // Another observation may already have committed. An old check cannot overwrite it or change owner authority.
      store.observeWatchedJob(job.workId, job.ref, job.observationVersion, state)
    }

    if (this.running || signal.aborted || !this.allowed()) return
    let candidates = store.jobAutoBatch(this.dispatchCursor)
    if (this.dispatchCursor && candidates.ok && !candidates.value.length) {
      this.dispatchCursor = undefined
      candidates = store.jobAutoBatch()
    }
    if (!candidates.ok) return
    for (const permit of candidates.value) {
      if (signal.aborted || !this.allowed()) return
      this.dispatchCursor = permit.workId
      const attempt = this.resume(permit, signal)
      if (!attempt) continue
      // A launch claims a durable permit before any await. A pre-start failure is visible in its dispatch and does not rearm it.
      this.running = attempt.catch(() => { if (!signal.aborted) this.onError() })
        .finally(() => { this.running = undefined })
      return
    }
  }
}
