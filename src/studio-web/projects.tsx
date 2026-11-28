/** 项目的导航、管理轮次与档案。归档只冻结写入，原有记录仍通过 Studio 读取。 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { StudioInput, StudioProjectArchive, StudioProjectCreate, StudioProjectSummary, StudioProjectUpdate } from '../studio/protocol.ts'
import { StudioApiError } from './api.ts'
import { createQuery, useQuery } from './query.ts'
import { SettingText, SettingsConfirm } from './settings-fields.tsx'
import { Button, FailureNotice, QueryStatus, Time, projectById, useAction, useStudio } from './ui.tsx'

type ProjectFields = Required<StudioProjectCreate>
const blankProject: ProjectFields = { name: '', objective: '', workspacePath: '' }
const projectFields = ({ name, objective, workspacePath }: StudioProjectSummary): ProjectFields => ({ name, objective, workspacePath: workspacePath ?? '' })
const validProject = (fields: ProjectFields) => !!fields.name.trim() && !!fields.objective.trim()

function ProjectFields({ value, change, disabled, creating = false }: {
  value: ProjectFields; change: (key: keyof ProjectFields, value: string) => void; disabled: boolean; creating?: boolean
}) {
  const { t } = useStudio()
  return <fieldset disabled={disabled} className="as-setting-panel as-fields">
    <SettingText label={t('projectName')} value={value.name} change={text => change('name', text)} maxLength={120} />
    <label className="as-setting-field">{t('projectObjective')}
      <textarea rows={3} maxLength={2000} value={value.objective} onChange={event => change('objective', event.currentTarget.value)} />
    </label>
    <SettingText label={t('projectWorkspace')} hint={t(creating ? 'projectWorkspaceCreateHint' : 'projectWorkspaceEditHint')}
      value={value.workspacePath} change={text => change('workspacePath', text)} maxLength={4096} />
  </fieldset>
}

function NewProject({ created, close }: { created: (id: string) => void; close: () => void }) {
  const { t, call, applyProject, reloadState } = useStudio()
  const [fields, setFields] = useState(blankProject)
  const action = useAction()
  const enter = useRef(created)
  useLayoutEffect(() => { enter.current = created }, [created])
  const submit = () => action.run(async () => {
    try {
      const path = fields.workspacePath.trim()
      const project = await call('createProject', { name: fields.name, objective: fields.objective, ...(path ? { workspacePath: path } : {}) })
      if (!project.id || project.state !== 'active') throw new StudioApiError('badResponse', 200)
      applyProject(project)
      close()
      enter.current(project.id)
    } catch (error) { reloadState(); throw error }
  })
  return <form className="as-card as-fields" onSubmit={event => { event.preventDefault(); if (validProject(fields)) void submit() }}>
    <ProjectFields value={fields} change={(key, value) => setFields(previous => ({ ...previous, [key]: value }))} disabled={action.busy} creating />
    {action.failure !== undefined && <FailureNotice failure={action.failure} />}
    <div className="as-actions">
      <Button type="submit" primary disabled={action.busy || !validProject(fields)}>{t(action.busy ? 'creatingProject' : 'createProject')}</Button>
      <Button disabled={action.busy} onClick={close}>{t('cancel')}</Button>
    </div>
  </form>
}

export function ProjectNavigation({ currentId, disabled, select }: { currentId: string; disabled: boolean; select: (id: string) => void }) {
  const { t, state } = useStudio()
  const [creating, setCreating] = useState(false)
  const archive = useRef<HTMLDetailsElement>(null)
  const form = useId()
  const active = state?.projects.filter(project => project.state === 'active') ?? []
  const archived = state?.archivedProjects ?? []
  const viewingArchive = projectById(state, currentId)?.state === 'archived'
  useEffect(() => { if (viewingArchive && archive.current) archive.current.open = true }, [viewingArchive, currentId])
  return <nav className="as-project-nav" aria-label={t('projects')}>
    <h3>{t('projects')}</h3>
    <select aria-label={t('project')} value={viewingArchive ? '' : currentId} disabled={disabled || !active.length}
      onChange={event => select(event.currentTarget.value)}>
      <option value="">{t('project')}</option>
      {currentId && !viewingArchive && !active.some(project => project.id === currentId) && <option value={currentId}>{currentId}</option>}
      {active.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    <Button disabled={disabled || creating} aria-expanded={creating} aria-controls={form} onClick={() => setCreating(true)}>
      <span aria-hidden="true">+</span> {t('newProject')}
    </Button>
    <div id={form} hidden={!creating}>{creating && <NewProject created={select} close={() => setCreating(false)} />}</div>
    <details ref={archive} className="as-project-nav-archived">
      <summary>{t('archivedProjects')} <span className="as-pill as-count">{archived.length}</span></summary>
      {archived.length ? <ul className="as-record-list">
        {archived.map(project => <li key={project.id}><Button disabled={disabled} aria-current={currentId === project.id ? 'page' : undefined}
          onClick={() => select(project.id)}>{project.name}</Button></li>)}
      </ul> : <p className="as-muted">{t('noArchivedProjects')}</p>}
    </details>
  </nav>
}

function ProjectEditor({ project, busy, save }: {
  project: StudioProjectSummary; busy: boolean; save: (changes: StudioProjectUpdate) => Promise<boolean>
}) {
  const { t } = useStudio()
  const [draft, setDraft] = useState<{ base: StudioProjectSummary; changes: Partial<ProjectFields> }>()
  const fields = { ...projectFields(project), ...draft?.changes }
  const stale = !!draft && draft.base.managementEpoch !== project.managementEpoch
  const change = (key: keyof ProjectFields, value: string) => setDraft(previous => {
    const base = previous?.base ?? project
    const changes = { ...previous?.changes }
    if (value === projectFields(base)[key]) delete changes[key]
    else changes[key] = value
    return Object.keys(changes).length ? { base, changes } : undefined
  })
  return <form className="as-fields" onSubmit={event => {
    event.preventDefault()
    if (!draft || stale || !validProject(fields)) return
    const { workspacePath, ...changes } = draft.changes
    void save({ projectId: project.id, expectedEpoch: draft.base.managementEpoch, ...changes,
      ...(workspacePath !== undefined ? { workspacePath: workspacePath.trim() || null } : {}) }).then(ok => { if (ok) setDraft(undefined) })
  }}>
    <h3>{t('editProject')}</h3>
    <ProjectFields value={fields} change={change} disabled={busy} />
    {stale && <p className="as-warning" role="status">{t('projectDraftStale')}</p>}
    <div className="as-actions">
      <Button type="submit" primary disabled={!draft || stale || busy || !validProject(fields)}>{t('saveProject')}</Button>
      {draft && <Button disabled={busy} onClick={() => setDraft(undefined)}>{t('discardSettings')}</Button>}
    </div>
  </form>
}

const archiveFields = ['decisions', 'progress', 'openIssues'] as const
type ArchiveEdits = Partial<Pick<StudioProjectArchive, typeof archiveFields[number]>>

function ProjectArchive({ project }: { project: StudioProjectSummary }) {
  const { t, call, reloadState } = useStudio()
  const { id: projectId } = project
  const query = useMemo(() => createQuery(async signal => {
    const archive = await call('projectArchive', { projectId }, signal)
    if (archive.projectId !== projectId) throw new StudioApiError('badResponse', 200)
    // 远端归档可能先于 Studio 状态轮询发生；立即停止编辑，并刷新导航。
    if (archive.readonly !== (project.state === 'archived')) reloadState()
    return archive
  }), [call, projectId, project.state, reloadState])
  const result = useQuery(query)
  const archive = result.data
  const [edits, setEdits] = useState<ArchiveEdits>({})
  const [saved, setSaved] = useState(false)
  const action = useAction()
  const readOnly = archive?.readonly || project.state === 'archived'
  const changed = Object.keys(edits).length > 0
  const submit = () => action.run(async () => {
    try {
      const receipt = await call('updateProjectArchive', { projectId, ...edits })
      if (receipt.projectId !== projectId || receipt.readonly) throw new StudioApiError('badResponse', 200)
      query.reconcile(() => receipt)
      setEdits({})
      setSaved(true)
    } catch (error) { query.reload(); reloadState(); throw error }
  })
  return <form className="as-fields" onSubmit={event => { event.preventDefault(); if (archive && !readOnly && changed) void submit() }}>
    <h3>{t('projectArchive')}</h3>
    <QueryStatus query={result} reload={query.reload} />
    {readOnly && <p className="as-muted">{t('archiveReadOnly')}</p>}
    {archive && <>
      {archive.updatedAt && <div className="as-meta">{t('updatedAt')} <Time value={archive.updatedAt} /></div>}
      {archiveFields.map(field => <label key={field} className="as-setting-field">{t(`archiveField.${field}`)}
        <textarea rows={3} value={edits[field] ?? archive[field]} maxLength={8000} disabled={action.busy} readOnly={readOnly}
          onChange={event => {
            const value = event.currentTarget.value
            setEdits(previous => {
              const next = { ...previous }
              if (value === archive[field]) delete next[field]
              else next[field] = value
              return next
            })
            setSaved(false)
          }} />
      </label>)}
      <div className="as-actions"><Button type="submit" primary disabled={readOnly || !changed || action.busy}>
        {t(action.busy ? 'saving' : 'saveArchive')}
      </Button></div>
    </>}
    {action.failure !== undefined && <FailureNotice failure={action.failure} />}
    {saved && <p className="as-success" role="status">{t('archiveSaved')}</p>}
  </form>
}

type LifecycleOp = 'replaceProjectLeader' | 'archiveProject' | 'reopenProject'
type Confirmation = { op: Exclude<LifecycleOp, 'reopenProject'>; expectedEpoch: number }

/** 确认或编辑使用打开界面时的轮次，而不是静默采用轮询得到的新轮次。 */
export function ProjectBar({ project, refreshTimeline }: { project: StudioProjectSummary; refreshTimeline: () => void }) {
  const { t, call, open, applyProject, reloadState } = useStudio()
  const [mode, setMode] = useState<'manage' | 'archive'>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [saved, setSaved] = useState<'updateProject' | LifecycleOp>()
  const panel = useId()
  const action = useAction()
  const archived = project.state === 'archived'
  const visible = archived && mode === 'manage' ? 'archive' : mode
  const projectId = project.id
  const run = (op: 'updateProject' | LifecycleOp, input: StudioInput<'updateProject'>) => action.run(async () => {
    setSaved(undefined)
    try {
      const receipt = await call(op, input)
      const epochChangeRequired = op !== 'updateProject'
      if (receipt.id !== projectId || receipt.state !== (op === 'archiveProject' ? 'archived' : 'active')
        || receipt.managementEpoch < input.expectedEpoch + Number(epochChangeRequired)) throw new StudioApiError('badResponse', 200)
      applyProject(receipt)
      refreshTimeline()
      setSaved(op)
      if (op === 'archiveProject') setMode('archive')
    } catch (error) { reloadState(); throw error }
  })
  const toggle = (next: typeof visible) => { action.clear(); setMode(next === visible ? undefined : next) }
  return <section className="as-project-bar" aria-label={t('projectManagement')}>
    <div className="as-project-bar-top">
      <dl className="as-facts as-project-facts">
        <div><dt>{t('projectObjective')}</dt><dd className="as-message-text">{project.objective}</dd></div>
        <div><dt>{t('projectWorkspace')}</dt><dd><code>{project.workspacePath ?? t('noWorkspace')}</code></dd></div>
        <div><dt>{t('managementEpoch')}</dt><dd>{project.managementEpoch}</dd></div>
      </dl>
      <div className="as-actions">
        {archived ? <>
          <span className="as-pill" data-tone="warn">{t('archivedProject')}</span>
          <Button primary disabled={action.busy} onClick={() => void run('reopenProject', { projectId, expectedEpoch: project.managementEpoch })}>
            {t(action.busy ? 'reopeningProject' : 'reopenProject')}
          </Button>
        </> : <Button disabled={action.busy} aria-expanded={visible === 'manage'} aria-controls={panel}
          onClick={() => toggle('manage')}>{t('manageProject')}</Button>}
        <Button disabled={action.busy} aria-expanded={visible === 'archive'} aria-controls={panel}
          onClick={() => toggle('archive')}>{t('projectArchive')}</Button>
      </div>
    </div>
    {action.failure !== undefined && <FailureNotice failure={action.failure} />}
    {saved && <p className="as-success" role="status">{t(`projectSaved.${saved}`)}</p>}
    <div id={panel} className="as-project-drawer" hidden={!visible}>
      {visible === 'archive' && <ProjectArchive key={project.state} project={project} />}
      {visible === 'manage' && <>
        <ProjectEditor project={project} busy={action.busy} save={changes => run('updateProject', changes)} />
        <div className="as-actions as-project-actions">
          <Button disabled={action.busy} onClick={() => open({ kind: 'preferences', projectId, scope: 'project' })}>{t('projectPreferences')}</Button>
          <Button disabled={action.busy} onClick={() => setConfirmation({ op: 'replaceProjectLeader', expectedEpoch: project.managementEpoch })}>
            {t('replaceProjectLeader')}
          </Button>
          <Button disabled={action.busy} onClick={() => setConfirmation({ op: 'archiveProject', expectedEpoch: project.managementEpoch })}>
            {t('archiveProject')}
          </Button>
        </div>
      </>}
    </div>
    {confirmation && <SettingsConfirm title={t(`confirmTitle.${confirmation.op}`)} body={t(`confirmBody.${confirmation.op}`, { name: project.name })}
      acceptLabel={t(confirmation.op)} dismiss={() => setConfirmation(undefined)} accept={() => {
        setConfirmation(undefined)
        void run(confirmation.op, { projectId, expectedEpoch: confirmation.expectedEpoch })
      }} />}
  </section>
}
