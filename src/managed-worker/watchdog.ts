/** Project recorded Studio state and local Session visibility without probing, dispatching, or recovering work. */
import { z } from 'zod'
import type { ManagedWorkerStore } from './store.ts'
import { WATCHDOG_KINDS, WATCHDOG_PAGE_LIMIT, type WatchdogDocument, type WatchdogEntry, type WatchdogExecution,
  type WatchdogJob, type WatchdogQuota } from './watchdog-store.ts'

const query = z.tuple([z.enum(WATCHDOG_KINDS), z.uuid()])
type SessionPresence = 'idle' | 'running' | 'not-attached' | 'unknown'
type ObserveSession = (sessionId: string) => SessionPresence

/** A live registry entry is a local observation, not an execution grant or proof a model is generating. */
function observedSession(label: string, sessionId: string, observe: ObserveSession): string {
  let visibility: SessionPresence
  try { visibility = observe(sessionId) } catch { visibility = 'unknown' }
  const visible = visibility === 'not-attached' ? 'not attached here; absence alone does not confirm failure'
    : visibility === 'unknown' ? 'visibility unknown' : `attached, ${visibility}`
  return `${label} Session ${sessionId}: ${visible}.`
}

function documentHealth(entry: WatchdogDocument, captureUnconfirmed: boolean, observe: ObserveSession, failureAlerts: boolean): string {
  const facts = [`Document ${entry.id}: snapshot v${entry.documentVersion}; execution epoch ${entry.executionEpoch}; authorization v${entry.authorizationVersion}.`]
  let concern: string | undefined
  if (entry.projectId && entry.workId && entry.leaderSessionId && entry.managementEpoch) {
    facts.push(`Linked work ${entry.workId} in project ${entry.projectId}; management epoch ${entry.managementEpoch}.`,
      observedSession('Current Leader', entry.leaderSessionId, observe))
  }
  if (entry.shared) facts.push(`Shared base revision ${entry.shared.baseVersion}; observed head ${entry.shared.headVersion}.`)
  if (entry.documentVersion === 2) {
    facts.push('The document write is committed; no new write is inferred.')
  } else {
    // Independent conditions may coexist. Review, an explicit pause and a shared-version conflict are not interchangeable.
    if (entry.paused) facts.push(entry.recoveryPause ? 'Write paused in recorded Host recovery.' : 'Write paused in the saved authorization.')
    if (entry.pendingReview) facts.push('Owner correction pending review; writes held.')
    if (captureUnconfirmed) facts.push('Instruction capture unconfirmed; writes held.')
    if (entry.pauseUnconfirmed) facts.push('Pause could not be confirmed; writes held.')
    if (entry.shared && entry.shared.baseVersion !== entry.shared.headVersion) facts.push('Shared document conflict; the old revision cannot be written.')
    if (entry.recovery) {
      const { evidenceId, turn, failureEventSeq } = entry.recovery
      facts.push(`Recovery evidence ${evidenceId}: current continuation ended with TRANSPORT (turn ${turn}, event ${failureEventSeq}).`,
        `To consider a paused replacement, open an unbound document Worker and use /studio-doc recover ${entry.id} ${evidenceId}.`)
    }
    if (entry.repeatedScopeRefusals) {
      const calls = entry.repeatedScopeRefusals.map(({ evidenceId, eventSeq }) => `Native call event ${eventSeq}:\n/studio-doc guard ${evidenceId}`).join('\n')
      concern = 'Progress concern: Repeated scope refusals (ACTION_NOT_APPROVED) on at least two distinct calls in the current execution and authorization. This does not confirm task failure or that the requested effects were the same.\n'
        + `To inspect the two most recent recorded calls, open current document Worker Session ${entry.sessionId} and run:\n${calls}`
    } else if (!entry.recovery && !entry.paused && !entry.pendingReview && !captureUnconfirmed && !entry.pauseUnconfirmed
      && (!entry.shared || entry.shared.baseVersion === entry.shared.headVersion)) facts.push('Awaiting the current authorized document action.')
  }
  // A historical delivery remains visible after recovery, but is not a receipt for a newer failure.
  const notice = entry.failureNotice
  if (notice) {
    const state = notice.state === 'delivered' ? `delivered (${notice.messageId})`
      : notice.state === 'unconfirmed' ? 'delivery unconfirmed; no automatic resend' : 'attempt recorded; no receipt confirmed yet'
    facts.push(`Feishu Watchdog notice for evidence ${notice.evidenceId}: ${state}.`)
  }
  if (failureAlerts && entry.recovery && entry.recovery.evidenceId !== notice?.evidenceId) {
    facts.push('No Feishu notice attempt recorded for the current evidence.')
  }
  facts.push(observedSession('Current Worker', entry.sessionId, observe))
  return concern ? `${facts.join(' ')}\n${concern}` : facts.join(' ')
}

