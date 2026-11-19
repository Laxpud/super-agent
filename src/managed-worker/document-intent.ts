/** A proposed action for the current document task, not an approval. */
export type DocumentIntent = { kind: 'pause' } | { kind: 'narrow'; keepLines: number[] }

const MAX_TEXT_LENGTH = 512
const MAX_KEEP_LINES = 32
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u

const PAUSE = /^(?:(?:please +)?(?:pause|stop)(?: +(?:editing|changes))?|(?:请 *)?(?:先 *)?(?:暂停|停止)(?: *修改)?)[.!。]?$/iu
const CHINESE_CHANGE = /^(?:请 *)?只(?:改|修改) *第 *([0-9]+(?: *[、,] *[0-9]+)*) *行(?: *, *(?:其他|其它)保持不变)?[.。]?$/u
const CHINESE_KEEP = /^(?:请 *)?只保留 *第 *([0-9]+(?: *[、,] *[0-9]+)*) *行的原批准改动[.。]?$/u
const ENGLISH_CHANGE = /^(?:please +)?only +change +(?:line +([0-9]+)|lines +([0-9]+(?: *, *[0-9]+)+(?: *,? * +and +[0-9]+)?|[0-9]+ +and +[0-9]+))[.]?$/iu

/**
 * Parse only complete, single-line commands from a small fixed grammar. Line
 * numbers are one-based, unique, and returned in the order given. Unsupported
 * or ambiguous input produces no proposal.
 *
 * The Host must independently verify source, the subset of current approved
 * changes, versions, message ordering, and owner confirmation before acting.
 */
export function documentIntent(text: string | null): DocumentIntent | undefined {
  if (text === null || text.length > MAX_TEXT_LENGTH || LINE_BREAK.test(text)) return undefined
  // Reject compatibility digits other than full-width digits: e.g. ①② is not line 12.
  for (const character of text) {
    if (!/^[0-9０-９]$/u.test(character) && /[0-9]/u.test(character.normalize('NFKC'))) return undefined
  }
  const normalized = text.normalize('NFKC')
  if (normalized.length > MAX_TEXT_LENGTH || LINE_BREAK.test(normalized)) return undefined
  const sentence = normalized.trim()
  if (PAUSE.test(sentence)) return { kind: 'pause' }

  const english = ENGLISH_CHANGE.exec(sentence)
  const list = english?.[1] ?? english?.[2] ?? CHINESE_CHANGE.exec(sentence)?.[1] ?? CHINESE_KEEP.exec(sentence)?.[1]
  if (list === undefined) return undefined

  // The grammar has already validated the separators; now validate the numbers.
  const keepLines = list.match(/[0-9]+/g)?.map(Number)
  if (!keepLines || keepLines.length > MAX_KEEP_LINES || keepLines.some(line => !Number.isSafeInteger(line) || line < 1)) return undefined
  if (new Set(keepLines).size !== keepLines.length) return undefined
  return { kind: 'narrow', keepLines }
}
