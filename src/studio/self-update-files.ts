import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { computeReleaseManifest, RELEASE_ASSETS, verifyStudioClientBuild } from './build-info.ts'
import { tryLocalFileLock } from './local-process.ts'
import type { StudioSelfUpdateFailureCode, StudioSelfUpdatePhase, StudioSelfUpdateRecord } from './protocol.ts'
import { updateRecordView } from './self-update-ledger.ts'
import type { StudioSelfUpdateConfig } from './settings-protocol.ts'

export const updateIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
export const fingerprintPattern = /^[a-f0-9]{64}$/u
export const within = (parent: string, child: string) => {
  const part = relative(parent, child)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}
export const overlaps = (a: string, b: string) => within(a, b) || within(b, a)

export function syncPath(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export function atomicJson<T>(dir: string, name: string, value: T): T {
  const temporary = join(dir, `.${name}.${randomUUID()}`)
  writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  renameSync(temporary, join(dir, name))
  syncPath(dir)
  return value
}

export function readPrivateJson<T>(path: string): T {
  const info = lstatSync(path)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65_536) throw new Error('Invalid Studio update state file')
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeUpdateState(dir: string, record: StudioSelfUpdateRecord, phase: StudioSelfUpdatePhase,
  values: Partial<StudioSelfUpdateRecord> = {}): StudioSelfUpdateRecord {
  return atomicJson(dir, 'state.json', updateRecordView({ ...record, ...values, phase, updatedAt: Date.now() }))
}

/** 将本地失败转换成稳定的协议原因码，不转发原始异常及其中可能存在的宿主路径。 */
export class StudioUpdateFailure extends Error {
  constructor(readonly code: StudioSelfUpdateFailureCode) { super(code) }
}
export const updateFailureCode = (error: unknown, fallback: StudioSelfUpdateFailureCode): StudioSelfUpdateFailureCode =>
  error instanceof StudioUpdateFailure ? error.code : fallback

/** 状态正文与结构化原因并列；不把子进程异常文本或内部路径写进摘要。 */
export function logUpdateController(dir: string, phase: string, failedPhase?: StudioSelfUpdatePhase, failureCode?: StudioSelfUpdateFailureCode): void {
  try {
    appendFileSync(join(dir, 'controller.log'), `${new Date().toISOString()} ${phase}${failedPhase ? ` (failed: ${failedPhase})` : ''}`
      + `${failureCode ? ` ${JSON.stringify({ failureCode })}` : ''}\n`, { mode: 0o600 })
  } catch { /* 已持久化的状态不因附加日志失败而改变。 */ }
}

const installOwnerFile = '.studio-owner.json'
const installOwner = (stateDir: string) => createHash('sha256').update(canonicalDirectory(stateDir, true)).digest('hex')

export function assertStudioInstallOwner(installRoot: string, stateDir: string): void {
  canonicalDirectory(installRoot, true)
  const path = join(installRoot, installOwnerFile)
  if (!lstatSync(path, { throwIfNoEntry: false })) return
  try {
    if (readPrivateJson<{ stateDirHash?: string }>(path)?.stateDirHash === installOwner(stateDir)) return
  } catch { /* 未证明归属的发布根不能被认领。 */ }
  throw new StudioUpdateFailure('LOCK_CONFLICT')
}

/** 原子认领托管根，控制器持锁到切换或回退完成；不同数据目录不能复用已经认领的发布根。 */
export function lockStudioInstallRoot(installRoot: string, stateDir: string): () => void {
  assertStudioInstallOwner(installRoot, stateDir)
  const unlock = tryLocalFileLock(join(installRoot, '.studio-install.lock'))
  if (!unlock) throw new StudioUpdateFailure('LOCK_CONFLICT')
  try {
    assertStudioInstallOwner(installRoot, stateDir)
    if (!lstatSync(join(installRoot, installOwnerFile), { throwIfNoEntry: false })) {
      atomicJson(installRoot, installOwnerFile, { stateDirHash: installOwner(stateDir) })
    }
    return unlock
  } catch (error) { unlock(); throw error }
}

export function canonicalDirectory(path: string, privateToOwner = false): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error('Expected a canonical directory')
  const info = lstatSync(path)
  if (!info.isDirectory() || (privateToOwner && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw new Error('Expected an owner-only directory')
  return path
}

export function privateDirectory(path: string): string {
  mkdirSync(path, { mode: 0o700, recursive: true })
  return canonicalDirectory(path, true)
}

export function releaseTarget(installRoot: string): string {
  canonicalDirectory(installRoot, true)
  canonicalDirectory(join(installRoot, 'releases'), true)
  const pointer = join(installRoot, 'current')
  if (!lstatSync(pointer).isSymbolicLink()) throw new Error('Studio current must be a symbolic link')
  const target = realpathSync(pointer)
  if (!within(join(installRoot, 'releases'), target) || target === join(installRoot, 'releases')) throw new Error('Studio current leaves managed releases')
  return canonicalDirectory(target, true)
}

export function switchRelease(installRoot: string, target: string, previous: string): void {
  if (releaseTarget(installRoot) !== previous || !within(join(installRoot, 'releases'), canonicalDirectory(target, true))
    || target === join(installRoot, 'releases')) throw new Error('Studio release pointer changed')
  const temporary = join(installRoot, `.current-${randomUUID()}`)
  symlinkSync(relative(installRoot, target), temporary, 'dir')
  renameSync(temporary, join(installRoot, 'current'))
  syncPath(installRoot)
}

export function verifyRelease(root: string, buildId: string, expected?: string): string {
  const fingerprint = computeReleaseManifest(root).artifactFingerprint
  for (const entry of ['lib/managed-worker.js', 'lib/self-update-runner.js', 'studio-web/index.js']) {
    if (!lstatSync(join(root, entry)).isFile()) throw new Error('Studio release is missing an executable entry')
  }
  verifyStudioClientBuild(root, buildId)
  if (expected !== undefined && fingerprint !== expected) throw new Error('Studio release fingerprint changed')
  return fingerprint
}

/** 发布树只复制约定资产；在复制前拒绝链接，并在完成后重新核验每个资产的字节。 */
export function copyRelease(source: string, target: string, buildId: string, expected?: string): string {
  const fingerprint = verifyRelease(source, buildId, expected)
  mkdirSync(target, { mode: 0o700 })
  for (const name of RELEASE_ASSETS) cpSync(join(source, name), join(target, name), { recursive: true, force: false, errorOnExist: true })
  const readme = join(source, 'README.md')
  if (existsSync(readme) && lstatSync(readme).isFile()) cpSync(readme, join(target, 'README.md'), { force: false, errorOnExist: true })
  verifyRelease(target, buildId, fingerprint)
  function syncTree(path: string) {
    // 发布清单已枚举全部运行资产；先同步文件，再同步其所在目录。
    syncPath(path)
    let parent = path.slice(0, path.lastIndexOf(sep))
    while (parent !== target) { syncPath(parent); parent = parent.slice(0, parent.lastIndexOf(sep)) }
  }
  for (const file of Object.keys(computeReleaseManifest(target).files)) syncTree(join(target, file))
  if (existsSync(join(target, 'README.md'))) syncPath(join(target, 'README.md'))
  syncPath(target)
  syncPath(resolve(target, '..'))
  return fingerprint
}

export type StudioReloadCommand = NonNullable<StudioSelfUpdateConfig['reloadCommand']>

export function validateReloadCommand(command: StudioReloadCommand): void {
  if (!isAbsolute(command.executable) || resolve(command.executable) !== command.executable || !lstatSync(realpathSync(command.executable)).isFile() ||
    command.args.some(argument => !argument.isWellFormed() || argument.includes('\0') || argument.includes('--from-default-profile')) ||
    (command.profileName !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(command.profileName))) throw new Error('Invalid Studio reload recipe')
  if (command.cwd !== undefined) canonicalDirectory(command.cwd)
  if (command.dshHome !== undefined) canonicalDirectory(command.dshHome)
  for (const [index, argument] of command.args.entries()) {
    if (argument === '--profile' || argument.startsWith('--profile=')) {
      const profile = argument === '--profile' ? command.args[index + 1] : argument.slice('--profile='.length)
      if (!profile || (command.profileName && profile !== command.profileName)) throw new Error('Studio reload targets a different profile')
    }
  }
}
