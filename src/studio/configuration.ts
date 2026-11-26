/** Owner-only Studio settings: validate business rules before letting DSH reconcile its own profile row. */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { validateFeishuInbox } from '../managed-worker/feishu-inbox.ts'
import type { StudioHostConfig } from '../managed-worker/index.ts'
import { quotaProviderMap } from '../managed-worker/quota.ts'
import { createTextWorkerModelPolicy } from '../managed-worker/text-worker-model-policy.ts'
import { StudioFeishuSetup } from './feishu-setup.ts'
import type { StudioHttpOperations } from './http.ts'
import { confirmStudioModel } from './models.ts'
import { StudioError } from './pending.ts'
import type { FeishuState, StudioModel } from './protocol.ts'
import { reuseLaunchCredential, type StudioCredentials } from './settings-credentials.ts'
import { StudioDirectorySwitch, verifyWorkspace } from './settings-directory.ts'
import { feishuBinding, sameBinding, type ConfigurationChange, type CredentialState, type StudioConfiguration, type StudioConfigurationOp } from './settings-protocol.ts'

type Raw = Record<string, unknown>
interface Entry { options: { config?: unknown } }
interface ConfigEditor {
  entries(): Entry[]
  edit(entry: Entry, change: (current: Raw, inherited: Raw) => Raw): Promise<void>
}
const edits = new WeakSet<object>()
const error = (code: string, message: string, status = 409) => new StudioError(code, message, status)
const conflict = () => error('STUDIO_CONFIG_CONFLICT', 'The Studio configuration changed elsewhere. Read it before applying edits.')
const ownModel = ({ provider, model, reasoningEffort }: StudioModel): StudioModel => ({ provider, model,
  ...(reasoningEffort ? { reasoningEffort } : {}) })

/** Project every supported option explicitly; internal references and unknown profile properties never cross HTTP. */
export function studioConfiguration(config: StudioHostConfig): StudioConfiguration {
  const binding = config.feishuConversation ?? config.feishuDocumentInbox ?? config.feishuTextInbox
  const summary = binding && { appId: binding.appId, botOpenId: binding.botOpenId, ownerOpenId: binding.ownerOpenId, chatId: binding.chatId }
  const { assistant, leader } = config.textWorkerBounds
  const bounds = (value: typeof assistant) => ({ min: value?.min ?? null, max: value?.max ?? null })
  return { stateDir: config.stateDir, studioCwd: config.studioCwd,
    assistantModel: config.assistantModel ? ownModel(config.assistantModel) : null,
    leaderModel: config.leaderModel ? ownModel(config.leaderModel) : null,
    feishu: !summary ? { mode: 'off' }
      : config.feishuConversation ? { mode: 'conversation', binding: summary }
        : config.feishuDocumentInbox ? { mode: 'document', binding: summary }
          : { mode: 'text', binding: summary, cwd: config.feishuTextInbox!.cwd, route: ownModel(config.feishuTextInbox!),
            documentCorrections: config.feishuTextInbox!.documentCorrections },
    guiDocumentInbox: config.guiDocumentInbox, documentContinuations: config.documentContinuations,
    advisor: config.advisor ? ownModel(config.advisor) : null, memory: config.memory,
    textWorkerRoutes: config.textWorkerRoutes, textWorkerDefaults: { assistant: config.textWorkerDefaults.assistant ?? null,
      leader: config.textWorkerDefaults.leader ?? null }, textWorkerBounds: { assistant: bounds(assistant), leader: bounds(leader) },
    quotaPools: config.quotaPools, quotaFeishuAlerts: config.quotaFeishuAlerts, watchdog: config.watchdog,
    documentRecovery: config.documentRecovery, documentFailureFeishuAlerts: config.documentFailureFeishuAlerts,
    systemdJobInbox: config.systemdJobInbox, systemdJobPollSeconds: config.systemdJobPollSeconds }
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value, (_key, node: unknown) => node && typeof node === 'object' && !Array.isArray(node)
    ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : node)).digest('hex')
}

