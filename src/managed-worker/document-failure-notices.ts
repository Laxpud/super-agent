/** Send model-free notices for recorded document failures through the verified owner channel. */
import { createHash } from 'node:crypto'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { StudioFeishuNoticeDestination } from './feishu-inbox.ts'
import type { DocumentFailure, ManagedWorkerStore } from './store.ts'

/** Include only durable coordinates, never the original document, model prompt, or the provider error body. */
function failureNotice(failure: DocumentFailure): string {
  const { taskId, evidenceId, executionEpoch, authorizationVersion, turn, failureEventSeq } = failure
  return `Studio Watchdog system notice: a document continuation ended with TRANSPORT.\nTask ${taskId}; evidence ${evidenceId}.\n`
    + `Execution epoch ${executionEpoch}, authorization version ${authorizationVersion}; turn ${turn}, event ${failureEventSeq}.\n`
    + `Open Studio Web and run /studio-health document ${taskId} for the current state. This notice did not retry or recover the task.`
}

/** Coalesce native evidence and connection events into one bounded, single-flight drain; do not run a polling timer. */
export class StudioDocumentFailureNotices {
  private pending = false
  private active: Promise<void> | undefined

  constructor(private readonly ctx: Context, private readonly store: ManagedWorkerStore,
    private readonly destination: () => StudioFeishuNoticeDestination | undefined, private readonly stopping: AbortSignal,
    private readonly onError: () => void) {}

  wake(): void {
    if (this.stopping.aborted) return
    this.pending = true
    if (this.active) return
    this.active = Promise.resolve().then(async () => {
      while (this.pending && !this.stopping.aborted) {
        this.pending = false
        try { await this.ctx.agents.withoutInitiator(() => this.deliverPages()) }
        catch { if (!this.stopping.aborted) this.onError() }
      }
    }).finally(() => {
      this.active = undefined
      if (this.pending) this.wake()
    })
  }

  /** Allow a connection loss to settle its already recorded attempt before closing the Store. */
  async drain(): Promise<void> { await this.active }

  private async deliverPages(): Promise<void> {
    let afterEvidenceId: string | undefined
    while (!this.stopping.aborted) {
      const channel = this.destination()
      if (!channel) return
      const page = this.store.pendingDocumentFailureNoticePage(channel.scope, afterEvidenceId)
      if (!page.ok) throw new Error('Cannot read Studio document failure notice candidates')
      for (const evidenceId of page.value.evidenceIds) {
        if (this.stopping.aborted) return
        const destination = this.destination()
        if (!destination || destination.scope !== channel.scope) return
        const claim = this.store.claimDocumentFailureNotice(evidenceId, destination.scope)
        if (!claim.ok) {
          if (claim.reason === 'STORAGE_ERROR') throw new Error('Cannot confirm Studio document failure notice claim')
          continue
        }
        if (!claim.value.failure) continue
        // The claim and send start have no asynchronous gap. Do not retry a call with an ambiguous receipt.
        const key = createHash('sha256').update(destination.scope).update('\0').update(evidenceId).digest('hex').slice(0, 32)
        let receipt: string | undefined
        try { receipt = await destination.send(failureNotice(claim.value.failure), `studio-fault-${key}`) }
        catch { /* Keep only the outcome the configured channel could actually confirm. */ }
        const settled = this.store.settleDocumentFailureNotice(evidenceId, destination.scope, receipt)
        if ((!settled.ok || settled.value.state !== 'delivered') && !this.stopping.aborted) this.onError()
      }
      afterEvidenceId = page.value.next
      if (afterEvidenceId === undefined) return
      // Yield between pages, including pages whose now-stale candidates needed no external I/O.
      await yieldToHost(undefined, { signal: this.stopping, ref: false })
    }
  }
}
