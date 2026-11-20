import { isPreferenceText } from './memory-store.js'

const REQUEST_TEXT_LIMIT = 2400

// A prefix can state durability itself; otherwise the body must begin with a durable marker.
const durableRemember = [
  /^(?:(?:请\s*)?把这条记为长期偏好|(?:请\s*)?记住(?:我的|这条|这个)长期偏好|(?:以后|今后|从今以后)都?\s*(?:请\s*)?记住)\s*[:：]/u,
  /^(?:please\s+)?(?:remember\s+my|(?:remember|save)\s+this\s+as\s+a)\s+long[- ]term\s+preference\s*[:：]/iu,
]
const plainRemember = [
  /^(?:请\s*)?记住(?:\s*[:：]\s*|\s*)/u,
  /^(?:please\s+)?remember(?:\s*[:：]\s*|\s+(?:that\s+|to\s+)?)/iu,
]
const leadingDurability = /^(?:(?:从今以后|从现在起|以后|今后|往后|每次)|(?:from\s+now\s+on|going\s+forward|always|in\s+(?:the\s+)?future|for\s+all\s+future)(?=\s|[,，]|$))/iu

const hiddenOrMultiline = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\p{Cf}\p{Zl}\p{Zp}]/u
const nonClauseCharacter = /[^\p{L}\p{M}\p{N}\s'’-]|(?<![\p{L}\p{M}\p{N}])['’-]|['’-](?![\p{L}\p{M}\p{N}])/u
const transientEnglish = /\b(?:today|tonight|tomorrow|yesterday|temporarily|for\s+now|until|(?:this|current|next)\s+(?:one|once|time|report|task|request|draft|response|week|month|session)|(?:just|only)\s+once|not\s+(?:always|permanent(?:ly)?|long[- ]term)|(?:do\s+not|don['’]t|never)\s+(?:remember|save|store))\b/iu
const mixedEnglish = /\b(?:and|or|then|also|plus|but|as\s+well\s+as|example|if|maybe|perhaps)\b/iu
const transientChinese = /(?:这(?:个(?:报告|任务|请求|会话)|份报告|一次|次|回)|本(?:次|轮|报告|任务|请求|会话|周|月)|此次|这一轮|这周|今天|今日|今晚|明天|暂时|暂且|临时|下(?:一?(?:次|份报告)|一?个?(?:任务|请求))|只此一次|一次性|不是长期|不(?:要|用|必|需要)(?:永久|长期)?(?:记住|保存|记录))/u
const mixedChinese = /(?:并|而且|同时|顺便|然后|接着|另外|再(?:帮|请|把|用|写|做|给|生成|发送)|以及|或者|和(?:请|帮|把|给|用|使用|写|生成|发送)|例如|比如|举例|如果|假如|也许)/u

/** Select the verbatim preference body from a complete owner request, or decline an unsupported form. */
export function preferenceIntent(requestText: string): string | undefined {
  // Reject line breaks and hidden characters before trimming the separators.
  if (requestText.length > REQUEST_TEXT_LIMIT || !requestText.isWellFormed() || hiddenOrMultiline.test(requestText)) return undefined

  const request = requestText.trim()
  const durablePrefix = durableRemember.map(pattern => pattern.exec(request)?.[0]).find(Boolean)
  const prefix = durablePrefix ?? plainRemember.map(pattern => pattern.exec(request)?.[0]).find(Boolean)
  if (!prefix) return undefined

  const body = request.slice(prefix.length).trim()
  if (!isPreferenceText(body)) return undefined

  // Validate without the leading time phrase or one final terminator, but preserve both in the returned text.
  const sentence = body.replace(/[.!。！]$/u, '').trimEnd()
  const marker = leadingDurability.exec(sentence)?.[0]
  if (!durablePrefix && !marker) return undefined
  const clause = marker ? sentence.slice(marker.length).replace(/^\s*[,，]?\s*/u, '') : sentence

  // Refuse quotes, clause punctuation, common joiners and conflicting time cues rather than splitting them.
  if (!/\p{L}/u.test(clause) || nonClauseCharacter.test(clause)
    || transientEnglish.test(sentence) || transientChinese.test(sentence)
    || mixedEnglish.test(clause) || mixedChinese.test(clause)) return undefined
  return body
}