function jobHealth(entry: WatchdogJob, observe: ObserveSession): string {
  const { id, paused, authorizationVersion, attempt, automatic, startEvidence } = entry
  const state = entry.state === 'running' ? 'Waiting on the recorded external invocation'
    : entry.state === 'unknown' ? 'External observation unknown, not a confirmed failure'
      : entry.state === 'failed' ? 'Recorded external failure' : 'External invocation recorded complete'
  const facts = [`Job for work ${id}: ${state}.`,
    `${entry.unit} / ${entry.invocationId}; observation v${entry.observationVersion} at ${entry.observedAt}.`,
    `Project ${entry.projectId}; management epoch ${entry.managementEpoch}.`, observedSession('Current Leader', entry.leaderSessionId, observe)]
  if (paused) facts.push(`Owner paused further post-processing (authorization v${authorizationVersion}); this does not stop the job or an already started attempt.`)
  else facts.push(`Post-processing is not paused (authorization v${authorizationVersion}).`)

  // A released reservation is text work history, not proof this job started post-processing.
  if (attempt?.state === 'released') facts.push(`Latest text reservation (execution epoch ${attempt.executionEpoch}) was released before start.`)
  else if (attempt) facts.push(`Post-processing attempt (execution epoch ${attempt.executionEpoch}): ${executionStatus[attempt.state]}.`)
  // Compare the saved admission with the owner pause, not the current presence or activity of the Worker.
  if (startEvidence?.kind === 'before-pause') {
    facts.push(`The recorded Studio start at authorization v${startEvidence.startAuthorizationVersion} predates the current pause at v${startEvidence.pauseAuthorizationVersion}.`)
  } else if (startEvidence?.kind === 'during-pause') {
    facts.push(`Recorded inconsistency: Studio recorded a start while owner pause v${startEvidence.authorizationVersion} was active.`)
  } else if (startEvidence?.kind === 'unconfirmed') {
    facts.push('Start and pause order unconfirmed: the saved evidence cannot establish the order. This does not show that the attempt started while paused.')
  }
  if (startEvidence && startEvidence.kind !== 'unconfirmed') facts.push('This does not establish model entry or an external action.')

  const waiting = entry.state === 'completed' && !paused && (!attempt || attempt.state === 'released')
  if (waiting) facts.push('No post-processing start is recorded.')
  if (automatic?.state === 'spent') {
    facts.push(`The current automatic grant was spent on execution epoch ${automatic.executionEpoch}; it cannot be reused.`)
  } else if (automatic?.state === 'unused') {
    facts.push('An unused automatic grant is recorded for the current Leader and authorization version.')
    // This is evidence of an outstanding follow-up, not permission or a check of the live launch prerequisites.
    if (waiting) facts.push('Whether it can start now depends on the Leader, model route and quota; this snapshot does not check launch readiness.')
  } else {
    facts.push('No automatic grant is recorded for the current Leader and authorization version.')
    if (waiting) facts.push('The owner can decide whether follow-up is still needed.')
  }
  facts.push(`In the current Leader Session, read the saved job with /studio-job status ${id} if job control is enabled, or /studio-project work ${id}.`)
  return facts.join(' ')
}

const executionStatus: Record<WatchdogExecution['state'], string> = {
  pending: 'waiting for assignment',
  reserved: 'reserved, not yet entered',
  running: 'recorded active; may be starting, running, or awaiting settlement',
  completed: 'completion recorded',
  failed: 'failure recorded',
  interrupted: 'interruption recorded',
  released: 'reservation released without entering',
}

