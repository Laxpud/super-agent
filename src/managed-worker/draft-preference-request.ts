/** Recognize an explicit preference reference in the original Assistant assignment, not in model arguments. */
export const DRAFT_PREFERENCE_HEADER = 'Studio preference citation:'

const reservedLine = /^studio[ \t]+preference[ \t]+citation(?=[ \t:：]|$)/iu
const citationHeader = /^Studio preference citation: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

/** Reserve one exact first line and require a real task below it. Malformed or repeated markers never fall back to an uncited draft. */
export function parseDraftPreference(text: string): { kind: 'plain' } | { kind: 'invalid' } | { kind: 'citation'; citationId: string } {
  const lines = text.split(/\r\n|[\r\n\u0085\u2028\u2029]/u)
  if (!lines.some(line => reservedLine.test(line.trimStart()))) return { kind: 'plain' }
  const id = citationHeader.exec(lines[0] ?? '')?.[1]
  const assignment = lines.slice(1)
  if (!id || !assignment.some(line => line.trim().length > 0) || assignment.some(line => reservedLine.test(line.trimStart()))) {
    return { kind: 'invalid' }
  }
  return { kind: 'citation', citationId: id }
}
