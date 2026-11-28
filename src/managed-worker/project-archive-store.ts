import { studioNow, type StudioStoreAccess } from './store.ts'

export interface ProjectArchive {
  projectId: string; decisions: string; progress: string; openIssues: string; updatedAt: string
}
export type ProjectArchiveFields = Pick<ProjectArchive, 'decisions' | 'progress' | 'openIssues'>

/** 按项目保存一份可交接档案；旧事实账本不自动变成现行档案。 */
export class ProjectArchiveStore {
  constructor(private readonly access: StudioStoreAccess) {}
  private get db() { return this.access.db }

  get(projectId: string): ProjectArchive | undefined {
    this.access.assertActive()
    const row = this.db.prepare('SELECT * FROM studio_project_archive WHERE project_id = ?').get(projectId)
    if (row) return { projectId, decisions: String(row.decisions), progress: String(row.progress), openIssues: String(row.open_issues), updatedAt: String(row.updated_at) }
  }

  update(projectId: string, fields: Partial<ProjectArchiveFields>): ProjectArchive {
    return this.access.write(() => {
      this.#requireActive(projectId)
      const prior = this.get(projectId)
      const decisions = fields.decisions ?? prior?.decisions ?? ''
      const progress = fields.progress ?? prior?.progress ?? ''
      const openIssues = fields.openIssues ?? prior?.openIssues ?? ''
      if ([decisions, progress, openIssues].some(text => text.length > 8_000 || !text.isWellFormed() || text.includes('\0'))) {
        throw new Error('Invalid Studio archive text')
      }
      this.db.prepare(`INSERT INTO studio_project_archive VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id)
        DO UPDATE SET decisions = excluded.decisions, progress = excluded.progress, open_issues = excluded.open_issues, updated_at = excluded.updated_at`)
        .run(projectId, decisions, progress, openIssues, studioNow())
      return this.get(projectId)!
    })
  }

  delete(projectId: string): boolean {
    return this.access.write(() => {
      this.#requireActive(projectId)
      return this.db.prepare('DELETE FROM studio_project_archive WHERE project_id = ?').run(projectId).changes === 1
    })
  }

  #requireActive(projectId: string) {
    if (!this.db.prepare("SELECT 1 FROM studio_project WHERE project_id = ? AND state = 'active'").get(projectId)) {
      throw new Error('Studio archive can only change while its project is active')
    }
  }
}
