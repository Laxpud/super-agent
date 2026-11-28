import { randomUUID } from 'node:crypto'
import { copyFileSync, lstatSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { syncPath } from '../studio/self-update-files.ts'

export const V1_TABLES = [
  'studio_bot', 'studio_project', 'studio_project_leader', 'studio_session', 'studio_task', 'studio_task_execution',
  'studio_project_archive', 'studio_preference', 'studio_host_run',
  'agent_studio_assistant', 'agent_studio_settings', 'agent_studio_message', 'agent_studio_parallel_turn', 'agent_studio_route_control',
  'agent_studio_session', 'agent_studio_pending', 'agent_studio_feishu_binding', 'agent_studio_feishu_outbox',
] as const
export const V2_TABLES = [...V1_TABLES, 'studio_project_forward', 'studio_project_forward_notice'] as const
export const CURRENT_STUDIO_VERSION = 2
const sqliteSidecars = ['-wal', '-shm', '-journal'] as const

/** 只验证约定的现役图；迁移保存的只读旧表允许保留已知的不完整外键。 */
export function validateForeignKeys(db: DatabaseSync, tables: readonly string[], subject: string): void {
  for (const table of tables) {
    if (db.prepare(`PRAGMA foreign_key_check("${table.replaceAll('"', '""')}")`).get()) throw new Error(`${subject} failed foreign key validation: ${table}`)
  }
}

/** 完整验证独立备份、状态目录副本或脱离宿主探针读到的数据库版本。 */
export function validateStudioCopy(db: DatabaseSync): void {
  const integrity = db.prepare('PRAGMA quick_check').all()
  if (integrity.length !== 1 || integrity[0]?.quick_check !== 'ok') throw new Error('Studio database copy did not pass integrity checking')
  const version = db.prepare('PRAGMA user_version').get()?.user_version
  if (version !== CURRENT_STUDIO_VERSION) throw new Error(`Unsupported Studio database copy user_version: ${String(version)}`)
  validateForeignKeys(db, V2_TABLES, 'Studio database copy')
}

/** 拒绝缺失或被替换为非普通文件的主库和 SQLite 旁文件；校验不依赖 DSH 宿主服务。 */
export function validateStudioDatabase(path: string, sealedRunId?: string): void {
  if (!lstatSync(path).isFile()) throw new Error('Missing Studio database')
  for (const suffix of sqliteSidecars) {
    const sidecar = lstatSync(path + suffix, { throwIfNoEntry: false })
    if (sidecar && !sidecar.isFile()) throw new Error('Invalid Studio SQLite sidecar')
  }
  using db = new DatabaseSync(path, { readOnly: true })
  validateStudioCopy(db)
  if (sealedRunId !== undefined) {
    const run = db.prepare('SELECT run_id, clean FROM studio_host_run WHERE singleton = 1').get()
    if (run?.run_id !== sealedRunId || run.clean !== 1) throw new Error('Studio database does not contain the sealed run')
  }
}

export function unlinkIfPresent(path: string): void {
  try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

/** 仅在宿主锁排除所有写入者后使用。先验证私有备份与同目录临时文件，再替换数据库并删除已失败版本的旁文件。 */
export function restoreStudioDatabase(path: string, backupPath: string, sealedRunId: string): void {
  const info = lstatSync(backupPath)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Invalid Studio SQLite backup')
  if (sqliteSidecars.some(suffix => lstatSync(backupPath + suffix, { throwIfNoEntry: false }))) throw new Error('Studio backup must be standalone')
  validateStudioDatabase(backupPath, sealedRunId)
  const staged = `${path}.restore-${randomUUID()}`
  try {
    copyFileSync(backupPath, staged)
    validateStudioDatabase(staged, sealedRunId)
    syncPath(staged)
    for (const suffix of sqliteSidecars) unlinkIfPresent(path + suffix)
    renameSync(staged, path)
    syncPath(dirname(path))
    validateStudioDatabase(path, sealedRunId)
  } finally { unlinkIfPresent(staged) }
}
