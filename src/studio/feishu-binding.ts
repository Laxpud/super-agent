import s from '@deepseek-ai/schemastery'

export interface FeishuInboxConfig {
  appId: string
  botOpenId: string
  ownerOpenId: string
  chatId: string
}

export type FeishuBindingConfig = FeishuInboxConfig

export const feishuBindingPatterns = {
  appId: /^cli_[a-fA-F0-9]{16}$/,
  openId: /^ou_[a-zA-Z0-9]+$/,
  chatId: /^oc_[a-zA-Z0-9]+$/,
}
const { appId, openId, chatId } = feishuBindingPatterns

export const feishuBindingFields = {
  appId: s.string().pattern(appId).required().description('Feishu self-built application ID; provide its App Secret in STUDIO_FEISHU_APP_SECRET at startup.'),
  botOpenId: s.string().pattern(openId).required(),
  ownerOpenId: s.string().pattern(openId).required(),
  chatId: s.string().pattern(chatId).required(),
}
export const FeishuConversationConfig: s<FeishuBindingConfig> = s.object(feishuBindingFields)

/** Keep the exact serialized field order: persisted generations, receipts and deduplication all use this scope. */
export function feishuSourceScope(config: FeishuBindingConfig): string {
  return JSON.stringify(['feishu', config.appId, config.botOpenId, config.chatId, config.ownerOpenId])
}

/** Fail before opening the Studio database if this optional transport is misconfigured. */
export function validateFeishuInbox(config: FeishuBindingConfig): void {
  if (!appId.test(config.appId) || !openId.test(config.botOpenId) || !openId.test(config.ownerOpenId)
    || !chatId.test(config.chatId) || config.botOpenId === config.ownerOpenId) {
    throw new Error('Studio Feishu requires an exact application, separate bot and owner identities, and a private chat ID')
  }
}
