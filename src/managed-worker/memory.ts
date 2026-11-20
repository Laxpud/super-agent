/** Manage owner-declared Studio preferences without inserting them into a model turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import { isMemoryKey, isPreferenceText, MEMORY_TEXT_LIMIT, type MemorySource, type StudioPreference } from './memory-store.ts'
import type { ManagedResult, ManagedWorkerStore } from './store.ts'

export const MEMORY_COMMAND = 'studio-memory'
export const MEMORY_HINT = 'list [<project-id>|global] [after-key] | read <key> [<project-id>] | trace <key> [revision] | remember <JSON> | correct <JSON> | restrict <key> <revision> <project-id> | forget <key> <revision>'
const key = z.string().refine(isMemoryKey)
const text = z.string().refine(isPreferenceText)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const revisionArg = z.string().regex(/^[1-9]\d*$/u).transform(Number).pipe(revision)
const project = z.uuid()
const remember = z.strictObject({ key, text, projectId: project.optional() })
const correct = z.strictObject({ key, expectedRevision: revision, text })
const restrict = z.tuple([key, revisionArg, project])
const forget = z.tuple([key, revisionArg])
const list = z.tuple([z.union([z.literal('global'), project]).optional(), key.optional()])
const read = z.tuple([key, project.optional()])
const trace = z.tuple([key, revisionArg.optional()])
const SOURCE_TAIL_LIMIT = 16

interface CommandResult { kind: 'success' | 'error'; text: string }
const success = (message: string): CommandResult => ({ kind: 'success', text: message })
const denied = (reason: string): CommandResult => ({ kind: 'error', text: `Studio memory: ${reason}.` })

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) }
  catch { return undefined }
}

function coordinates(entry: StudioPreference): string {
  return `${entry.key} v${entry.revision}; ${entry.projectId ? `project ${entry.projectId}` : 'global'}`
}

function origin(entry: StudioPreference): string {
  const { sessionId, commandId, eventSeq } = entry.source
  return `Owner command ${commandId} in Session ${sessionId}, event ${eventSeq}. Recorded at ${entry.at}.`
}

/** The native interceptor logs a command before invoking its handler. Verify the exact fresh source after a durability barrier. */
async function confirmedCommandSource(ctx: Context, agent: Agent, commandId: string, signal: AbortSignal): Promise<MemorySource | undefined> {
  // Capture the boundary now; a concurrent command or turn can append while persistence drains.
  const end = agent.session.seq
  const start = Math.max(0, end - SOURCE_TAIL_LIMIT)
  await ctx.sessionPersistence.flush()
  signal.throwIfAborted()
  await using handle = await ctx.sessionPersistence.open(agent.id, 'read', { signal })
  const { events } = await handle.read(start, end - start, { signal })
  for (const event of events) {
    if ((event.type as string) !== 'command/run' || event.seq < handle.inheritedEventCount || event.seq >= end) continue
    // Older development declarations do not yet include the installed Host's command lifecycle payload.
    const data = event.data as { commandId?: unknown; name?: unknown; source?: { kind?: unknown }; args?: unknown }
    if (data.commandId === commandId && data.name === MEMORY_COMMAND && data.source?.kind === 'user' && data.args === undefined) {
      return { sessionId: agent.id, commandId, eventSeq: event.seq }
    }
  }
}

/** Native Web command only. Reads never create a model input, and only current authority may commit after a source read. */
export async function memoryCommand(ctx: Context, store: ManagedWorkerStore, agent: Agent, commandId: string,
  rawInput: string, signal: AbortSignal, ready: () => boolean): Promise<CommandResult> {
  signal.throwIfAborted()
  if (!ready()) return denied('OPEN_A_STUDIO_ASSISTANT_SESSION')
  if (rawInput.length > MEMORY_TEXT_LIMIT * 6 + 512) return denied('INPUT_TOO_LARGE')
  const [, verb, argument = ''] = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(rawInput.trim()) ?? []
  const args = argument ? argument.split(/\s+/u) : []
  if (verb === 'list') {
    const parsed = list.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_SCOPE_AND_OPTIONAL_CURSOR')
    const [scope, after] = parsed.data
    const result = store.memory.list(scope === 'global' ? undefined : scope, after)
    if (!result.ok) return denied(result.reason)
    const { items, next } = result.value
    if (!items.length) return success('No current preferences in this scope and page.')
    return success(`Current preferences:\n${items.map(coordinates).join('\n')}`
      + (next === undefined ? '' : `\nMore results: /studio-memory list ${scope ?? 'global'} ${next}`))
  }
  if (verb === 'read') {
    const parsed = read.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_PREFERENCE_KEY_AND_OPTIONAL_PROJECT')
    const result = store.memory.read(...parsed.data)
    if (!result.ok) return denied(result.reason)
    return success(`Current preference ${coordinates(result.value)}.\n${origin(result.value)}\n\n${result.value.text}`)
  }
  if (verb === 'trace') {
    const parsed = trace.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_PREFERENCE_KEY_AND_OPTIONAL_REVISION')
    const result = store.memory.trace(...parsed.data)
    if (!result.ok) return denied(result.reason)
    const entry = result.value
    return success(`Preference audit only: ${coordinates(entry)}; recorded operation ${entry.operation}; recorded state ${entry.state}.\n${origin(entry)}`)
  }

  // Parse before touching persistence. The submitted text is not copied into the native command/run event or mutation receipt.
  let mutate: (source: MemorySource) => ManagedResult<StudioPreference>
  if (verb === 'remember') {
    const parsed = remember.safeParse(parseJson(argument))
    if (!parsed.success) return denied('EXPECTED_KEY_AND_NONSECRET_PREFERENCE_TEXT')
    const { key: name, text: value, projectId } = parsed.data
    mutate = source => store.memory.remember(name, value, projectId, source)
  } else if (verb === 'correct') {
    const parsed = correct.safeParse(parseJson(argument))
    if (!parsed.success) return denied('EXPECTED_KEY_REVISION_AND_NONSECRET_PREFERENCE_TEXT')
    const { key: name, expectedRevision, text: value } = parsed.data
    mutate = source => store.memory.change(name, expectedRevision, { kind: 'correct', text: value }, source)
  } else if (verb === 'restrict') {
    const parsed = restrict.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_KEY_REVISION_AND_PROJECT')
    const [name, expectedRevision, projectId] = parsed.data
    mutate = source => store.memory.change(name, expectedRevision, { kind: 'restrict', projectId }, source)
  } else if (verb === 'forget') {
    const parsed = forget.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_KEY_AND_REVISION')
    const [name, expectedRevision] = parsed.data
    mutate = source => store.memory.change(name, expectedRevision, { kind: 'forget' }, source)
  } else return denied(`Use /studio-memory ${MEMORY_HINT}`)

  const source = await confirmedCommandSource(ctx, agent, commandId, signal).catch(() => undefined)
  signal.throwIfAborted()
  if (!ready()) return denied('OPEN_A_STUDIO_ASSISTANT_SESSION')
  if (!source) return denied('MEMORY_SOURCE_UNCONFIRMED')
  const result = mutate(source)
  if (!result.ok) return denied(result.reason)
  const entry = result.value
  return success(`Preference saved: ${coordinates(entry)}; ${entry.state}. ${origin(entry)} No task authorization changed.`)
}
