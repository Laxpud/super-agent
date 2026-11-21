/** Pin opt-in text Worker routes to one exact, Host-confirmed provider, model and reasoning effort. */
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'

export type TextWorkerModelSelection = { provider: string; model: string; reasoningEffort?: string }
export type PinnedTextWorkerModel = Readonly<Required<TextWorkerModelSelection>>
export type TextWorkerDispatchRole = 'assistant' | 'leader'
type TextWorkerDefaults = Readonly<Partial<Record<TextWorkerDispatchRole, PinnedTextWorkerModel | null>>>

const ROUTE_LIMIT = 64
const IDENTIFIER_LIMIT = 256
const LOOKUP_TIMEOUT_MS = 5_000
// Permit exact route punctuation without accepting whitespace, control/format characters or lone surrogates.
const identifierPattern = /^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u
const identifier = () => s.string().min(1).max(IDENTIFIER_LIMIT).pattern(identifierPattern).required()
const isIdentifier = (value: unknown): value is string => typeof value === 'string'
  && value.length <= IDENTIFIER_LIMIT && identifierPattern.test(value)

/** An allow-list row always names a concrete effort, even when the caller may rely on a Host default. */
export const TextWorkerRouteConfig: s<Required<TextWorkerModelSelection>> = s.object({
  provider: identifier().description('Exact registered DSH provider route.'),
  model: identifier().description('Exact model ID on this provider route.'),
  reasoningEffort: identifier().description('Exact supported reasoning effort ID for this model.'),
})

/** Null leaves the role's existing dispatch selection unchanged. */
export const TextWorkerDefaultsConfig = s.object({
  assistant: s.union([s.const(null), TextWorkerRouteConfig]).default(null),
  leader: s.union([s.const(null), TextWorkerRouteConfig]).default(null),
}).default({ assistant: null, leader: null })

/** Compare the configured tuple against the actual Step or stream, without substituting defaults. */
export function sameTextWorkerModel(pinned: Readonly<TextWorkerModelSelection>, actual?: Readonly<TextWorkerModelSelection>): boolean {
  return !!actual && actual.provider === pinned.provider && actual.model === pinned.model
    && actual.reasoningEffort === pinned.reasoningEffort
}

/** Give a readable unconfirmed-route error. Supply a local message, not a raw Host error. */
export function textWorkerModelError(reason: string): Error {
  return new Error(`TEXT_WORKER_MODEL_UNCONFIRMED: ${reason}`)
}

function notAllowed(reason: string): Error {
  return new Error(`TEXT_WORKER_MODEL_NOT_ALLOWED: ${reason}`)
}

interface ExactModelRegistry {
  resolveModelInfo(provider: string, model: string, signal: AbortSignal): unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Trust only exact identity and an advertised effort; omitted modalities use the ordinary text baseline. */
function confirmEffort(info: unknown, selection: Readonly<TextWorkerModelSelection>): { effort: string } | { problem: string } {
  if (!isRecord(info) || !Object.hasOwn(info, 'provider') || !Object.hasOwn(info, 'id')
    || info.provider !== selection.provider || info.id !== selection.model) {
    return { problem: 'The Host did not confirm the exact provider and model.' }
  }
  const { inputModalities, reasoning } = info
  if (inputModalities !== undefined && (!Array.isArray(inputModalities) || !inputModalities.includes('text'))) {
    return { problem: 'The model metadata does not confirm text input.' }
  }
  const explicit = selection.reasoningEffort
  const effort = explicit ?? (isRecord(reasoning) && Object.hasOwn(reasoning, 'defaultEffort') ? reasoning.defaultEffort : undefined)
  if (!isIdentifier(effort) || !isRecord(reasoning) || !Array.isArray(reasoning.efforts)
    || !reasoning.efforts.some(item => isRecord(item) && Object.hasOwn(item, 'id') && item.id === effort)) {
    return { problem: explicit === undefined ? 'The Host did not confirm a supported default reasoning effort.'
      : 'The Host did not confirm the requested reasoning effort.' }
  }
  return { effort }
}

/** Bound the wait even when an adapter does not act on the signal it receives. */
async function awaitMetadata(result: unknown, signal: AbortSignal): Promise<unknown> {
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const listener = addAbortListener(signal, () => reject(signal.reason))
  try { return await Promise.race([result, aborted]) }
  finally { listener[Symbol.dispose]() }
}

/** Keep an immutable snapshot of allowed routes and role defaults; check current metadata only when pinning. */
export class TextWorkerModelPolicy {
  readonly #ctx: Context
  readonly #entries: readonly PinnedTextWorkerModel[]
  readonly #defaults: Readonly<Record<TextWorkerDispatchRole, PinnedTextWorkerModel | undefined>>

