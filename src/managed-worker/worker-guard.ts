import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import type { StudioWorkerPermission } from '../studio/protocol.ts'
import { assertWorkspaceTraversal, resolveWorkspaceTarget, verifyWorkspaceIdentity, workspaceGitConfigSafe, WORKSPACE_LIST_LIMIT, WorkspacePathError,
  type WorkspaceIdentity, type WorkspaceTargetMode } from './workspace.ts'

export type WorkerGuardDenyCode =
  | 'STUDIO_EXECUTION_INACTIVE'
  | 'STUDIO_TOOL_FORBIDDEN'
  | 'STUDIO_ESCALATION_FORBIDDEN'
  | 'STUDIO_INVALID_ARGUMENTS'
  | 'STUDIO_OUTSIDE_WORKSPACE'
  | 'STUDIO_HIGH_IMPACT_FORBIDDEN'
  | 'STUDIO_READ_ONLY_VIOLATION'
  | 'STUDIO_SANDBOX_MISMATCH'

export interface WorkerGuardDenial { code: WorkerGuardDenyCode; reason: string; needsOwnerDecision: boolean }
export interface WorkerGuardExecution {
  active: boolean
  signal: AbortSignal
  workspacePath: string | null
  workspaceIdentity?: WorkspaceIdentity
  permission: StudioWorkerPermission
}
export interface WorkerSandboxPolicy { mode: string; workspaceRoot?: string; additionalWritableRoots?: readonly string[] }
export interface WorkerGuardInput {
  name: string
  arguments: unknown
  execution?: WorkerGuardExecution
  signal?: AbortSignal
  parent?: unknown
  protectedRoots: readonly string[]
  sandbox?: WorkerSandboxPolicy
  sessionDirectoryMatches?: boolean
}

export const STUDIO_LIST_DIRECTORY = 'studio_list_directory'
const READ_TOOLS = [STUDIO_LIST_DIRECTORY, 'read', 'read_image', 'glob', 'grep'] as const
const WRITE_TOOLS = ['write', 'edit'] as const
const ALWAYS_FORBIDDEN = new Set(['apply_patch', 'job_output', 'job_kill', 'job_list', 'pwsh'])

/** 工具展示与执行共用一份档位清单；没有绑定时不展示任何本地工具。 */
export function workerToolAllowlist(workspacePath: string | null, permission: StudioWorkerPermission): string[] {
  return workspacePath === null ? [] : [...READ_TOOLS, ...(permission === 'workspace-write' ? [...WRITE_TOOLS, 'bash'] : [])]
}

/** 使用 DSH 实际解析的策略而非预设标签；拒绝工作区之外的显式附加写入授权。 */
export function workerSandboxMatches(policy: WorkerSandboxPolicy | undefined, execution: Pick<WorkerGuardExecution, 'permission' | 'workspacePath'>): boolean {
  return (policy?.mode === 'read-only' || policy?.mode === 'workspace-write') && policy.mode === execution.permission
    && (execution.workspacePath === null || policy.workspaceRoot === undefined || policy.workspaceRoot === execution.workspacePath)
    && (policy.mode !== 'workspace-write' || !policy.additionalWritableRoots?.length)
}

const deny = (code: WorkerGuardDenyCode, detail: string, needsOwnerDecision = false): WorkerGuardDenial =>
  ({ code, reason: `Studio tool denied (${code}): ${detail}`, needsOwnerDecision })
const invalid = (detail: string) => deny('STUDIO_INVALID_ARGUMENTS', detail)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed() && !value.includes('\0')
const nonblank = (value: unknown): value is string => text(value) && !!value.trim()
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const optional = (value: unknown, test: (value: unknown) => boolean) => value === undefined || test(value)

