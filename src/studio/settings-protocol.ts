/** 设置页的浏览器契约。路径、绑定和模型都是宿主配置；密钥不进入任何快照或保存回执。 */
import type { FeishuState, StudioModel } from './protocol.ts'

export interface FeishuBinding { appId: string; botOpenId: string; ownerOpenId: string; chatId: string }
export type FeishuMode = 'off' | 'conversation' | 'document' | 'text'
export type FeishuConfiguration = { mode: 'off' }
  | { mode: 'conversation' | 'document'; binding: FeishuBinding }
  | { mode: 'text'; binding: FeishuBinding; cwd: string; route: StudioModel; documentCorrections: boolean }
export type PinnedModel = Required<StudioModel>
export type StudioDispatchRole = 'assistant' | 'leader'
export interface StudioQuotaPool { id: string; providers: string[] }

export interface StudioConfiguration {
  stateDir: string
  studioCwd: string
  assistantModel: StudioModel | null
  leaderModel: StudioModel | null
  feishu: FeishuConfiguration
  guiDocumentInbox: boolean
  documentContinuations: boolean
  advisor: StudioModel | null
  memory: boolean
  textWorkerRoutes: PinnedModel[]
  textWorkerDefaults: Record<StudioDispatchRole, PinnedModel | null>
  textWorkerBounds: Record<StudioDispatchRole, { min: PinnedModel | null; max: PinnedModel | null }>
  quotaPools: StudioQuotaPool[]
  quotaFeishuAlerts: boolean
  watchdog: boolean
  documentRecovery: boolean
  documentFailureFeishuAlerts: boolean
  systemdJobInbox: boolean
  systemdJobPollSeconds: number
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

/** 绑定身份变化与模式变化分开。相同四元组切换模式时，不会被视为迁移到另一个用户。 */
export function sameBinding(a: FeishuBinding | undefined, b: FeishuBinding | undefined): boolean {
  return a?.appId === b?.appId && a?.botOpenId === b?.botOpenId && a?.ownerOpenId === b?.ownerOpenId && a?.chatId === b?.chatId
}

export function feishuBinding(value: FeishuConfiguration): FeishuBinding | undefined {
  return value.mode === 'off' ? undefined : value.binding
}
