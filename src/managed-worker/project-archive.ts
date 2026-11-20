/** Owner commands for project facts backed by an exact excerpt of a saved text result. */
import { z } from 'zod'
import { isProjectFactKey, isProjectFactQuote, type ProjectFact, type ProjectArchiveStore } from './project-archive-store.ts'

export const PROJECT_ARCHIVE_HINT = 'record-fact <JSON> | facts [after-key] | fact <key> | fact-history <key> <revision>'
const key = z.string().refine(isProjectFactKey)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const revisionArg = z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(revision)
const saveArgs = z.strictObject({ key, expectedEpoch: revision, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  workId: z.uuid(), quote: z.string().refine(isProjectFactQuote) })
const listArgs = z.tuple([key.optional()])
const historyArgs = z.tuple([key, revisionArg])

interface CommandReceipt { kind: 'success' | 'error'; text: string }
const success = (text: string): CommandReceipt => ({ kind: 'success', text })
const denied = (reason: string): CommandReceipt => ({ kind: 'error', text: `Studio project archive: ${reason}.` })

/** Distinguish who selected the fact from the Worker who produced its source. */
function factOrigin(fact: ProjectFact): string {
  return `Project ${fact.projectId}; work ${fact.workId}; execution epoch ${fact.executionEpoch}.`
    + ` Worker Bot ${fact.workerBotId}; Session ${fact.workerSessionId}; message ${fact.messageId} (turn ${fact.turn}, event ${fact.eventSeq}).\n`
    + `Recorded by owner command ${fact.commandId} in Leader Session ${fact.leaderSessionId} at management epoch ${fact.managementEpoch}, ${fact.at}.`
}

/** The caller authenticates the native owner control. The Store derives project scope and current management from this Session. */
export function projectArchiveCommand(archive: ProjectArchiveStore, sessionId: string, commandId: string,
  verb: string | undefined, argument: string): CommandReceipt | undefined {
  if (verb === 'record-fact') {
    let json: unknown
    try { json = JSON.parse(argument) } catch { return denied('EXPECTED_PROJECT_FACT_JSON') }
    const fields = saveArgs.safeParse(json)
    if (!fields.success) return denied('EXPECTED_PROJECT_FACT_JSON')
    const result = archive.save(sessionId, commandId, fields.data)
    if (!result.ok) return denied(result.reason)
    const fact = result.value
    return success(`Project fact saved: ${fact.key} v${fact.revision}. No work or authorization changed.\n${factOrigin(fact)}`)
  }
  if (verb === 'facts') {
    const parsed = listArgs.safeParse(argument ? argument.split(/\s+/u) : [])
    if (!parsed.success) return denied('EXPECTED_OPTIONAL_FACT_CURSOR')
    const result = archive.list(sessionId, parsed.data[0])
    if (!result.ok) return denied(result.reason)
    const { items, next } = result.value
    if (!items.length) return success('No current project facts on this page.')
    return success(`Current project facts:\n${items.map(fact => `${fact.key} v${fact.revision}; work ${fact.workId}`).join('\n')}`
      + (next === undefined ? '' : `\nMore results: /studio-project facts ${next}`))
  }
  if (verb === 'fact') {
    const parsed = key.safeParse(argument)
    if (!parsed.success) return denied('EXPECTED_FACT_KEY')
    const result = archive.read(sessionId, parsed.data)
    if (!result.ok) return denied(result.reason)
    const fact = result.value
    return success(`Current project fact ${fact.key} v${fact.revision} (owner-selected Worker excerpt).\n${factOrigin(fact)}\n\n${fact.quote}`)
  }
  if (verb === 'fact-history') {
    const parsed = historyArgs.safeParse(argument.split(/\s+/u))
    if (!parsed.success) return denied('EXPECTED_FACT_KEY_AND_REVISION')
    const [name, rev] = parsed.data
    const result = archive.trace(sessionId, name, rev)
    if (!result.ok) return denied(result.reason)
    const fact = result.value
    return success(`Project fact audit only: ${fact.key} v${fact.revision}.\n${factOrigin(fact)}`)
  }
}
