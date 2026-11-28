import { lstatSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lockSync } from 'proper-lockfile'
import { inspectLocalProcess, localProcessState, tryLocalFileLock, type LocalProcessIdentity } from '../studio/local-process.ts'
import { atomicJson, privateDirectory, readPrivateJson } from '../studio/self-update-files.ts'

interface HostLockOwner extends LocalProcessIdentity { dev: string; ino: string }
const ownerName = 'host-lock.json'
const lockError = () => Object.assign(new Error('Studio state directory lock is already held'), { code: 'ELOCKED' })

export function tryStudioStateGuard(stateDir: string): (() => void) | undefined {
  const runtime = privateDirectory(join(stateDir, 'runtime'))
  return tryLocalFileLock(join(runtime, '.host-lock-guard'))
}

/** 调用方须持有 stateDir 的内核互斥锁；只允许移除身份和目录 inode 均匹配的已死亡宿主残锁。 */
export function clearDeadStudioHostLock(stateDir: string): void {
  const path = `${stateDir}.lock`, ownerPath = join(stateDir, 'runtime', ownerName)
  const lock = lstatSync(path, { throwIfNoEntry: false, bigint: true })
  if (!lock) return
  let owner: HostLockOwner
  try { owner = readPrivateJson<HostLockOwner>(ownerPath) } catch { throw lockError() }
  if (!lock.isDirectory() || lock.uid !== BigInt(process.getuid!()) || !owner || owner.dev !== String(lock.dev) || owner.ino !== String(lock.ino)
    || localProcessState(owner) !== 'gone') throw lockError()
  rmdirSync(path)
  unlinkSync(ownerPath)
}

/** 保留 proper-lockfile 与旧宿主互斥；Linux 上由 flock 串行发放及回收，不按 mtime 强抢活进程。 */
export async function lockStudioHostDirectory(dir: string, onCompromised: (error: Error) => void): Promise<() => void> {
  if (process.platform !== 'linux') return lockSync(dir, { stale: 30_000, onCompromised })
  const stateDir = realpathSync(dir), runtime = join(stateDir, 'runtime')
  const self = inspectLocalProcess(process.pid)
  if (!self || self === 'gone') throw new Error('Studio cannot identify its host process')
  for (let attempt = 0; attempt < 5; attempt++) {
    const guard = tryStudioStateGuard(stateDir)
    if (guard) {
      let unlock: (() => void) | undefined
      try {
        const path = `${stateDir}.lock`
        // Linux 的内核锁会在进程退出时释放；保留 heartbeat 来兼容只识别 proper-lockfile 的旧宿主。
        const acquire = () => lockSync(stateDir, { stale: Infinity, update: 10_000, onCompromised })
        try { unlock = acquire() }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
          clearDeadStudioHostLock(stateDir)
          unlock = acquire()
        }
        const stat = lstatSync(path, { bigint: true })
        atomicJson<HostLockOwner>(runtime, ownerName, { ...self, dev: String(stat.dev), ino: String(stat.ino) })
        const removeOwner = () => {
          try { unlinkSync(join(runtime, ownerName)) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        const onExit = () => { try { removeOwner() } catch { /* 无法清理时由下次启动校验锁目录。 */ } }
        process.once('exit', onExit)
        return () => {
          process.off('exit', onExit)
          // 保留 owner 至 proper-lockfile 释放完成，以便关停途中 SIGKILL 后能识别残锁。
          try { unlock!(); removeOwner() } finally { guard() }
        }
      } catch (error) {
        try { unlock?.() } finally { guard() }
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
      }
    }
    if (attempt < 4) await delay(25 * (2 ** attempt))
  }
  throw lockError()
}
