/** 分组呈现实际可配置项；所有依赖校验仍由宿主执行，前端只提前提示可修正的输入。 */
import type { StudioModel } from '../studio/protocol.ts'
import type { StudioConfiguration, WorkerModelRouteConfig } from '../studio/settings-protocol.ts'
import { blankModel, ModelEditor, SettingSelect, SettingText, type ModelCatalog } from './settings-fields.tsx'
import { Button, useStudio } from './ui.tsx'

const ROLES = ['assistant', 'leader'] as const
interface Fields { value: StudioConfiguration; change: (patch: Partial<StudioConfiguration>) => void; models?: ModelCatalog }
const identifier = (id: string) => id.length <= 256 && /^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u.test(id)
const filledModel = (model: StudioModel) => identifier(model.provider) && identifier(model.model)
  && (model.reasoningEffort === undefined || identifier(model.reasoningEffort))
export const absolute = (path: string) => /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/u.test(path)

/** 文本编辑保留空格，提交时才规范化路径、路由 ID 和飞书绑定。 */
export function normalizeConfiguration(value: StudioConfiguration): StudioConfiguration {
  return { ...value, studioCwd: value.studioCwd.trim(), workerModelRoutes: value.workerModelRoutes.map(row => ({ ...row, id: row.id.trim() })),
    feishu: value.feishu.mode === 'disabled' ? value.feishu : { ...value.feishu, binding: {
      appId: value.feishu.binding.appId.trim(), botOpenId: value.feishu.binding.botOpenId.trim(),
      ownerOpenId: value.feishu.binding.ownerOpenId.trim(), chatId: value.feishu.binding.chatId.trim(),
    } } }
}

/** 只返回一条需要先修正的原因，区分类目以便从当前选项卡直达问题。 */
export function configurationProblem(value: StudioConfiguration) {
  const rows = value.workerModelRoutes
  const ids = new Set(rows.map(row => row.id))
  if (rows.length > 64 || ids.size !== rows.length || rows.some(row => !identifier(row.id) || !filledModel(row))
    || Object.values(value.workerModelDefaults).some(id => !ids.has(id))) return { section: 'workers', key: 'workerPolicyInvalid' } as const
  if (!absolute(value.studioCwd)) return { section: 'advanced', key: 'configError.STUDIO_WORKSPACE_INVALID' } as const
  if ([value.assistantModel, value.leaderModel].some(model => model && !filledModel(model))) return { section: 'advanced', key: 'modelChoice' } as const
}

function WorkerSelection({ rows, value = '', change }: {
  rows: WorkerModelRouteConfig[]; value?: string; change: (value: string) => void
}) {
  const { t } = useStudio()
  const ids = rows.map(row => row.id.trim())
  const options = rows.filter((row, index) => identifier(ids[index]!) && ids.indexOf(ids[index]!) === ids.lastIndexOf(ids[index]!) && filledModel(row))
  return <SettingSelect label={t('workerDefault')} value={value} change={change}>
    <option value="">{t('workerNoDefault')}</option>
    {value && !options.some(row => row.id.trim() === value) && <option value={value} disabled>{t('workerMissingRoute', { name: value })}</option>}
    {options.map(row => <option key={row.id.trim()} value={row.id.trim()}>{row.id.trim()} · {row.provider} / {row.model}
      {row.reasoningEffort && ` · ${row.reasoningEffort}`}</option>)}
  </SettingSelect>
}

export function WorkerSettings({ value, models, change }: Fields) {
  const { t } = useStudio()
  const rows = value.workerModelRoutes
  const patchRoute = (index: number, patch: Partial<WorkerModelRouteConfig>) => change({
    workerModelRoutes: rows.map((row, at) => at === index ? { ...row, ...patch } : row),
  })
  const move = (from: number, to: number) => {
    if (to < 0 || to >= rows.length) return
    const next = [...rows]
    const [selected] = next.splice(from, 1)
    if (selected) { next.splice(to, 0, selected); change({ workerModelRoutes: next }) }
  }
  return <section className="as-card as-fields">
    <h3>{t('workerRoutes')}</h3><p>{t('workersIntro')}</p><p className="as-muted">{t('workerRoutesHint')}</p>
    {rows.map((row, index) => <div className="as-setting-row as-fields" key={index}>
      <SettingText label={t('workerRouteId', { index: index + 1 })} value={row.id} maxLength={256} change={id => patchRoute(index, { id })} />
      <ModelEditor title={t('workerRoute', { index: index + 1 })} value={row} options={models} change={model => {
        if (model) change({ workerModelRoutes: rows.map((entry, at) => at === index ? { id: entry.id, ...model } : entry) })
      }} />
      <div className="as-actions">
        <Button disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={t('moveRouteUp', { index: index + 1 })}>{t('moveUp')}</Button>
        <Button disabled={index === rows.length - 1} onClick={() => move(index, index + 1)} aria-label={t('moveRouteDown', { index: index + 1 })}>{t('moveDown')}</Button>
        <Button aria-label={t('removeRoute', { index: index + 1 })} onClick={() => change({ workerModelRoutes: rows.filter((_, at) => at !== index) })}>{t('remove')}</Button>
      </div>
    </div>)}
    <div className="as-actions"><Button disabled={rows.length >= 64} onClick={() => change({ workerModelRoutes: [...rows, { ...blankModel, id: '' }] })}>{t('addRoute')}</Button></div>
    {ROLES.map(role => <fieldset key={role} className="as-model-fields">
      <legend>{t('workerRole', { role: t(`role.${role}`) })}</legend>
      <WorkerSelection rows={rows} value={value.workerModelDefaults[role]} change={id => {
        const defaults = { ...value.workerModelDefaults }
        if (id) defaults[role] = id
        else delete defaults[role]
        change({ workerModelDefaults: defaults })
      }} />
    </fieldset>)}
    <SettingSelect label={t('workerPermission')} value={value.defaultWorkerPermission} change={permission => {
      if (permission === 'read-only' || permission === 'workspace-write') change({ defaultWorkerPermission: permission })
    }}>
      <option value="read-only">{t('permission.read-only')}</option>
      <option value="workspace-write">{t('permission.workspace-write')}</option>
    </SettingSelect>
    <p className="as-muted">{t('workerPermissionHint')}</p>
  </section>
}

export function AdvancedSettings({ value, change, models }: Fields) {
  const { t } = useStudio()
  return <>
    <section className="as-card as-fields"><SettingText label={t('workDirectory')} hint={t('workDirectoryHint')} maxLength={4096}
      value={value.studioCwd} change={studioCwd => change({ studioCwd })} /></section>
    <section className="as-card as-fields"><h3>{t('initialModels')}</h3><p>{t('initialModelsHint')}</p>
      <ModelEditor title={t('role.assistant')} value={value.assistantModel} options={models} disableLabel={t('inheritance')}
        change={assistantModel => change({ assistantModel })} />
      <ModelEditor title={t('role.leader')} value={value.leaderModel} options={models} disableLabel={t('inheritance')}
        change={leaderModel => change({ leaderModel })} />
    </section>
  </>
}
