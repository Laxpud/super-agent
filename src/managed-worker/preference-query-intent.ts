import { isMemoryKey } from './memory-store.js'

export type PreferenceQuery =
  | { kind: 'list'; projectId?: string }
  | { kind: 'read'; key: string; projectId?: string }
  | { kind: 'trace'; key: string; revision?: number; projectId?: string }
  | { kind: 'clarify' }

const QUERY_TEXT_LIMIT = 256

// Capture one identifier-like token, including common invalid keys and single Han labels, but not prose.
const identifier = String.raw`(?:[A-Za-z0-9_-]+|\p{Script=Han}+)`
const version = String.raw`[vV](?:[+-]?[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?`
const projectSuffix = new RegExp(String.raw`(?:（项目 (${identifier})）| \(project (${identifier})\))([?？.。])?$`, 'u')
const projectUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const revisionNumber = /^v[1-9][0-9]*$/u

const list = /^(?:你记住了哪些偏好[?？]?|[Ww]hat preferences do you remember\??)$/u
const ambiguousTrace = /^(?:这条偏好的出处是什么[?？]?|[Ww]hat is the source of this preference\??)$/u
const read = [
  new RegExp(String.raw`^查看偏好 (${identifier})[.。]?$`, 'u'),
  new RegExp(String.raw`^[Ss]how preference (${identifier})\.?$`, 'u'),
]
const trace = [
  new RegExp(String.raw`^偏好 (${identifier})(?: (${version}))? 的出处是什么[?？]?$`, 'u'),
  new RegExp(String.raw`^[Ww]hat is the source of preference (${identifier})(?: (${version}))?\??$`, 'u'),
]

function queryBody(text: string): PreferenceQuery | undefined {
  if (list.test(text)) return { kind: 'list' }
  if (ambiguousTrace.test(text)) return { kind: 'clarify' }
  for (const pattern of read) {
    const key = pattern.exec(text)?.[1]
    if (key !== undefined) return isMemoryKey(key) ? { kind: 'read', key } : { kind: 'clarify' }
  }
  for (const pattern of trace) {
    const match = pattern.exec(text)
    if (!match) continue
    const [, key, rawRevision] = match
    if (!isMemoryKey(key)) return { kind: 'clarify' }
    if (rawRevision === undefined) return { kind: 'trace', key }

    // Never discard a malformed revision and accidentally return the current revision instead.
    const revision = Number(rawRevision.slice(1))
    if (!revisionNumber.test(rawRevision) || !Number.isSafeInteger(revision)) return { kind: 'clarify' }
    return { kind: 'trace', key, revision }
  }
  return undefined
}

/** Recognize one complete preference query without resolving keys or project IDs against storage. */
export function preferenceQueryIntent(text: string): PreferenceQuery | undefined {
  // Do not trim or normalize the input: only the literal spaces and punctuation in the forms are allowed.
  if (text.length > QUERY_TEXT_LIMIT || !text.isWellFormed()) return undefined
  const suffix = projectSuffix.exec(text)
  if (!suffix) return queryBody(text)

  // The optional sentence terminator can sit before or after the project suffix, but not in both places.
  const query = queryBody(text.slice(0, suffix.index) + (suffix[3] ?? ''))
  if (!query || query.kind === 'clarify') return query
  const projectId = suffix[1] ?? suffix[2]
  if (projectId === undefined || !projectUuid.test(projectId)) return { kind: 'clarify' }
  return { ...query, projectId }
}
