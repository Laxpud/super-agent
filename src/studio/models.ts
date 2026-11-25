/** Studio role defaults use the live DSH model catalog, not guessed provider or effort names. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { addAbortListener } from 'node:events'
import { StudioError } from './pending.ts'
import type { StudioModel, StudioModelOption } from './protocol.ts'

const unavailable = () => new StudioError('MODEL_UNAVAILABLE', 'The selected model or reasoning effort is not available. Check Studio settings.', 409)

async function bound<T>(start: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
  deadline.throwIfAborted()
  const stopped = Promise.withResolvers<never>()
  const listener = addAbortListener(deadline, () => stopped.reject(deadline.reason))
  try { return await Promise.race([stopped.promise, Promise.resolve().then(() => start(deadline))]) }
  finally { listener[Symbol.dispose]() }
}

/** Expose only advertised text routes. A failing provider has no entries, not invented fallback routes. */
export async function studioModelOptions(ctx: Context, signal: AbortSignal): Promise<StudioModelOption[]> {
  const groups = await Promise.all(ctx.llm.listProviders().map(async ({ id: provider }) => {
    try {
      return await bound(async deadline => {
        const models = await ctx.llm.listModels(provider)
        return (await Promise.all(models.map(async ({ id: model, name }) => {
          try {
            const resolved = await ctx.llm.resolveModelInfo(provider, model, deadline)
            if (resolved.provider !== provider || resolved.id !== model || (resolved.inputModalities && !resolved.inputModalities.includes('text'))) return []
            return [{ provider, model, label: name, reasoningEfforts: resolved.reasoning?.efforts.map(effort => effort.id) ?? [] }]
          } catch { return [] }
        }))).flat()
      }, signal)
    } catch { return [] }
  }))
  signal.throwIfAborted()
  return groups.flat()
}

/** Validate the exact saved tuple at settings save and again before a turn uses it. */
export async function confirmStudioModel(ctx: Context, route: StudioModel, signal: AbortSignal): Promise<void> {
  try {
    await bound(async deadline => {
      if (!ctx.llm.listProviders().some(provider => provider.id === route.provider)) throw unavailable()
      const models = await ctx.llm.listModels(route.provider)
      if (!models.some(model => model.id === route.model)) throw unavailable()
      const value = await ctx.llm.resolveModelInfo(route.provider, route.model, deadline)
      if (value.provider !== route.provider || value.id !== route.model || (value.inputModalities && !value.inputModalities.includes('text'))
        || (route.reasoningEffort !== undefined && !value.reasoning?.efforts.some(effort => effort.id === route.reasoningEffort))) throw unavailable()
    }, signal)
  } catch { signal.throwIfAborted(); throw unavailable() }
}

export function defaultStudioModel(ctx: Context): StudioModel {
  const service = (ctx as unknown as { get(name: string): unknown }).get('agentDefaultModel') as { currentSelection?(): StudioModel } | undefined
  const route = service?.currentSelection?.()
  if (!route?.provider || !route.model) throw unavailable()
  return route
}