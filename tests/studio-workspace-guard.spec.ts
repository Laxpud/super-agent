import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { StudioAssistant, WORKER_PRESET } from '../src/managed-worker/assistant.ts'
import { Config } from '../src/managed-worker/index.ts'
import { ManagedWorkerStore, type StudioExecution } from '../src/managed-worker/store.ts'
import { WorkerModelPolicy } from '../src/managed-worker/text-worker-model-policy.ts'
import { summarizeGuardAction, WorkerEvidence, type ObservedTool } from '../src/managed-worker/worker-evidence.ts'
import { evaluateWorkerToolCall, guardActionFingerprint, workerToolAllowlist, type WorkerGuardInput } from '../src/managed-worker/worker-guard.ts'
import { canonicalizeWorkspaceRoot, listWorkspaceDirectory, protectedHostRoots, resolveWorkspaceTarget, verifyWorkspaceIdentity,
  type WorkspaceTargetMode } from '../src/managed-worker/workspace.ts'
import { studioTaskText } from '../src/studio/domain.ts'
import { ASSISTANT_CONVERSATION, GUARD_PENDING_CHOICES, WORKER_DELEGATE, type StudioWorkerPermission } from '../src/studio/protocol.ts'
import { StudioService } from '../src/studio/service.ts'
import { studioOwnerMessageId } from '../src/studio/source.ts'

const assistantRoom = ASSISTANT_CONVERSATION
const scope = 'verified-offline-private-chat'
const model = { provider: 'fixture', model: 'worker' }
const signal = new AbortController().signal
const noop = () => {}
const disposer = () => noop

function workspaceFixture() {
  const parent = realpathSync(tmpdir())
  const dir = mkdtempSync(join(parent, 'studio-workspace-guard-'))
  onTestFinished(() => {
    if (realpathSync(dir) !== dir) throw new Error('Refusing to clean up a different fixture path')
    rmSync(dir, { recursive: true, force: true })
  })
  const root = join(dir, 'workspace'), sibling = join(dir, 'workspace-sibling'), stateDir = join(dir, 'state')
  for (const path of [root, sibling, stateDir, join(root, 'a')]) mkdirSync(path)
  const file = join(root, 'a', 'note.txt'), outside = join(sibling, 'outside.txt')
  writeFileSync(file, 'fixture line\n')
  writeFileSync(outside, 'outside sentinel\n')
  const protectedRoots = protectedHostRoots(stateDir)
  const binding = canonicalizeWorkspaceRoot(root, protectedRoots)
  return { dir, root, sibling, stateDir, file, outside, binding, protectedRoots,
    target: (path: string, mode: WorkspaceTargetMode) => resolveWorkspaceTarget(root, path, { mode, protectedRoots }) }
}

const invalidWorkspace = expect.objectContaining({ code: 'STUDIO_WORKSPACE_INVALID' })
const outsideWorkspace = expect.objectContaining({ code: 'STUDIO_OUTSIDE_WORKSPACE' })

