/** Owner-only publication and inspection of reusable Leader Bot methods. */
import { z } from 'zod'
import { isExperienceText, type BotExperience, type BotExperienceStore } from './bot-experience-store.ts'
import { isProjectFactKey } from './project-archive-store.ts'

export const BOT_EXPERIENCE_HINT = 'record-experience <JSON> | experiences [after-key] | experience <key> | experience-history <key> <revision>'
const key = z.string().refine(isProjectFactKey)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const revisionArg = z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(revision)
const text = z.string().refine(isExperienceText)
const saveArgs = z.strictObject({ key, expectedEpoch: revision, expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  method: text, conditions: text, factKey: key, factRevision: revision })
const listArgs = z.tuple([key.optional()])
const historyArgs = z.tuple([key, revisionArg])

interface CommandReceipt { kind: 'success' | 'error'; text: string }
const success = (text: string): CommandReceipt => ({ kind: 'success', text })
const denied = (reason: string): CommandReceipt => ({ kind: 'error', text: `Studio Bot experience: ${reason}.` })

/** The receipt identifies the original fact and decision without opening the other project's archive. */
function origin(item: BotExperience): string {
  return `Leader Bot ${item.botId}; source project ${item.projectId}, fact ${item.factKey} v${item.factRevision}.\n`
    + `Recorded by owner command ${item.commandId} in Leader Session ${item.leaderSessionId} at management epoch ${item.managementEpoch}, ${item.at}.`
}

/** The caller authenticates the native owner command. The Store resolves the Bot and project from the live Leader binding. */
export function botExperienceCommand(store: BotExperienceStore, sessionId: string, commandId: string,
  verb: string | undefined, argument: string): CommandReceipt | undefined {
  if (verb === 'record-experience') {
    let json: unknown
    try { json = JSON.parse(argument) } catch { return denied('EXPECTED_BOT_EXPERIENCE_JSON') }
    const args = saveArgs.safeParse(json)
    if (!args.success) return denied('EXPECTED_BOT_EXPERIENCE_JSON')
    const result = store.save(sessionId, commandId, args.data)
    if (!result.ok) return denied(result.reason)
    const item = result.value
    return success(`Bot experience saved: ${item.key} v${item.revision}. No work or authorization changed.\n${origin(item)}`)
  }
  if (verb === 'experiences') {
    const args = listArgs.safeParse(argument ? argument.split(/\s+/u) : [])
    if (!args.success) return denied('EXPECTED_OPTIONAL_EXPERIENCE_CURSOR')
    const result = store.list(sessionId, args.data[0])
    if (!result.ok) return denied(result.reason)
    const { items, next } = result.value
    if (!items.length) return success('No experience records for this Leader Bot on this page.')
    return success(`Leader Bot experiences:\n${items.map(item => `${item.key} v${item.revision}; ${item.sourceCurrent ? 'source current' : 'source no longer current'}`).join('\n')}`
      + (next === undefined ? '' : `\nMore results: /studio-project experiences ${next}`))
  }
  if (verb === 'experience') {
    const args = key.safeParse(argument)
    if (!args.success) return denied('EXPECTED_EXPERIENCE_KEY')
    const result = store.read(sessionId, args.data)
    if (!result.ok) return denied(result.reason)
    const item = result.value
    return success(`Current Bot experience ${item.key} v${item.revision} (guidance, not authorization).\n${origin(item)}\n\n`
      + `Conditions:\n${item.conditions}\n\nMethod:\n${item.method}`)
  }
  if (verb === 'experience-history') {
    const args = historyArgs.safeParse(argument.split(/\s+/u))
    if (!args.success) return denied('EXPECTED_EXPERIENCE_KEY_AND_REVISION')
    const [name, rev] = args.data
    const result = store.trace(sessionId, name, rev)
    if (!result.ok) return denied(result.reason)
    const item = result.value
    return success(`Bot experience audit only: ${item.key} v${item.revision}.\n${origin(item)}`)
  }
}
