import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Identifies one invocation of a transient service in the local user manager. */
export interface SystemdJobRef {
  unit: string
  invocationId: string
}

export type SystemdJobState = 'running' | 'completed' | 'failed' | 'unknown'

const execFileAsync = promisify(execFile)
const systemctl = '/usr/bin/systemctl'
const timeoutMs = 2_000
const maxOutputBytes = 4_096
const properties = [
  'Id', 'LoadState', 'InvocationID', 'Transient', 'Type', 'RemainAfterExit', 'Restart',
  'ActiveState', 'SubState', 'Result', 'ExecMainCode', 'ExecMainStatus',
] as const
const propertyNames: ReadonlySet<string> = new Set(properties)

/** Checks reference syntax only; the manager must still confirm the unit and invocation. */
export function validSystemdJob(ref: SystemdJobRef): boolean {
  // The fixed prefix and extension leave 236 bytes of systemd's 255-byte unit name limit.
  return ref != null
    && typeof ref.unit === 'string' && /^studio-job-[a-z0-9][a-z0-9-]{0,235}\.service$/.test(ref.unit)
    && typeof ref.invocationId === 'string' && /^[0-9a-f]{32}$/.test(ref.invocationId)
    && ref.invocationId !== '00000000000000000000000000000000'
}

/** Compare both coordinates; systemd can reuse a service name for a different invocation. */
export function sameSystemdJob(left: SystemdJobRef, right: SystemdJobRef): boolean {
  return left.unit === right.unit && left.invocationId === right.invocationId
}

function readState(stdout: string, ref: SystemdJobRef): SystemdJobState {
  // Accept one complete set of properties. Reject repeated keys or extra lines instead
  // of letting a later line override the identity or state of the observed invocation.
  const fields = new Map<string, string>()
  for (const line of stdout.replace(/\n$/, '').split('\n')) {
    const separator = line.indexOf('=')
    if (separator < 1) return 'unknown'
    const key = line.slice(0, separator)
    if (!propertyNames.has(key) || fields.has(key)) return 'unknown'
    fields.set(key, line.slice(separator + 1))
  }
  if (fields.size !== properties.length
    || fields.get('Id') !== ref.unit || fields.get('InvocationID') !== ref.invocationId
    || fields.get('LoadState') !== 'loaded' || fields.get('Transient') !== 'yes'
    || fields.get('Type') !== 'oneshot' || fields.get('RemainAfterExit') !== 'yes'
    || fields.get('Restart') !== 'no') return 'unknown'

  const active = fields.get('ActiveState')
  const substate = fields.get('SubState')
  const result = fields.get('Result') ?? ''
  if (active === 'activating' && substate === 'start' && result === 'success') return 'running'
  // A retained oneshot stays active after exiting. CLD_EXITED (1) with status 0
  // distinguishes a clean main-process exit from an absent or ambiguous exit status.
  if (active === 'active' && substate === 'exited' && result === 'success'
    && fields.get('ExecMainCode') === '1' && fields.get('ExecMainStatus') === '0') return 'completed'
  if (active === 'failed' && substate === 'failed' && /^[a-z][a-z0-9-]*$/.test(result)
    && result !== 'success') return 'failed'
  return 'unknown'
}

/** Reads a bounded snapshot for this invocation only. Unavailable evidence returns `unknown`. */
export async function observeSystemdJob(ref: SystemdJobRef, signal: AbortSignal): Promise<SystemdJobState> {
  if (signal.aborted || process.platform !== 'linux' || !process.getuid || !validSystemdJob(ref)) return 'unknown'
  const snapshot = { unit: ref.unit, invocationId: ref.invocationId }
  const runtimeDir = `/run/user/${process.getuid()}`

  try {
    // Pin the standard local user sockets and do not inherit an alternate D-Bus
    // address or systemd environment. Neither input nor output controls the command.
    const { stdout } = await execFileAsync(systemctl, [
      '--user', '--no-pager', 'show', `--property=${properties.join(',')}`, '--', snapshot.unit,
    ], {
      env: { LC_ALL: 'C', XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` },
      cwd: '/',
      encoding: 'utf8',
      signal,
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      killSignal: 'SIGKILL',
    })
    return signal.aborted ? 'unknown' : readState(stdout, snapshot)
  } catch {
    // Do not expose command diagnostics (including partial output) to callers.
    return 'unknown'
  }
}
