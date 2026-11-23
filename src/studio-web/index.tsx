/** Read Studio's persisted tool presentation without querying the Host or changing what the model sees. */
import { useId, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { ADVISOR_CONSULT, ADVISOR_READ, DRAFT_DELEGATE, DRAFT_READ, STUDY_DELEGATE, STUDY_READ } from '../managed-worker/result-tool-names.ts'

const SLOT = 'tool.call.toolview'
const NS = 'dshSuperagentStudio'
const en = { preparing: 'Preparing Studio call…', running: 'Studio call running…', receipt: 'Studio tool receipt',
  stopped: 'Studio call interrupted', failed: 'Studio call failed', noOutput: 'No text was recorded.' }
const zh: Record<keyof typeof en, string> = { preparing: '正在准备 Studio 调用…', running: 'Studio 正在处理…', receipt: 'Studio 工具回执',
  stopped: 'Studio 调用已中断', failed: 'Studio 调用失败', noOutput: '没有记录文本。' }

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
  interface LocaleNamespaceMap { [NS]: keyof typeof en }
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

export const inject = ['slots', 'locale']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'Studio result views: dictionaries')
  ctx.slots.inject(SLOT, function* () {
    for (const key of [DRAFT_DELEGATE, DRAFT_READ, STUDY_DELEGATE, STUDY_READ, ADVISOR_CONSULT, ADVISOR_READ]) {
      yield ctx.slots.register({ name: SLOT, key, locale: NS }, StudioResult)
    }
  })
}
