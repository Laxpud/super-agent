import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, appendFileSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { canonicalDirectory, within } from './self-update-files.ts'

/** 子进程不继承宿主环境；只提供受信工具路径、区域以及显式配置的 profile 坐标。 */
export function minimalEnvironment(): NodeJS.ProcessEnv {
  const paths = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  return { PATH: [...new Set([dirname(process.execPath), ...paths, '/usr/bin', '/bin'])].join(delimiter), LANG: 'C.UTF-8' }
}

function executable(name: string, environment: NodeJS.ProcessEnv): string {
  for (const directory of environment.PATH!.split(delimiter)) {
    try {
      const path = realpathSync(join(directory, name))
      accessSync(path, constants.X_OK)
      if (lstatSync(path).isFile()) return path
    } catch { /* 按可信宿主 PATH 搜索绝对工具入口。 */ }
  }
  throw new Error(`Required Studio update tool unavailable: ${name}`)
}

export function verifySource(root: string): void {
  canonicalDirectory(root)
  if (!['package.json', 'cordis.patch.yml', 'tsdown.config.ts', 'pnpm-lock.yaml', 'src/managed-worker/index.ts', 'src/studio-web/index.tsx']
    .every(name => realpathSync(join(root, name)) === join(root, name) && lstatSync(join(root, name)).isFile())) throw new Error('Incomplete Studio source repository')
  if ((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }).name !== 'agent-studio') {
    throw new Error('Studio source package name does not match')
  }
}

/** 复制 Git 跟踪和未忽略的工作树字节，包括实际未提交修改；不转移 git 元数据、忽略文件或现有产物。 */
function snapshot(source: string, target: string, env: NodeJS.ProcessEnv): { sourceHead: string; sourceFingerprint: string } {
  const git = executable('git', env)
  const run = (args: string[]) => execFileSync(git, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-C', source, ...args], { env, encoding: 'utf8', timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 })
  if (run(['rev-parse', '--show-toplevel']).trim() !== source) throw new Error('Registered source must be the Git repository root')
  const head = () => run(['rev-parse', '--verify', 'HEAD']).trim()
  const sourceHead = head()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceHead)) throw new Error('Cannot verify Studio Git HEAD')
  const paths = () => [...new Set(run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))]
    .filter(path => !/^(?:\.git|node_modules|lib|studio-web\/lib)(?:\/|$)/u.test(path)).sort()
  const entries = paths()
  const digest = createHash('sha256')
  const read = (path: string) => {
    const absolute = resolve(source, path)
    if (!within(source, absolute) || absolute !== join(source, path)) throw new Error('Invalid Studio source entry')
    const stat = lstatSync(absolute, { throwIfNoEntry: false })
    if (!stat) return undefined // 工作树中的未提交删除也属于快照。
    if (!stat.isFile() || realpathSync(absolute) !== absolute) throw new Error('Studio source snapshot cannot contain links or special files')
    return { mode: stat.mode & 0o111 ? 0o700 : 0o600, bytes: readFileSync(absolute) }
  }
  const entriesDigest = new Map<string, string>()
  for (const path of entries) {
    const file = read(path)
    if (!file) continue
    const sha = createHash('sha256').update(file.bytes).digest('hex')
    const coordinate = JSON.stringify([path, file.mode, sha])
    entriesDigest.set(path, coordinate)
    digest.update(`${coordinate}\n`)
    const output = join(target, path)
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
    writeFileSync(output, file.bytes, { flag: 'wx', mode: file.mode })
  }
  if (head() !== sourceHead || JSON.stringify(paths()) !== JSON.stringify(entries)) throw new Error('Studio source changed during snapshot')
  for (const path of entries) {
    const file = read(path)
    const now = file && JSON.stringify([path, file.mode, createHash('sha256').update(file.bytes).digest('hex')])
    if (now !== entriesDigest.get(path)) throw new Error('Studio source changed during snapshot')
  }
  verifySource(target)
  return { sourceHead, sourceFingerprint: digest.digest('hex') }
}

export interface PrecheckResult { exitCode: number | null; sourceHead: string; sourceFingerprint: string }
export type RunStudioPrecheck = (source: string, workspace: string, log: string, buildId: string, signal: AbortSignal) => Promise<PrecheckResult>

async function runCommand(path: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, signal: AbortSignal): Promise<number | null> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let logged = 0
    let forced: NodeJS.Timeout | undefined
    const send = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name) } catch { /* 构建组已退出。 */ } }
    const abort = () => { if (!forced) { send('SIGTERM'); forced = setTimeout(() => send('SIGKILL'), 2_000) } }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const output = (part: Buffer) => {
      if (logged >= 8 * 1024 * 1024) return
      logged += part.length
      try { appendFileSync(log, part) } catch { if (!forced) abort() }
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.once('error', reject)
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      clearTimeout(forced)
      resolve(signal.aborted || forced ? null : code)
    })
  })
}

/** 门禁在新建 HOME、依赖仓和工作树运行；按锁文件取依赖，不执行依赖生命周期脚本。 */
export const runStudioPrecheck: RunStudioPrecheck = async (source, workspace, log, buildId, requestSignal) => {
  const home = join(dirname(workspace), 'build-home')
  mkdirSync(home, { mode: 0o700 })
  const store = join(home, 'pnpm-store')
  const hostCache = process.env.COREPACK_HOME || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'node', 'corepack')
  const env = { ...minimalEnvironment(), HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'), GIT_CONFIG_NOSYSTEM: '1', AGENT_STUDIO_BUILD_ID: buildId, CI: 'true',
    COREPACK_HOME: hostCache, COREPACK_ENABLE_NETWORK: '0', npm_config_store_dir: store }
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10 * 60_000)])
  const receipt = snapshot(source, workspace, env)
  const pnpm = executable('pnpm', env)
  const dependencies = await runCommand(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', store], workspace, env, log, signal)
  if (dependencies !== 0) return { exitCode: dependencies, ...receipt }
  return { exitCode: await runCommand(pnpm, ['check'], workspace, env, log, signal), ...receipt }
}