/** Only changed business fields are expanded into the raw complete-config slot; retain inheritance/expressions for untouched fields. */
function candidate(raw: Raw, base: StudioConfiguration, next: StudioConfiguration, credentialId: string, directory?: StudioDirectorySwitch): Raw {
  const result = { ...raw }
  for (const field of Object.keys(base) as Array<keyof StudioConfiguration>) {
    if (field !== 'feishu' && !isDeepStrictEqual(next[field], base[field])) result[field] = next[field]
  }
  const { feishu } = next
  if (!isDeepStrictEqual(feishu, base.feishu)) {
    result.feishuConversation = feishu.mode === 'conversation' ? feishu.binding : null
    result.feishuDocumentInbox = feishu.mode === 'document' ? feishu.binding : null
    result.feishuTextInbox = feishu.mode === 'text' ? { ...feishu.binding, ...feishu.route, cwd: feishu.cwd,
      documentCorrections: feishu.documentCorrections } : null
  }
  if (credentialId !== (raw.studioFeishuCredentialId ?? '')) result.studioFeishuCredentialId = credentialId
  if (directory) result.studioDirectoryToken = directory.token
  return result
}

function routes(value: StudioConfiguration): StudioModel[] {
  return [value.assistantModel, value.leaderModel, value.advisor, ...value.textWorkerRoutes,
    value.feishu.mode === 'text' ? value.feishu.route : null].filter((model): model is StudioModel => model !== null)
}

/** Match activation rules before saving. Only confirm new model tuples so unrelated edits can repair an unavailable configuration. */
async function verifyChanges(ctx: Context, base: StudioConfiguration, next: StudioConfiguration, signal: AbortSignal) {
  const { feishu, watchdog, documentRecovery, documentFailureFeishuAlerts, quotaFeishuAlerts, quotaPools,
    systemdJobInbox, systemdJobPollSeconds: interval } = next
  const dedicatedInbox = feishu.mode === 'text' || feishu.mode === 'document'
  if (documentRecovery && !watchdog) throw error('STUDIO_WATCHDOG_REQUIRED', 'Document recovery requires Watchdog.')
  if (quotaFeishuAlerts && (!dedicatedInbox || !quotaPools.length)) {
    throw error('STUDIO_QUOTA_ALERT_REQUIREMENTS', 'Quota notices require a quota pool and a dedicated Feishu inbox.')
  }
  if (documentFailureFeishuAlerts && (!dedicatedInbox || !documentRecovery)) {
    throw error('STUDIO_DOCUMENT_ALERT_REQUIREMENTS', 'Document notices require recovery and a dedicated Feishu inbox.')
  }
  if (interval !== 0 && (!systemdJobInbox || interval < 5 || interval > 300)) {
    throw error('STUDIO_JOB_INTERVAL', 'Enable job observation and use 5–300 seconds, or use zero to disable automatic observation.')
  }
  if (next.studioCwd && next.studioCwd !== base.studioCwd) verifyWorkspace(next.studioCwd)
  if (feishu.mode === 'text' && (base.feishu.mode !== 'text' || base.feishu.cwd !== feishu.cwd)) verifyWorkspace(feishu.cwd)
  const binding = feishuBinding(feishu)
  if (binding) {
    try { validateFeishuInbox(binding) }
    catch { throw error('STUDIO_FEISHU_IDS_INVALID', 'Use distinct bot and owner IDs and an exact private chat.') }
  }
  try { createTextWorkerModelPolicy(ctx, next.textWorkerRoutes, next.textWorkerDefaults, next.textWorkerBounds) }
  catch { throw error('STUDIO_WORKER_POLICY_INVALID', 'Worker defaults and bounds must use exact allow-list rows and follow their order.') }
  try { quotaProviderMap(quotaPools) }
  catch { throw error('STUDIO_QUOTA_POOLS_INVALID', 'Each quota pool and provider must be unique.') }
  const previous = new Set(routes(base).map(fingerprint))
  const selected = new Map(routes(next).map(route => [fingerprint(route), route]))
  const newRoutes = [...selected].filter(([key]) => !previous.has(key)).map(([, value]) => value)
  const verification = AbortSignal.any([signal, AbortSignal.timeout(18_000)])
  try {
    for (let index = 0; index < newRoutes.length; index += 8) {
      verification.throwIfAborted()
      await Promise.all(newRoutes.slice(index, index + 8).map(route => confirmStudioModel(ctx, route, verification)))
    }
  } catch (cause) {
    signal.throwIfAborted()
    if (verification.aborted) throw error('STUDIO_MODELS_UNCONFIRMED', 'Model metadata checks timed out. No settings were applied.', 503)
    throw cause
  }
}

