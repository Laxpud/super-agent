import { isMemoryKey } from './memory-store.js'

export type PreferenceScopeChangeIntent =
  | { kind: 'restrict'; key: string; expectedRevision: number; targetProjectId: string }
  | { kind: 'forget'; key: string; expectedRevision: number; projectId?: string }
  | { kind: 'invalid' }

const REQUEST_TEXT_LIMIT = 256
const hiddenOrMultiline = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u
// Use the Store's exact lowercase UUID spelling; the Store checks whether that project exists.
const projectUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

const chineseRestriction = /^(?:请[ \t]*)?(?:把|将)[ \t]*偏好[ \t]+(\S+)[ \t]+(v[1-9][0-9]*)[ \t]+限定到项目[ \t]+([^\s.。]+)[.。]?$/u
const englishRestriction = /^(?:[Pp]lease[ \t]+)?[Rr]estrict[ \t]+preference[ \t]+(\S+)[ \t]+(v[1-9][0-9]*)[ \t]+to[ \t]+project[ \t]+([^\s.]+)\.?$/u
const chineseForget = /^(?:请[ \t]*)?忘记[ \t]*偏好[ \t]+([^\s（]+)[ \t]+(v[1-9][0-9]*)(?:[ \t]*（项目[ \t]+([^\s）]+)）)?[.。]?$/u
const englishForget = /^(?:[Pp]lease[ \t]+)?[Ff]orget[ \t]+preference[ \t]+(\S+)[ \t]+(v[1-9][0-9]*)(?:[ \t]+\(project[ \t]+([^\s)]+)\))?\.?$/u

// Identify malformed direct requests without treating quoted examples or unrelated prose as requests.
const directStarter = /^\s*(?:(?:请\s*)?(?:忘记|限定|限制)\s*(?:(?:这条|那条|这项|这个|该)\s*)?偏好(?!的)|(?:please\s+)?(?:restrict|forget)\s+(?:(?:this|that|the|my|our)\s+)?preferences?\b)/iu
const chineseObjectStarter = /^\s*(?:请\s*)?(?:把|将)\s*(?:(?:这条|那条|这项|这个|该)\s*)?偏好(?=\s|限定|限制|[（("'“‘])/u
const chineseObjectAction = /(限定|限制)|改为|更正为|纠正为|修改为|[：:，,；;]/u

function startsScopeChange(text: string): boolean {
  if (directStarter.test(text)) return true
  // In 把/将 sentences the action follows the preference. A correction verb takes precedence over wording in its body.
  const object = chineseObjectStarter.exec(text)?.[0]
  return object !== undefined && chineseObjectAction.exec(text.slice(object.length))?.[1] !== undefined
}

/** Parse one explicit scope change. Return invalid for malformed direct requests and undefined for other input. */
export function preferenceScopeChangeIntent(text: string): PreferenceScopeChangeIntent | undefined {
  if (!startsScopeChange(text)) return undefined
  if (text.length > REQUEST_TEXT_LIMIT || !text.isWellFormed() || hiddenOrMultiline.test(text)) return { kind: 'invalid' }

  // Match the whole sentence; do not recover fields from examples, extra clauses or inferred context.
  const request = text.trim()
  const restriction = chineseRestriction.exec(request) ?? englishRestriction.exec(request)
  const match = restriction ?? chineseForget.exec(request) ?? englishForget.exec(request)
  if (!match) return { kind: 'invalid' }

  const [, key, revision, projectId] = match
  if (!isMemoryKey(key) || revision === undefined || (projectId !== undefined && !projectUuid.test(projectId))) return { kind: 'invalid' }
  const expectedRevision = Number(revision.slice(1))
  if (!Number.isSafeInteger(expectedRevision)) return { kind: 'invalid' }

  // A restriction always starts at global scope; an unqualified forget targets global scope as well.
  // The backend checks the actual scope and current revision, so parsing cannot authorize a migration or promotion.
  if (restriction) return projectId === undefined ? { kind: 'invalid' } : { kind: 'restrict', key, expectedRevision, targetProjectId: projectId }
  return { kind: 'forget', key, expectedRevision, ...(projectId === undefined ? {} : { projectId }) }
}