describe('Studio workspace validation', () => {
  it('canonicalizes an existing directory alias and fences replacement by device and inode', () => {
    const f = workspaceFixture()
    const link = join(f.dir, 'alias')
    symlinkSync(f.root, link, 'dir')
    const { dev, ino } = statSync(f.root)
    expect(canonicalizeWorkspaceRoot(`${link}/a/..`, f.protectedRoots)).toEqual({ root: f.root, dev, ino })
    expect(verifyWorkspaceIdentity(f.root, f.binding)).toBe(true)
    expect(verifyWorkspaceIdentity(link, f.binding)).toBe(false)
    expect(verifyWorkspaceIdentity(f.root, { dev: dev + 1, ino })).toBe(false)
    const original = join(f.dir, 'original-workspace')
    renameSync(f.root, original)
    mkdirSync(f.root)
    expect(verifyWorkspaceIdentity(f.root)).toBe(true)
    expect(verifyWorkspaceIdentity(f.root, f.binding)).toBe(false)
  })

  it.each([
    ['empty', () => '', invalidWorkspace], ['relative', () => 'workspace', invalidWorkspace],
    ['NUL', () => '/tmp/studio\0suffix', invalidWorkspace], ['tilde', () => '~', outsideWorkspace],
    ['missing', (f: ReturnType<typeof workspaceFixture>) => join(f.dir, 'missing'), invalidWorkspace],
    ['file', (f: ReturnType<typeof workspaceFixture>) => f.file, invalidWorkspace],
    ['filesystem root', () => '/', outsideWorkspace], ['home', () => homedir(), outsideWorkspace],
  ] as const)('rejects a binding to %s', (_kind, path, error) => {
    const f = workspaceFixture()
    expect(() => canonicalizeWorkspaceRoot(path(f), f.protectedRoots)).toThrow(error)
  })

  it('protects existing .ssh, .dsh and state directories by both lexical and physical paths', () => {
    const f = workspaceFixture()
    const home = join(f.dir, 'home')
    mkdirSync(home)
    mkdirSync(join(home, '.ssh'))
    symlinkSync(f.sibling, join(home, '.dsh'), 'dir')
    vi.stubEnv('HOME', home)
    try {
      expect(homedir()).toBe(home)
      const roots = protectedHostRoots(f.stateDir)
      const stateAlias = join(f.dir, 'state-alias')
      symlinkSync(f.stateDir, stateAlias, 'dir')
      for (const path of [home, join(home, '.ssh'), join(home, '.dsh'), f.sibling, f.stateDir, stateAlias]) {
        expect(() => canonicalizeWorkspaceRoot(path, roots)).toThrow(outsideWorkspace)
      }
    } finally { vi.unstubAllEnvs() }
  })

  it.each(['../workspace-sibling/outside.txt', 'a/../../workspace-sibling/outside.txt', '../workspace/a/note.txt'])
  ('rejects traversal even if normalization can bring it back in scope: %s', path => {
    const f = workspaceFixture()
    for (const mode of ['read', 'search', 'create', 'write'] as const) expect(() => f.target(path, mode)).toThrow(outsideWorkspace)
    expect(f.target('a/../a/note.txt', 'read')).toBe(f.file)
  })

  it('rejects an external link for reading, searching and writing, including a path that would leave and reenter the workspace', () => {
    const f = workspaceFixture()
    symlinkSync(f.outside, join(f.root, 'external-file'))
    symlinkSync(f.sibling, join(f.root, 'external-dir'), 'dir')
    symlinkSync(join(f.root, 'a'), join(f.sibling, 'return'), 'dir')
    for (const target of ['external-file', 'external-dir/outside.txt', 'external-dir/return/note.txt', 'external-dir/../a/note.txt']) {
      for (const mode of ['read', 'search', 'write', 'create'] as const) expect(() => f.target(target, mode)).toThrow(outsideWorkspace)
    }
    expect(() => f.target('external-dir', 'search')).toThrow(outsideWorkspace)
    expect(readFileSync(f.outside, 'utf8')).toBe('outside sentinel\n')
  })

  it('rejects internal or dangling links for both edit and create, but accepts a real missing destination', () => {
    const f = workspaceFixture()
    symlinkSync(join(f.root, 'a'), join(f.root, 'dir-link'), 'dir')
    symlinkSync(f.file, join(f.root, 'file-link'))
    symlinkSync(join(f.root, 'not-created'), join(f.root, 'dangling'))
    expect(f.target('file-link', 'read')).toBe(f.file)
    for (const path of ['file-link', 'dir-link/note.txt', 'dangling']) {
      expect(() => f.target(path, 'create')).toThrow(outsideWorkspace)
      expect(() => f.target(path, 'write')).toThrow(outsideWorkspace)
    }
    expect(() => f.target('dir-link/new.txt', 'create')).toThrow(outsideWorkspace)
    expect(() => f.target('dangling', 'read')).toThrow(invalidWorkspace)
    expect(f.target('a/new.txt', 'create')).toBe(join(f.root, 'a', 'new.txt'))
  })

  it('lists sorted direct entries and exposes the external link name, not its target or contents', () => {
    const f = workspaceFixture()
    writeFileSync(join(f.root, 'local.txt'), 'local')
    symlinkSync(f.file, join(f.root, 'internal'))
    symlinkSync(f.sibling, join(f.root, 'external'), 'dir')
    symlinkSync(join(f.sibling, 'missing-secret'), join(f.root, 'external-dangling'))
    expect(listWorkspaceDirectory(f.root, undefined, f.protectedRoots)).toEqual([
      { name: 'a', kind: 'dir' }, { name: 'external', kind: 'external-symlink' },
      { name: 'external-dangling', kind: 'external-symlink' }, { name: 'internal', kind: 'symlink' }, { name: 'local.txt', kind: 'file' },
    ])
    expect(listWorkspaceDirectory(f.root, 'a', f.protectedRoots, 1)).toEqual([{ name: 'note.txt', kind: 'file' }])
    expect(() => listWorkspaceDirectory(f.root, 'external', f.protectedRoots)).toThrow(outsideWorkspace)
  })
})

function guardFixture() {
  const f = workspaceFixture()
  const call = (permission: StudioWorkerPermission, name: string, args: unknown, overrides: Partial<WorkerGuardInput> = {}) =>
    evaluateWorkerToolCall({ name, arguments: args,
      execution: { active: true, signal, permission, workspacePath: f.root, workspaceIdentity: f.binding },
      protectedRoots: f.protectedRoots, sandbox: { mode: permission, workspaceRoot: f.root }, ...overrides })
  return { ...f, call, shell: (permission: StudioWorkerPermission, command: string, args: object = {}) =>
    call(permission, 'bash', { command, ...args }) }
}

