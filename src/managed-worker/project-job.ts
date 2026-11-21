/** Owner controls for project work that depends on an already submitted systemd user job. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { StudioJobCandidate } from './project-job-candidate-store.ts'
import type { StudioJobRoute, StudioProjectJob, StudioProjectJobLink } from './project-store.ts'
import type { ManagedResult, ManagedWorkerStore } from './store.ts'
import { observeSystemdJob, sameSystemdJob, validSystemdJob, type SystemdJobRef } from './systemd-job.ts'

interface JobReceipt { kind: 'success' | 'error'; text: string }
const id = z.uuid()
export const STUDIO_JOB_HINT = 'attach <work-id> <unit> <invocation-id> | status <work-id> | check <work-id> [<candidate-id>] | replace-candidate <work-id> <candidate-id> <unit> <invocation-id> | pause/resume/auto <work-id> <authorization-version>'
const denied = (reason: string): JobReceipt => ({ kind: 'error', text: `Studio external job control rejected: ${reason}.` })
const usage = () => denied(`Use /studio-job ${STUDIO_JOB_HINT}`)
const MAX_CONTROL_OPERATIONS = 4

/** Present the pinned reference rather than the current occupant of a reusable service name. */
export function projectJobText(job: StudioProjectJob): string {
  const { unit, invocationId } = job.ref
  const state = job.state === 'unknown' ? 'unknown (query could not confirm the pinned invocation)' : job.state
  const { automatic } = job
  const continuation = !automatic ? 'not authorized for the current version' : automatic.executionEpoch !== undefined
    ? `claimed by execution epoch ${automatic.executionEpoch}`
    : `one attempt authorized on ${automatic.route.model.provider}/${automatic.route.model.model}, subject to confirmed success and the current Leader, route and quota`
  return `Work ${job.workId}\nExternal job: ${unit}; invocation ${invocationId}.\nLast checked: ${state} at ${job.observedAt} (observation ${job.observationVersion}).\n`
    + `Post-processing: ${job.paused ? 'paused' : job.state === 'completed' ? 'external dependency satisfied' : 'waiting for confirmed success'}; authorization ${job.authorizationVersion}.\n`
    + `Automatic post-processing: ${continuation}.\nJournal reference: _SYSTEMD_INVOCATION_ID=${invocationId}.`
}

/** Report what is missing without calling a candidate an attachment, failure, or authorization. */
function candidateText({ workId, candidateId, ref, recordedAt }: StudioJobCandidate): string {
  return `Work ${workId}\nUnconfirmed external job reference ${candidateId}: ${ref.unit}; invocation ${ref.invocationId}.\nSaved at ${recordedAt}.`
    + '\nThe exact invocation has not been verified by the local user manager. Not attached, not watched, and no dispatch or automatic authorization is allowed.'
    + `\nOnce the exact invocation is observable, check it in the current Leader Session:\n/studio-job check ${workId} ${candidateId}`
    + `\nTo correct the reference without checking it:\n/studio-job replace-candidate ${workId} ${candidateId} <unit> <invocation-id>`
}

