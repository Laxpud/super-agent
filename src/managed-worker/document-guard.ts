/** Describe the document check's own outcome and expose its metadata to the owner, not to a model tool. */
import { z } from 'zod'
import { documentGuardCategory, type DocumentGuardCapture, type DocumentGuardEvidence } from './document-guard-store.ts'
import { sharedDocumentError } from './document-command.ts'
import type { ManagedWorkerStore } from './store.ts'

interface CommandResult { kind: 'success' | 'error'; text: string }

export const DOCUMENT_GUARD_HINT = 'guard [evidence-id]'
const labels = {
  denied: 'Explicit scope refusal',
  state: 'Task state blocked the write',
  unconfirmed: 'Check unconfirmed',
} as const

/** Keep a technical non-decision distinct from a completed scope refusal, even if evidence could not be stored. */
export function documentGuardFeedback(reason: string, capture: DocumentGuardCapture): string {
  const category = documentGuardCategory(reason)
  if (!category) return `Managed write denied: ${reason}`
  const retention = capture.retention
  const source = retention?.kind === 'retained'
    ? ` Evidence ${retention.evidenceId}; see /studio-doc guard ${retention.evidenceId} in the current Worker.`
    : retention?.reason === 'limit' ? ' This observation was not retained because the evidence limit was reached.'
      : ' No durable evidence was confirmed for this observation.'
  const guidance = category === 'denied' ? `Managed write denied: ${reason}. The checked effect was outside the approved scope. Changing how it is requested does not authorize it.`
    : category === 'state' ? `Managed write blocked by task state: ${sharedDocumentError(reason)?.text ?? `${reason}. Check /studio-doc status and /studio-doc inbox before continuing.`}`
      : `Managed write verification unconfirmed: ${reason}. This is not a scope refusal. Do not repeat the original write. When the Host is available, check /studio-doc status and /studio-doc inbox in the current Worker. If the result still cannot be verified, treat it as unconfirmed.`
  return guidance + source
}

function formatEvidence(entry: DocumentGuardEvidence): string {
  const { evidenceId, workerSessionId, executionEpoch, authorizationVersion, documentId, expectedVersion, toolCallId, category, reason, phase, at } = entry
  const origin = `Worker Session ${workerSessionId}; execution epoch ${executionEpoch}; tool call ${toolCallId}.`
  const checked = `Authorization ${authorizationVersion === undefined ? 'not confirmed in this check' : `v${authorizationVersion}`}.`
    + (documentId === undefined ? '' : ` Shared document ${documentId}.`)
    + (expectedVersion === undefined ? '' : ` Expected document version in the call or permit: ${expectedVersion}.`)
  return `Evidence ${evidenceId}: ${labels[category]} (${reason}). ${phase === 'authorize' ? 'Guard check' : 'Commit recheck'}, ${at}.\n${origin}\n${checked}`
}

/** Query one exact ID or a bounded recent page, under the Store's current Worker and task fence. */
export function documentGuardCommand(store: ManagedWorkerStore, sessionId: string, argument: string): CommandResult {
  if (argument && !z.uuid().safeParse(argument).success) {
    return { kind: 'error', text: 'Use /studio-doc guard [evidence-id], with one ID from the tool feedback or recent evidence.' }
  }
  const result = store.readDocumentGuard(sessionId, argument || undefined)
  if (!result.ok) {
    const hint = result.reason === 'STALE_EXECUTION' || result.reason === 'SESSION_NOT_BOUND'
      ? ' Open the document Worker currently bound to the task, including its replacement Session after transfer.'
      : result.reason === 'DOCUMENT_GUARD_EVIDENCE_NOT_FOUND'
        ? ' Not found in this task. Check the full ID or run /studio-doc guard without an ID to check the task and its recent evidence.' : ''
    return { kind: 'error', text: `Cannot read document guard evidence: ${result.reason}.${hint}` }
  }
  const { task, items, limited, more } = result.value
  const notes = [
    ...(limited ? ['The retention limit has been reached; later checks may not be present.'] : []),
    ...(more ? ['Only recent records are shown. Use an exact evidence ID from the original tool feedback to open an older one.'] : []),
    'Evidence describes a past check. It is not approval, and reading it does not retry a write.',
  ]
  return { kind: 'success', text: [`Document guard evidence for task ${task.taskId}. Current execution epoch ${task.executionEpoch}; authorization v${task.authorizationVersion}.`,
    ...(items.length ? items.map(formatEvidence) : ['No recorded observations in this view. This does not confirm approval.']), ...notes,
  ].join('\n\n') }
}
