/** 在宿主面板栏挂载 Agent Studio，并保留已记录的 Studio 工具结果展示。 */
import { useId, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ADVISOR_CONSULT, ADVISOR_READ, DRAFT_DELEGATE, DRAFT_READ, STUDY_DELEGATE, STUDY_READ } from '../managed-worker/result-tool-names.ts'
import type { StudioState } from '../studio/protocol.ts'
import { callStudio } from './api.ts'
import { createDrafts } from './drafts.ts'
import { en, NS, zh } from './locales.ts'
import { createQuery, useQuery, type StudioQuery } from './query.ts'
import { Studio } from './studio.tsx'
import { installWorkspaceVisibility } from './workspaces.ts'

const SLOT = 'tool.call.toolview'
const PANEL_ID = 'agent-studio' as MainPanelId

// Use only the rc.3 owner props this view needs; the workspace's older DSH types do not declare this slot contract.
type ToolView = { useDisclosure: () => { readonly expanded: boolean; toggle(): void } } & (
  { phase: 'preparing' | 'start' } | { phase: 'result'; block: {
    readonly meta?: unknown
    readonly content: readonly { readonly type: string; readonly text?: string }[]
    readonly isError: boolean
    readonly error?: { readonly code: string }
  } }
)
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap { [SLOT]: { kind: 'keyed'; scope: 'session'; owner: ToolView } }
}

const row: CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', gap: 6, minHeight: 28, padding: '3px 0',
  background: 'none', border: 0, textAlign: 'start', font: 'inherit', color: 'var(--dsw-alias-label-secondary)' }
const result: CSSProperties = { margin: '2px 0 6px', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 'min(50vh, 28rem)', overflow: 'auto' }

/** Legacy or failed calls may lack presentation metadata; retain their recorded receipt or failure. */
function savedView(meta: unknown): { title: string; text: string } | undefined {
  if (meta === null || typeof meta !== 'object' || !('title' in meta) || !('text' in meta)) return
  if (typeof meta.title === 'string' && meta.title.trim() && typeof meta.text === 'string' && meta.text.trim()) {
    return { title: meta.title, text: meta.text }
  }
}

function StudioResult({ t, useDisclosure, ...call }: ToolView & PropsLocale<typeof NS>) {
  const { expanded, toggle } = useDisclosure()
  const bodyId = useId()
  if (call.phase !== 'result') return <div style={row} role="status">{t(call.phase === 'preparing' ? 'preparing' : 'running')}</div>

  const { block } = call
  const stopped = block.error?.code === 'interrupted'
  // The original output and its provenance live in meta. Render as text, including any Markdown or HTML source as-is.
  const saved = stopped || block.isError ? undefined : savedView(block.meta)
  const title = saved?.title ?? t(stopped ? 'stopped' : block.isError ? 'failed' : 'receipt')
  const text = saved?.text ?? (block.content.flatMap(value => value.type === 'text' && typeof value.text === 'string' ? [value.text] : [])
    .join('\n\n') || block.error?.code || t('noOutput'))
  const color = stopped ? 'var(--dsw-alias-state-warn-primary)' : block.isError ? 'var(--dsw-alias-state-error-primary)' : row.color
  return <>
    <button type="button" style={{ ...row, cursor: 'pointer', color }}
      aria-controls={bodyId} aria-expanded={expanded} onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>{title}
    </button>
    <div id={bodyId} hidden={!expanded}>
      {expanded && <pre style={result} tabIndex={0} aria-label={title}>{text}</pre>}
    </div>
  </>
}

/** 宿主提供导航按钮和标签；图标只显示待我处理计数，不消费 Session 活动。 */
function StudioIcon({ size, stateQuery, t }: SidebarPanelIconOwnerProps & PropsLocale<typeof NS> & {
  stateQuery: StudioQuery<StudioState>
}) {
  const { data } = useQuery(stateQuery)
  const count = data?.pendingCount ?? 0
  return <span style={{ display: 'inline-flex', position: 'relative' }}>
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.5 16.5H11L6 20v-3.5h-1.5A2.5 2.5 0 0 1 2 14V6.5A2.5 2.5 0 0 1 4.5 4h15A2.5 2.5 0 0 1 22 6.5V14a2.5 2.5 0 0 1-2.5 2.5Z" />
      <path d="M7 10h.01M12 10h.01M17 10h.01" strokeWidth="2.5" />
    </svg>
    {count > 0 && <span title={t('pendingCount', { count })} style={{ position: 'absolute', insetInlineEnd: -6, top: -5,
      minWidth: 12, height: 12, paddingInline: 2, textAlign: 'center', borderRadius: 9, fontSize: 9, fontWeight: 650, lineHeight: '12px',
      color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-button-primary-fill)' }}>{count > 9 ? '9+' : count}</span>}
  </span>
}

export const inject = ['slots', 'locale']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'Agent Studio: dictionaries')
  const t = ctx.locale.bind(NS)
  const stateQuery = createQuery(signal => callStudio('state', {}, signal), 4000)
  // 会话目录由宿主提供。补充投影只影响当前 Client 的 Workspaces 导航，不修改底层会话或远程索引。
  ctx.inject?.(['sessions'], scope => {
    scope.effect(() => {
      const sessions = (scope as unknown as { get(name: string): unknown }).get('sessions') as { list?: unknown } | undefined
      const visibility = installWorkspaceVisibility(sessions?.list)
      if (!visibility) return () => {}
      const update = () => visibility.update(stateQuery.getSnapshot().data?.hiddenSessionIds ?? [])
      const unsubscribe = stateQuery.subscribe(update)
      update()
      return () => { unsubscribe(); visibility.dispose() }
    }, 'Agent Studio: Workspace visibility')
  })
  // 图标（可能同时在更多菜单）和主面板合用一次状态轮询。切走主面板仍保留未发送的草稿。
  const drafts = createDrafts()
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS },
    (props: PropsLocale<typeof NS>) => <Studio t={props.t} locale={ctx.locale.getLocale().active} stateQuery={stateQuery} drafts={drafts} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10,
    label: () => t('studio'), locale: NS }, (props: SidebarPanelIconOwnerProps & PropsLocale<typeof NS>) => <StudioIcon {...props} stateQuery={stateQuery} />))
  ctx.slots.inject(SLOT, function* () {
    for (const key of [DRAFT_DELEGATE, DRAFT_READ, STUDY_DELEGATE, STUDY_READ, ADVISOR_CONSULT, ADVISOR_READ]) {
      yield ctx.slots.register({ name: SLOT, key, locale: NS }, StudioResult)
    }
  })
}
