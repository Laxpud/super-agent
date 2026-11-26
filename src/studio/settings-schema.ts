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
const pinned = model.extend({ reasoningEffort: id })
const selection = pinned.nullable()
const bounds = z.strictObject({ min: selection, max: selection })
const revision = z.string().regex(/^[a-f0-9]{64}$/u)
const feishu = z.discriminatedUnion('mode', [z.strictObject({ mode: z.literal('off') }),
  z.strictObject({ mode: z.enum(['conversation', 'document']), binding }),
  z.strictObject({ mode: z.literal('text'), binding, cwd: path, route: model, documentCorrections: z.boolean() })])
const bool = z.boolean()
const config = z.strictObject({ stateDir: path.min(1), studioCwd: path, assistantModel: model.nullable(), leaderModel: model.nullable(),
  feishu, guiDocumentInbox: bool, documentContinuations: bool, advisor: model.nullable(), memory: bool,
  textWorkerRoutes: z.array(pinned).max(64), textWorkerDefaults: z.strictObject({ assistant: selection, leader: selection }),
  textWorkerBounds: z.strictObject({ assistant: bounds, leader: bounds }),
  quotaPools: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u),
    providers: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u)).min(1).max(32) })).max(32),
  quotaFeishuAlerts: bool, watchdog: bool, documentRecovery: bool, documentFailureFeishuAlerts: bool,
  systemdJobInbox: bool, systemdJobPollSeconds: z.int().min(0).max(300),
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