describe('Studio Worker tool authority', () => {
  it('denies every known local capability for an active unbound text task', () => {
    const f = guardFixture()
    expect(workerToolAllowlist(null, 'read-only')).toEqual([])
    for (const name of [...workerToolAllowlist(f.root, 'workspace-write'), 'pwsh', 'apply_patch', 'job_output', 'subagent']) {
      const verdict = f.call('read-only', name, {}, { execution: { active: true, signal, permission: 'read-only', workspacePath: null } })
      expect(verdict?.code).toBe('STUDIO_TOOL_FORBIDDEN')
    }
  })

  it.each([
    { sandbox_permissions: 'danger-full-access' }, { sandbox_permissions: 'workspace-write' },
    { sandbox_permissions: undefined }, { justification: '' }, { justification: null },
  ])('rejects an own escalation key, regardless of tool or value (%j)', extra => {
    const f = guardFixture()
    for (const permission of ['read-only', 'workspace-write'] as const) {
      for (const name of [...workerToolAllowlist(f.root, 'workspace-write'), 'unknown']) {
        expect(f.call(permission, name, { ...extra })?.code).toBe('STUDIO_ESCALATION_FORBIDDEN')
      }
    }
    const inherited = Object.assign(Object.create(extra) as object, { file_path: 'a/note.txt' })
    expect(f.call('read-only', 'read', inherited)).toBeUndefined()
  })

  it('allows native reads, searches and only narrow literal shell commands in read-only', () => {
    const f = guardFixture()
    for (const [name, args] of [
      ['studio_list_directory', {}], ['read', { file_path: 'a/note.txt', offset: 1, limit: 2 }],
      ['glob', { path: 'a', pattern: '**/*.txt' }], ['grep', { pattern: 'fixture', path: 'a', include: '*.txt' }],
    ] as const) expect(f.call('read-only', name, args)).toBeUndefined()
    for (const command of ['git status', 'ls', 'ls -la -- a', 'wc -l a/note.txt', 'pwd']) {
      expect(f.shell('read-only', command)).toBeUndefined()
    }
    expect(f.call('read-only', 'write', { file_path: 'new.txt', content: 'new' })?.code).toBe('STUDIO_READ_ONLY_VIOLATION')
    expect(f.call('read-only', 'edit', { file_path: 'a/note.txt', old_string: 'fixture', new_string: 'changed' })?.code)
      .toBe('STUDIO_READ_ONLY_VIOLATION')
  })

  it.each(['ls > a/new.txt', 'ls >> a/new.txt', 'ls | wc -l', 'ls; pwd', 'ls && pwd', 'ls || pwd',
    'ls $(pwd)', 'ls `pwd`', 'ls "$HOME"', 'ls\npwd', 'git -c core.fsmonitor=fixture-helper status'])
  ('does not accept shell syntax or global Git overrides: %s', command => {
    const f = guardFixture()
    expect(f.shell('read-only', command)?.code).toBe('STUDIO_READ_ONLY_VIOLATION')
    expect(f.shell('workspace-write', command)?.code).toBe('STUDIO_HIGH_IMPACT_FORBIDDEN')
  })

  it('allows bound write/edit and local check commands without executing them', () => {
    const f = guardFixture()
    const bins = join(f.root, 'node_modules', '.bin')
    mkdirSync(bins, { recursive: true })
    writeFileSync(join(bins, 'tsc'), '', { mode: 0o755 })
    expect(f.call('workspace-write', 'write', { file_path: 'a/new.txt', content: '' })).toBeUndefined()
    expect(f.call('workspace-write', 'edit', { file_path: f.file, old_string: 'fixture', new_string: 'changed' })).toBeUndefined()
    for (const command of ['pnpm check', 'pnpm test', 'npx tsc', 'git status']) {
      expect(f.shell('workspace-write', command, { workdir: f.root })).toBeUndefined()
    }
    expect(f.shell('workspace-write', 'npx tsc', { workdir: 'a' })?.code).toBe('STUDIO_INVALID_ARGUMENTS')
    expect(readFileSync(f.file, 'utf8')).toBe('fixture line\n')
  })

  it.each(['git push', 'pnpm publish', 'sudo true', 'curl localhost', 'ssh localhost', 'scripts/agent-studio restart',
    'rm -rf /', 'rm ../outside', "bash -c 'pwd'", "node -e 'fixture'"])
  ('blocks high-impact commands even after write authorization: %s', command => {
    expect(guardFixture().shell('workspace-write', command)).toMatchObject({ code: 'STUDIO_HIGH_IMPACT_FORBIDDEN', needsOwnerDecision: true })
  })

  it('rejects background jobs, out-of-scope workdirs and symlink targets through the actual guard', () => {
    const f = guardFixture()
    const links = ['linked-file', 'linked-dir']
    symlinkSync(f.outside, join(f.root, links[0]!))
    symlinkSync(f.sibling, join(f.root, links[1]!), 'dir')
    expect(f.shell('workspace-write', 'pnpm check', { run_in_background: true })?.code).toBe('STUDIO_HIGH_IMPACT_FORBIDDEN')
    for (const workdir of [f.sibling, '../workspace-sibling', 'linked-dir']) {
      expect(f.shell('workspace-write', 'pnpm check', { workdir })?.code).toBe('STUDIO_OUTSIDE_WORKSPACE')
    }
    for (const [name, args] of [['read', { file_path: 'linked-file' }], ['glob', { path: 'linked-dir', pattern: '*' }],
      ['grep', { path: 'linked-dir', pattern: 'sentinel' }], ['write', { file_path: 'linked-file', content: 'new' }]] as const) {
      expect(f.call('workspace-write', name, args)?.code).toBe('STUDIO_OUTSIDE_WORKSPACE')
    }
    expect(f.call('workspace-write', 'read', { file_path: 'a/note.txt' }, {
      sandbox: { mode: 'workspace-write', workspaceRoot: f.root, additionalWritableRoots: [f.sibling] },
    })?.code).toBe('STUDIO_SANDBOX_MISMATCH')
  })

  it('denies a previously valid bound tool when the workspace inode changes', () => {
    const f = guardFixture()
    expect(f.call('read-only', 'read', { file_path: f.file })).toBeUndefined()
    renameSync(f.root, join(f.dir, 'old-workspace'))
    mkdirSync(join(f.root, 'a'), { recursive: true })
    writeFileSync(f.file, 'different file')
    expect(f.call('read-only', 'read', { file_path: f.file })?.code).toBe('STUDIO_OUTSIDE_WORKSPACE')
  })

  it('gives stale, stopped, and cancelled calls no opportunity to reach argument or path validation', () => {
    const f = guardFixture()
    const authority = { active: true, signal, permission: 'read-only' as const, workspacePath: f.root }
    for (const input of [{ execution: undefined }, { execution: { ...authority, active: false } },
      { execution: { ...authority, signal: AbortSignal.abort() } }, { signal: AbortSignal.abort() }]) {
      expect(f.call('read-only', 'read', { file_path: f.outside }, input)).toMatchObject({
        code: 'STUDIO_EXECUTION_INACTIVE', needsOwnerDecision: false,
      })
    }
  })
})