function attachmentReceipt(result: ManagedResult<StudioProjectJobLink>, workId: string, unconfirmed: string): JobReceipt {
  if (!result.ok) return result.reason === 'STALE_JOB_CANDIDATE'
    ? denied(`STALE_JOB_CANDIDATE; read the current reference with /studio-job status ${workId}`) : denied(result.reason)
  const link = result.value
  return link.kind === 'unconfirmed' ? { kind: 'success', text: `${unconfirmed}\n${candidateText(link.candidate)}` }
    : receipt({ ok: true, value: link.job }, 'External job attached. No Worker or unit was started.')
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
    private readonly stopping: AbortSignal, private readonly automaticRoute?: (agent: Agent) => StudioJobRoute) {}

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
    const stored = projects.readJobLink(agent.id, workId)
    if (!stored.ok) return denied(stored.reason)
    const job = stored.value?.kind === 'attached' ? stored.value.job : undefined
    const candidate = stored.value?.kind === 'unconfirmed' ? stored.value.candidate : undefined
    if (verb === 'status' && !args.length) {
      if (candidate) return { kind: 'success', text: candidateText(candidate) }
      return job ? { kind: 'success', text: projectJobText(job) } : denied('NO_EXTERNAL_JOB_ATTACHED')
    }

    const current = projects.current(agent.id)
    if (!current.ok) return denied(current.reason)
    if (verb === 'attach' && args.length === 2) {
      const ref: SystemdJobRef = { unit: args[0]!, invocationId: args[1]! }
      if (!validSystemdJob(ref)) return denied('EXPECTED_A_STUDIO_JOB_UNIT_AND_EXACT_INVOCATION_ID')
      if (job) {
        return sameSystemdJob(job.ref, ref)
          ? { kind: 'success', text: `Already attached. No action was repeated.\n${projectJobText(job)}` } : denied('WORK_ALREADY_HAS_EXTERNAL_JOB')
      }
      if (candidate) return sameSystemdJob(candidate.ref, ref)
        ? { kind: 'success', text: `The same reference is already saved. No new check ran.\n${candidateText(candidate)}` }
        : denied(`EXTERNAL_JOB_CANDIDATE_EXISTS; read /studio-job status ${workId} before replacing the reference`)
      return this.inspectAttachment(agent, workId, commandId, ref, signal)
    }
    if (verb === 'replace-candidate' && args.length === 3) {
      const [candidateId, unit, invocationId] = args as [string, string, string]
      const ref = { unit, invocationId }
      if (!id.safeParse(candidateId).success || !validSystemdJob(ref)) return usage()
      const replaced = projects.replaceJobCandidate(agent.id, workId, commandId, candidateId, ref)
      const label = replaced.ok && replaced.value.candidateId !== candidateId
        ? 'Reference updated. No new check ran.' : 'The same reference is already saved. No new check ran.'
      return attachmentReceipt(replaced.ok ? { ok: true, value: { kind: 'unconfirmed', candidate: replaced.value } } : replaced, workId, label)
    }
    if (verb === 'check' && args.length === 1) {
      if (!candidate || candidate.candidateId !== args[0]) return denied(`STALE_JOB_CANDIDATE; read /studio-job status ${workId}`)
      return this.inspectAttachment(agent, workId, commandId, candidate.ref, signal, candidate.candidateId)
    }
    if (candidate) {
      return verb === 'check' && !args.length
        ? denied(`EXTERNAL_JOB_NOT_CONFIRMED; use /studio-job check ${workId} ${candidate.candidateId}`)
        : denied(`EXTERNAL_JOB_NOT_CONFIRMED; see /studio-job status ${workId}`)
    }
    if (!job) return denied('NO_EXTERNAL_JOB_ATTACHED')
    if (verb === 'check' && !args.length) {
      if (job.state === 'completed' || job.state === 'failed') {
        return { kind: 'success', text: `The recorded terminal observation was kept.\n${projectJobText(job)}` }
      }
      const state = await observeSystemdJob(job.ref, signal)
      signal.throwIfAborted()
      if (!this.ready(agent)) return denied('LEADER_UNAVAILABLE')
      const observed = projects.observeJob(agent.id, workId, job.observationVersion, state)
      if (!observed.ok && observed.reason === 'STALE_JOB_OBSERVATION') {
        // The program watcher can win the observation CAS while the manual check is in flight.
        const latest = projects.readJobLink(agent.id, workId)
        if (latest.ok && latest.value?.kind === 'attached') {
          return { kind: 'success', text: `A newer saved observation was kept.\n${projectJobText(latest.value.job)}` }
        }
      }
      return receipt(observed, 'External status checked. This check did not authorize dispatch.')
    }
    if ((verb === 'pause' || verb === 'resume' || verb === 'auto') && args.length === 1 && /^[1-9]\d*$/u.test(args[0]!)) {
      const version = Number(args[0])
      if (!Number.isSafeInteger(version)) return usage()
      if (verb === 'auto') {
        if (!this.automaticRoute) return denied('EXTERNAL_JOB_WATCH_DISABLED')
        let route: StudioJobRoute
        try { route = this.automaticRoute(agent) } catch { return denied('WORKSPACE_OR_MODEL_MISSING') }
        const armed = projects.armJob(agent.id, workId, commandId, version, route)
        return receipt(armed, armed.ok && armed.value.authorizationVersion !== version + 1
          ? 'Earlier automatic authorization already recorded. No authorization changed.'
          : 'Automatic post-processing authorized for one attempt. This command did not start a Worker.')
      }
      const paused = verb === 'pause'
      const result = projects.setJobPaused(agent.id, workId, commandId, version, paused)
      if (result.ok && result.value.authorizationVersion !== version + 1) return receipt(result, 'Earlier command already recorded. No authorization changed.')
      return receipt(result, paused ? 'Post-processing paused. The external job was not stopped.' : 'Post-processing pause cleared. No Worker was started.')
    }
    return usage()
  }

  /** Observe outside the write lock, then recheck the exact pending identity and current management before recording it. */
  private async inspectAttachment(agent: Agent, workId: string, commandId: string, ref: SystemdJobRef,
    signal: AbortSignal, candidateId?: string): Promise<JobReceipt> {
    const state = await observeSystemdJob(ref, signal)
    signal.throwIfAborted()
    if (!this.ready(agent)) return denied('LEADER_UNAVAILABLE')
    const label = candidateId === undefined ? 'The first check could not verify this invocation. Reference saved.'
      : 'Still unconfirmed after checking this invocation. The saved reference was kept.'
    return attachmentReceipt(this.store.projects.recordJobAttachment(agent.id, workId, commandId, ref, state, candidateId), workId, label)
  }
}
