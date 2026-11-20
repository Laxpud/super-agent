import { isMemoryKey, isPreferenceText } from './memory-store.js'

type PreferenceCorrection =
  | { kind: 'correct'; key: string; expectedRevision: number; projectId?: string; text: string }
  | { kind: 'invalid' }

const REQUEST_TEXT_LIMIT = 2400

// Recognize direct correction starters separately so malformed requests do not become ordinary work.
const correctionStarter = /^\s*(?:(?:请\s*)?(?:把|将|更正|修改|纠正)\s*偏好|(?:please\s+)?(?:change|correct|update)\s+preference\b)/iu
const chineseCorrection = /^(?:请\s*)?(?:把|将)\s*偏好\s+([^\s（(]+)\s+(v[1-9][0-9]*)(?:\s*（项目\s+([^\s）]+)）)?\s*(?:改为|更正为)\s*[:：](.*)$/u
const englishCorrection = /^(?:[Pp]lease\s+)?[Cc]hange\s+preference\s+(\S+)\s+(v[1-9][0-9]*)(?:\s+\(project\s+([^\s)]+)\))?\s+to\s*[:：](.*)$/u
// Preserve the exact lowercase UUID spelling accepted by the Store; do not resolve or normalize IDs.
const projectUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const hiddenOrMultiline = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u

const leadingDurability = /^(?:(?:从今以后|从现在起|以后|今后|往后|每次)都?|(?:from\s+now\s+on|going\s+forward|always|in\s+(?:the\s+)?future|for\s+all\s+future)(?=\s|[,，]|$))/iu
const nonClauseCharacter = /[^\p{L}\p{M}\p{N}\s'’-]|(?<![\p{L}\p{M}\p{N}])['’-]|['’-](?![\p{L}\p{M}\p{N}])/u
const transientEnglish = /\b(?:today|tonight|tomorrow|yesterday|temporarily|for\s+(?:now|a\s+while|the\s+time\s+being|(?:the\s+)?next)|in\s+the\s+meantime|at\s+the\s+moment|until|(?:this|current|next)\s+(?:one|once|time|report|task|request|draft|response|week|month|session|occasion)|(?:just|only)\s+once|one[- ](?:off|time)|not\s+(?:always|permanent(?:ly)?|long[- ]term)|(?:do\s+not|don['’]t|never)\s+(?:remember|save|store))\b/iu
const boundedDuration = /\bfor\s+(?:an?|[0-9]+|one|two|three|a\s+few|several)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\b/iu
const mixedEnglish = /\b(?:and|or|then|also|plus|but|as\s+well\s+as|example|if|maybe|perhaps)\b/iu
const transientChinese = /(?:这(?:个(?:报告|任务|请求|会话)|份报告|一次|次|回)|本(?:次|轮|报告|任务|请求|会话|周|月)|此次|这一轮|眼下|目前|这周|今天|今日|今晚|明天|暂(?:时|且|用)|临时|下(?:一?(?:次|份报告)|一?个?(?:任务|请求))|[只仅]此一次|一次性|不是长期|不(?:要|用|必|需要)(?:永久|长期)?(?:记住|保存|记录))/u
const mixedChinese = /(?:并|而且|同时|顺便|然后|接着|另外|其次|再(?:帮|请|把|用|写|做|给|生成|发送)|以及|或者|和(?:请|帮|把|给|用|使用|写|生成|发送)|例如|比如|举例|如果|假如|也许)/u

/** Parse one exact preference correction; leave existence, scope and revision checks to the Host and Store. */
export function preferenceCorrectionIntent(text: string): PreferenceCorrection | undefined {
  if (!correctionStarter.test(text)) return undefined
  if (text.length > REQUEST_TEXT_LIMIT || !text.isWellFormed() || hiddenOrMultiline.test(text)) return { kind: 'invalid' }

  const request = text.trim()
  const match = chineseCorrection.exec(request) ?? englishCorrection.exec(request)
  if (!match) return { kind: 'invalid' }
  const [, key, revision, projectId, rawBody] = match
  if (!isMemoryKey(key) || revision === undefined || rawBody === undefined) return { kind: 'invalid' }
  const expectedRevision = Number(revision.slice(1))
  const body = rawBody.trim()
  if (!Number.isSafeInteger(expectedRevision) || (projectId !== undefined && !projectUuid.test(projectId))
    || !isPreferenceText(body)) return { kind: 'invalid' }

  // Check the single clause without its optional durability phrase or final punctuation; store the original body.
  const sentence = body.replace(/[.!。！]$/u, '').trimEnd()
  const marker = leadingDurability.exec(sentence)?.[0]
  const clause = marker ? sentence.slice(marker.length).replace(/^\s*[,，]?\s*/u, '') : sentence
  if (!/\p{L}/u.test(clause) || nonClauseCharacter.test(clause)
    || transientEnglish.test(sentence) || boundedDuration.test(sentence) || transientChinese.test(sentence)
    || mixedEnglish.test(clause) || mixedChinese.test(clause)) return { kind: 'invalid' }

  // Omitting the project leaves a global correction, never an inferred session project.
  return { kind: 'correct', key, expectedRevision, ...(projectId === undefined ? {} : { projectId }), text: body }
}
