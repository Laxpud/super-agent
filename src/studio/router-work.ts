/** 将当前 Assistant 轮次已登记的工作交给宿主管理，普通 DSH 会话仍使用原工具行为。 */
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface StudioRoutedWork {
  id: string
  kind: 'draft' | 'study' | 'advice' | 'revision'
  /** 仅普通文字任务可重开无工具的修订。受保护证据与其他协调任务不随文字改向转移授权。 */
  redirectable?: boolean
}

type StartWork = (work: StudioRoutedWork, run: (signal: AbortSignal) => Promise<string>) => void
const routes = new WeakMap<Agent, StartWork>()

/** 只有 Studio 打开的确切前台轮次能登记后台工作。卸载后不沿用旧的消息归属。 */
export function installStudioRouterWork(agent: Agent, start: StartWork): () => void {
  routes.set(agent, start)
  return () => { if (routes.get(agent) === start) routes.delete(agent) }
}

/** 工具先登记原请求与实际任务，再提交执行。后台信号独立于前台工具调用的生命周期。 */
export function startStudioRouterWork(agent: Agent, work: StudioRoutedWork, run: (signal: AbortSignal) => Promise<string>): boolean {
  const start = routes.get(agent)
  if (!start) return false
  start(work, run)
  return true
}