const success = (value: Extract<ToolExecutionResult, { isError: false }>['value']): ToolExecutionResult => ({ isError: false, value, content: [] })
const failure = (code: string): ToolExecutionResult => ({ isError: true, error: { message: `Fixture ${code}`, info: { name: 'FixtureError', code } }, content: [] })
const observed = (name: string, args: object, toolSignal = signal): ObservedTool => ({ name, arguments: args, signal: toolSignal })
const foreground = (cwd: string, extra: object = {}) => ({ kind: 'foreground', cwd, exitCode: 0, signal: null, timedOut: false,
  aborted: false, stdout: { text: 'fixture output', truncated: false }, ...extra })

describe('Studio host tool evidence', () => {
  it('captures only actual native write/edit results, normalizes paths, and deduplicates equal action/path pairs', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const file = join(f.root, 'new.txt')
    writeFileSync(file, 'new')
    const create = observed('write', { file_path: file })
    const edit = observed('edit', { file_path: f.file })
    evidence.observe(create, success({ path: file, before: null, after: 'new' }), undefined)
    evidence.observe(create, success({ path: `${f.root}/a/../new.txt`, before: 'new', after: 'other' }), undefined)
    writeFileSync(f.file, 'modified')
    evidence.observe(edit, success({ path: f.file, before: 'fixture line\n', after: 'modified' }), undefined)
    const noOp = join(f.root, 'same.txt')
    writeFileSync(noOp, 'same')
    evidence.observe(edit, success({ path: noOp, before: 'same', after: 'same' }), undefined)
    evidence.observe(edit, success({ path: f.outside, before: 'old', after: 'new' }), undefined)
    evidence.observe(create, success({ path: 'claimed.txt', before: null, after: 'fake' }), undefined)
    evidence.observe(create, failure('WRITE_FAILED'), undefined)
    expect(evidence.result()).toEqual({ version: 1, changedFiles: [{ path: 'new.txt', action: 'write' }, { path: 'a/note.txt', action: 'edit' }],
      checks: [], overallCheckStatus: 'not_run' })
    expect(new WorkerEvidence(null, f.protectedRoots).result()).toBeUndefined()
  })

  it('uses actual foreground exit status, timeout and abort instead of successful-looking output', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const run = (command: string, result: ToolExecutionResult, caller = signal) => {
      const exec = observed('bash', { command, workdir: 'a' }, caller)
      const workdir = evidence.shellWorkdir(exec)
      expect(workdir).toBe(join(f.root, 'a'))
      evidence.observe(exec, result, workdir)
    }
    run('pnpm check', success(foreground(f.root)))
    expect(evidence.result()?.overallCheckStatus).toBe('passed')
    run('pnpm test', success(foreground(f.root, { exitCode: 7, stdout: { text: 'all checks passed', truncated: true } })))
    run('pnpm build', success(foreground(f.root, { timedOut: true, exitCode: null, signal: 'SIGTERM' })))
    run('pnpm lint', failure('ABORTED'), AbortSignal.abort())
    run('pnpm check', failure('TOOL_TIMEOUT'))
    run('pnpm check', success(foreground(f.root, { aborted: true })))
    run('pnpm check', success(foreground(f.outside)))
    const receipt = evidence.result()!
    expect(receipt.overallCheckStatus).toBe('failed')
    expect(receipt.checks).toMatchObject([
      { workdir: f.root, exitCode: 0, timedOut: false, aborted: false, status: 'passed' },
      { exitCode: 7, status: 'failed', output: expect.stringContaining('all checks passed') },
      { exitCode: null, timedOut: true, signal: 'SIGTERM', status: 'failed' },
      { exitCode: null, aborted: true, status: 'failed' },
      { exitCode: null, timedOut: true, status: 'failed' },
      { exitCode: 0, aborted: true, status: 'failed' },
      { workdir: join(f.root, 'a'), status: 'failed' },
    ])
  })

  it('keeps an omitted failure in the overall status and redacts tool output before publishing it', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const exec = observed('bash', { command: 'pnpm check' })
    for (let count = 0; count < 32; count++) evidence.observe(exec, success(foreground(f.root,
      { stderr: { text: '\u001b[31mAPI_KEY=fixture-secret\u001b[0m', truncated: false } })), f.root)
    const before = evidence.result()!
    evidence.observe(exec, success(foreground(f.root, { exitCode: 5 })), f.root)
    expect(before.overallCheckStatus).toBe('passed')
    expect(evidence.result()).toMatchObject({ overallCheckStatus: 'failed', omittedChecks: 1 })
    expect(evidence.result()?.checks).toHaveLength(32)
    expect(before.checks[0]?.output).toBe('stdout: fixture output\nstderr: API_KEY=[redacted]')
  })
})