interface Runtime {
  credentials: StudioCredentials
  credential: { state: CredentialState; secret?: string }
  setup: StudioFeishuSetup
  feishuState(): FeishuState
  /** Do not let new owner commands or channel work cross the boundary from one configuration to another. */
  quiesce(next: StudioConfiguration, directory?: StudioDirectorySwitch): () => void
}

/** Settings are not an agent tool: these operations change credentials, retention, routing and execution limits. */
export class StudioConfigurationControl {
  readonly #editor?: ConfigEditor
  readonly #entry?: Entry
  readonly #base: StudioConfiguration
  readonly #revision: string

  constructor(private readonly ctx: Context, private readonly initial: StudioHostConfig, private readonly runtime: Runtime) {
    const editor = (ctx as unknown as { get(name: string): unknown }).get('configEditor') as ConfigEditor | undefined
    const entry = (ctx.fiber as unknown as { entry?: Entry }).entry
    this.#base = studioConfiguration(initial)
    if (editor && entry && typeof editor.entries === 'function' && typeof editor.edit === 'function') {
      this.#editor = editor
      this.#entry = entry
    }
    this.#revision = fingerprint(this.#entry?.options.config ?? this.#base)
  }

  #writable() {
    return !!this.#editor && !!this.#entry && this.#editor.entries().includes(this.#entry)
  }

  #assertEditable(revision: string) {
    if (revision !== this.#revision) throw conflict()
    if (!this.#writable()) throw error('STUDIO_CONFIG_READONLY', 'This Host cannot write the active Studio profile row.')
  }

  readonly operations: Pick<StudioHttpOperations, StudioConfigurationOp> = {
    configuration: () => ({ profile: this.runtime.credentials.profile?.name, writable: this.#writable(),
      credentialsWritable: this.runtime.credentials.writable, revision: this.#revision, config: this.#base,
      feishu: { state: this.runtime.feishuState(), credential: this.runtime.credential.state } }),
    saveConfiguration: (input, signal) => this.#save(input, signal),
    feishuCheck: (input, signal) => {
      signal.throwIfAborted()
      if (input.action !== 'start') return this.runtime.setup.status(input.id, input.action === 'cancel')
      this.#assertEditable(input.revision)
      if (edits.has(this.ctx.root)) throw error('STUDIO_CONFIG_BUSY', 'Studio is applying another settings change.')
      const binding = feishuBinding(this.#base.feishu)
      const sameApp = binding?.appId === input.appId
      const existing = sameApp ? this.runtime.credential.secret : undefined
      const secret = input.secret ?? existing
      if (!secret) throw error('STUDIO_FEISHU_SECRET_REQUIRED', 'Enter the App Secret for this Feishu application.')
      if (!this.runtime.credentials.writable) throw error('STUDIO_CREDENTIALS_UNAVAILABLE', 'This Host cannot save a Feishu credential.')
      return this.runtime.setup.start(input, secret, !!existing && this.runtime.feishuState() !== 'identity-mismatch')
    },
  }

  async #save(input: ConfigurationChange, signal: AbortSignal) {
    this.#assertEditable(input.revision)
    const root = this.ctx.root
    if (edits.has(root)) throw error('STUDIO_CONFIG_BUSY', 'Studio is applying another settings change.')
    edits.add(root)
    let nextCredential = this.initial.studioFeishuCredentialId
    const oldBinding = feishuBinding(this.#base.feishu)
    const { config, directory: change, verificationId } = input
    const newBinding = feishuBinding(config.feishu)
    let editorReached = false
    let committed = false
    let staged = false
    let resume: (() => void) | undefined
    let releaseStartupSecret: (() => void) | undefined
    try {
      let directory: StudioDirectorySwitch | undefined
      if (config.stateDir !== this.#base.stateDir || change) {
        if (!change || change.confirmation !== config.stateDir || config.stateDir === this.#base.stateDir) {
          throw error('STUDIO_DIRECTORY_CONFIRMATION', 'Confirm the exact target directory and how to initialize it.')
        }
        if (verificationId || !isDeepStrictEqual(this.#base, { ...config, stateDir: this.#base.stateDir })) {
          throw error('STUDIO_DIRECTORY_SEPARATE', 'Apply a data directory switch separately from other settings.')
        }
        directory = new StudioDirectorySwitch(this.#base.stateDir, config.stateDir, change.mode)
      }
      if (!directory) await verifyChanges(this.ctx, this.#base, config, signal)
      if (newBinding && verificationId) {
        const secret = this.runtime.setup.checkedSecret(verificationId, input.revision, newBinding)
        nextCredential = randomUUID()
        signal.throwIfAborted()
        await this.runtime.credentials.stage(newBinding, nextCredential, secret)
        staged = true
      } else {
        if (newBinding && (!sameBinding(oldBinding, newBinding)
          || (this.runtime.credential.state === 'missing' && !isDeepStrictEqual(this.#base.feishu, config.feishu)))) {
          throw error('FEISHU_VERIFICATION_REQUIRED', 'Verify the exact Feishu binding before saving.')
        }
        if (!newBinding) nextCredential = ''
      }
      signal.throwIfAborted()
      if (oldBinding && this.runtime.credential.state === 'startup' && this.runtime.credential.secret) {
        // Also available to DSH if it rolls back and remounts the old entry after a failed apply.
        releaseStartupSecret = reuseLaunchCredential(this.ctx, oldBinding, this.runtime.credential.secret)
      }
      let revision = this.#revision
      try {
        await this.#editor!.edit(this.#entry!, raw => {
          signal.throwIfAborted()
          if (fingerprint(raw) !== input.revision) throw conflict()
          const next = candidate(raw, this.#base, config, nextCredential, directory)
          if (!isDeepStrictEqual(raw, next)) {
            resume = this.runtime.quiesce(config, directory)
            editorReached = true
            revision = fingerprint(next)
          }
          return next
        })
        committed = true
      } catch (cause) {
        if (cause instanceof StudioError || signal.aborted && !editorReached) throw cause
        if (cause instanceof Error && cause.message.includes('is overridden by a home patch or command-line overlay')) {
          editorReached = false // DSH rejects before saving the profile in this case.
          throw error('STUDIO_CONFIG_OVERRIDDEN', 'A higher-priority DSH layer overrides this Studio configuration.')
        }
        throw error(directory ? 'STUDIO_DIRECTORY_UNCONFIRMED' : 'STUDIO_CONFIG_UNCONFIRMED',
          'Studio could not confirm that settings were applied. Read the current settings before trying again.', 503)
      }
      const oldRef = this.initial.studioFeishuCredentialId
      const cleanup = !oldBinding || !oldRef || oldRef === nextCredential || await this.runtime.credentials.remove(oldBinding, oldRef)
      return { revision, ...(!cleanup ? { credentialCleanup: 'unconfirmed' as const } : {}) }
    } finally {
      resume?.()
      releaseStartupSecret?.()
      // Never remove a staged credential after an unconfirmed profile update could have selected it.
      try { if (staged && !committed && !editorReached && newBinding) await this.runtime.credentials.remove(newBinding, nextCredential) }
      finally { edits.delete(root) }
    }
  }
}
