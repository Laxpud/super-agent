/** 管理 Worker 的可选路由和宿主模型确认，不把模型配置绑定到 Bot 身份。 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { confirmStudioModel } from '../studio/models.ts'
import type { StudioModel, StudioRole, StudioTaskSummary } from '../studio/protocol.ts'

export type WorkerDispatchRole = Exclude<StudioRole, 'worker'>
export interface WorkerModelRouteConfig extends StudioModel { id: string }
export type WorkerModelDefaultsConfig = Partial<Record<WorkerDispatchRole, string>>
export type ProviderFailure = 'unknown' | 'cancelled' | 'transient' | 'quota'

const identifier = /^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u
const id = () => s.string().min(1).max(256).pattern(identifier).required()
const modelFields = { provider: id(), model: id(), reasoningEffort: s.string().min(1).max(256).pattern(identifier) }
export const WorkerModelRouteConfig: s<WorkerModelRouteConfig> = s.object({ id: id(), ...modelFields })
export const WorkerModelDefaultsConfig: s<WorkerModelDefaultsConfig> = s.object({ assistant: s.string(), leader: s.string() })
export const LegacyWorkerRouteConfig: s<StudioModel> = s.object({ ...modelFields, reasoningEffort: id() })
export const LegacyWorkerDefaultsConfig = s.object({
  assistant: s.union([s.const(null), LegacyWorkerRouteConfig]), leader: s.union([s.const(null), LegacyWorkerRouteConfig]),
})

const sameModel = (a: StudioModel, b: StudioModel) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
const valid = (value: unknown): value is string => typeof value === 'string' && value.length <= 256 && identifier.test(value)

/** 旧配置没有路由 ID，按确定性的模型三元组生成；只在新键缺失时读取旧值。 */
export function migrateWorkerModels(routes?: readonly WorkerModelRouteConfig[], defaults?: WorkerModelDefaultsConfig,
  legacyRoutes?: readonly StudioModel[], legacyDefaults?: Partial<Record<WorkerDispatchRole, StudioModel | null>>) {
  const workerModelRoutes = routes ?? (legacyRoutes ?? []).map(route => ({ ...route,
    id: `legacy-${createHash('sha256').update(JSON.stringify([route.provider, route.model, route.reasoningEffort])).digest('hex').slice(0, 24)}` }))
  const workerModelDefaults: WorkerModelDefaultsConfig = { ...defaults }
  if (defaults === undefined) for (const role of ['assistant', 'leader'] as const) {
    const prior = legacyDefaults?.[role]
    if (!prior) continue
    const route = workerModelRoutes.find(entry => sameModel(entry, prior))
    if (!route) throw new Error(`Legacy textWorkerDefaults.${role} does not match a configured Worker model route`)
    workerModelDefaults[role] = route.id
  }
  return { workerModelRoutes: [...workerModelRoutes], workerModelDefaults }
}

/** V1 只分类明确的提供方状态；没有可验证的额度耗尽信号时，不把一般限流当成额度故障。 */
export function classifyProviderFailure(error: unknown): ProviderFailure {
  if (!error || typeof error !== 'object') return 'unknown'
  const { name, code, status } = error as { name?: unknown; code?: unknown; status?: unknown }
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'CANCELLED') return 'cancelled'
  if (code === 'insufficient_quota' || code === 'QUOTA_EXHAUSTED' || code === 'billing_hard_limit_reached') return 'quota'
  if (status === 408 || status === 429 || typeof status === 'number' && status >= 500 && status <= 599
    || name === 'TimeoutError' || code === 'TRANSPORT' || code === 'ECONNRESET' || code === 'ETIMEDOUT') return 'transient'
  return 'unknown'
}

export interface WorkerModelTask {
  task: Pick<StudioTaskSummary, 'permission' | 'workspacePath' | 'projectId'>
  fallback: StudioModel
  routeId?: string
}

/** 默认路由引用允许清单 ID；派工时只确认选中的精确模型，不预先停池或降级。 */
export class WorkerModelPolicy {
  readonly #entries = new Map<string, Readonly<WorkerModelRouteConfig>>()
  readonly #defaults: WorkerModelDefaultsConfig

  constructor(private readonly ctx: Context, entries: readonly WorkerModelRouteConfig[], defaults: WorkerModelDefaultsConfig) {
    if (entries.length > 64) throw new Error('Configure at most 64 Worker model routes')
    for (const entry of entries) {
      if (!valid(entry.id) || !valid(entry.provider) || !valid(entry.model)
        || (entry.reasoningEffort !== undefined && !valid(entry.reasoningEffort)) || this.#entries.has(entry.id)) {
        throw new Error('Worker model routes require distinct IDs and valid model selections')
      }
      this.#entries.set(entry.id, Object.freeze({ ...entry }))
    }
    this.#defaults = { ...defaults }
    for (const role of ['assistant', 'leader'] as const) {
      const route = this.#defaults[role]
      if (route !== undefined) this.explicitRoute(route)
    }
  }

  defaultFor(role: WorkerDispatchRole): Readonly<WorkerModelRouteConfig> | undefined {
    const id = this.#defaults[role]
    return id === undefined ? undefined : this.explicitRoute(id)
  }

  explicitRoute(id: string): Readonly<WorkerModelRouteConfig> {
    const route = this.#entries.get(id)
    if (!route) throw new Error('The Worker model route ID does not exist')
    return route
  }

  selectModel(role: WorkerDispatchRole, task: WorkerModelTask): StudioModel {
    const route = task.routeId !== undefined ? this.explicitRoute(task.routeId) : this.defaultFor(role)
      ?? [...this.#entries.values()].find(entry => sameModel(entry, task.fallback)) ?? this.#entries.values().next().value ?? task.fallback
    return { provider: route.provider, model: route.model, ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}) }
  }

  async pin(route: StudioModel, signal: AbortSignal): Promise<Readonly<StudioModel>> {
    await confirmStudioModel(this.ctx, route, signal)
    return Object.freeze({ ...route })
  }

  classifyProviderFailure(error: unknown): ProviderFailure { return classifyProviderFailure(error) }
}