function ledgerFixture() {
  const f = workspaceFixture()
  const database = join(f.stateDir, 'studio.sqlite')
  const domain = new ManagedWorkerStore(database, f.stateDir)
  const sqlite = new DatabaseSync(database)
  onTestFinished(() => { try { sqlite.close(); domain.finishRun() } finally { domain.close() } })
  const register = (key: string, sourceMessageId = `source-${key}`) => domain.registerTask({ projectId: null, requesterBotId: domain.assistantBotId,
    workspacePath: f.root, permission: 'read-only', sourceMessageId, requestId: `request-${key}`, requestText: `Fixture task ${key}` }).taskId
  const begin = (key: string, sourceMessageId?: string) => domain.beginExecution(register(key, sourceMessageId), `worker-${key}`, null, model)!
  const isolatedHost = { on: disposer } as unknown as Context
  const service = new StudioService(isolatedHost, domain, f.root, { assistant: null, leader: null }, () => true, signal, () => 'online', noop)
  const enqueue = vi.spyOn(service.sessions, 'enqueue').mockImplementation(noop)
  onTestFinished(() => service.sessions.drain())
  return { ...f, domain, sqlite, begin, register, service, enqueue }
}

const denialArgs = { command: 'git push', workdir: '.' }
function recordIntercept(f: ReturnType<typeof ledgerFixture>, execution: StudioExecution, args: unknown = denialArgs) {
  const denial = evaluateWorkerToolCall({ name: 'bash', arguments: args,
    // 模拟已取得的拒绝结果被重新提交；账本必须自行核对执行是否仍然有效。
    execution: { active: true, workspacePath: f.root, workspaceIdentity: f.binding, permission: 'read-only', signal },
    sandbox: { mode: 'read-only', workspaceRoot: f.root }, protectedRoots: f.protectedRoots })!
  return f.domain.recordGuardInterception(execution, denial, guardActionFingerprint('bash', args, denial.code), summarizeGuardAction('bash'))
}

