import type { DatabaseSync } from 'node:sqlite'
import type { StudioPending, StudioSelfUpdateRecord } from './protocol.ts'
import type { StudioStore } from './store.ts'

export interface UpdateEntry {
  runId: string
  requestId: string
  requestHash: string
  record: StudioSelfUpdateRecord
}
interface UpdateRow { run_id: string; request_id: string; request_hash: string; record: string }
const decode = (row: UpdateRow): UpdateEntry => ({ runId: row.run_id, requestId: row.request_id, requestHash: row.request_hash,
  record: JSON.parse(row.record) as StudioSelfUpdateRecord })

/** 写权限只在现役 Host 运行中生效；待办、出箱与一次性更新授权共用同一事务。 */
export class StudioSelfUpdateLedger {
  constructor(private readonly db: DatabaseSync, private readonly studio: StudioStore, private readonly runId: string,
    private readonly write: <T>(callback: () => T) => T) {
    // 这是向后兼容的可选账表：沿用 V2 关系图与 user_version，旧版 Host 可打开同一账本。
    this.write(() => db.exec(`CREATE TABLE IF NOT EXISTS studio_self_update (
      update_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      run_id TEXT NOT NULL, phase TEXT NOT NULL, record TEXT NOT NULL
    ) STRICT`))
  }

  find(value: string, key: 'update_id' | 'request_id' = 'update_id'): UpdateEntry | undefined {
    const row = this.db.prepare(`SELECT run_id, request_id, request_hash, record FROM studio_self_update WHERE ${key} = ?`)
      .get(value) as unknown as UpdateRow | undefined
    return row && decode(row)
  }

  recent(allActive = false): UpdateEntry[] {
    const scope = allActive ? "WHERE phase IN ('prechecking', 'awaiting_confirmation', 'approved', 'draining')" : 'ORDER BY rowid DESC LIMIT 1'
    return (this.db.prepare(`SELECT run_id, request_id, request_hash, record FROM studio_self_update ${scope}`).all() as unknown as UpdateRow[]).map(decode)
  }

  start(record: StudioSelfUpdateRecord, requestId: string, hash: string): void {
    this.write(() => this.db.prepare('INSERT INTO studio_self_update VALUES (?, ?, ?, ?, ?, ?)')
      .run(record.updateId, requestId, hash, this.runId, record.phase, JSON.stringify(record)))
  }

  private update(from: UpdateEntry, record: StudioSelfUpdateRecord): boolean {
    return this.db.prepare('UPDATE studio_self_update SET phase = ?, record = ? WHERE update_id = ? AND run_id = ? AND phase = ?')
      .run(record.phase, JSON.stringify(record), record.updateId, from.runId, from.record.phase).changes === 1
  }

  transition(from: UpdateEntry, record: StudioSelfUpdateRecord, item?: StudioPending): boolean {
    return this.write(() => {
      if (from.runId !== this.runId || !this.update(from, record)) return false
      if (item) this.studio.addPendingInTx(item)
      return true
    })
  }

  /** 校验必须位于 CAS 事务内；未绑定本次运行、指纹或有效窗口的答复不能产生资格。 */
  decide(updateId: string, itemId: string, value: string, by: 'gui' | 'feishu', validate: (entry: UpdateEntry) => boolean): StudioPending | undefined {
    return this.write(() => {
      const entry = this.find(updateId)
      if (!entry || entry.runId !== this.runId || entry.record.phase !== 'awaiting_confirmation' || entry.record.pendingId !== itemId) return
      if (!validate(entry)) return
      const settled = this.studio.settleTaskPendingInTx(itemId, 'resolved', value, by)
      if (!settled) return
      const record: StudioSelfUpdateRecord = { ...entry.record, phase: value === settled.options[0] ? 'approved' : 'cancelled', updatedAt: Date.now() }
      if (!this.update(entry, record)) throw new Error('Studio update decision lost its transaction fence')
      return settled
    })
  }

  expire(entry: UpdateEntry): boolean {
    return this.write(() => {
      const { record } = entry
      if (!this.update(entry, { ...record, phase: 'expired', updatedAt: Date.now() })) return false
      if (record.pendingId) this.studio.settleTaskPendingInTx(record.pendingId, 'expired')
      return true
    })
  }
}
