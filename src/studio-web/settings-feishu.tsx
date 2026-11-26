/** 飞书配置只使用一次性检查回执。密钥输入不会进入设置草稿、浏览器持久存储或查询。 */
import { useEffect, useRef, useState } from 'react'
import { feishuBinding, sameBinding, type ConfigurationSnapshot, type FeishuBinding, type FeishuCheckResult, type FeishuConfiguration, type FeishuMode } from '../studio/settings-protocol.ts'
import { blankModel, ConfigurationFailure, configurationReason, ModelEditor, SettingSelect, SettingText, SettingToggle, type ModelCatalog } from './settings-fields.tsx'
import { Button, useStudio } from './ui.tsx'

const MODES = ['off', 'conversation', 'document', 'text'] as const
const EMPTY: FeishuBinding = { appId: '', botOpenId: '', ownerOpenId: '', chatId: '' }
const inProgress = (result: FeishuCheckResult | undefined) => result?.state === 'waiting' || result?.state === 'connecting'
const keys = ['appId', 'botOpenId', 'ownerOpenId', 'chatId'] as const
const labels = ['feishuApp', 'feishuBot', 'feishuOwner', 'feishuChat'] as const
const patterns = [/^cli_[a-fA-F0-9]{16}$/u, /^ou_[a-zA-Z0-9]+$/u, /^ou_[a-zA-Z0-9]+$/u, /^oc_[a-zA-Z0-9]+$/u]
export type VerifiedFeishu = Extract<FeishuCheckResult, { state: 'verified' }>