  constructor(ctx: Context, entries: readonly Required<TextWorkerModelSelection>[], defaults?: TextWorkerDefaults) {
    this.#ctx = ctx
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > ROUTE_LIMIT) {
      throw notAllowed(`Configure between 1 and ${ROUTE_LIMIT} text Worker routes.`)
    }
    const snapshot: PinnedTextWorkerModel[] = []
    for (const entry of entries) {
      const { provider, model, reasoningEffort } = entry ?? {}
      if (!isIdentifier(provider) || !isIdentifier(model) || !isIdentifier(reasoningEffort)) {
        throw notAllowed('Each configured text Worker route must name an exact provider, model and reasoning effort.')
      }
      const route = Object.freeze({ provider, model, reasoningEffort })
      if (snapshot.some(existing => sameTextWorkerModel(existing, route))) {
        throw notAllowed('The text Worker route configuration contains a duplicate tuple.')
      }
      snapshot.push(route)
    }
    this.#entries = Object.freeze(snapshot)

    // Resolve each role to a frozen allow-list row; do not retain the caller's defaults or consult the Host.
    const resolveDefault = (role: TextWorkerDispatchRole): PinnedTextWorkerModel | undefined => {
      const selection = defaults?.[role]
      if (selection == null) return undefined
      const route = this.#entries.find(entry => sameTextWorkerModel(entry, selection))
      if (!route) throw notAllowed(`textWorkerDefaults.${role} must exactly match a tuple in textWorkerRoutes.`)
      return route
    }
    this.#defaults = Object.freeze({ assistant: resolveDefault('assistant'), leader: resolveDefault('leader') })
  }

  /** Return the configured route for this role; dispatch must still confirm it through pin. */
  defaultFor(role: TextWorkerDispatchRole): PinnedTextWorkerModel | undefined {
    return this.#defaults[role]
  }

  /** Reject out-of-policy selections before consulting the Host; pin only an exact effort that is also allowed. */
  async pin(selection: Readonly<TextWorkerModelSelection>, signal: AbortSignal): Promise<PinnedTextWorkerModel> {
    signal.throwIfAborted()
    const { provider, model, reasoningEffort } = selection
    const allowed = this.#entries.filter(route => route.provider === provider && route.model === model)
    signal.throwIfAborted()
    if (!allowed.length || (reasoningEffort !== undefined && !allowed.some(route => route.reasoningEffort === reasoningEffort))) {
      throw notAllowed('The requested text Worker route or explicit reasoning effort is not configured.')
    }

    const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)])
    let confirmed: ReturnType<typeof confirmEffort>
    try {
      // The bundle's declarations can lag rc.3; check the inspected runtime method on the registered service.
      const registry = (this.#ctx as unknown as { get(name: string): unknown }).get('llm') as Partial<ExactModelRegistry> | undefined
      const resolveModelInfo = registry?.resolveModelInfo
      lookupSignal.throwIfAborted()
      if (typeof resolveModelInfo !== 'function') {
        confirmed = { problem: 'The Host exact model metadata service is unavailable.' }
      } else {
        const info = await awaitMetadata(resolveModelInfo.call(registry, provider, model, lookupSignal), lookupSignal)
        lookupSignal.throwIfAborted()
        confirmed = confirmEffort(info, { provider, model, reasoningEffort })
      }
      lookupSignal.throwIfAborted()
    } catch {
      signal.throwIfAborted()
      throw textWorkerModelError(lookupSignal.aborted ? 'The Host exact model metadata lookup timed out.'
        : 'The Host could not resolve metadata for the exact provider and model.')
    }

    if ('problem' in confirmed) throw textWorkerModelError(confirmed.problem)
    const pinned = allowed.find(route => route.reasoningEffort === confirmed.effort)
    if (!pinned) throw notAllowed('The confirmed default reasoning effort is not configured for this text Worker route.')
    return pinned
  }
}

/** Leave unconfigured dispatch unchanged, but reject role defaults without an allow-list at apply time. */
export function createTextWorkerModelPolicy(ctx: Context, entries?: readonly Required<TextWorkerModelSelection>[],
  defaults?: TextWorkerDefaults): TextWorkerModelPolicy | undefined {
  if (entries === undefined || entries.length === 0) {
    if (defaults?.assistant != null || defaults?.leader != null) {
      throw notAllowed('textWorkerDefaults requires a nonempty textWorkerRoutes list.')
    }
    return undefined
  }
  return new TextWorkerModelPolicy(ctx, entries, defaults)
}
