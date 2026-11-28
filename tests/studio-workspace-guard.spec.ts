import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { StudioAssistant, WORKER_PRESET } from '../src/managed-worker/assistant.ts'
import { Config } from '../src/managed-worker/index.ts'
import { ManagedWorkerStore, type StudioExecution } from '../src/managed-worker/store.ts'
import { WorkerModelPolicy } from '../src/managed-worker/text-worker-model-policy.ts'
import { summarizeGuardAction, WorkerEvidence, type ObservedTool } from '../src/managed-worker/worker-evidence.ts'
import { evaluateWorkerToolCall, guardActionFingerprint, workerToolAllowlist, type WorkerGuardInput } from '../src/managed-worker/worker-guard.ts'
import { canonicalizeWorkspaceRoot, listWorkspaceDirectory, protectedHostRoots, resolveWorkspaceTarget, verifyWorkspaceIdentity,
  type WorkspaceTargetMode } from '../src/managed-worker/workspace.ts'
import { callStudio } from '../src/studio-web/api.ts'
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

  it('protects a custom DSH_HOME and a separately provided profile root by lexical and physical path', () => {
    const f = workspaceFixture()
    const data = join(f.root, 'custom-dsh-data'), alias = join(f.dir, 'custom-dsh-alias')
    const profile = join(f.root, 'custom-profile')
    mkdirSync(data)
    mkdirSync(profile)
    symlinkSync(data, alias, 'dir')
    writeFileSync(join(data, 'credential'), 'fixture data')
    vi.stubEnv('DSH_HOME', alias)
    try {
      const roots = protectedHostRoots(f.stateDir, [profile])
      for (const path of [data, alias, profile]) expect(() => canonicalizeWorkspaceRoot(path, roots)).toThrow(outsideWorkspace)
      expect(() => resolveWorkspaceTarget(f.root, 'custom-dsh-data/credential', { mode: 'read', protectedRoots: roots })).toThrow(outsideWorkspace)
      expect(listWorkspaceDirectory(f.root, undefined, roots)).toEqual([{ name: 'a', kind: 'dir' }])
      vi.stubEnv('HOME', f.dir)
      vi.stubEnv('DSH_HOME', '~/workspace/custom-dsh-data')
      expect(() => canonicalizeWorkspaceRoot(data, protectedHostRoots(f.stateDir))).toThrow(outsideWorkspace)
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
      expect(verdict?.code).toBe(name === 'bash' || name === 'pwsh' ? 'STUDIO_READ_ONLY_VIOLATION' : 'STUDIO_TOOL_FORBIDDEN')
    }
  })

  it.each([
    { sandbox_permissions: 'danger-full-access' }, { sandbox_permissions: 'workspace-write' },
    { sandbox_permissions: undefined }, { justification: '' }, { justification: null },
  ])('rejects an own escalation key, regardless of tool or value (%j)', extra => {
    const f = guardFixture()
    for (const permission of ['read-only', 'workspace-write'] as const) {
      for (const name of [...workerToolAllowlist(f.root, permission), 'unknown']) {
        expect(f.call(permission, name, { ...extra })?.code).toBe('STUDIO_ESCALATION_FORBIDDEN')
      }
    }
    const inherited = Object.assign(Object.create(extra) as object, { file_path: 'a/note.txt' })
    expect(f.call('read-only', 'read', inherited)).toBeUndefined()
  })

  it('allows native reads and searches but never exposes or authorizes read-only shell tools', () => {
    const f = guardFixture()
    expect(workerToolAllowlist(f.root, 'read-only')).toEqual(['studio_list_directory', 'read', 'read_image', 'glob', 'grep'])
    for (const [name, args] of [
      ['studio_list_directory', {}], ['read', { file_path: 'a/note.txt', offset: 1, limit: 2 }],
      ['glob', { path: 'a', pattern: '**/*.txt' }], ['grep', { pattern: 'fixture', path: 'a', include: '*.txt' }],
    ] as const) expect(f.call('read-only', name, args)).toBeUndefined()
    for (const name of ['bash', 'pwsh']) for (const args of [null, { command: 'pwd' }, { command: 'git status' }, { sandbox_permissions: 'workspace-write' }]) {
      expect(f.call('read-only', name, args)).toMatchObject({ code: 'STUDIO_READ_ONLY_VIOLATION', needsOwnerDecision: true })
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
    'rm -rf /', 'rm ../outside', 'rm a/note.txt', 'mv a/note.txt a/moved.txt', 'cp a/note.txt a/copied.txt', "bash -c 'pwd'", "node -e 'fixture'"])
  ('blocks high-impact commands even after write authorization: %s', command => {
    expect(guardFixture().shell('workspace-write', command)).toMatchObject({ code: 'STUDIO_HIGH_IMPACT_FORBIDDEN', needsOwnerDecision: true })
  })

  it.each([
    '[CoRe]\n FSmOnItOr = fixture-helper', '[diff]\n external = fixture-helper', '[core]\n sshCommand = fixture-helper',
    '[diff "fixture"]\n textconv = fixture-helper', '[filter "fixture"]\n smudge = fixture-helper',
    '[filter "fixture"]\n clean = fixture-helper', '[pager]\n status = fixture-helper', '[core]\n editor = fixture-helper',
    '[core]\n hooksPath = fixture-hooks', '[includeIf "gitdir:fixture"]\n path = other-config', '[core] fsmonitor = fixture-helper',
  ])('rejects Git commands when the real repository config reads %j', config => {
    const f = guardFixture()
    const git = join(f.root, '.git')
    mkdirSync(git)
    const path = join(git, 'config')
    writeFileSync(path, '[core]\n repositoryformatversion = 0\n # fsmonitor is just a comment\n')
    expect(f.shell('workspace-write', 'git status', { workdir: 'a' })).toBeUndefined()
    writeFileSync(path, `${config}\n`)
    for (const command of ['git status', 'git diff', 'git log', 'git show', 'git add -- .']) {
      expect(f.shell('workspace-write', command, { workdir: 'a' })).toMatchObject({ code: 'STUDIO_HIGH_IMPACT_FORBIDDEN', needsOwnerDecision: true })
    }
  })

  it.each(['gitfile', 'gitdir-link', 'config-link'])('blocks Git metadata that redirects to the outside: %s', kind => {
    const f = guardFixture()
    const git = join(f.root, '.git')
    if (kind === 'gitfile') writeFileSync(git, `gitdir: ${f.sibling}\n`)
    else if (kind === 'gitdir-link') symlinkSync(f.sibling, git, 'dir')
    else { mkdirSync(git); symlinkSync(f.outside, join(git, 'config')) }
    expect(f.shell('workspace-write', 'git status')).toMatchObject({ code: 'STUDIO_HIGH_IMPACT_FORBIDDEN', needsOwnerDecision: true })
  })

  it('returns a sandbox mismatch when the Session directory has drifted despite matching native sandbox settings', () => {
    const f = guardFixture()
    const args = { file_path: 'a/note.txt' }
    expect(f.call('read-only', 'read', args, { sessionDirectoryMatches: true })).toBeUndefined()
    expect(f.call('read-only', 'read', args, { sessionDirectoryMatches: false })?.code).toBe('STUDIO_SANDBOX_MISMATCH')
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
const observe = (evidence: WorkerEvidence, exec: ObservedTool, result: ToolExecutionResult) => {
  evidence.trackCheck(exec)
  evidence.observe(exec, result)
}

describe('Studio host tool evidence', () => {
  it('captures only actual native write/edit results, normalizes paths, and deduplicates equal action/path pairs', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const file = join(f.root, 'new.txt')
    writeFileSync(file, 'new')
    const create = observed('write', { file_path: file })
    const edit = observed('edit', { file_path: f.file })
    evidence.observe(create, success({ path: file, before: null, after: 'new' }))
    evidence.observe(create, success({ path: `${f.root}/a/../new.txt`, before: 'new', after: 'other' }))
    writeFileSync(f.file, 'modified')
    evidence.observe(edit, success({ path: f.file, before: 'fixture line\n', after: 'modified' }))
    const noOp = join(f.root, 'same.txt')
    writeFileSync(noOp, 'same')
    evidence.observe(edit, success({ path: noOp, before: 'same', after: 'same' }))
    evidence.observe(edit, success({ path: f.outside, before: 'old', after: 'new' }))
    evidence.observe(create, success({ path: 'claimed.txt', before: null, after: 'fake' }))
    evidence.observe(create, failure('WRITE_FAILED'))
    expect(evidence.result()).toEqual({ version: 1, changedFiles: [{ path: 'new.txt', action: 'write' }, { path: 'a/note.txt', action: 'edit' }],
      checks: [], overallCheckStatus: 'not_run' })
    expect(new WorkerEvidence(null, f.protectedRoots).result()).toBeUndefined()
  })

  it('uses actual foreground exit status, timeout and abort instead of successful-looking output', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const run = (command: string, result: ToolExecutionResult, caller = signal) => {
      observe(evidence, observed('bash', { command, workdir: 'a' }, caller), result)
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

  it('does not mistake inspection, help or version output for a passed project check', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    for (const command of ['pwd', 'ls', 'wc -l a/note.txt', 'git status', 'git diff --check', 'git log', 'git show', 'tsc --version', 'vitest --help']) {
      observe(evidence, observed('bash', { command }), success(foreground(f.root)))
    }
    expect(evidence.result()).toMatchObject({ checks: [], overallCheckStatus: 'not_run' })
    const checks = ['pnpm check', 'pnpm test', 'pnpm typecheck', 'pnpm build', 'pnpm lint', 'npm test', 'npm run build', 'npx vitest run',
      'npx --no-install tsc', 'vitest run', 'tsc --noEmit']
    for (const command of checks) observe(evidence, observed('bash', { command }), success(foreground(f.root)))
    expect(evidence.result()?.checks.map(check => check.command)).toEqual(checks)
    expect(evidence.result()?.overallCheckStatus).toBe('passed')
  })

  it('keeps an omitted failure in the overall status and redacts tool output before publishing it', () => {
    const f = workspaceFixture()
    const evidence = new WorkerEvidence(f.root, f.protectedRoots)
    const exec = observed('bash', { command: 'pnpm check' })
    for (let count = 0; count < 32; count++) observe(evidence, exec, success(foreground(f.root,
      { stderr: { text: '\u001b[31mAPI_KEY=fixture-secret\u001b[0m', truncated: false } })))
    const before = evidence.result()!
    observe(evidence, exec, success(foreground(f.root, { exitCode: 5 })))
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
function expectExecutionRevoked(f: ReturnType<typeof ledgerFixture>, execution: StudioExecution) {
  expect(f.domain.executionCurrent(execution)).toBe(false)
  expect(f.domain.task(execution.taskId)).toMatchObject({ status: 'waiting_approval', authorizationVersion: execution.authorizationVersion + 1 })
  expect(f.sqlite.prepare('SELECT ended_at, outcome, result_event_seq FROM studio_task_execution WHERE task_id = ?').get(execution.taskId))
    .toEqual({ ended_at: expect.any(String), outcome: 'waiting_approval', result_event_seq: null })
  expect(evaluateWorkerToolCall({ name: 'read', arguments: { file_path: f.file },
    execution: { active: f.domain.executionCurrent(execution), workspacePath: f.root, workspaceIdentity: f.binding, permission: 'read-only', signal },
    sandbox: { mode: 'read-only', workspaceRoot: f.root }, protectedRoots: f.protectedRoots }))
    .toMatchObject({ code: 'STUDIO_EXECUTION_INACTIVE', needsOwnerDecision: false })
  expect(f.domain.finishExecution(execution, { text: 'stale success', eventSeq: 9 }, 'delivered')).toBe(false)
}
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
    observe(evidence, observed('bash', { command: 'pnpm test' }), success(foreground(f.root, { exitCode: 8 })))
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

  it.each([
    [undefined, true], [1, true], [Number.MAX_SAFE_INTEGER, true], [0, false], [-1, false], [1.5, false],
    [Number.MAX_SAFE_INTEGER + 1, false], ['1', false], [null, false],
  ])('uses the same positive-safe-integer receipt count contract on Host and Web (%j)', async (count, valid) => {
    const f = ledgerFixture()
    const taskId = f.register('count-contract')
    const pending = f.domain.task(taskId)!
    try {
      for (const key of ['omittedChangedFiles', 'omittedChecks']) {
        const receipt = { version: 1, changedFiles: [], checks: [], overallCheckStatus: 'not_run', ...(count !== undefined && { [key]: count }) }
        const raw = JSON.stringify(receipt)
        f.sqlite.prepare('UPDATE studio_task SET check_result = ? WHERE task_id = ?').run(raw, taskId)
        expect(f.domain.task(taskId)?.checkResult).toEqual(valid ? receipt : raw)
        // 对浏览器单独注入同一结构化响应，不让宿主的旧文本兼容掩盖协议差异。
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...pending, checkResult: receipt })))
        if (valid) await expect(callStudio('task', { taskId })).resolves.toMatchObject({ checkResult: receipt })
        else await expect(callStudio('task', { taskId })).rejects.toMatchObject({ kind: 'badResponse' })
      }
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps revocation committed even when a Feishu outbox failure rolls back the notification transaction', async () => {
    const f = ledgerFixture()
    const { domain, sqlite, service } = f
    service.feishu.activate(scope, Date.now() - 1)
    const request = await service.operations.send({ conversationId: assistantRoom, requestId: 'original', text: 'Fixture owner request' }, signal)
    const execution = f.begin('outbox-failure', studioOwnerMessageId(request.id))
    sqlite.exec(`CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON agent_studio_feishu_outbox
      WHEN NEW.kind = 'pending' BEGIN SELECT RAISE(ROLLBACK, 'fixture outbox failure'); END;`)
    expect(() => recordIntercept(f, execution)).toThrow('fixture outbox failure')
    expectExecutionRevoked(f, execution)
    expect(domain.studio.pending().items).toEqual([])
    expect(domain.studio.messages(assistantRoom, request.id).items).toEqual([])
    expect(sqlite.prepare("SELECT count(*) AS n FROM agent_studio_feishu_outbox WHERE kind = 'pending'").get()?.n).toBe(0)
  })

  it('publishes the Web and Feishu notifications together and at most once on successful revocation', async () => {
    const f = ledgerFixture()
    const { domain, sqlite, service } = f
    service.feishu.activate(scope, Date.now() - 1)
    const request = await service.operations.send({ conversationId: assistantRoom, requestId: 'original', text: 'Fixture owner request' }, signal)
    const execution = f.begin('notification', studioOwnerMessageId(request.id))
    const { recorded, pendingId } = recordIntercept(f, execution)
    expect(recorded).toBe(true)
    expect(pendingId).toMatch(new RegExp(`^guard-intercept:${execution.taskId}:${execution.authorizationVersion + 1}:[a-f0-9]{20}$`, 'u'))
    expectExecutionRevoked(f, execution)
    expect(recordIntercept(f, execution, { workdir: '.', command: 'git push' })).toEqual({ recorded: false })
    expect(domain.studio.pending().items).toMatchObject([{ id: pendingId, taskId: execution.taskId, messageId: request.id, topicId: request.id,
      options: [...GUARD_PENDING_CHOICES], state: 'pending' }])
    expect(sqlite.prepare("SELECT pending_id, state FROM agent_studio_feishu_outbox WHERE kind = 'pending'").all())
      .toEqual([{ pending_id: pendingId, state: 'queued' }])
    expect(guardActionFingerprint('bash', denialArgs, 'STUDIO_READ_ONLY_VIOLATION'))
      .toBe(guardActionFingerprint('bash', { workdir: '.', command: 'git push' }, 'STUDIO_READ_ONLY_VIOLATION'))
    expect(domain.studio.pendingItem(pendingId!)?.detail).not.toContain('git push')
  })

  it('revokes an execution without adding notifications when its pending bucket is full', () => {
    const f = ledgerFixture()
    const execution = f.begin('rate-limit')
    f.service.feishu.activate(scope, Date.now() - 1)
    // 正常拦截在第一个待办即撤权；预置满桶以单独覆盖同一授权版本的限流分支。
    for (let n = 1; n <= 5; n++) f.domain.studio.addPending({ id: `guard-intercept:${execution.taskId}:${execution.authorizationVersion + 1}:${String(n).padStart(20, '0')}`,
      kind: 'confirmation', taskId: execution.taskId, conversationId: assistantRoom, title: 'Previously stored interception', requester: 'Studio fixture',
      detail: 'Fixture pending bucket', options: [...GUARD_PENDING_CHOICES], acceptsText: false, mobile: 'card', state: 'pending', createdAt: Date.now() })
    expect(recordIntercept(f, execution)).toEqual({ recorded: true })
    expectExecutionRevoked(f, execution)
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
  let workerStep: ((agent: Agent) => Promise<void>) | undefined
  const permissions = new Map<string, StudioWorkerPermission>()
  const ctx = { on: (_name: string, listener: (session: object, event: object) => void) => {
    handlers.add(listener)
    return () => handlers.delete(listener)
  }, get: (name: string) => name === 'agentDefaultModel' ? { currentSelection: () => model } : undefined,
  agents: { get: (id: string) => agents.get(id), withoutInitiator: (run: () => unknown) => run(),
    create: async (opts: { sessionId: string; meta: { agentPreset: string; cwd: string }; signal: AbortSignal }) => {
      executions.push({ preset: opts.meta.agentPreset, cwd: opts.meta.cwd })
      const agent = native(opts.sessionId, opts.meta.agentPreset.endsWith('assistant') ? 'assistant' : 'worker', {}, opts.signal)
      return { agent, dispose: async () => { agents.delete(agent.id) } }
    } }, sessionPersistence: { flush: async () => {} }, logger: { warn: noop },
    permissionPresets: { set: (session: { id: string }, permission: StudioWorkerPermission) => permissions.set(session.id, permission) },
    sandboxPolicy: { resolve: ({ session }: { session: { id: string } }) => ({ mode: permissions.get(session.id), workspaceRoot: f.root }) },
  } as unknown as Context
  const ready = () => true
  const service = new StudioService(ctx, f.domain, config.studioCwd, { assistant: null, leader: null }, ready, signal, () => 'disabled', noop)
  const policy = new WorkerModelPolicy(ctx, config.workerModelRoutes, config.workerModelDefaults)
  // 派工、证据接线和批准使用真实服务及 SQLite；以合成原生事件代替实际 Agent 和模型。
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
        if (role === 'worker') {
          if (workerStep) idle = Promise.resolve().then(() => workerStep!(agent)).then(() => push('turn/end', { turn, reason: { kind: 'completed' } }))
          else push('turn/end', { turn, reason: { kind: 'completed' } })
          return
        }
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
  return { ...f, service, config, project, send, verdicts, executions, controller,
    setArgs: (args: object) => { nextArgs = args }, playWorker: (step: (agent: Agent) => Promise<void>) => { workerStep = step } }
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

  it('preserves actual file evidence and completed and aborted checks on owner stop without reopening the execution', async () => {
    const f = dispatchFixture()
    const project = f.project({ permission: 'workspace-write' })
    const readyToStop = Promise.withResolvers<() => void>()
    const release = Promise.withResolvers<void>()
    onTestFinished(() => release.resolve())
    f.playWorker(async agent => {
      try {
        const dispatch = (name: string, args: object) => {
          const exec = { ...observed(name, args), agent } as ToolExecution
          f.controller.observeDispatch(exec)
          return exec
        }
        writeFileSync(f.file, 'edited before manual stop\n')
        f.controller.observeToolResult(dispatch('edit', { file_path: f.file }), success({ path: f.file, before: 'fixture line\n', after: 'edited before manual stop\n' }))
        f.controller.observeToolResult(dispatch('bash', { command: 'pnpm check' }), success(foreground(f.root)))
        f.controller.observeToolResult(dispatch('bash', { command: 'pnpm lint' }), failure('ABORTED'))
        const pending = dispatch('bash', { command: 'pnpm test' })
        readyToStop.resolve(() => f.controller.observeToolResult(pending, success(foreground(f.root))))
        await release.promise
      } catch (error) { readyToStop.reject(error); throw error }
    })
    const request = await f.send('stop-evidence', 'Modify and check the files until stopped.', project.id)
    const confirmation = await vi.waitFor(() => {
      const item = f.domain.studio.pending().items.find(item => item.messageId === request.id)
      expect(item?.state).toBe('pending')
      return item!
    })
    await f.service.operations.answer({ id: confirmation.id, value: '允许本任务写入' }, signal)
    const late = await readyToStop.promise
    const live = f.domain.tasks(project.id).items[0]!
    expect(live.status).toBe('running')
    const stopped = await f.service.operations.stopTask({ taskId: live.taskId }, signal)
    release.resolve()
    late()
    await f.service.sessions.drain()
    expect(stopped).toMatchObject({ status: 'cancelled', authorizationVersion: live.authorizationVersion + 1, checkResult: {
      changedFiles: [{ path: 'a/note.txt', action: 'edit' }], overallCheckStatus: 'failed', checks: [
        { command: 'pnpm check', status: 'passed', exitCode: 0 }, { command: 'pnpm lint', aborted: true, status: 'failed' },
        { command: 'pnpm test', aborted: true, status: 'failed', exitCode: null },
      ],
    } })
    expect(f.domain.task(live.taskId)).toEqual(stopped)
    expect(f.sqlite.prepare('SELECT ended_at, outcome FROM studio_task_execution WHERE task_id = ?').get(live.taskId))
      .toEqual({ ended_at: expect.any(String), outcome: 'cancelled' })
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
