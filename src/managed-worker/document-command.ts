/** Owner-only commands for shared documents, handled directly by the Studio Web host. */
import { z } from 'zod'
import type { ManagedResult, ManagedTask, ManagedWorkerStore, SharedDocumentRevision } from './store.ts'

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const id = z.uuid()
const body = z.string().max(32_000)
const newArgs = z.strictObject({ text: body })
const saveArgs = z.strictObject({ documentId: id, expectedVersion: revision, text: body })
const readArgs = z.tuple([id, z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(revision).optional()])
export const documentStartArgs = z.union([
  z.strictObject({ initial: body, replacement: body }),
  z.strictObject({ documentId: id, expectedVersion: revision, replacement: body }),
])

interface CommandResult { kind: 'success' | 'error'; text: string }

/** A task's snapshot state and the shared document's head are separate; newer commits do not undo a completed task. */
export function sharedDocumentCoordinates(task: ManagedTask): string {
  const shared = task.sharedDocument
  if (!shared) return ''
  const { documentId, baseVersion, headVersion, committedVersion } = shared
  const state = committedVersion === undefined
    ? baseVersion === headVersion ? '' : ' Conflict: the document changed since this task was approved. Do not retry the old write.'
    : ` This task saved revision ${committedVersion}.`
  return ` Shared document ${documentId}; base revision ${baseVersion}; current revision ${headVersion}.${state}`
}

export function sharedDocumentError(reason: string): CommandResult | undefined {
  if (reason !== 'SHARED_DOCUMENT_CONFLICT') return
  return { kind: 'error', text: `${reason}: This write was not saved. Run /studio-doc status in the Worker to check the task's base and current revisions. Use /studio-doc doc-read <document-id> [revision] to compare the texts; do not retry the old write.` }
}

/** Commands mutate only the explicit target at the expected head; reading a revision never grants a write permit. */
export function sharedDocumentCommand(store: ManagedWorkerStore, sessionId: string, commandId: string, verb: string | undefined,
  argument: string): CommandResult | undefined {
  if (verb !== 'doc-new' && verb !== 'doc-read' && verb !== 'doc-save') return
  const failure = (reason: string): CommandResult => sharedDocumentError(reason)
    ?? { kind: 'error', text: `Shared document control rejected: ${reason}.` }
  const receipt = (result: ManagedResult<SharedDocumentRevision>, read = false): CommandResult => {
    if (!result.ok) return failure(result.reason)
    const { documentId, version, text } = result.value
    return { kind: 'success', text: `Shared document ${documentId}; revision ${version}.` + (read ? `\n\n${text}` : '') }
  }
  if (verb === 'doc-read') {
    const parsed = readArgs.safeParse(argument.split(/\s+/))
    return parsed.success ? receipt(store.readSharedDocument(...parsed.data), true) : failure('EXPECTED_DOCUMENT_ID_AND_OPTIONAL_REVISION')
  }
  let json: unknown
  try { json = JSON.parse(argument) } catch { return failure('INVALID_DOCUMENT_JSON') }
  if (verb === 'doc-new') {
    const args = newArgs.safeParse(json)
    return args.success ? receipt(store.createSharedDocument(sessionId, args.data.text, commandId)) : failure('EXPECTED_DOCUMENT_TEXT')
  }
  const args = saveArgs.safeParse(json)
  if (!args.success) return failure('EXPECTED_DOCUMENT_ID_VERSION_AND_TEXT')
  const { documentId, expectedVersion, text } = args.data
  return receipt(store.editSharedDocument(sessionId, documentId, expectedVersion, text, commandId))
}
