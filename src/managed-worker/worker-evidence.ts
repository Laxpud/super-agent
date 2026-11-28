import { isAbsolute, relative, sep } from 'node:path'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { StudioChangedFile, StudioCheckResult, StudioCommandCheck } from '../studio/protocol.ts'
import { resolveWorkspaceTarget } from './workspace.ts'

const FILE_LIMIT = 64
const CHECK_LIMIT = 32
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** 交付不复制原始工具日志：删除控制序列，隐藏常见凭据，只保留有界文本。 */
function excerpt(value: string, length: number): string {
  // 先掩蔽凭据再截断，不能因只截到一半而留下 token 前缀。
  const text = value.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, '[redacted private key]')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\b(?:Bearer|Basic)\s+[^\s'",;]+/giu, '[redacted authorization]')
    .replace(/(\b(?:[\w-]*(?:secret|token|password|api[-_]?key|credential)[\w-]*|authorization)["']?(?:\s*[:=]\s*|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, '$1[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|sk-[\w-]{12,}|AKIA[A-Z0-9]{16})\b/gu, '[redacted]')
  return text.length > length ? `${text.slice(0, length - 1).toWellFormed()}…` : text.toWellFormed()
}

function withinWorkspace(root: string, target: string, protectedRoots: readonly string[]): string | undefined {
  if (!isAbsolute(target)) return
  try { return resolveWorkspaceTarget(root, target, { mode: 'dir', protectedRoots }) }
  catch { return undefined }
}

/** 仅保存工具种类与请求的数据类别；被拒绝的命令、路径、补丁和额外参数不进入通知。 */
export function summarizeGuardAction(name: string): string {
  switch (name) {
    case 'bash': case 'pwsh': return `${name} · shell 命令（参数已隐藏）`
    case 'write': case 'edit': return `${name} · 文件修改（路径和内容已隐藏）`
    case 'read': case 'read_image': return `${name} · 文件读取（路径已隐藏）`
    case 'grep': case 'glob': case 'studio_list_directory': return `${name} · 文件查询（路径和查询参数已隐藏）`
    default: return '本地工具动作（参数已隐藏）'
  }
}

export interface ObservedTool { name: string; arguments: unknown; signal: AbortSignal }

/** 每个实例只属于一个 Worker 执行轮次；它不会读取模型正文或展示层工具 Markdown。 */
export class WorkerEvidence {
  private readonly changedFiles: StudioChangedFile[] = []
  private readonly checks: StudioCommandCheck[] = []
  private readonly fileKeys = new Set<string>()
  private omittedChangedFiles = 0
  private omittedChecks = 0
  private failed = false

  constructor(private readonly root: string | null, private readonly protectedRoots: readonly string[]) {}

  /** 候选工作目录在执行前规范化；错误结果可能没有 cwd，不能从模型的错误描述反推它。 */
  shellWorkdir(exec: ObservedTool): string | undefined {
    if (this.root === null || (exec.name !== 'bash' && exec.name !== 'pwsh')) return
    const args = record(exec.arguments)
    if (typeof args?.command !== 'string') return
    try { return resolveWorkspaceTarget(this.root, typeof args.workdir === 'string' ? args.workdir : undefined,
      { mode: 'dir', protectedRoots: this.protectedRoots, allowMissingDefaultRoot: true }) }
    catch { return undefined }
  }

  observe(exec: ObservedTool, result: Readonly<ToolExecutionResult>, shellWorkdir: string | undefined): void {
    if (this.root === null) return
    const value = result.isError ? undefined : record(result.value)
    if (exec.name === 'write' || exec.name === 'edit') {
      if (typeof value?.path !== 'string' || !isAbsolute(value.path) || typeof value.after !== 'string'
        || (typeof value.before !== 'string' && value.before !== null) || value.before === value.after) return
      let path: string
      try { path = relative(this.root, resolveWorkspaceTarget(this.root, value.path, { mode: 'write', protectedRoots: this.protectedRoots })).split(sep).join('/') }
      catch { return }
      const key = `${exec.name}\0${path}`
      if (this.fileKeys.has(key)) return
      this.fileKeys.add(key)
      if (this.changedFiles.length < FILE_LIMIT) this.changedFiles.push({ path, action: exec.name })
      else this.omittedChangedFiles++
      return
    }
    if (!shellWorkdir || (exec.name !== 'bash' && exec.name !== 'pwsh')) return
    const command = record(exec.arguments)?.command
    if (typeof command !== 'string') return
    const foreground = value?.kind === 'foreground' ? value : undefined
    const actualCwd = typeof foreground?.cwd === 'string' ? withinWorkspace(this.root, foreground.cwd, this.protectedRoots) : undefined
    const exitCode = typeof foreground?.exitCode === 'number' && Number.isSafeInteger(foreground.exitCode) ? foreground.exitCode : null
    const signal = typeof foreground?.signal === 'string' ? excerpt(foreground.signal, 80) : null
    const code = result.isError ? result.error.info?.code : undefined
    const timedOut = foreground?.timedOut === true || value?.kind === 'promoted'
      || code === 'TIMEOUT' || code === 'TOOL_TIMEOUT' || (exec.signal.aborted && exec.signal.reason?.name === 'TimeoutError')
    const aborted = foreground?.aborted === true || foreground?.stopped !== undefined || exec.signal.aborted
      || code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH'
    const sandbox = record(foreground?.sandbox)
    const sandboxFailed = sandbox?.denied === true || sandbox?.runnerFailed === true
    const passed = !result.isError && !!actualCwd && exitCode === 0 && foreground?.signal === null && !timedOut && !aborted && !sandboxFailed
      && foreground.timedOut === false && foreground.aborted === false && foreground.error == null
    this.failed ||= !passed
    if (this.checks.length >= CHECK_LIMIT) { this.omittedChecks++; return }
    const output = (key: 'stdout' | 'stderr') => {
      const stream = record(foreground?.[key])
      const text = typeof stream?.text === 'string' ? excerpt(stream.text, 800) : ''
      return text || stream?.truncated === true ? `${key}: ${text}${stream?.truncated === true ? '\n[原生工具已截断输出]' : ''}` : ''
    }
    const notes = [output('stdout'), output('stderr'), result.isError ? excerpt(result.error.message, 400) : '',
      sandboxFailed ? 'Native sandbox denied the command or its runner failed.' : '',
      !result.isError && !actualCwd ? 'No confirmed foreground process result.' : ''].filter(Boolean)
    this.checks.push({ command: excerpt(command, 512), workdir: actualCwd ?? shellWorkdir, exitCode, signal, timedOut, aborted,
      status: passed ? 'passed' : 'failed', output: excerpt(notes.join('\n'), 1_200) })
  }

  /** 返回快照，使后续到达的工具事件不能改变已经准备提交的收据。 */
  result(): StudioCheckResult | undefined {
    if (this.root === null) return
    return { version: 1, changedFiles: [...this.changedFiles], checks: [...this.checks],
      overallCheckStatus: this.failed ? 'failed' : this.checks.length ? 'passed' : 'not_run',
      ...(this.omittedChecks ? { omittedChecks: this.omittedChecks } : {}),
      ...(this.omittedChangedFiles ? { omittedChangedFiles: this.omittedChangedFiles } : {}) }
  }
}