export function FeishuSettings({ snapshot, value, models, change, verify, transient, reload, disabled }: {
  snapshot: ConfigurationSnapshot; value: FeishuConfiguration; models?: ModelCatalog; change: (next: FeishuConfiguration) => void;
  verify: (value: VerifiedFeishu | undefined) => void; transient: (dirty: boolean) => void; reload: () => void; disabled: boolean
}) {
  const { call, t, dates } = useStudio()
  const [secret, setSecret] = useState('')
  const [check, setCheck] = useState<FeishuCheckResult>()
  const [working, setWorking] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [copied, setCopied] = useState(false)
  const idRef = useRef<string>()
  const startRequest = useRef<AbortController>()
  const binding = feishuBinding(value)
  const active = feishuBinding(snapshot.config.feishu)
  const hasSecret = (snapshot.feishu.credential === 'stored' || snapshot.feishu.credential === 'startup') && active?.appId === binding?.appId
  const pending = inProgress(check)
  const goodIds = binding && keys.every((key, index) => (!binding[key].trim() && index > 0) || patterns[index]!.test(binding[key].trim()))
    && (!binding.botOpenId.trim() || binding.botOpenId.trim() !== binding.ownerOpenId.trim())
  const cancelCheck = () => {
    const id = idRef.current
    idRef.current = undefined
    if (id) void call('feishuCheck', { action: 'cancel', id }).catch(() => { /* 宿主同时有独立的到期清理。 */ })
    setCheck(undefined); setFailure(undefined); setCopied(false); verify(undefined)
  }

  useEffect(() => { transient(!!secret || working || pending) }, [secret, working, pending, transient])
  useEffect(() => () => {
    startRequest.current?.abort()
    if (idRef.current) void call('feishuCheck', { action: 'cancel', id: idRef.current }).catch(() => {})
    idRef.current = undefined
  }, [call])

  const changeResult = useRef({ change, verify, value })
  changeResult.current = { change, verify, value }
  // 验证 ID 只属于这次尝试；离开页面或切换应用后，不接收落后的轮询结果。
  useEffect(() => {
    if (!check || !pending || !('expiresAt' in check)) return
    const { expiresAt } = check
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (controller.signal.aborted || idRef.current !== check.id) return
      try {
        const result = await call('feishuCheck', { action: 'status', id: check.id }, controller.signal)
        if (controller.signal.aborted || idRef.current !== result.id) return
        setFailure(undefined)
        setCheck(result)
        if (result.state === 'verified') {
          const current = changeResult.current
          if (current.value.mode !== 'off') {
            current.change({ ...current.value, binding: result.binding })
            current.verify(result)
          }
        } else if (inProgress(result)) timer = setTimeout(poll, 1300)
      } catch (error) {
        if (controller.signal.aborted) return
        if (Date.now() >= expiresAt) setCheck({ id: check.id, state: 'expired' })
        else { setFailure(error); timer = setTimeout(poll, 2500) }
      }
    }
    timer = setTimeout(poll, 1200)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [call, check?.id, pending])

  // 验证不能永久有效；显示过成功的回执也只允许在有效期内使用。
  useEffect(() => {
    if (check?.state !== 'verified') return
    const timer = setTimeout(() => { setCheck({ id: check.id, state: 'expired' }); changeResult.current.verify(undefined) }, Math.max(0, check.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [check])

  function useMode(mode: FeishuMode) {
    if (mode === value.mode) return
    if (mode === 'off') { cancelCheck(); setSecret(''); change({ mode }); return }
    const next = binding ?? active ?? EMPTY
    const original = snapshot.config.feishu
    change(mode === 'text' ? original.mode === 'text' ? { ...original, binding: next }
      : { mode, binding: next, cwd: '', route: blankModel, documentCorrections: false } : { mode, binding: next })
  }

  async function start() {
    if (!binding || working || pending || !goodIds) return
    cancelCheck()
    const controller = startRequest.current = new AbortController()
    const supplied = secret.trim()
    setSecret('')
    setWorking(true)
    try {
      const { appId, botOpenId, ownerOpenId, chatId } = binding
      const result = await call('feishuCheck', { action: 'start', revision: snapshot.revision, appId: appId.trim(),
        ...(botOpenId.trim() ? { botOpenId: botOpenId.trim() } : {}), ...(ownerOpenId.trim() ? { ownerOpenId: ownerOpenId.trim() } : {}),
        ...(chatId.trim() ? { chatId: chatId.trim() } : {}), ...(supplied ? { secret: supplied } : {}) }, controller.signal)
      if (controller.signal.aborted) return
      idRef.current = result.id
      setCheck(result)
    } catch (error) { if (!controller.signal.aborted) setFailure(error) }
    finally { if (!controller.signal.aborted) setWorking(false); startRequest.current = undefined }
  }

  return <section className="as-card as-fields">
    <div className="as-meta">
      <h3>{t('feishuConnection')}</h3><span className="as-pill">{t(`feishu.${snapshot.feishu.state}`)}</span>
      <span className="as-pill">{t(`credential.${snapshot.feishu.credential}`)}</span>
    </div>
    <div className="as-actions"><Button onClick={reload}>{t('feishuCheckStatus')}</Button>
      <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">{t('feishuPlatform')}</a>
    </div>
    <p className="as-muted">{t('feishuPreparation')}</p>
    <fieldset className="as-setting-panel as-fields" disabled={disabled || working}>
      <SettingSelect label={t('feishuMode')} value={value.mode} change={mode => useMode(mode as FeishuMode)}>
        {MODES.map(mode => <option key={mode} value={mode}>{t(`mode.${mode}`)}</option>)}
      </SettingSelect><p>{t(`modeHint.${value.mode}`)}</p>
      {binding && value.mode !== 'off' && <>
        <fieldset className="as-model-fields as-fields" disabled={pending}>
          <legend>{t('feishuBinding')}</legend>
          <p className="as-muted">{t('feishuAutoIds')}</p>
          <div className="as-model-grid">
            {keys.map((key, index) => <SettingText key={key} label={t(labels[index]!)} value={binding[key]} maxLength={256}
              change={text => { cancelCheck(); change({ ...value, binding: { ...binding, [key]: text } }) }} />)}
          </div>
          {snapshot.credentialsWritable ? <SettingText label={t('feishuSecret')} type="password" autoComplete="new-password" maxLength={256}
            value={secret} placeholder={t(hasSecret ? 'feishuSecretReplace' : 'feishuSecretEnter')} hint={t('feishuSecretHint')}
            change={text => { cancelCheck(); setSecret(text) }} /> : <p role="status">{t('readOnlyCredentials')}</p>}
          <div className="as-actions"><Button disabled={!snapshot.credentialsWritable || !goodIds || (!secret.trim() && !hasSecret)}
            onClick={() => void start()}>{t(working ? 'feishuStartPending' : 'feishuStartCheck')}</Button></div>
        </fieldset>
        {value.mode === 'text' && <>
          <SettingText label={t('feishuTextCwd')} value={value.cwd} change={cwd => change({ ...value, cwd })} maxLength={4096} />
          <ModelEditor title={t('feishuTextModel')} options={models} value={value.route} change={route => { if (route) change({ ...value, route }) }} />
          <SettingToggle label={t('feishuCombined')} hint={t('feishuCombinedHint')} checked={value.documentCorrections}
            change={documentCorrections => change({ ...value, documentCorrections })} />
        </>}
      </>}
      {active && value.mode !== 'off' && <div className="as-actions"><Button onClick={() => useMode('off')}>{t('feishuUnbind')}</Button></div>}
    </fieldset>
    {failure !== undefined && <ConfigurationFailure error={failure} />}
    {check?.state === 'connecting' && <p role="status">{t('feishuCheckConnecting')}</p>}
    {check?.state === 'waiting' && <div className="as-fields">
      <p role="status">{t('feishuCheckWait')}</p>
      <code className="as-settings-code" tabIndex={0}>{check.phrase}</code>
      <p className="as-muted">{t('feishuCheckBy', { time: dates.format(check.expiresAt) })}</p>
      {navigator.clipboard && <div className="as-actions"><Button onClick={() => {
        void navigator.clipboard.writeText(check.phrase).then(() => setCopied(true), () => setCopied(false))
      }}>{t(copied ? 'feishuCodeCopied' : 'feishuCopyCode')}</Button></div>}
    </div>}
    {pending && <div className="as-actions"><Button onClick={cancelCheck}>{t('feishuCancelCheck')}</Button></div>}
    {check?.state === 'verified' && sameBinding(check.binding, binding) && <p className="as-success" role="status">{t('feishuVerified')}</p>}
    {check?.state === 'expired' && <p className="as-warning" role="status">{t('feishuCheckExpired')}</p>}
    {check?.state === 'cancelled' && <p role="status">{t('feishuCheckCancelled')}</p>}
    {check?.state === 'failed' && <p className="as-error" role="alert">{configurationReason(t, check.reason)}</p>}
    <p className="as-muted">{t('feishuLimits')}</p>
  </section>
}
