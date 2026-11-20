/** First-route claims share the managed Store's connection and survive configuration changes and Host restarts. */
import type { DatabaseSync } from 'node:sqlite'
import type { StudioFeishuInstruction } from './instruction-store.js'

export const FEISHU_DELIVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_feishu_delivery (
    source_scope TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('document', 'draft', 'result')),
    source_time_ms INTEGER NOT NULL CHECK (source_time_ms BETWEEN 0 AND 9007199254740991),
    run_id TEXT NOT NULL,
    PRIMARY KEY (source_scope, request_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_feishu_delivery_action_time
    ON studio_feishu_delivery (source_scope, source_time_ms) WHERE kind IN ('document', 'draft');
`

export type FeishuDeliveryKind = 'document' | 'draft' | 'result'
type DeliveryCoordinates = Pick<StudioFeishuInstruction, 'sourceScope' | 'requestId' | 'sourceTimeMs'>
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')

/** Validate the identity and timestamp before inspecting the body; an invalid body must not free a claimed ID. */
export function feishuDeliveryCoordinates(input: DeliveryCoordinates & Pick<StudioFeishuInstruction, 'channel' | 'messageId' | 'eventSeq'>):
  DeliveryCoordinates | undefined {
  if (!input) return
  const { channel, sourceScope, requestId, messageId, eventSeq, sourceTimeMs } = input
  if (channel !== 'feishu' || !isId(sourceScope) || !isId(requestId) || messageId !== requestId || eventSeq !== null
    || !Number.isSafeInteger(sourceTimeMs) || sourceTimeMs < 0) return
  return { sourceScope, requestId, sourceTimeMs }
}

/** Claims are not task reservations. The caller checks the legacy ledgers and writes under the same managed transaction. */
export class FeishuDeliveryStore {
  constructor(private readonly database: () => DatabaseSync, private readonly runId: string) {}

  has(scope: string, requestId: string): boolean {
    return !!this.database().prepare('SELECT 1 FROM studio_feishu_delivery WHERE source_scope = ? AND request_id = ?')
      .get(scope, requestId)
  }

  insert({ sourceScope, requestId, sourceTimeMs }: DeliveryCoordinates, kind: FeishuDeliveryKind): void {
    const { changes } = this.database().prepare(`INSERT INTO studio_feishu_delivery
      (source_scope, request_id, kind, source_time_ms, run_id) VALUES (?, ?, ?, ?, ?)`)
      .run(sourceScope, requestId, kind, sourceTimeMs, this.runId)
    if (changes !== 1 && changes !== 1n) throw new Error('Studio Feishu route claim did not affect exactly one row')
  }

  /** A claim for another Host run, another delivery timestamp, or a non-draft route cannot start a draft. */
  currentDraft({ sourceScope, requestId, sourceTimeMs }: DeliveryCoordinates): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_feishu_delivery WHERE source_scope = ? AND request_id = ?
      AND kind = 'draft' AND source_time_ms = ? AND run_id = ?`).get(sourceScope, requestId, sourceTimeMs, this.runId)
  }

  /** Newer action claims can fence a draft even if no task was started; result lookups do not affect ordering. */
  actionLate(scope: string, sourceTimeMs: number): boolean {
    return !!this.database().prepare(`SELECT 1 FROM studio_feishu_delivery WHERE source_scope = ? AND source_time_ms > ?
      AND kind IN ('document', 'draft') LIMIT 1`).get(scope, sourceTimeMs)
  }
}