describe('Studio evidence and guard decisions in the persistent ledger', () => {
  it('stores a version 1 JSON receipt and returns a structured task while preserving legacy text', async () => {
    const f = ledgerFixture()
    const live = f.begin('version-1')
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    evidence.observe(observed('bash', { command: 'pnpm test' }), success(foreground(f.root, { exitCode: 8 })), f.root)
    expect(f.domain.finishExecution(live, { text: 'All checks passed (untrusted claim).', eventSeq: 8 }, 'delivered', evidence.result())).toBe(true)
    const legacy = f.register('legacy')
    f.sqlite.prepare('UPDATE studio_task SET check_result = ? WHERE task_id = ?').run('Historical check: unstructured', legacy)
    const newRaw = f.sqlite.prepare('SELECT check_result FROM studio_task WHERE task_id = ?').get(live.taskId)?.check_result
    expect(typeof newRaw).toBe('string')
    expect(JSON.parse(String(newRaw))).toEqual(evidence.result())
    const { items } = await f.service.operations.tasks({}, signal)
    const projected = items.find(item => item.taskId === live.taskId)!
    expect(projected.checkResult).toEqual(evidence.result())
    expect(studioTaskText(projected)).toMatch(/检查总体状态：failed[\s\S]*Worker 正文（不作为宿主证据）：\nAll checks passed/u)
    expect(await f.service.operations.task({ taskId: legacy }, signal)).toMatchObject({ checkResult: 'Historical check: unstructured' })
    f.sqlite.prepare('UPDATE studio_task SET check_result = ? WHERE task_id = ?').run('{"version":2}', legacy)
    expect(f.domain.task(legacy)?.checkResult).toBe('{"version":2}')
  })

  it('rolls back revocation and pending changes when Feishu outbox insertion fails, then commits them together exactly once', async () => {
    const f = ledgerFixture()
    const { domain, sqlite, service } = f
    service.feishu.activate(scope, Date.now() - 1)
    const request = await service.operations.send({ conversationId: assistantRoom, requestId: 'original', text: 'Fixture owner request' }, signal)
    const execution = f.begin('atomic', studioOwnerMessageId(request.id))
    sqlite.exec(`CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON agent_studio_feishu_outbox
      WHEN NEW.kind = 'pending' BEGIN SELECT RAISE(ABORT, 'fixture outbox failure'); END;`)
    expect(() => recordIntercept(f, execution)).toThrow('fixture outbox failure')
    expect(domain.executionCurrent(execution)).toBe(true)
    expect(domain.task(execution.taskId)).toMatchObject({ status: 'running', authorizationVersion: execution.authorizationVersion })
    const proof = () => sqlite.prepare('SELECT ended_at, outcome, result_event_seq FROM studio_task_execution WHERE task_id = ?').get(execution.taskId)
    expect(proof()).toEqual({ ended_at: null, outcome: null, result_event_seq: null })
    expect(domain.studio.pending().items).toEqual([])
    expect(domain.studio.messages(assistantRoom, request.id).items).toEqual([])
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_studio_feishu_outbox WHERE kind = 'pending'").get()?.n).toBe(0)
    sqlite.exec('DROP TRIGGER fixture_fail_outbox')
    const { recorded, pendingId } = recordIntercept(f, execution)
    expect(recorded).toBe(true)
    expect(pendingId).toMatch(new RegExp(`^guard-intercept:${execution.taskId}:${execution.authorizationVersion + 1}:[a-f0-9]{20}$`, 'u'))
    expect(domain.task(execution.taskId)).toMatchObject({ status: 'waiting_approval', authorizationVersion: execution.authorizationVersion + 1 })
    expect(proof()).toEqual({ ended_at: expect.any(String), outcome: 'waiting_approval', result_event_seq: null })
    expect(domain.executionCurrent(execution)).toBe(false)
    expect(domain.finishExecution(execution, { text: 'stale success', eventSeq: 9 }, 'delivered')).toBe(false)
    expect(recordIntercept(f, execution, { workdir: '.', command: 'git push' })).toEqual({ recorded: false })
    expect(domain.studio.pending().items).toMatchObject([{ id: pendingId, taskId: execution.taskId, messageId: request.id, topicId: request.id,
      options: [...GUARD_PENDING_CHOICES], state: 'pending' }])
    expect(sqlite.prepare("SELECT pending_id, state FROM agent_studio_feishu_outbox WHERE kind = 'pending'").all())
      .toEqual([{ pending_id: pendingId, state: 'queued' }])
    expect(guardActionFingerprint('bash', denialArgs, 'STUDIO_READ_ONLY_VIOLATION'))
      .toBe(guardActionFingerprint('bash', { workdir: '.', command: 'git push' }, 'STUDIO_READ_ONLY_VIOLATION'))
    expect(domain.studio.pendingItem(pendingId!)?.detail).not.toContain('git push')
  })

  it('caps an execution-version pending bucket even if it is already full in the ledger', () => {
    const f = ledgerFixture()
    const execution = f.begin('rate-limit')
    f.service.feishu.activate(scope, Date.now() - 1)
    // 正常拦截在第一个待办即撤权；预置满桶以单独覆盖同一授权版本的限流分支。
    for (let n = 1; n <= 5; n++) f.domain.studio.addPending({ id: `guard-intercept:${execution.taskId}:${execution.authorizationVersion + 1}:${String(n).padStart(20, '0')}`,
      kind: 'confirmation', taskId: execution.taskId, conversationId: assistantRoom, title: 'Previously stored interception', requester: 'Studio fixture',
      detail: 'Fixture pending bucket', options: [...GUARD_PENDING_CHOICES], acceptsText: false, mobile: 'card', state: 'pending', createdAt: Date.now() })
    expect(recordIntercept(f, execution)).toEqual({ recorded: false })
    expect(f.domain.executionCurrent(execution)).toBe(true)
    expect(f.domain.studio.pending().items).toHaveLength(5)
    expect(f.sqlite.prepare("SELECT count(*) AS n FROM agent_studio_feishu_outbox WHERE kind = 'pending'").get()?.n).toBe(5)
  })

  it.each([
    ['gui', GUARD_PENDING_CHOICES[0], 'cancelled'], ['gui', GUARD_PENDING_CHOICES[1], 'interrupted'],
    ['feishu', GUARD_PENDING_CHOICES[0], 'cancelled'], ['feishu', GUARD_PENDING_CHOICES[1], 'interrupted'],
  ] as const)('%s decision %s ends as %s, never restoring the execution', async (channel, value, status) => {
    const f = ledgerFixture()
    f.service.feishu.activate(scope, Date.now() - 1)
    const execution = f.begin('decide')
    const { pendingId: id } = recordIntercept(f, execution)
    expect(id).toBeDefined()
    const card = f.service.feishu.next(scope)!
    expect(card).toMatchObject({ kind: 'pending', pending: { id } })
    f.service.feishu.finish(card.id, 'om_guard_fixture')
    const answerCard = (answer: string, messageId = 'om_guard_fixture') => f.service.feishu.answer({ scope, pendingId: id!, messageId, value: answer })
    expect(answerCard(value, 'om_not_the_card')).toBe(false)
    expect(answerCard('批准')).toBe(false)
    expect(() => f.service.operations.answer({ id: id!, value: '批准' }, signal)).toThrow('Choose a cancellation')
    expect(f.domain.task(execution.taskId)?.status).toBe('waiting_approval')
    if (channel === 'gui') await f.service.operations.answer({ id: id!, value }, signal)
    else expect(answerCard(value)).toBe(true)
    expect(f.domain.studio.pendingItem(id!)).toMatchObject({ state: 'resolved', answer: value, answeredBy: channel })
    expect(f.service.feishu.next(scope)).toMatchObject({ kind: 'pending-update', cardMessageId: 'om_guard_fixture', pending: { state: 'resolved' } })
    expect(f.domain.task(execution.taskId)).toMatchObject({ status, authorizationVersion: execution.authorizationVersion + 2 })
    expect(() => f.service.operations.answer({ id: id!, value }, signal)).toThrow('no longer current')
    expect(answerCard(value)).toBe(false)
    expect(f.domain.beginExecution(execution.taskId, 'replay-worker', null, model)).toBeUndefined()
    expect(f.domain.executionCurrent(execution)).toBe(false)
    expect(f.domain.finishExecution(execution, { text: 'must not deliver', eventSeq: 5 }, 'delivered')).toBe(false)
    expect(f.sqlite.prepare('SELECT outcome FROM studio_task_execution WHERE task_id = ?').all(execution.taskId)).toEqual([{ outcome: 'waiting_approval' }])
    expect(f.enqueue).not.toHaveBeenCalled()
  })

  it('rejects a late or expired Feishu text decision and never replays the original action', async () => {
    const f = ledgerFixture()
    f.service.feishu.activate(scope, Date.now() - 1_000)
    const execution = f.begin('expire')
    const { pendingId: id } = recordIntercept(f, execution)
    await f.service.feishu.receive({ scope, id: 'om_late', sourceTimeMs: f.domain.studio.pendingItem(id!)!.createdAt - 1,
      text: `仅解除等待 #${id}` }, signal)
    expect(f.domain.task(execution.taskId)?.status).toBe('waiting_approval')
    expect(f.domain.invalidateTask(execution.taskId, 'cancelled')).toBe(true)
    expect(f.domain.studio.pendingItem(id!)?.state).toBe('expired')
    expect(() => f.service.operations.answer({ id: id!, value: GUARD_PENDING_CHOICES[1] }, signal)).toThrow('no longer current')
    await f.service.feishu.receive({ scope, id: 'om_expired', sourceTimeMs: Date.now(), text: `仅解除等待 ${id}` }, signal)
    expect(f.domain.task(execution.taskId)).toMatchObject({ status: 'cancelled', authorizationVersion: execution.authorizationVersion + 2 })
    expect(f.domain.studio.pendingItem(id!)?.state).toBe('expired')
    expect(f.enqueue).not.toHaveBeenCalled()
  })
})

