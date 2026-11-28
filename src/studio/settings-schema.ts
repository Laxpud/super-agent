/** Validate the complete settings draft before it can reach the DSH profile writer. */
import { z } from 'zod'
import type { ConfigurationChange, FeishuCheck } from './settings-protocol.ts'

const id = z.string().min(1).max(256).regex(/^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u)
const path = z.string().max(4096).refine(value => value.isWellFormed() && !/[\p{Cc}]/u.test(value))
const appId = z.string().regex(/^cli_[a-fA-F0-9]{16}$/u)
const openId = z.string().max(256).regex(/^ou_[a-zA-Z0-9]+$/u)
const chatId = z.string().max(256).regex(/^oc_[a-zA-Z0-9]+$/u)
const binding = z.strictObject({ appId, botOpenId: openId, ownerOpenId: openId, chatId })
const model = z.strictObject({ provider: id, model: id, reasoningEffort: id.exactOptional() })
const revision = z.string().regex(/^[a-f0-9]{64}$/u)
const feishu = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('disabled') }),
  z.strictObject({ mode: z.literal('conversation'), binding })])
// 部署层的 selfUpdate 不属于可写配置草稿；严格对象也会拒绝回传只读的登记提示。
const config = z.strictObject({ stateDir: path.min(1), studioCwd: path.min(1), assistantModel: model.nullable(), leaderModel: model.nullable(),
  feishu, workerModelRoutes: z.array(model.extend({ id })).max(64),
  workerModelDefaults: z.strictObject({ assistant: id.exactOptional(), leader: id.exactOptional() }),
  defaultWorkerPermission: z.enum(['read-only', 'workspace-write']),
})

export const configurationChange = z.strictObject({ revision, config, allowReload: z.literal(true),
  verificationId: z.uuid().exactOptional(), directory: z.strictObject({ mode: z.enum(['copy', 'empty']), confirmation: path }).exactOptional(),
}) satisfies z.ZodType<ConfigurationChange>

/** The credential is supplied to one explicit verification action only, never to the ordinary configuration API. */
export const feishuCheck = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), revision, appId, botOpenId: openId.exactOptional(), ownerOpenId: openId.exactOptional(),
    chatId: chatId.exactOptional(), secret: z.string().min(1).max(256).regex(/^[^\s\p{Cc}\p{Cs}]+$/u).exactOptional() }),
  z.strictObject({ action: z.enum(['status', 'cancel']), id: z.uuid() }),
]) satisfies z.ZodType<FeishuCheck>
