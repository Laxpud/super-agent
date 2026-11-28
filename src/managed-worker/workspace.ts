import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export interface WorkspaceIdentity { dev: number; ino: number }
export interface WorkspaceBinding extends WorkspaceIdentity { root: string }
export type WorkspaceTargetMode = 'read' | 'search' | 'create' | 'write' | 'dir'
export interface WorkspaceTargetOptions {
  mode: WorkspaceTargetMode
  protectedRoots: readonly string[]
  allowMissingDefaultRoot?: boolean
}
export interface WorkspaceDirectoryEntry { name: string; kind: 'file' | 'dir' | 'symlink' | 'external-symlink' }
export const WORKSPACE_LIST_LIMIT = 200

/** 区分格式或类型错误与访问边界违规，供工具守卫返回准确的拒绝代码。 */
export class WorkspacePathError extends Error {
  constructor(readonly code: 'STUDIO_WORKSPACE_INVALID' | 'STUDIO_OUTSIDE_WORKSPACE', message: string) { super(message) }
}

const invalid = (message: string) => new WorkspacePathError('STUDIO_WORKSPACE_INVALID', message)
const outside = (message: string) => new WorkspacePathError('STUDIO_OUTSIDE_WORKSPACE', message)
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'

function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel.split(sep)[0] !== '..'
}

function assertPath(value: string): void {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed() || value.includes('\0')) {
    throw invalid('A non-empty, valid workspace path is required.')
  }
  if (/^~|^[\\/]{2}|^\\/u.test(value) || (process.platform !== 'win32' && /[\\]|^[A-Za-z]:/u.test(value))
    || (process.platform === 'win32' && /:/u.test(value.replace(/^[A-Za-z]:[\\/]/u, '')))) {
    throw outside('Home expansion, device and UNC paths are not allowed in a Studio workspace.')
  }
}

/** 同时保护宿主配置路径的词法拼写与物理位置；不存在的尾段仍保留在最近可解析的祖先下。 */
export function protectedHostRoots(stateDir: string, extra: string[] = []): readonly string[] {
  const home = homedir()
  const roots = new Set<string>()
  for (const input of [...['.ssh', '.aws', '.dsh', '.agents'].map(name => join(home, name)), '/etc/shadow', stateDir, ...extra]) {
    const absolute = resolve(input)
    roots.add(absolute)
    const suffix: string[] = []
    for (let cursor = absolute; ; cursor = dirname(cursor)) {
      try { roots.add(join(realpathSync.native(cursor), ...suffix)); break }
      catch (error) {
        if (!missing(error) || dirname(cursor) === cursor) break
        suffix.unshift(parse(cursor).base)
      }
    }
  }
  return [...roots]
}

function assertContained(root: string, target: string, protectedRoots: readonly string[]): void {
  if (!within(root, target) || protectedRoots.some(hostRoot => within(hostRoot, target))) {
    throw outside('The path is outside the authorized workspace or in a protected host location.')
  }
}

/** 只绑定现存目录；别名会规范化，但系统根、用户家目录与受保护路径不能被选为工作区。 */
export function canonicalizeWorkspaceRoot(input: string, protectedRoots: readonly string[]): WorkspaceBinding {
  assertPath(input)
  if (!isAbsolute(input)) throw invalid('Select an existing absolute directory on the Studio host.')
  try {
    const root = realpathSync.native(input)
    const home = homedir()
    let physicalHome = home
    try { physicalHome = realpathSync.native(home) }
    catch (error) { if (!missing(error)) throw error }
    if (dirname(root) === root || relative(home, root) === '' || relative(physicalHome, root) === '') {
      throw outside('The filesystem root or the user home directory cannot be a Studio workspace.')
    }
    assertContained(parse(root).root, root, protectedRoots)
    assertContained(parse(resolve(input)).root, resolve(input), protectedRoots)
    const stat = statSync(root)
    if (!stat.isDirectory()) throw invalid('The Studio workspace must be a directory.')
    return { root, dev: stat.dev, ino: stat.ino }
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error
    throw invalid('The Studio workspace must be an existing, accessible directory.')
  }
}

/** 检查原 Session 的物理根目录及设备/索引节点；替换目录或将其改为链接时立即失效。 */
export function verifyWorkspaceIdentity(root: string, expected?: WorkspaceIdentity): boolean {
  try {
    if (realpathSync.native(root) !== root) return false
    const stat = statSync(root)
    return stat.isDirectory() && (expected === undefined || (stat.dev === expected.dev && stat.ino === expected.ino))
  } catch { return false }
}

function existing(path: string) {
  try { return lstatSync(path) }
  catch (error) {
    if (missing(error)) return undefined
    throw invalid('The workspace path could not be inspected.')
  }
}

function physicalTarget(scope: string, path: string, protectedRoots: readonly string[]): string {
  let physical: string
  try { physical = realpathSync.native(path) }
  catch { throw invalid('The workspace target does not resolve to an existing path.') }
  assertContained(scope, physical, protectedRoots)
  return physical
}

function parts(path: string): string[] {
  return path.split(process.platform === 'win32' ? /[\\/]/u : '/').filter(Boolean)
}