function dispatchFixture() {
  const f = ledgerFixture()
  const config = Config({ stateDir: f.stateDir, studioCwd: f.root, defaultWorkerPermission: 'workspace-write' })
  const handlers = new Set<(session: object, event: object) => void>()
  const agents = new Map<string, Agent>()
  const executions: Array<{ preset: string; cwd: string }> = []
  const verdicts: Array<{ output?: unknown; error?: unknown }> = []
  const ctx = { on: (_name: string, listener: (session: object, event: object) => void) => {
    handlers.add(listener)
    return () => handlers.delete(listener)
  }, get: (name: string) => name === 'agentDefaultModel' ? { currentSelection: () => model } : undefined,
  agents: { get: (id: string) => agents.get(id), withoutInitiator: (run: () => unknown) => run(),
    create: async (opts: { sessionId: string; meta: { agentPreset: string; cwd: string }; signal: AbortSignal }) => {
      executions.push({ preset: opts.meta.agentPreset, cwd: opts.meta.cwd })
      const agent = native(opts.sessionId, opts.meta.agentPreset.endsWith('assistant') ? 'assistant' : 'worker', {}, opts.signal)
      return { agent, dispose: async () => { agents.delete(agent.id) } }
    } }, sessionPersistence: { flush: async () => {} }, logger: { warn: noop } } as unknown as Context
  const ready = () => true
  const service = new StudioService(ctx, f.domain, config.studioCwd, { assistant: null, leader: null }, ready, signal, () => 'disabled', noop)
  const policy = new WorkerModelPolicy(ctx, config.workerModelRoutes, config.workerModelDefaults)
  // 派工及批准使用真实服务、原文登记和 SQLite；只省略安装版 smoke 独立覆盖的 Worker 执行本体。
  vi.spyOn(policy, 'pin').mockResolvedValue(model)
  onTestFinished(() => service.sessions.drain())
  const controller = new StudioAssistant(ctx, f.domain, service.sessions, policy, ready, config.studioCwd)
  let nextArgs: object = {}
  function native(id: string, role: 'assistant' | 'leader' | 'worker', initial: object, toolSignal = signal): Agent {
    const tools = new Map<string, ToolDefinition>()
    const session = { id, header: {}, inheritedEventCount: 0, firstLiveSeq: 0, events: [] as object[],
      get seq() { return this.events.length }, eventAt(seq: number) { return this.events[seq] } }
    const push = (type: string, data: object) => {
      const event = { seq: session.seq, type, surfaceOp: 'append', data }
      session.events.push(event)
      for (const handler of handlers) handler(session, event)
    }
    let idle = Promise.resolve()
    const agent = { id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, model: { select: noop }, cancel: noop,
      whenIdle: () => idle, ctx: { systemPrompt: { suppressRuntimeContext: disposer, section: disposer }, tools: {
        register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return noop },
      } }, followup(input: UserMessage) {
        const turn = session.seq + 1
        push('turn/start', { turn })
        push('user/message', input)
        if (role === 'worker') { push('turn/end', { turn, reason: { kind: 'completed' } }); return }
        const callId = `call-${turn}`
        push('tool/call', { callId, name: WORKER_DELEGATE, turn })
        const args = role === 'assistant' ? nextArgs : initial
        const tool = tools.get(WORKER_DELEGATE)!
        idle = Promise.resolve(tool.execute(args, { agent, name: tool.name, callId, signal: toolSignal,
          deferContext: noop, concludeTurn: noop } as unknown as Parameters<ToolDefinition['execute']>[1]))
          .then(output => { verdicts.push({ output }) }, error => { verdicts.push({ error }) })
          .then(() => push('turn/end', { turn, reason: { kind: 'completed' } }))
      } } as unknown as Agent
    agents.set(id, agent)
    if (role !== 'worker') controller.install(agent, role)
    return agent
  }
  const send = (requestId: string, text: string, room = assistantRoom) =>
    service.operations.send({ conversationId: room, requestId, text }, signal)
  const project = (args: object) => {
    const leader = native('bound-leader', 'leader', args)
    return f.domain.projects.create({ name: 'Fixture project', objective: 'Validate approval', workspacePath: f.root, leaderSessionId: leader.id })
  }
  return { ...f, service, config, project, send, verdicts, executions, setArgs: (args: object) => { nextArgs = args } }
}

