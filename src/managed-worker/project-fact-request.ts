/** Parse an explicit reference from the original owner text, not from model arguments or a selected project. */
export const PROJECT_FACT_HEADER = 'Studio project fact:'

const lineBreak = /\r\n|[\r\n\u0085\u2028\u2029]/u
const reservedLine = /^studio[ \t]+project[ \t]+fact(?=[ \t:：]|$)/iu
const exactHeader = /^Studio project fact: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([a-z][a-z0-9-]{0,63}) v([1-9][0-9]*)$/u

export type ProjectFactRequest = { kind: 'plain' } | { kind: 'invalid' }
  | { kind: 'fact'; projectId: string; key: string; revision: number; taskText: string }

/** A reserved line cannot become an ordinary task. Accept one exact first line and preserve every byte below it. */
export function parseProjectFactRequest(text: string): ProjectFactRequest {
  if (!text.split(lineBreak).some(line => reservedLine.test(line.trimStart()))) return { kind: 'plain' }
  const separator = lineBreak.exec(text)
  if (!separator || separator.index > 140 || !text.isWellFormed() || text.includes('\0')) return { kind: 'invalid' }
  const [, projectId, key, version] = exactHeader.exec(text.slice(0, separator.index)) ?? []
  const revision = Number(version)
  const taskText = text.slice(separator.index + separator[0].length)
  if (!projectId || !key || !Number.isSafeInteger(revision) || !taskText.trim()
    || taskText.split(lineBreak).some(line => reservedLine.test(line.trimStart()))) return { kind: 'invalid' }
  return { kind: 'fact', projectId, key, revision, taskText }
}
