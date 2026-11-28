/** 设置页的浏览器契约。路径、绑定和模型都是宿主配置；密钥不进入任何快照或保存回执。 */
import type { WorkerModelDefaultsConfig, WorkerModelRouteConfig } from '../managed-worker/text-worker-model-policy.ts'
import type { FeishuState, StudioModel, StudioWorkerPermission } from './protocol.ts'

export interface FeishuBinding { appId: string; botOpenId: string; ownerOpenId: string; chatId: string }
export type FeishuMode = 'disabled' | 'conversation'
export type FeishuConfiguration = { mode: 'disabled' } | { mode: 'conversation'; binding: FeishuBinding }
export type { WorkerModelDefaultsConfig, WorkerModelRouteConfig }

export interface StudioConfiguration {
  stateDir: string
  studioCwd: string
  assistantModel: StudioModel | null
  leaderModel: StudioModel | null
  workerModelRoutes: WorkerModelRouteConfig[]
  workerModelDefaults: WorkerModelDefaultsConfig
  defaultWorkerPermission: StudioWorkerPermission
  feishu: FeishuConfiguration
}

export type CredentialState = 'none' | 'startup' | 'stored' | 'missing'
export interface ConfigurationSnapshot {
  profile?: string
  writable: boolean
  credentialsWritable: boolean
  revision: string
  config: StudioConfiguration
  feishu: { state: FeishuState; credential: CredentialState }
}

export type DirectoryMode = 'copy' | 'empty'
export interface ConfigurationChange {
  revision: string
  config: StudioConfiguration
  allowReload: true
  verificationId?: string
  directory?: { mode: DirectoryMode; confirmation: string }
}
export interface ConfigurationReceipt {
  revision: string
  credentialCleanup?: 'unconfirmed'
}

export type FeishuCheck = { action: 'start'; revision: string; appId: string; botOpenId?: string; ownerOpenId?: string; chatId?: string; secret?: string }
  | { action: 'status' | 'cancel'; id: string }
export type FeishuCheckResult = { id: string; state: 'connecting' | 'waiting'; phrase: string; expiresAt: number }
  | { id: string; state: 'verified'; binding: FeishuBinding; expiresAt: number }
  | { id: string; state: 'failed'; reason: 'FEISHU_BOT_UNCONFIRMED' | 'FEISHU_BOT_MISMATCH' | 'FEISHU_CONNECTION_UNCONFIRMED' }
  | { id: string; state: 'expired' | 'cancelled' }

export type StudioConfigurationOp = 'configuration' | 'saveConfiguration' | 'feishuCheck'

/** 仅比较绑定四元组；验证和凭据保留都依赖同一个精确私聊身份。 */
export function sameBinding(a: FeishuBinding | undefined, b: FeishuBinding | undefined): boolean {
  return a?.appId === b?.appId && a?.botOpenId === b?.botOpenId && a?.ownerOpenId === b?.ownerOpenId && a?.chatId === b?.chatId
}

export function feishuBinding(value: FeishuConfiguration): FeishuBinding | undefined {
  return value.mode === 'disabled' ? undefined : value.binding
}
