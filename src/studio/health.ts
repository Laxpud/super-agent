import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import type { StudioHealthStatus } from './protocol.ts'

const challengePattern = /^[a-f0-9]{64}$/u
export const studioHealthSocket = (stateDir: string) => join(stateDir, 'runtime', 'health.sock')

function assertPrivate(path: string, directory: boolean): void {
  const info = lstatSync(path)
  if ((directory ? !info.isDirectory() : !info.isSocket()) || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('Studio health endpoint must be owner-only')
  }
}

/** 每条连接仅接受一个 256 bit 随机挑战，原样回显以绑定该次应答。权限由 Unix socket 的父目录限定。 */
export async function openStudioHealthSocket(stateDir: string, health: () => StudioHealthStatus): Promise<() => void> {
  if (process.platform === 'win32' || realpathSync(stateDir) !== stateDir) throw new Error('Studio health socket requires a canonical Unix state directory')
  const info = lstatSync(stateDir)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022)) throw new Error('Studio state directory is not owner controlled')
  const dir = join(stateDir, 'runtime'), address = studioHealthSocket(stateDir)
  if (Buffer.byteLength(address) >= 104) throw new Error('Studio health socket path is too long')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivate(dir, true)
  if (lstatSync(address, { throwIfNoEntry: false })) {
    // 调用方已独占 stateDir 锁，只有该目录中上次非正常退出留下的 socket 可移除。
    assertPrivate(address, false)
    unlinkSync(address)
  }
  const server = createServer(socket => {
    let input = ''
    socket.on('error', () => socket.destroy())
    socket.setTimeout(1_000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.on('data', (part: string) => {
      input += part
      if (input.length > 65) { socket.destroy(); return }
      if (!input.endsWith('\n')) return
      const nonce = input.slice(0, -1)
      if (!challengePattern.test(nonce)) { socket.destroy(); return }
      socket.removeAllListeners('data')
      try { socket.end(JSON.stringify({ nonce, health: health() })) } catch { socket.destroy() }
    })
  })
  server.maxConnections = 16
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address, resolve) })
  try { chmodSync(address, 0o600) } catch (error) { server.close(); throw error }
  server.unref()
  const identity = lstatSync(address)
  return () => {
    // Node 同步解除监听 socket 名称；只在仍属于本实例时调用清理。
    const current = lstatSync(address, { throwIfNoEntry: false })
    if (current?.ino === identity.ino && current.dev === identity.dev) server.close()
    else server.unref()
  }
}

export async function probeStudioHealth(stateDir: string): Promise<StudioHealthStatus> {
  const address = studioHealthSocket(stateDir)
  assertPrivate(join(stateDir, 'runtime'), true)
  assertPrivate(address, false)
  const nonce = randomBytes(32).toString('hex')
  return new Promise((resolve, reject) => {
    const socket = createConnection(address)
    let output = ''
    const invalid = () => { socket.destroy(); reject(new Error('Studio health response is unavailable')) }
    socket.setTimeout(1_000, invalid)
    socket.on('error', invalid)
    socket.on('connect', () => socket.write(`${nonce}\n`))
    socket.setEncoding('utf8')
    socket.on('data', (part: string) => { output += part; if (output.length > 4_096) invalid() })
    socket.on('end', () => {
      try {
        const response = JSON.parse(output) as { nonce?: string; health?: StudioHealthStatus }
        if (response.nonce !== nonce || !response.health || typeof response.health !== 'object') throw new Error('Invalid challenge response')
        resolve(response.health)
      } catch { invalid() }
    })
    socket.on('close', () => reject(new Error('Studio health connection closed')))
  })
}