/** 原生文件工具与搜索进程可能对 `..` 采用不同语义；只允许折返已确认的非链接目录。 */
function checkParentSegments(root: string, raw: string, protectedRoots: readonly string[]): void {
  const base = isAbsolute(raw) ? parse(raw).root : ''
  const segments = parts(raw.slice(base.length))
  if (segments.lastIndexOf('..') === -1) return
  if (base) {
    const prefix = parts(root.slice(parse(root).root.length))
    if (resolve(base, ...segments.slice(0, prefix.length)) !== root) throw outside('The path traverses outside the workspace.')
    segments.splice(0, prefix.length)
  }
  const lastParent = segments.lastIndexOf('..')
  let cursor = root
  // 对每个会被归一化消去的路径段做检查，否则 shell 和路径后端可能读到不同文件。
  for (const [i, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    assertContained(root, cursor, protectedRoots)
    if (i < lastParent && !existing(cursor)?.isDirectory()) {
      throw outside('A parent path segment may only traverse real workspace directories.')
    }
  }
}

/** 验证词法范围和真实文件类型；允许创建缺失尾段，但不接受写路径中的任何符号链接。 */
export function resolveWorkspaceTarget(root: string, rawTarget: string | undefined, options: WorkspaceTargetOptions): string {
  const { mode, protectedRoots, allowMissingDefaultRoot } = options
  const raw = rawTarget === undefined && allowMissingDefaultRoot ? root : rawTarget
  if (raw === undefined) throw invalid('A workspace target path is required.')
  assertPath(raw)
  const candidate = resolve(root, raw)
  assertContained(root, candidate, protectedRoots)
  if (!verifyWorkspaceIdentity(root)) throw outside('The workspace directory has changed or is unavailable.')
  checkParentSegments(root, raw, protectedRoots)

  if (mode === 'create' || mode === 'write') {
    const segments = parts(relative(root, candidate))
    if (!segments.length) throw invalid('The workspace directory itself is not writable as a file.')
    let cursor = root
    for (const [i, segment] of segments.entries()) {
      const parent = cursor
      cursor = join(parent, segment)
      assertContained(root, cursor, protectedRoots)
      const stat = existing(cursor)
      if (!stat) {
        if (mode === 'write') throw invalid('The target file to edit must already exist.')
        physicalTarget(root, parent, protectedRoots)
        return candidate
      }
      if (stat.isSymbolicLink()) throw outside('Writing through a symbolic link is not allowed in a Studio workspace.')
      if (i + 1 < segments.length ? !stat.isDirectory() : !stat.isFile()) {
        throw invalid('A writable workspace target must be a regular file beneath real directories.')
      }
    }
    return physicalTarget(root, candidate, protectedRoots)
  }

  // 检查每个词法前缀，避免链接先借道受保护树或工作区外、再由下级链接返回工作区。
  let cursor = root
  for (const segment of parts(relative(root, candidate))) {
    cursor = join(cursor, segment)
    assertContained(root, cursor, protectedRoots)
    if (existing(cursor)?.isSymbolicLink()) physicalTarget(root, cursor, protectedRoots)
  }
  const entry = existing(candidate)
  if (!entry) throw invalid('The workspace target must already exist.')
  if (!entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()) throw invalid('Special files are not allowed in a Studio workspace.')
  const physical = physicalTarget(root, candidate, protectedRoots)
  const stat = existing(physical)
  if (mode === 'read' && !stat?.isFile() || mode === 'dir' && !stat?.isDirectory()
    || mode === 'search' && !stat?.isFile() && !stat?.isDirectory()) {
    throw invalid(mode === 'read' ? 'The workspace target must be a regular file.' : mode === 'dir'
      ? 'The workspace target must be a directory.' : 'The search target must be a regular file or directory.')
  }
  // 原生搜索会递归访问目标子目录，不能仅核验搜索起点再让它扫过受保护的子树。
  if (mode === 'search' && stat?.isDirectory()) assertWorkspaceTraversal(physical, protectedRoots)
  return physical
}

/** 递归操作不能从受保护树的祖先起步；仅检查直接项的目录列表不受此限。 */
export function assertWorkspaceTraversal(root: string, protectedRoots: readonly string[]): void {
  if (protectedRoots.some(path => within(root, path))) throw outside('Recursive operations cannot include protected host locations.')
}

/** 列出直接子项，不打开文件或遍历链接目标；越界链接只返回名字和分类。 */
export function listWorkspaceDirectory(root: string, rawPath: string | undefined, protectedRoots: readonly string[],
  limit = WORKSPACE_LIST_LIMIT): WorkspaceDirectoryEntry[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_LIST_LIMIT) throw invalid(`Directory limit must be 1–${WORKSPACE_LIST_LIMIT}.`)
  const path = resolveWorkspaceTarget(root, rawPath, { mode: 'dir', protectedRoots, allowMissingDefaultRoot: true })
  const entries: WorkspaceDirectoryEntry[] = []
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const target = join(path, entry.name)
    if (protectedRoots.some(protectedRoot => within(protectedRoot, target))) continue
    const kind = entry.isSymbolicLink() ? linkKind(root, path, target, protectedRoots)
      : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : undefined
    if (kind) entries.push({ name: entry.name, kind })
    if (entries.length >= limit) break
  }
  return entries
}

function linkKind(root: string, parent: string, target: string, protectedRoots: readonly string[]): 'symlink' | 'external-symlink' {
  try {
    const link = resolve(parent, readlinkSync(target))
    assertContained(root, link, protectedRoots)
    assertContained(root, realpathSync.native(target), protectedRoots)
    return 'symlink'
  } catch (error) {
    // 断链不是可读目标；保留类型，只有已知目标越界（或无法安全检查）才标为外部链接。
    return missing(error) ? 'symlink' : 'external-symlink'
  }
}
