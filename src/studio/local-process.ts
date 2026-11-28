import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

export interface LocalProcessIdentity { pid: number; bootId: string; starttime: string }

/** Linux 的系统启动 ID 与进程启动时刻共同识别 PID；权限错误不当作进程已退出。 */
export function inspectLocalProcess(pid: number): LocalProcessIdentity | 'gone' | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1) return
  let stat: string
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8') }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : undefined }
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  if (['Z', 'X', 'x'].includes(fields[0] ?? '')) return 'gone'
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), starttime = fields[19]
    if (starttime && /^\d+$/u.test(starttime) && /^[a-f\d-]{36}$/u.test(bootId)) return { pid, bootId, starttime }
  } catch { /* 无法确认内核身份时不回收锁或发送信号。 */ }
}

export function localProcessState(owner: LocalProcessIdentity): 'running' | 'gone' | 'unknown' {
  if (!owner || typeof owner.bootId !== 'string' || !/^[a-f\d-]{36}$/u.test(owner.bootId)
    || typeof owner.starttime !== 'string' || !/^\d+$/u.test(owner.starttime)) return 'unknown'
  const actual = inspectLocalProcess(owner.pid)
  return !actual ? 'unknown' : actual === 'gone' || actual.bootId !== owner.bootId || actual.starttime !== owner.starttime ? 'gone' : 'running'
}

/** flock 在继承的描述符上加锁；父进程关闭该描述符或退出时内核释锁。不要删除锁文件，否则会分裂锁域。 */
export function tryLocalFileLock(path: string): (() => void) | undefined {
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.nlink !== 1) throw new Error('Invalid Studio lock file')
    const result = spawnSync('/usr/bin/flock', ['-n', '3'], { shell: false, timeout: 1_000, stdio: ['ignore', 'ignore', 'ignore', fd] })
    if (result.status === 0) return () => closeSync(fd)
    if (result.status !== 1) throw new Error('Studio requires Linux flock', { cause: result.error })
  } catch (error) { closeSync(fd); throw error }
  closeSync(fd)
}
