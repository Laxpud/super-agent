/** 设置组件共享可访问的字段、模态确认和宿主错误呈现。 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { StudioModel, StudioModelOption } from '../studio/protocol.ts'
import { StudioApiError } from './api.ts'
import type { en } from './locales.ts'
import { configurationEn as settingsErrorKeys } from './settings-locales.ts'
import { Button, useStudio } from './ui.tsx'

export const SETTINGS_SECTIONS = ['models', 'workers', 'feishu', 'documents', 'oversight', 'advanced'] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]
export type ModelCatalog = StudioModelOption[]
export const blankModel: StudioModel = { provider: '', model: '' }

export function SettingToggle({ label, hint, checked, disabled, change }: {
  label: string; hint: string; checked: boolean; disabled?: boolean; change: (enabled: boolean) => void
}) {
  const id = useId()
  return <div className="as-setting-toggle">
    <input id={id} type="checkbox" checked={checked} disabled={disabled} aria-describedby={`${id}-help`}
      onChange={event => change(event.currentTarget.checked)} />
    <label htmlFor={id}>{label}</label><p id={`${id}-help`} className="as-muted">{hint}</p>
  </div>
}

export function SettingText({ label, hint, value, change, ...props }: {
  label: string; hint?: string; value: string; change: (value: string) => void; placeholder?: string;
  type?: 'text' | 'password'; inputMode?: 'text' | 'numeric'; autoComplete?: string; maxLength?: number
}) {
  const id = useId()
  return <div className="as-setting-field">
    <label htmlFor={id}>{label}</label>
    <input {...props} id={id} value={value} onChange={event => change(event.currentTarget.value)}
      aria-describedby={hint ? `${id}-help` : undefined} spellCheck={false} />
    {hint && <p id={`${id}-help`} className="as-muted">{hint}</p>}
  </div>
}

export function SettingSelect({ label, value, change, children }: {
  label: string; value: string; change: (value: string) => void; children: ReactNode
}) {
  return <label className="as-setting-field"><span>{label}</span>
    <select value={value} onChange={event => change(event.currentTarget.value)}>{children}</select>
  </label>
}

/** 不按提供方列表顺序替用户选模型；已有但不再列出的值仍可读。 */
export function ModelEditor({ title, value, options, change, disableLabel, exact = false }: {
  title: string; value: StudioModel | null; options?: ModelCatalog; change: (model: StudioModel | null) => void;
  disableLabel?: string; exact?: boolean
}) {
  const { t } = useStudio()
  const provider = value?.provider ?? ''
  const model = value?.model ?? ''
  const effort = value?.reasoningEffort ?? ''
  const providers = [...new Set(options?.map(option => option.provider))]
  const models = options?.filter(option => option.provider === provider) ?? []
  const efforts = models.find(option => option.model === model)?.reasoningEfforts ?? []
  return <fieldset className="as-model-fields">
    <legend>{title}</legend>
    <div className="as-model-grid">
      <SettingSelect label={t('provider')} value={provider} change={next => change(!next && disableLabel ? null : { provider: next, model: '' })}>
        <option value="">{disableLabel ?? t('providerChoice')}</option>
        {provider && !providers.includes(provider) && <option value={provider}>{options ? t('unavailableOption', { name: provider }) : provider}</option>}
        {providers.map(item => <option key={item} value={item}>{item}</option>)}
      </SettingSelect>
      <label className="as-setting-field"><span>{t('model')}</span>
        <select value={model} disabled={!provider} onChange={event => change({ provider, model: event.currentTarget.value })}>
          <option value="">{t('modelChoice')}</option>
          {model && !models.some(item => item.model === model) && <option value={model}>{options ? t('unavailableOption', { name: model }) : model}</option>}
          {models.map(item => <option key={item.model} value={item.model}>{item.label}</option>)}
        </select>
      </label>
      <label className="as-setting-field"><span>{t('effort')}</span>
        <select value={effort} disabled={!model} onChange={event => change({ provider, model,
          ...(event.currentTarget.value ? { reasoningEffort: event.currentTarget.value } : {}) })}>
          <option value="">{t(exact ? 'effortChoice' : 'optionalEffort')}</option>
          {effort && !efforts.includes(effort) && <option value={effort}>{options ? t('unavailableOption', { name: effort }) : effort}</option>}
          {efforts.map(item => <option key={item} value={item}>{item}</option>)}
        </select>
      </label>
    </div>
  </fieldset>
}

export function configurationReason(t: ReturnType<typeof useStudio>['t'], code: string) {
  const key = `configError.${code}`
  return /^(?:STUDIO_|FEISHU_|MODEL_UNAVAILABLE$|INVALID_INPUT$)/u.test(code) && Object.hasOwn(settingsErrorKeys, key)
    ? t(key as keyof typeof en) : t('configGenericError')
}

export function ConfigurationFailure({ error }: { error: unknown }) {
  const { t } = useStudio()
  const message = error instanceof StudioApiError ? error.code ? configurationReason(t, error.code)
    : t(error.kind, { status: error.status }) : t('configGenericError')
  return <p className="as-error" role="alert">{message}</p>
}

/** Native modal keeps background controls inert and restores focus to the initiating button. */
export function SettingsConfirm({ title, body, children, dismiss, accept, acceptLabel, cancelLabel, disabled }: {
  title: string; body: string; children?: ReactNode; dismiss: () => void; accept: () => void; acceptLabel: string;
  cancelLabel?: string; disabled?: boolean
}) {
  const { t } = useStudio()
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    const prior = document.activeElement
    if (typeof node.showModal === 'function') node.showModal()
    else node.setAttribute('open', '')
    node.querySelector<HTMLButtonElement>('button')?.focus()
    return () => {
      if (typeof node.close === 'function') node.close()
      if (prior instanceof HTMLElement && prior.isConnected) prior.focus()
    }
  }, [])
  return <dialog ref={dialog} className="as-settings-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`}
    onCancel={event => { event.preventDefault(); dismiss() }}>
    <form onSubmit={event => { event.preventDefault(); if (!disabled) accept() }}>
      <h3 id={`${id}-title`}>{title}</h3><p id={`${id}-body`}>{body}</p>
      {children}
      <div className="as-actions as-end"><Button onClick={dismiss}>{cancelLabel ?? t('cancel')}</Button>
        <Button type="submit" primary disabled={disabled}>{acceptLabel}</Button></div>
    </form>
  </dialog>
}
