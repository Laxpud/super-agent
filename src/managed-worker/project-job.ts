/** Owner controls for project work that depends on an already submitted systemd user job. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { StudioProjectJob } from './project-store.ts'
import type { ManagedResult, ManagedWorkerStore } from './store.ts'
import { observeSystemdJob, validSystemdJob, type SystemdJobRef } from './systemd-job.ts'

interface JobReceipt { kind: 'success' | 'error'; text: string }
const id = z.uuid()
const denied = (reason: string): JobReceipt => ({ kind: 'error', text: `Studio external job control rejected: ${reason}.` })
const usage = () => denied('Use /studio-job attach <work-id> <unit> <invocation-id>, status/check <work-id>, or pause/resume <work-id> <authorization-version>')
const MAX_CONTROL_OPERATIONS = 4

/** Present the pinned reference rather than the current occupant of a reusable service name. */
export function projectJobText(job: StudioProjectJob): string {
  const { unit, invocationId } = job.ref
  const state = job.state === 'unknown' ? 'unknown (query could not confirm the pinned invocation)' : job.state
  return `Work ${job.workId}\nExternal job: ${unit}; invocation ${invocationId}.\nLast checked: ${state} at ${job.observedAt} (observation ${job.observationVersion}).\n`
    + `Post-processing: ${job.paused ? 'paused' : job.state === 'completed' ? 'eligible for explicit Leader dispatch' : 'waiting for confirmed success'}; authorization ${job.authorizationVersion}.\n`
    + `Journal reference: _SYSTEMD_INVOCATION_ID=${invocationId}.`
}

function receipt(result: ManagedResult<StudioProjectJob>, label: string): JobReceipt {
  return result.ok ? { kind: 'success', text: `${label}\n${projectJobText(result.value)}` } : denied(result.reason)
}

/** Only fixed status metadata accompanies the original owner request; unit output is never read into the prompt. */
export function projectJobContext(job: StudioProjectJob): string {
  return `External dependency confirmed complete by Studio: ${job.ref.unit} (invocation ${job.ref.invocationId}). No job output was read.`
}

/** Run bounded status checks outside any Worker. Shutting down the Studio aborts checks, not the observed units. */
export class StudioProjectJobControl {
  private readonly operations = new Set<Promise<JobReceipt>>()

  constructor(private readonly store: ManagedWorkerStore, private readonly ready: (agent: Agent) => boolean,
    private readonly stopping: AbortSignal) {}

  async drain(): Promise<void> { await Promise.allSettled(this.operations) }

  async command(agent: Agent, commandId: string, rawInput: string, caller: AbortSignal): Promise<JobReceipt> {
    if (this.stopping.aborted || !this.ready(agent)) return denied('OPEN_THE_STUDIO_LEADER_SESSION_FOR_THIS_PROJECT')
    if (rawInput.length > 512) return usage()
    if (this.operations.size >= MAX_CONTROL_OPERATIONS) return denied('JOB_CONTROL_BUSY')
    const signal = AbortSignal.any([caller, this.stopping])
    const command = this.perform(agent, commandId, rawInput.trim().split(/\s+/u), signal)
    this.operations.add(command)
    try { return await command } finally { this.operations.delete(command) }
  }

  private async perform(agent: Agent, commandId: string, [verb, workId, ...args]: string[], signal: AbortSignal): Promise<JobReceipt> {
    signal.throwIfAborted()
    if (!workId || !id.safeParse(workId).success) return usage()
    const projects = this.store.projects
    const stored = projects.readJob(agent.id, workId)
    if (!stored.ok) return denied(stored.reason)
    const job = stored.value
    if (verb === 'status' && !args.length) return job
      ? { kind: 'success', text: projectJobText(job) } : denied('NO_EXTERNAL_JOB_ATTACHED')

    const current = projects.current(agent.id)
    if (!current.ok) return denied(current.reason)
    if (verb === 'attach' && args.length === 2) {
      const ref: SystemdJobRef = { unit: args[0]!, invocationId: args[1]! }
      if (!validSystemdJob(ref)) return denied('EXPECTED_A_STUDIO_JOB_UNIT_AND_EXACT_INVOCATION_ID')
      if (job) {
        return job.ref.unit === ref.unit && job.ref.invocationId === ref.invocationId
          ? { kind: 'success', text: `Already attached. No action was repeated.\n${projectJobText(job)}` } : denied('WORK_ALREADY_HAS_EXTERNAL_JOB')
      }
      const state = await observeSystemdJob(ref, signal)
      signal.throwIfAborted()
      if (!this.ready(agent)) return denied('LEADER_UNAVAILABLE')
      if (state === 'unknown') return denied('EXTERNAL_JOB_NOT_CONFIRMED; nothing was attached or started')
      // Management and eligibility are checked again in the write transaction, after the external observation.
      return receipt(projects.attachJob(agent.id, workId, commandId, ref, state), 'External job attached. No Worker or unit was started.')
    }
    if (!job) return denied('NO_EXTERNAL_JOB_ATTACHED')
    if (verb === 'check' && !args.length) {
      if (job.state === 'completed' || job.state === 'failed') {
        return { kind: 'success', text: `The recorded terminal observation was kept.\n${projectJobText(job)}` }
      }
      const state = await observeSystemdJob(job.ref, signal)
      signal.throwIfAborted()
      if (!this.ready(agent)) return denied('LEADER_UNAVAILABLE')
      return receipt(projects.observeJob(agent.id, workId, job.observationVersion, state), 'External status checked. No Worker was started.')
    }
    if ((verb === 'pause' || verb === 'resume') && args.length === 1 && /^[1-9]\d*$/u.test(args[0]!)) {
      const version = Number(args[0])
      if (!Number.isSafeInteger(version)) return usage()
      const paused = verb === 'pause'
      const result = projects.setJobPaused(agent.id, workId, commandId, version, paused)
      if (result.ok && result.value.authorizationVersion !== version + 1) return receipt(result, 'Earlier command already recorded. No authorization changed.')
      return receipt(result, paused ? 'Post-processing paused. The external job was not stopped.' : 'Post-processing pause cleared. No Worker was started.')
    }
    return usage()
  }
}