/** 同步核验工具权限、实际沙箱和目标；返回拒绝只记录原因，不提升权限或启动执行。 */
export function evaluateWorkerToolCall(input: WorkerGuardInput): WorkerGuardDenial | undefined {
  const { arguments: args, execution, name, protectedRoots } = input
  if (!execution?.active || execution.signal.aborted || input.signal?.aborted) {
    return deny('STUDIO_EXECUTION_INACTIVE', 'No current Studio Worker execution authorizes this call.')
  }
  const { permission, workspacePath: root } = execution
  if (permission === 'read-only' && (name === 'bash' || name === 'pwsh')) {
    return deny('STUDIO_READ_ONLY_VIOLATION', 'Shell tools are not authorized for read-only tasks.', true)
  }
  if (args !== null && typeof args === 'object' && (Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification'))) {
    return deny('STUDIO_ESCALATION_FORBIDDEN', 'Managed Workers cannot request sandbox escalation.')
  }
  if (input.parent !== undefined || ALWAYS_FORBIDDEN.has(name) || root === null) {
    return deny('STUDIO_TOOL_FORBIDDEN', 'This tool is not available to the current Studio Worker execution.')
  }
  if (permission === 'read-only' && (name === 'write' || name === 'edit')) {
    return deny('STUDIO_READ_ONLY_VIOLATION', 'The task is authorized for read-only work.', true)
  }
  if (!workerToolAllowlist(root, permission).includes(name)) return deny('STUDIO_TOOL_FORBIDDEN', 'The tool is not on the Worker allowlist.')
  if (!workerSandboxMatches(input.sandbox, execution) || input.sessionDirectoryMatches === false) {
    return deny('STUDIO_SANDBOX_MISMATCH', 'The native sandbox or Session working directory does not match the task authority.')
  }
  if (!isRecord(args)) return invalid('Expected an object of named tool arguments.')
  if (!verifyWorkspaceIdentity(root, execution.workspaceIdentity)) {
    return deny('STUDIO_OUTSIDE_WORKSPACE', 'The bound workspace directory changed or is unavailable.', true)
  }

  try {
    if (name === 'bash') return checkShell(args, root, protectedRoots)
    if (name === STUDIO_LIST_DIRECTORY || name === 'glob' || name === 'grep') {
      if (!optional(args.path, nonblank)) return invalid('path must be a non-empty string when supplied.')
      if (name === STUDIO_LIST_DIRECTORY) {
        if (!optional(args.limit, value => positive(value) && value <= WORKSPACE_LIST_LIMIT)) return invalid('Invalid directory listing limit.')
      } else if (!nonblank(args.pattern) || (name === 'grep' && !optional(args.include, text))) {
        return invalid('Search requires a non-empty pattern and an optional string include filter.')
      }
      resolveWorkspaceTarget(root, args.path as string | undefined, { mode: name === STUDIO_LIST_DIRECTORY ? 'dir' : 'search', protectedRoots,
        allowMissingDefaultRoot: true })
    } else {
      if (!nonblank(args.file_path)) return invalid('file_path must be a non-empty string.')
      const mode = name === 'write' ? 'create' : name === 'edit' ? 'write' : 'read'
      resolveWorkspaceTarget(root, args.file_path, { mode, protectedRoots })
      if ((name === 'read' && (!optional(args.offset, positive) || !optional(args.limit, positive)))
        || (name === 'write' && !text(args.content))
        || (name === 'edit' && (!text(args.old_string) || !args.old_string || !text(args.new_string) || args.old_string === args.new_string
          || !optional(args.replace_all, value => typeof value === 'boolean')))) return invalid(`Invalid arguments for ${name}.`)
    }
  } catch (error) {
    if (error instanceof WorkspacePathError) return error.code === 'STUDIO_OUTSIDE_WORKSPACE'
      ? deny('STUDIO_OUTSIDE_WORKSPACE', error.message, true) : invalid(error.message)
    return invalid('The workspace target could not be verified.')
  }
}

/** 递归排序 JSON 对象键，保证同一工具、参数与拒绝码不因键的传输顺序而重复登记。 */
export function guardActionFingerprint(toolName: string, args: unknown, code: WorkerGuardDenyCode): string {
  const json = JSON.stringify([toolName, args, code], (_key, value: unknown) => isRecord(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  return createHash('sha256').update(json).digest('hex')
}

/** 不解释 shell 语言，而是识别一个更小的字面 argv 子集；不能无歧义解析的输入一律拒绝。 */
function literalCommand(input: string): string[] | undefined {
  if (/[\r\n\v\f|><;&$`()\\]/u.test(input)) return
  const result: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === ' ' || char === '\t') {
      if (word !== undefined) result.push(word)
      word = undefined
    } else {
      if (/[*?\[\]{}#!]/u.test(char)) return
      word = (word ?? '') + char
    }
  }
  if (quote !== undefined) return
  if (word !== undefined) result.push(word)
  return result.length ? result : undefined
}

const checkScripts = new Set(['check', 'test', 'typecheck', 'build', 'lint'])
const checkBins = new Set(['vitest', 'tsc', 'eslint', 'prettier'])
const developmentBins = new Set(['pnpm', 'npm', 'yarn', 'npx', ...checkBins])
const external = new Set(['sudo', 'su', 'doas', 'pkexec', 'systemctl', 'service', 'dsh', 'tmux', 'curl', 'wget',
  'ssh', 'scp', 'rsync', 'nc', 'ncat', 'socat'])
const wrappers = new Set(['bash', 'sh', 'zsh', 'dash', 'eval', 'exec', 'env', 'python', 'python3', 'node'])
const highImpactFileCommands = new Set(['rm', 'mv', 'cp'])

type CheckPath = (value: string, mode: WorkspaceTargetMode) => string

function checkShell(args: Record<string, unknown>, root: string, protectedRoots: readonly string[]): WorkerGuardDenial | undefined {
  const { command, workdir, run_in_background, timeoutMs, description } = args
  if (!nonblank(command) || !optional(workdir, nonblank) || !optional(run_in_background, value => typeof value === 'boolean')
    || !optional(timeoutMs, value => positive(value) && value <= 120_000) || !optional(description, nonblank)) return invalid('Invalid bash arguments.')
  const restricted = (detail: string) => deny('STUDIO_HIGH_IMPACT_FORBIDDEN', detail, true)
  if (run_in_background === true) return restricted('Background shell jobs are not allowed.')
  const argv = literalCommand(command)
  if (!argv) return restricted('Use one literal command: shell operators, expansion, wrappers and unquoted patterns are not supported.')
  const [bin = '', ...rest] = argv
  if (rest.some(arg => /^~|^[\\/]{2}|^[A-Za-z]:[\\/]/u.test(arg))) return restricted('Home expansion and device or UNC paths are not allowed.')
  if (highImpactFileCommands.has(bin)) return restricted('Shell deletion, moving and copying are forbidden. Use write or edit for permitted file changes.')
  if (external.has(bin) || wrappers.has(bin) || /(?:^|\/)scripts\/agent-studio$/u.test(bin)) {
    return restricted('Privilege changes, service control, external commands and shell wrappers are forbidden.')
  }
  const cwd = resolveWorkspaceTarget(root, workdir as string | undefined, { mode: 'dir', protectedRoots, allowMissingDefaultRoot: true })
  const checkPath: CheckPath = (value, mode) => {
    if (!nonblank(value) || value === '-') throw new WorkspacePathError('STUDIO_WORKSPACE_INVALID', 'Expected a literal workspace path.')
    return resolveWorkspaceTarget(root, isAbsolute(value) ? value : `${cwd}${sep}${value}`, { mode, protectedRoots })
  }
  const checked = (paths: string[], mode: WorkspaceTargetMode) => { for (const path of paths) checkPath(path, mode) }
  switch (bin) {
    case 'pwd':
      if (rest.every(arg => /^-[LP]$/u.test(arg))) return
      break
    case 'ls': {
      const paths = onlyFlags(rest, /^(?:-[aAlt1hFdpSciUu]+|--(?:all|almost-all|directory|human-readable|classify|color=(?:never|auto|always)))$/u)
      if (paths) { for (const path of paths) checkDirectEntry(checkPath, path, cwd, root, protectedRoots); return }
      break
    }
    case 'wc': {
      const paths = onlyFlags(rest, /^(?:-[cmlwL]+|--(?:bytes|chars|lines|words|max-line-length))$/u)
      if (paths?.length) { checked(paths, 'read'); return }
      break
    }
    case 'git': {
      assertWorkspaceTraversal(root, protectedRoots)
      if (!checkGitDirectory(cwd, root, protectedRoots)) return restricted('Git repository metadata or config is outside the workspace or unsafe.')
      if (checkGit(rest, checkPath, cwd)) return
      return restricted('Only git status, diff, log, show and add with safe local arguments are allowed.')
    }
    case 'find':
      if (checkFind(rest, checkPath)) return
      break
    case 'rg':
      if (checkRg(rest, checkPath)) return
      break
    case 'pnpm': case 'npm': case 'yarn': case 'npx': case 'vitest': case 'tsc': case 'eslint': case 'prettier':
      if (checkDevelopmentCommand(bin, rest, checkPath, cwd)) { assertWorkspaceTraversal(root, protectedRoots); return }
      return restricted('Only local check, test, typecheck, build or lint commands are allowed; installs, publishes and arbitrary runners are forbidden.')
    case 'mkdir': {
      const paths = onlyFlags(rest, /^(?:-p|--parents)$/u)
      if (!paths?.length) break
      try {
        if (paths.some(path => path.split(/[\\/]/u).includes('..'))) return restricted('Directory creation may not contain parent path segments.')
        checked(paths, 'create')
      } catch (error) {
        if (error instanceof WorkspacePathError) return restricted(error.message)
        throw error
      }
      return
    }
  }
  return restricted('This command or option is not on the Studio shell allowlist.')
}

/** 选项必须是明确允许的完整 token；`--` 之后只能是位置参数，拒绝任何未知选项。 */
function onlyFlags(args: readonly string[], flags: RegExp): string[] | undefined {
  const paths: string[] = []
  let positions = false
  for (const arg of args) {
    if (!positions && arg === '--') { positions = true; continue }
    if (positions || !/^-./u.test(arg)) paths.push(arg)
    else if (!flags.test(arg)) return
  }
  return paths
}

function checkDirectEntry(checkPath: CheckPath, path: string, cwd: string, root: string, protectedRoots: readonly string[]): void {
  // ls 不递归；目录参数不用采用禁止受保护后代的 search 模式。
  const target = isAbsolute(path) ? path : `${cwd}${sep}${path}`
  try { resolveWorkspaceTarget(root, target, { mode: 'dir', protectedRoots }) }
  catch (error) {
    if (!(error instanceof WorkspacePathError) || error.code === 'STUDIO_OUTSIDE_WORKSPACE') throw error
    checkPath(path, 'read')
  }
}

function checkGit(args: string[], checkPath: CheckPath, cwd: string): boolean {
  const [verb, ...options] = args
  if (verb !== 'status' && verb !== 'diff' && verb !== 'log' && verb !== 'show' && verb !== 'add') return false
  const separator = options.indexOf('--')
  const flags = separator === -1 ? options : options.slice(0, separator)
  const paths = separator === -1 ? [] : options.slice(separator + 1)
  const common = /^(?:--(?:no-pager|no-ext-diff|no-textconv|no-color|stat|name-only|name-status|oneline|cached|staged|patch|shortstat|summary|check|decorate|no-decorate|abbrev-commit|no-patch|all|graph|reverse)|-[0-9]{1,5}|-n[0-9]{1,5}|-[pUs]|-U[0-9]{1,5}|--max-count=[0-9]{1,5})$/u
  for (const option of flags) {
    if (verb === 'status' && /^(?:-[sbu]|--(?:short|branch|porcelain(?:=v[12])?|untracked-files(?:=(?:no|normal|all))?))$/u.test(option)
      || verb === 'add' && /^(?:-[Anuv]|--(?:all|update|dry-run|verbose))$/u.test(option)
      || verb !== 'status' && verb !== 'add' && common.test(option)) continue
    if (/^-/u.test(option)) return false
    if (verb === 'status' || verb === 'add') paths.push(option)
    else if (!/^(?:[A-Za-z0-9_][\w./~^{}-]*)(?::[\w./-]+)?$/u.test(option)) return false
    else {
      const [rev, object] = option.split(':')
      if (object !== undefined) {
        if (object.split('/').includes('..') || isAbsolute(object)) return false
        checkPath(object, 'read')
      } else if (rev) {
        if (rev.split('/').includes('..')) return false
        if (pathPresent(join(cwd, rev)) || rev.includes('/') && !/^refs\//u.test(rev)) paths.push(rev)
      }
    }
  }
  // Git pathspec 魔法、排除规则与通配符会绕过实参的字面路径校验。
  for (const path of paths) {
    if (/[:*?\[\]]/u.test(path)) return false
    checkPath(path, 'search')
  }
  return true
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
}

/** Git 可沿父路径寻找仓库；只接受工作区内的真实仓库目录，不解析 gitfile 指向的工作树。 */
function checkGitDirectory(cwd: string, root: string, protectedRoots: readonly string[]): boolean {
  const bare = (path: string) => ['HEAD', 'objects', 'refs'].every(entry => pathPresent(join(path, entry)))
  let inScope = true
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    if (pathPresent(dotGit) || bare(dir)) {
      if (!inScope) return false
      const gitDir = pathPresent(dotGit) ? dotGit : dir
      return workspaceGitConfigSafe(root, gitDir, protectedRoots)
    }
    if (dirname(dir) === dir) return true
    if (dir === root) inScope = false
  }
}

function checkFind(args: string[], checkPath: CheckPath): boolean {
  const paths: string[] = []
  let expressions = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!
    if (/^-/u.test(token)) expressions = true
    if (!expressions) { paths.push(token); continue }
    if (token === '-print') continue
    const value = args[++i]
    if (value === undefined || !(token === '-name' || token === '-iname' || token === '-path'
      || token === '-type' && /^[fdl]$/u.test(value) || (token === '-maxdepth' || token === '-mindepth') && /^[0-9]{1,3}$/u.test(value))) return false
  }
  for (const path of paths.length ? paths : ['.']) checkPath(path, 'search')
  return true
}

function checkRg(args: string[], checkPath: CheckPath): boolean {
  const positional: string[] = []
  let literal = false
  let explicitPattern = false
  let files = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (literal || !/^-./u.test(arg)) positional.push(arg)
    else if (arg === '--') literal = true
    else if (arg === '--files') files = true
    else if (arg === '-e' || arg === '--regexp' || arg === '-g' || arg === '--glob') {
      if (!args[++i]) return false
      if (arg === '-e' || arg === '--regexp') explicitPattern = true
    } else if (!/^(?:-[nSivFwlc]+|--(?:hidden|no-ignore|no-heading|line-number|files-with-matches|count|fixed-strings|ignore-case|smart-case|no-config|glob=.+|max-count=[0-9]+))$/u.test(arg)) return false
  }
  if (files && explicitPattern || !files && !explicitPattern && !positional.length) return false
  // 只要 argv 任一位置使用 -e，所有位置参数都变成路径；不先按位置猜测 pattern。
  const paths = files || explicitPattern ? positional : positional.slice(1)
  for (const path of paths.length ? paths : ['.']) checkPath(path, 'search')
  return true
}

function developmentInvocation(bin: string, args: string[]) {
  if (!developmentBins.has(bin)) return
  let command = bin
  if (bin === 'pnpm' || bin === 'npm' || bin === 'yarn') {
    const exec = bin === 'pnpm' && args[0] === 'exec'
    if (args[0] === 'run' || exec) args = args.slice(1)
    command = args[0] ?? ''
    args = args.slice(1)
    if (!exec && checkScripts.has(command)) return { command, args, script: true }
    if (bin !== 'pnpm') return
  } else if (bin === 'npx') {
    if (args[0] === '--no-install') args = args.slice(1)
    command = args[0] ?? ''
    args = args.slice(1)
  }
  if (checkBins.has(command)) return { command, args, script: false }
}

/** 只有允许的开发检查才进入结果统计；查看帮助、版本或仅格式化输出不算运行检查。 */
export function isWorkerCheckCommand(commandLine: string): boolean {
  const argv = literalCommand(commandLine)
  if (!argv) return false
  const [bin = '', ...args] = argv
  const invocation = developmentInvocation(bin, args)
  return !!invocation && (invocation.script || (!invocation.args.some(arg => /^(?:--(?:help|version)|-[vh])$/u.test(arg))
    && (invocation.command !== 'prettier' || invocation.args.includes('--check'))))
}

function checkDevelopmentCommand(bin: string, rest: string[], checkPath: CheckPath, cwd: string): boolean {
  const invocation = developmentInvocation(bin, rest)
  if (!invocation) return false
  const { command, script } = invocation
  let { args } = invocation
  if (script) return args.every(arg => /^(?:--run|--watch=false|--noEmit|--pretty=false)$/u.test(arg))
  // npx 默认可能在线下载安装；只允许调用工作区内已安装的对应二进制。
  if (bin === 'npx') checkPath(join(cwd, 'node_modules', '.bin', command), 'read')
  if (command === 'vitest' && args[0] === 'run') args = args.slice(1)
  const paths = onlyFlags(args, /^(?:--(?:run|watch=false|noEmit|pretty=false|check|version|help)|-[vh])$/u)
  if (!paths) return false
  for (const path of paths) checkPath(path, 'search')
  return true
}
