/** Manage owner-declared Studio preferences without inserting them into a model turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { z } from 'zod'
import { isMemoryKey, isPreferenceText, MEMORY_TEXT_LIMIT, PREFERENCE_CORRECTION_RECEIPT_PREFIX, PREFERENCE_PROPOSAL_RECEIPT_PREFIX,
  type MemorySource, type PreferenceCitation, type StudioPreference } from './memory-store.ts'
import type { PreferenceQuery } from './preference-query-intent.ts'
import type { ManagedResult, ManagedWorkerStore } from './store.ts'

export const MEMORY_COMMAND = 'studio-memory'
export const MEMORY_HINT = 'list [<project-id>|global] [after-key] | read <key> [<project-id>] | trace <key> [revision] | remember <JSON> | correct <JSON> | restrict <key> <revision> <project-id> | forget <key> <revision>'
  + ' | cite <key> <revision> [<project-id>] | resolve <citation-id> [<project-id>] | trace-citation <citation-id>'
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
const cite = z.tuple([key, revisionArg, project.optional()])
const resolveCitation = z.tuple([z.uuid(), project.optional()])
const traceCitation = z.tuple([z.uuid()])
const SOURCE_TAIL_LIMIT = 16

interface CommandResult { kind: 'success' | 'error'; text: string }
const success = (message: string): CommandResult => ({ kind: 'success', text: message })
const denied = (reason: string): CommandResult => ({ kind: 'error', text: `Studio memory: ${reason}.` })

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw) }
  catch { return undefined }
}

function coordinates(entry: Pick<StudioPreference, 'key' | 'revision' | 'projectId'>): string {
  return `${entry.key} v${entry.revision}; ${entry.projectId ? `project ${entry.projectId}` : 'global'}`
}

function citationScope(entry: PreferenceCitation): string {
  return entry.projectId ? `project ${entry.projectId}` : 'unprojected'
}

function origin(entry: Pick<StudioPreference, 'source' | 'at'>): string {
  const { sessionId, commandId, eventSeq } = entry.source
  if (commandId.startsWith(PREFERENCE_CORRECTION_RECEIPT_PREFIX)) {
    const proposalId = commandId.slice(PREFERENCE_CORRECTION_RECEIPT_PREFIX.length)
    return `Owner-confirmed preference correction ${proposalId}; original owner message in Session ${sessionId}, event ${eventSeq}.`
  }
  if (commandId.startsWith(PREFERENCE_PROPOSAL_RECEIPT_PREFIX)) {
    const proposalId = commandId.slice(PREFERENCE_PROPOSAL_RECEIPT_PREFIX.length)
    return `Owner-confirmed preference proposal ${proposalId}; original owner message in Session ${sessionId}, event ${eventSeq}. Recorded at ${entry.at}.`
  }
  return `Owner command ${commandId} in Session ${sessionId}, event ${eventSeq}. Recorded at ${entry.at}.`
}

/** Use the same current preference views for natural queries and native commands. */
function listCurrent(store: ManagedWorkerStore, projectId?: string, after?: string): CommandResult {
  const result = store.memory.list(projectId, after)
  if (!result.ok) return denied(result.reason)
  const { items, next } = result.value
  if (!items.length) return success('No current preferences in this scope and page.')
  return success(`Current preferences:\n${items.map(coordinates).join('\n')}`
    + (next === undefined ? '' : `\nMore results: /studio-memory list ${projectId ?? 'global'} ${next}`))
}

function readCurrent(store: ManagedWorkerStore, key: string, projectId?: string): CommandResult {
  const result = store.memory.read(key, projectId)
  if (!result.ok) return denied(result.reason)
  return success(`Current preference ${coordinates(result.value)}.\n${origin(result.value)}\n\n${result.value.text}`)
}

function auditOnly(entry: StudioPreference): CommandResult {
  return success(`Preference audit only: ${coordinates(entry)}; recorded operation ${entry.operation}; recorded state ${entry.state}.\n${origin(entry)}`)
}

/** Answer an already-authorized owner's query without writing memory or treating audit metadata as current. */
export function memoryQuery(store: ManagedWorkerStore, query: PreferenceQuery): CommandResult {
  switch (query.kind) {
    case 'list': return listCurrent(store, query.projectId)
    case 'read': return readCurrent(store, query.key, query.projectId)
    case 'trace': {
      const result = store.memory.traceVisible(query.key, query.revision, query.projectId)
      if (!result.ok) return denied(result.reason)
      if (query.revision !== undefined) return auditOnly(result.value)
      return success(`Current preference source: ${coordinates(result.value)}.\n${origin(result.value)}`)
    }
    case 'clarify':
      return success('Please use the stable preference key or the exact project UUID to clarify this read-only query. No preference text was read.')
  }
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
    return listCurrent(store, scope === 'global' ? undefined : scope, after)
  }
  if (verb === 'read') {
    const parsed = read.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_PREFERENCE_KEY_AND_OPTIONAL_PROJECT')
    return readCurrent(store, ...parsed.data)
  }
  if (verb === 'trace') {
    const parsed = trace.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_PREFERENCE_KEY_AND_OPTIONAL_REVISION')
    const result = store.memory.trace(...parsed.data)
    return result.ok ? auditOnly(result.value) : denied(result.reason)
  }

  if (verb === 'resolve') {
    const parsed = resolveCitation.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_CITATION_ID_AND_OPTIONAL_PROJECT')
    const result = store.memory.resolveCitation(...parsed.data)
    if (!result.ok) return denied(result.reason)
    const { citation, preference } = result.value
    return success(`Current preference from citation ${citation.citationId}: ${coordinates(preference)}.\n${origin(preference)}\n\n${preference.text}`)
  }
  if (verb === 'trace-citation') {
    const parsed = traceCitation.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_CITATION_ID')
    const result = store.memory.traceCitation(...parsed.data)
    if (!result.ok) return denied(result.reason)
    const entry = result.value
    return success(`Preference citation audit only: ${entry.citationId}; source ${entry.key} v${entry.revision}; use scope ${citationScope(entry)}.\n${origin(entry)}`)
  }

  // Parse before touching persistence. Neither a preference mutation nor a citation receipt echoes the preference text.
  let mutate: (source: MemorySource) => ManagedResult<StudioPreference | PreferenceCitation>
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
  } else if (verb === 'cite') {
    const parsed = cite.safeParse(args)
    if (!parsed.success) return denied('EXPECTED_KEY_REVISION_AND_OPTIONAL_PROJECT')
    const [name, expectedRevision, projectId] = parsed.data
    mutate = source => store.memory.cite(name, expectedRevision, projectId, source)
  } else return denied(`Use /studio-memory ${MEMORY_HINT}`)

  const source = await confirmedCommandSource(ctx, agent, commandId, signal).catch(() => undefined)
  signal.throwIfAborted()
  if (!ready()) return denied('OPEN_A_STUDIO_ASSISTANT_SESSION')
  if (!source) return denied('MEMORY_SOURCE_UNCONFIRMED')
  const result = mutate(source)
  if (!result.ok) return denied(result.reason)
  const entry = result.value
  if ('citationId' in entry) {
    return success(`Preference citation ${entry.citationId}: ${entry.key} v${entry.revision}; use scope ${citationScope(entry)}. ${origin(entry)} No task authorization changed.`)
  }
  return success(`Preference saved: ${coordinates(entry)}; ${entry.state}. ${origin(entry)} No task authorization changed.`)
}