function executionHealth(entry: WatchdogExecution, observe: ObserveSession): string {
  // A project item's text dispatch is separate from the state of its linked job or document.
  const label = entry.kind === 'project' ? 'Project text work' : entry.kind === 'feishu' ? 'Feishu task'
    : entry.kind === 'draft' ? 'Web draft' : entry.kind === 'study' ? 'Study' : 'Advice'
  const termination = entry.kind === 'project' ? entry.termination : undefined
  const status = termination && entry.state === 'running' ? 'dispatch still recorded as running; Worker turn has ended'
    : entry.kind === 'project' && entry.state === 'pending' ? 'no text dispatch recorded' : executionStatus[entry.state]
  const block = entry.kind === 'project' ? entry.ownerBlock : undefined
  // Keep a past release separate from the current owner decision. A later running or finished dispatch leads with its execution state.
  const hold = block === 'active' ? 'blocked by owner'
    : block === 'cleared' && (entry.state === 'pending' || entry.state === 'released') ? 'owner block cleared' : undefined
  const facts = [`${label} ${entry.id}: ${hold ?? status}.`]
  if (hold) facts.push(`Text dispatch history: ${status}.`)
  if (entry.reason === 'PROJECT_WORK_BLOCKED') facts.push('An owner block released that reservation before it started.')
  else if (entry.reason) facts.push(`Recorded reason: ${entry.reason}.`)
  if (block === 'cleared') facts.push(hold ? 'Clearing the block did not authorize dispatch.' : 'An earlier owner block was cleared; that did not authorize dispatch.')
  if (entry.projectId && entry.leaderSessionId && entry.managementEpoch) facts.push(`Project ${entry.projectId}; management epoch ${entry.managementEpoch}.`,
    observedSession('Current Leader', entry.leaderSessionId, observe))
  if (block) facts.push(`For the saved condition, use /studio-project work ${entry.id} in the current Leader Session.`)
  if (termination) facts.push(`Worker turn ${termination.turn} ended with ${termination.code} (native event ${termination.endEventSeq}).`,
    `For the saved dispatch, use /studio-project work ${entry.id} in the current Leader Session.`)
  else if (entry.kind === 'project' && entry.state === 'running') facts.push('No native turn termination is recorded for this dispatch; its outcome is not established.')
  if (entry.sessionId && !termination && (entry.state === 'reserved' || entry.state === 'running')) {
    if (entry.executionEpoch) facts.push(`Execution epoch ${entry.executionEpoch}.`)
    facts.push(observedSession(entry.kind === 'advice' ? 'Advisor' : 'Worker', entry.sessionId, observe))
  } else if (entry.sessionId && entry.executionEpoch) {
    facts.push(`Recorded execution Session ${entry.sessionId}, epoch ${entry.executionEpoch}.`)
  }
  return facts.join(' ')
}

function quotaHealth(entry: WatchdogQuota): string {
  if (entry.state === 'clear') return `Quota pool ${entry.poolId}: no active Studio stop recorded.`
  if (entry.state === 'unconfirmed' || !entry.incident) return `Quota pool ${entry.poolId}: stop state unconfirmed; inference held.`
  const { reason, incidentId, noticedAt, sessionId } = entry.incident
  const notice = entry.notice ? ` Existing Feishu notice: ${entry.notice}.` : ''
  return `Quota pool ${entry.poolId}: inference held (${reason}); incident ${incidentId} at ${noticedAt}.`
    + (sessionId ? ` Source Session ${sessionId}.` : '') + notice
}

function renderEntry(entry: WatchdogEntry, captureUnconfirmed: boolean, observe: ObserveSession, failureAlerts: boolean): string {
  if (entry.kind === 'document') return documentHealth(entry, captureUnconfirmed, observe, failureAlerts)
  if (entry.kind === 'job') return jobHealth(entry, observe)
  return executionHealth(entry, observe)
}

/** Only the owner-native command reads this status. Inspecting a receipt does not wake the notifier. */
export function watchdogCommand(store: ManagedWorkerStore, argument: string, observe: ObserveSession,
  failureAlerts: boolean): { kind: 'success' | 'error'; text: string } {
  const input = argument.trim()
  const parsed = input ? query.safeParse(input.length <= 96 ? input.split(/\s+/u) : undefined) : undefined
  if (parsed && !parsed.success) return { kind: 'error', text: 'Use /studio-health or /studio-health <document|job|draft|feishu|project|study|advice> <id>.' }
  const target = parsed?.success ? { kind: parsed.data[0], id: parsed.data[1] } : undefined
  const result = store.watchdog(target)
  if (!result.ok) return { kind: 'error', text: `Studio Watchdog could not confirm a snapshot: ${result.reason}. No health or recovery conclusion was made.` }
  const { entries, truncated, quotas, captureUnconfirmed, pauseUnconfirmed } = result.value
  const header = ['Studio Watchdog: read-only snapshot. External states are saved observations; no polling, inference, or recovery ran.']
  if (captureUnconfirmed) header.push('A document instruction capture is unconfirmed in this Host run; document writes are held.')
  if (pauseUnconfirmed) header.push('A document pause is unconfirmed in this Host run; affected writes are held.')
  if (truncated.length) header.push(`Overview limited to ${WATCHDOG_PAGE_LIMIT} per category. More records exist for: ${truncated.join(', ')}. Use the exact ID to inspect one.`)
  if (truncated.includes('document')) header.push('A document omitted from the overview may still have evidence. Use /studio-health document <task-id> to check it.')
  if (truncated.includes('project')) header.push('Some project holds may be outside this overview. Use /studio-health project <work-id> to check one.')
  const sections = [...header, ...quotas.map(quotaHealth), ...entries.map(entry => renderEntry(entry, captureUnconfirmed, observe, failureAlerts))]
  if (!entries.length) sections.push('No matching task or job records in this snapshot; this is not a general health attestation.')
  return { kind: 'success', text: sections.join('\n') }
}