describe('studio_delegate_task workspace grants', () => {
  it('rejects a Leader attempting to substitute another valid directory for the bound workspace', async () => {
    const f = dispatchFixture()
    const project = f.project({ workspacePath: f.sibling })
    const request = await f.send('leader-bad-root', `Review ${f.sibling}.`, project.id)
    await vi.waitFor(() => expect(f.verdicts[0]?.error).toMatchObject({ code: 'STUDIO_OUTSIDE_WORKSPACE' }))
    expect((await f.service.operations.message({ id: request.id, conversationId: project.id }, signal)).status).toBe('completed')
    expect(f.domain.tasks().items).toEqual([])
    expect(f.executions).toEqual([])
    expect(f.domain.studio.pending().items).toEqual([])
  })

  it('rejects an invalid explicitly named Assistant workspace without falling back to the valid studioCwd', async () => {
    const f = dispatchFixture()
    const invalidPath = join(f.dir, 'missing')
    f.setArgs({ workspacePath: invalidPath })
    await f.send('assistant-bad-root', `Inspect "${invalidPath}" in read-only mode.`)
    await vi.waitFor(() => expect(f.verdicts[0]?.error).toMatchObject({ code: 'STUDIO_WORKSPACE_INVALID' }))
    expect(f.config.studioCwd).toBe(f.root)
    expect(f.domain.tasks().items).toEqual([])
    expect(f.executions.some(call => call.preset === WORKER_PRESET)).toBe(false)
  })

  it('keeps a bound project read-only when permission is omitted despite a workspace-write setting', async () => {
    const f = dispatchFixture()
    const project = f.project({})
    expect(f.config.defaultWorkerPermission).toBe('workspace-write')
    await f.send('leader-read-default', 'Inspect the project without asking for write access.', project.id)
    await vi.waitFor(() => expect(f.verdicts[0]?.output).toMatchObject({ text: expect.stringContaining('registered.') }))
    expect(f.domain.tasks(project.id).items).toMatchObject([{ workspacePath: f.root, permission: 'read-only' }])
    expect(f.domain.studio.pending().items).toEqual([])
  })

  it('creates no write task before explicit confirmation; rejecting or replaying the approval never starts a Worker', async () => {
    const f = dispatchFixture()
    const project = f.project({ permission: 'workspace-write' })
    const text = 'Modify this project workspace; this request alone is not the write confirmation.'
    const request = await f.send('leader-write', text, project.id)
    const item = await vi.waitFor(() => {
      const [first] = f.domain.studio.pending().items
      expect(first).toMatchObject({ state: 'pending', messageId: request.id, options: ['允许本任务写入', 'Not now'] })
      return first!
    })
    expect(item.detail).toContain(f.root)
    expect(item.detail).toContain(text)
    expect(f.domain.tasks().items).toEqual([])
    expect(f.executions).toEqual([])
    expect(() => f.service.operations.answer({ id: item.id, value: 'yes' }, signal)).toThrow()
    expect(f.domain.tasks().items).toEqual([])
    await f.service.operations.answer({ id: item.id, value: 'Not now' }, signal)
    await vi.waitFor(() => expect(f.verdicts[0]?.output).toMatchObject({ text: expect.stringContaining('owner declined') }))
    expect(() => f.service.operations.answer({ id: item.id, value: '允许本任务写入' }, signal)).toThrow()
    expect(f.domain.tasks().items).toEqual([])
    expect(f.executions).toEqual([])
  })
})
