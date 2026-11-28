/** Keep Studio's write-only Feishu secret in the DSH credential seam, not in settings, SQLite or Session input. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { StudioError } from './pending.ts'
import { sameBinding, type CredentialState, type FeishuBinding } from './settings-protocol.ts'

interface CredentialRecord { kind: 'api-key'; key?: string }
interface CredentialVault {
  readRecord(key: string): Promise<{ kind: string; key?: string } | undefined>
  modifyRecord(key: string, change: () => Promise<CredentialRecord>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}
interface HostProfile { name: string; dir: string; home?: string; patchPath?: string }
const idPattern = /^[a-f0-9-]{36}$/u
const scope = 'agent-studio-managed-worker'
// 整个配置档不改名；旧命名空间只读取或清理既有凭据，不再写入。
const legacyScope = 'dsh-superagent-managed-worker'
const host = (ctx: Context) => ctx as unknown as { get(name: string): unknown }
export const findProfile = (ctx: Context) => host(ctx).get('profileContext') as HostProfile | undefined
const currentReload = new WeakMap<object, { binding: FeishuBinding; secret: string }>()

/** The launch-only legacy credential can survive this one deliberate remount without being persisted. */
export function reuseLaunchCredential(ctx: Context, binding: FeishuBinding, secret: string): () => void {
  const entry = { binding, secret }
  currentReload.set(ctx.root, entry)
  return () => { if (currentReload.get(ctx.root) === entry) currentReload.delete(ctx.root) }
}

function takeLaunchCredential(): string | undefined {
  const value = process.env.STUDIO_FEISHU_APP_SECRET
  delete process.env.STUDIO_FEISHU_APP_SECRET
  return value && value.isWellFormed() && !/\s|\0/u.test(value) ? value : undefined
}

/** 根据 DSH 配置档和飞书应用限定凭据记录；换绑后只清理先前由本功能保存的记录。 */
export class StudioCredentials {
  readonly #vault: CredentialVault | undefined
  readonly profile: HostProfile | undefined

  constructor(private readonly ctx: Context) {
    this.profile = findProfile(ctx)
    const vault = host(ctx).get('credentials') as Partial<CredentialVault> | undefined
    if (this.profile && typeof vault?.readRecord === 'function' && typeof vault.modifyRecord === 'function' && typeof vault.deleteRecord === 'function') {
      this.#vault = vault as CredentialVault
    }
  }

  get writable() { return this.#vault !== undefined }

  #key(binding: FeishuBinding, id: string, namespace = scope): string {
    if (!idPattern.test(id) || !this.profile) throw new Error('Invalid Studio credential reference')
    const instance = createHash('sha256').update(JSON.stringify([this.profile.dir, binding.appId])).digest('hex').slice(0, 32)
    return `${namespace}/feishu-${instance}-${id}`
  }

  /** Missing or inaccessible secrets leave only Feishu offline. Other Studio settings remain repairable. */
  async load(binding: FeishuBinding | undefined, id: string): Promise<{ state: CredentialState; secret?: string }> {
    if (!binding) return { state: 'none' }
    const startup = takeLaunchCredential()
    if (id) {
      try {
        const stored = await this.#vault?.readRecord(this.#key(binding, id))
          ?? await this.#vault?.readRecord(this.#key(binding, id, legacyScope))
        return stored?.kind === 'api-key' && stored.key ? { state: 'stored', secret: stored.key } : { state: 'missing' }
      } catch { return { state: 'missing' } }
    }
    const reload = currentReload.get(this.ctx.root)
    const secret = startup ?? (sameBinding(binding, reload?.binding) ? reload?.secret : undefined)
    return secret ? { state: 'startup', secret } : { state: 'missing' }
  }

  async stage(binding: FeishuBinding, id: string, secret: string): Promise<void> {
    if (!this.#vault) throw new StudioError('STUDIO_CREDENTIALS_UNAVAILABLE', 'This Host has no writable credential service.', 409)
    try {
      const key = this.#key(binding, id)
      await this.#vault.modifyRecord(key, async () => ({ kind: 'api-key', key: secret }))
      const saved = await this.#vault.readRecord(key)
      if (saved?.kind !== 'api-key' || saved.key !== secret) throw new Error('Studio credential write was not confirmed')
    } catch { throw new StudioError('STUDIO_CREDENTIAL_UNCONFIRMED', 'The credential store did not confirm the change.', 503) }
  }

  async remove(binding: FeishuBinding, id: string): Promise<boolean> {
    if (!this.#vault) return false
    try {
      const current = this.#key(binding, id)
      const key = await this.#vault.readRecord(current) === undefined ? this.#key(binding, id, legacyScope) : current
      await this.#vault.deleteRecord(key)
      return true
    } catch { return false }
  }
}
