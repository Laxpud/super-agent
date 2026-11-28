/** A new Studio directory is provisioned only while the old Host is quiescent. Never adopt, overwrite or delete an existing directory. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { validateStudioCopy, type ManagedWorkerStore } from '../managed-worker/store.ts'
import { StudioError } from './pending.ts'
import { STUDIO_DB, type DirectoryMode } from './settings-protocol.ts'

export { STUDIO_DB } from './settings-protocol.ts'
const MARKER = '.studio-directory'
const TOKEN = /^[a-f0-9-]{36}$/u
const pathError = () => new StudioError('STUDIO_DIRECTORY_INVALID', 'Choose a new absolute directory in an existing, trusted parent.', 400)

function within(parent: string, child: string) {
  const part = relative(parent, child)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

function checkedParent(path: string): string {
  const parent = dirname(path)
  const info = lstatSync(parent)
  if (!info.isDirectory() || realpathSync(parent) !== parent || (process.platform !== 'win32' && (info.mode & 0o022) !== 0)) throw pathError()
  return parent
}

function syncPath(path: string) {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

/** A saved switch must not initialize a blank ledger after a crash or an unsuccessful drain/copy. */
export function confirmStudioDirectory(path: string, token: string): void {
  if (!token) return
  const marker = join(path, MARKER)
  if (!TOKEN.test(token) || realpathSync(path) !== path || !lstatSync(join(path, STUDIO_DB)).isFile()) {
    throw new Error('The configured Studio directory was not prepared')
  }
  const stat = lstatSync(marker)
  if (!stat.isFile() || stat.size !== token.length || readFileSync(marker, 'utf8') !== token) {
    throw new Error('The configured Studio directory has no matching preparation receipt')
  }
}

/** 关联一次准备工作与新配置的激活；没有匹配凭据就不能打开新账本。 */
export class StudioDirectorySwitch {
  readonly token = randomUUID()
  readonly #parent: string

  /** Check without creating anything. A new sibling avoids mixing old backup paths, workspaces and active locks. */
  constructor(from: string, readonly target: string, readonly mode: DirectoryMode) {
    try {
      if (!isAbsolute(target) || resolve(target) !== target || lstatSync(target, { throwIfNoEntry: false })) throw pathError()
      const source = realpathSync(from)
      if (within(source, target) || within(target, source)) throw pathError()
      this.#parent = checkedParent(target)
    } catch { throw pathError() }
  }

  /** After admission stops and the store is settled, produce the whole SQLite snapshot (including WAL state). */
  async prepare(store: ManagedWorkerStore): Promise<void> {
    store.assertStateSealed()
    checkedParent(this.target)
    mkdirSync(this.target, { mode: 0o700 })
    const database = join(this.target, STUDIO_DB)
    closeSync(openSync(database, 'wx', 0o600))
    if (this.mode === 'copy') {
      await store.copySettingsState(database)
      using copy = new DatabaseSync(database, { readOnly: true })
      validateStudioCopy(copy)
    }
    syncPath(database)
    // Publish the preparation receipt last. A failed copy remains untouched at its new path for diagnosis.
    writeFileSync(join(this.target, MARKER), this.token, { flag: 'wx', mode: 0o600, flush: true })
    if (process.platform !== 'win32') { syncPath(this.target); syncPath(this.#parent) }
  }
}

/** A working directory changes only the CWD used for future Sessions, never existing Session metadata. */
export function verifyWorkspace(path: string): void {
  try {
    if (!isAbsolute(path) || !lstatSync(realpathSync(path)).isDirectory()) throw new Error()
  } catch { throw new StudioError('STUDIO_WORKSPACE_INVALID', 'Select an existing absolute directory on the Studio host.') }
}
