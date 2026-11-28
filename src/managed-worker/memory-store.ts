import { randomUUID } from 'node:crypto'
import { studioNow, type StudioStoreAccess } from './store.ts'

export interface StudioPreference {
  preferenceId: string; prefKey: string; projectId: string | null; text: string;
  state: 'active' | 'forgotten'; version: number; updatedAt: string
}

function decode(row: Record<string, unknown>): StudioPreference {
  return { preferenceId: String(row.preference_id), prefKey: String(row.pref_key), projectId: row.project_id as string | null,
    text: String(row.text), state: row.state === 'forgotten' ? 'forgotten' : 'active', version: Number(row.version), updatedAt: String(row.updated_at) }
}

/** 只管理用户明确登记的全局或项目偏好，不自动提取、引用或重新激活已忘记的值。 */
export class MemoryStore {
  constructor(private readonly access: StudioStoreAccess) {}
  private get db() { return this.access.db }

  get(prefKey: string, projectId: string | null = null): StudioPreference | undefined {
    this.access.assertActive()
    const row = this.db.prepare('SELECT * FROM studio_preference WHERE pref_key = ? AND project_id IS ?').get(prefKey, projectId)
    return row && decode(row)
  }

  list(projectId: string | null = null, includeForgotten = false): StudioPreference[] {
    this.access.assertActive()
    return this.db.prepare(`SELECT * FROM studio_preference WHERE project_id IS ? AND (? = 1 OR state = 'active') ORDER BY pref_key LIMIT 200`)
      .all(projectId, Number(includeForgotten)).map(decode)
  }

  /** 按更新时间合并适用范围；另计总数，让提示词明确报告预算之外（含读取上限）的省略数量。 */
  forPrompt(projectId: string | null, limit: number): { items: StudioPreference[]; total: number } {
    this.access.assertActive()
    const filter = "WHERE state = 'active' AND (project_id IS NULL OR project_id = ?)"
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM studio_preference ${filter}`).get(projectId)?.total)
    const items = this.db.prepare(`SELECT * FROM studio_preference ${filter} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(projectId, limit).map(decode)
    return { items, total }
  }

  save(prefKey: string, text: string, projectId: string | null = null): StudioPreference {
    validate(prefKey, text)
    return this.access.write(() => {
      this.#writable(projectId)
      this.db.prepare('INSERT INTO studio_preference VALUES (?, ?, ?, ?, \'active\', 1, ?)')
        .run(randomUUID(), prefKey, projectId, text, studioNow())
      return this.get(prefKey, projectId)!
    })
  }

  update(prefKey: string, expectedVersion: number, text: string, projectId: string | null = null): StudioPreference | undefined {
    validate(prefKey, text)
    return this.#change(prefKey, projectId, expectedVersion, 'active', text)
  }

  forget(prefKey: string, expectedVersion: number, projectId: string | null = null): StudioPreference | undefined {
    return this.#change(prefKey, projectId, expectedVersion, 'forgotten', '')
  }

  #change(prefKey: string, project: string | null, version: number, state: StudioPreference['state'], text: string) {
    return this.access.write(() => {
      this.#writable(project)
      const row = this.db.prepare(`UPDATE studio_preference SET text = ?, state = ?, version = version + 1, updated_at = ?
        WHERE pref_key = ? AND project_id IS ? AND version = ? AND state = 'active' RETURNING *`)
        .get(text, state, studioNow(), prefKey, project, version)
      return row && decode(row)
    })
  }

  #writable(project: string | null): void {
    if (project !== null && !this.db.prepare("SELECT 1 FROM studio_project WHERE state = 'active' AND project_id = ?").get(project)) {
      throw new Error('Studio preferences require an active project')
    }
  }
}

function validate(key: string, text: string): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(key) || !text.trim() || text.length > 4_000 || !text.isWellFormed() || text.includes('\0')) {
    throw new Error('Invalid Studio preference key or text')
  }
}
