import { z } from 'zod'
import type { ProjectArchiveStore } from './project-archive-store.ts'

export const PROJECT_ARCHIVE_HINT = 'archive-view <project-id> | archive-update <JSON> | archive-clear <project-id>'
const changes = z.strictObject({ projectId: z.uuid(), decisions: z.string().max(8_000).exactOptional(),
  progress: z.string().max(8_000).exactOptional(), openIssues: z.string().max(8_000).exactOptional() })

/** 档案写操作只从已认证的项目命令进入；数据库还检查项目未归档。 */
export function projectArchiveCommand(store: ProjectArchiveStore, verb: string, value: string, allowed: (id: string) => boolean): string | undefined {
  if (verb !== 'archive-view' && verb !== 'archive-update' && verb !== 'archive-clear') return
  if (verb === 'archive-update') {
    const { projectId, ...fields } = changes.parse(JSON.parse(value))
    if (!allowed(projectId)) throw new Error('Studio archive belongs to another project')
    store.update(projectId, fields)
  } else {
    const id = z.uuid().parse(value)
    if (!allowed(id)) throw new Error('Studio archive belongs to another project')
    if (verb === 'archive-clear') return store.delete(id) ? 'Project archive cleared.' : 'Project archive is already empty.'
  }
  const id = verb === 'archive-update' ? changes.parse(JSON.parse(value)).projectId : value
  const archive = store.get(id)
  if (!archive) return 'No archive has been recorded for this project.'
  return `Decisions:\n${archive.decisions || '—'}\n\nProgress:\n${archive.progress || '—'}\n\nOpen issues:\n${archive.openIssues || '—'}`
}
