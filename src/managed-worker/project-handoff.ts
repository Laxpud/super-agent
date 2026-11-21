/** Describe a recorded transfer separately from the state the current Leader must use. */
import type { ProjectHandoffItem, ProjectHandoffReview } from './project-handoff-store.ts'
import type { StudioProjectBinding } from './project-store.ts'

export const PROJECT_HANDOFF_HINT = 'handoff [management-epoch]'

function leader(binding: StudioProjectBinding): string {
  return `Leader Bot ${binding.leaderBotId}; Session ${binding.leaderSessionId}; management epoch ${binding.managementEpoch}.`
}

/** Derive only a display label from the recorded states; it is not a dispatch or authorization decision. */
function stateOf({ run, document, job, blocked }: ProjectHandoffItem): string {
  if (blocked) return 'blocked'
  if (run && run.state !== 'released') return run.state
  if (document) {
    if (document.documentVersion === 2) return 'document committed'
    if (document.hold || document.paused) return 'document action held'
    return 'awaiting document action'
  }
  if (job) {
    if (job.paused) return 'post-processing paused'
    if (job.state === 'completed') return 'external job completion recorded'
    return `awaiting confirmed job completion (${job.state})`
  }
  return 'pending'
}

function workItem(item: ProjectHandoffItem): string {
  const { workId, leaderSessionId, managementEpoch, sourceMessageId, run, document, job } = item
  const lines = [
    `- Work ${workId}: ${stateOf(item)}.`,
    `  Owner message ${sourceMessageId} in Leader Session ${leaderSessionId} at management epoch ${managementEpoch}.`,
  ]
  if (run) {
    const state = run.state === 'released' ? 'released before model entry' : run.state
    const result = run.result ? ` Saved result message ${run.result.messageId}, turn ${run.result.turn}, event ${run.result.eventSeq}.` : ''
    lines.push(`  Text attempt ${run.executionEpoch} (${state}); Worker Session ${run.workerSessionId}, assigned at management epoch ${run.managementEpoch}.${result}`)
  }
  if (document) {
    const hold = document.hold ? ` Hold: ${document.hold}.` : ''
    lines.push(`  Document task ${document.taskId}; Worker Session ${document.workerSessionId}, execution epoch ${document.executionEpoch}; authorization v${document.authorizationVersion}; snapshot v${document.documentVersion}; ${document.paused ? 'paused' : 'not paused'}.${hold}`)
  }
  if (job) {
    const automatic = job.automatic ? ` Automatic continuation ${job.automatic} at this snapshot.` : ' No current automatic continuation grant at this snapshot.'
    lines.push(`  Recorded job observation v${job.observationVersion}: ${job.state} at ${job.observedAt}; authorization v${job.authorizationVersion}; ${job.paused ? 'paused' : 'not paused'}.${automatic}`)
  }
  return lines.join('\n')
}

/** The two sections contain metadata only. Historical state must not be mistaken for current authorization. */
export function projectHandoffText({ record, current }: ProjectHandoffReview): string {
  const { before, after, at, commandId, truncated, items } = record
  return [
    `Project handoff record for ${after.projectId}; management epoch ${after.managementEpoch}.`,
    `Transferred from ${leader(before)}`,
    `Transferred to ${leader(after)}`,
    `Source: owner command ${commandId} in Session ${after.leaderSessionId}, recorded at ${at}.`,
    '',
    'At transfer (history only):',
    ...(items.length ? items.map(workItem) : ['No work recorded in this handoff.']),
    ...(truncated ? [`Only the most recent ${items.length} work items were recorded. Other work is not covered by this record.`] : []),
    '',
    'Current state of the same work (read only):',
    leader(current.binding),
    ...(current.items.length ? current.items.map(workItem) : ['No recorded work IDs to recheck.']),
    ...(current.items.some(item => item.blocked) ? ['Open /studio-project work <work-id> in the current Leader Session to check the saved condition for each blocked item.'] : []),
    '',
    'This record neither grants authorization nor starts work. Use /studio-project work [work-id] for other work or exact saved results, and check current authorization before continuing.',
  ].join('\n')
}
