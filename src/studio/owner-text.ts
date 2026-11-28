/** 解析已经由宿主认证的用户文字。这里不调用模型，也不能替用户补写决定或扩大动作范围。 */
import { ASSISTANT_CONVERSATION, GUARD_PENDING_CHOICES, GUARD_PENDING_PREFIX, type StudioPending } from './protocol.ts'

const end = /[。！!.\s]+$/u
const key = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ').replace(end, '').toLowerCase()
const titleKey = (value: string): string => key(value).replace(/[？?]$/u, '').trim()
const unwrap = (value: string): string => value.replace(/^[「『“"《](.+)[」』”"》]$/u, '$1')

export const ownerTextKey = key
export const asksForProjects = /^(?:(?:请)?(?:帮我)?(?:列出|查看|看看|查一下)(?:目前|当前|现有|所有)?(?:的)?项目(?:列表|清单)?|(?:现在|目前|当前)?(?:都)?有(?:哪些|什么|几个|多少个)项目|(?:现在|目前|当前)?(?:的)?项目(?:列表|清单)|(?:what projects (?:are there|do (?:i|we) have)|(?:show|list)(?: my| the| all)? projects))[？?。！!\s]*$/iu
export const asksForActiveWork = /^(?:(?:现在|目前|当前)?(?:都)?(?:有|还有)(?:哪些|什么)(?:在处理的)?(?:工作|任务)(?:在(?:跑|运行|处理)|正在(?:运行|处理))?|(?:现在|目前|当前)?(?:正在|在)(?:做|处理)(?:什么|哪些)(?:事|任务)?|(?:查看|列出)(?:现在|目前|当前)?(?:正在处理的|在途)(?:工作|任务)|what(?: are you| is) (?:working on|running))[？?。！!\s]*$/iu
export const asksForPending = /^(?:(?:现在|目前)?(?:还有|有)(?:什么|哪些)(?:事项)?(?:需要我(?:回答|处理|确认|决定)(?:的(?:事项)?|吗)?|待我处理|待(?:我)?确认(?:的事项)?|待办)|(?:看看|查(?:看|询)|列出)(?:一下)?(?:现在的|所有|我的)?(?:待我处理(?:事项)?|待确认(?:事项)?|待办)|待我处理|待确认(?:事项)?|what(?:'s| is) (?:waiting for|pending for) me|\/studio-pending)[?？。.!！\s]*$/iu

export function confirmationStatusQuery(raw: string): { target: string } | undefined {
  const text = key(raw).replace(/[？?]$/u, '')
  if (/^(?:(?:请)?(?:查询|查看|看看|列出)(?:一下)?)?(?:最近(?:的)?|已处理(?:的)?)?(?:确认(?:结果|状态)|已处理的确认|历史确认)$/u.test(text)) return { target: '' }
  const match = /^(?:请)?(?:查询|查看|看看|查一下)\s*(.+?)\s*(?:的)?(?:确认状态|确认结果|确认事项)$/u.exec(text)
    ?? /^(?:请)?(?:查询|查看|看看|查一下)\s*(?:确认事项|确认状态)\s*[:：]?\s+(.+)$/u.exec(text)
    ?? /^(.+?)\s*的确认(?:状态|结果)(?:怎么样了|如何|是什么)?$/u.exec(text)
  return match?.[1] ? { target: match[1].trim() } : undefined
}

export interface TextDecision { approve: boolean; target: string; ambiguous?: boolean }

/** 裸决定只在直接回复一条确认时有效。问句、普通应答和引述不能成为权限。 */
export function readTextDecision(raw: string): TextDecision | undefined {
  const text = key(raw)
  if (/[?？]/u.test(text) || text.length > 4_000) return
  const chinese = /^(?:我(?:现在|明确)?|请)?\s*(不批准|不同意|不允许|拒绝|驳回|不确认|批准|同意|允许|确认)\s*[:：]?\s*(.*)$/u.exec(text)
  if (chinese?.[1] !== undefined) {
    const target = chinese[2] ?? ''
    // 「确认一下…」是请求查证，不是授权；其余附加条件必须与确定的目标完整匹配。
    if (chinese[1] === '确认' && /^(?:一下|是否|有没有|能否|状态)/u.test(target)) return
    return { approve: !/^(?:不|拒绝|驳回)/u.test(chinese[1]), target, ambiguous: chinese[1] === '确认' }
  }
  const english = /^(?:i\s+|please\s+)?(do not approve|not now|decline|reject|approve|confirm)(?:\s*[:：]\s*|\s+|$)(.*)$/iu.exec(text)
  if (english?.[1] !== undefined) return { approve: /^(?:approve|confirm)$/iu.test(english[1]), target: english[2] ?? '' }
}

export function refersToThisConfirmation(target: string): boolean {
  return /^(?:|这(?:一)?(?:项|条|次)(?:确认|申请|操作)?|该(?:事项|申请|操作)|this(?: request| action| confirmation)?)$/iu.test(key(target))
}

/** 只比较真实待办中的范围标识。任务名只有和动作一起出现时才可消歧，不取最近一项。 */
export function namesConfirmation(target: string, item: StudioPending, projectName?: string): boolean {
  const sought = unwrap(titleKey(target)).replace(/^[#＃]/u, '')
  if (!sought) return false
  const title = titleKey(item.title)
  const aliases = [item.id, `确认事项 ${item.id}`, title]
  if (item.taskId) aliases.push(item.taskId, `任务 ${item.taskId}`, `task ${item.taskId}`, `${item.taskId} 的${title}`, `任务 ${item.taskId} ${title}`, `任务${item.taskId}的${title}`)
  if (projectName) aliases.push(`${projectName} ${title}`, `${projectName}的${title}`, `项目 ${projectName} 的${title}`)
  const project = /^Create the ongoing project “(.+)”\?$/u.exec(item.title)?.[1]
  if (project) aliases.push(`创建项目 ${project}`, `创建项目${project}`, `创建项目「${project}」`, `立项 ${project}`, `立项${project}`, `create project ${project}`)
  return aliases.some(alias => titleKey(alias) === sought)
}

export interface TextRouteControl { kind: 'stop' | 'redirect'; target: string }

/** 阻塞解除必须明示任务 ID 和已核实的条件；不会根据普通对话推断。 */
export function readTaskUnblock(raw: string): { taskId: string; detail: string } | undefined {
  const match = /^(?:解除阻塞|unblock)\s+([a-f0-9-]{36})\s*[:：]\s*([\s\S]{1,1000})$/iu.exec(raw.trim())
  if (match?.[1] && match[2]) return { taskId: match[1].toLowerCase(), detail: match[2] }
}

/** 只将明确的控制词交给快速路径；未匹配的普通指令继续由 Router 理解。 */
export function readRouteControl(raw: string): TextRouteControl | undefined {
  const text = key(raw)
  if (/[?？]/u.test(text) || text.length > 4_000) return
  const stop = /^(?:请)?\s*撤销(?:对)?\s*(.+?)\s*的(?:批准|授权|写入权限)$/u.exec(text)
    ?? /^(?:请|先|请先)?\s*(?:停止|暂停|停(?=\s|$)|取消|撤销(?:对)?)(?:\s*(?:任务|事项|对话|请求))?\s*[:：]?\s*([^，,。；;]*?)(?:[，,]\s*(?:不要再写文件|先不要继续))?$/u.exec(text)
    ?? /^(?:请)?\s*(.+?)\s*(?:先停|暂停|停止|先不要继续)(?:[，,]\s*(?:不要再写文件|先不要继续))?$/u.exec(text)
    ?? /^(?:please )?(?:stop|pause|cancel)(?:\s+(?:task\s+)?(.*))?$/iu.exec(text)
  if (stop) return { kind: 'stop', target: unwrap((stop[1] ?? '').trim()) }
  const named = /^(?:请)?(?:把|将)\s*(?:任务\s*)?(.+?)\s*(?:改成|改为|调整为|先改为)\s*\S/u.exec(text)
    ?? /^(?:更正|改向|调整)\s*(.+?)\s*[:：]\s*\S/u.exec(text)
  if (named?.[1]) return { kind: 'redirect', target: unwrap(named[1].trim()) }
  if (/^(?:(?:刚才|前面)(?:的)?(?:那个|那条|这一轮|这项任务))?\s*(?:先别.+(?:先|改)|先改(?:成|为)|改成|改为|不对[，,]|更正[：:])\S/u.test(text)) {
    return { kind: 'redirect', target: '' }
  }
}

/** 受理、任务状态和补交采用明确命令；没有 ID 时只查询回复对象或近期已登记工作。 */
export function readWorkQuery(raw: string): { kind: 'intake' | 'tasks' | 'task' | 'resubmit'; id?: string } | undefined {
  const input = raw.trim().replace(/[?？。！!]+$/u, '').trimEnd()
  const receipt = /^(?:查询受理|受理状态|message status)(?:\s+([\w-]{1,256}))?$/iu.exec(input)
  if (receipt) return { kind: 'intake', ...(receipt[1] && { id: receipt[1] }) }
  const resubmit = /^(?:补交消息|resubmit message)\s+(om_[a-zA-Z0-9_-]+)$/iu.exec(input)
  if (resubmit?.[1]) return { kind: 'resubmit', id: resubmit[1] }
  const task = /^(?:查询任务|任务状态|task status)\s+([\w-]{1,256})$/iu.exec(input)
  if (task?.[1]) return { kind: 'task', id: task[1] }
  if (/^(?:最近任务|查询近期任务|查看近期任务|recent tasks)$/iu.test(input)) return { kind: 'tasks' }
}

export const FEISHU_CHECK_COMMAND = '/studio-feishu-check'
export function isFeishuCheck(raw: string): boolean {
  const text = raw.trim()
  return text === FEISHU_CHECK_COMMAND || (text.startsWith(FEISHU_CHECK_COMMAND) && /\s/u.test(text.charAt(FEISHU_CHECK_COMMAND.length)))
}

type GuardTextAction = typeof GUARD_PENDING_CHOICES[number]
export type OwnerInput =
  | { kind: 'feishu-check' | 'pending' | 'projects' | 'active-work' | 'confirmation-ack' | 'conversation' }
  | { kind: 'work-query'; query: NonNullable<ReturnType<typeof readWorkQuery>> }
  | { kind: 'confirmation-status'; target: string }
  | { kind: 'task-stop'; taskId: string }
  | { kind: 'guard-decision'; action?: GuardTextAction; id?: string }
  | { kind: 'decision'; decision: TextDecision }
  | { kind: 'unblock'; command: NonNullable<ReturnType<typeof readTaskUnblock>> }
  | { kind: 'route-control'; command: TextRouteControl }

/** 分类只读原文和已知卡片，不查找待办、不改变授权。实时消息按优先序处理；补交可拒绝所有潜在控制。 */
export function classifyOwnerInput(raw: string, conversationId = ASSISTANT_CONVERSATION, direct?: Pick<StudioPending, 'id' | 'kind'>): OwnerInput {
  const text = raw.trim()
  if (isFeishuCheck(text)) return { kind: 'feishu-check' }
  if (asksForPending.test(text)) return { kind: 'pending' }
  if (conversationId === ASSISTANT_CONVERSATION && asksForProjects.test(text)) return { kind: 'projects' }
  if (conversationId === ASSISTANT_CONVERSATION && asksForActiveWork.test(text)) return { kind: 'active-work' }
  const work = readWorkQuery(text)
  if (work) return { kind: 'work-query', query: work }
  const status = confirmationStatusQuery(text)
  if (status) return { kind: 'confirmation-status', target: status.target }
  // 精确任务 ID 的停止优先于卡片决定；它绝不选择对话中的其他执行。
  const route = readRouteControl(text)
  const taskId = route?.target.replace(/^[#＃]/u, '')
  if (route?.kind === 'stop' && taskId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(taskId)) return { kind: 'task-stop', taskId }
  const guard = /^(取消任务|仅解除等待(?:（不重放被拒动作）)?)(?:\s+[#＃]?(guard-intercept:[^\s]+))?$/u.exec(text.replace(/[。！!]+$/u, ''))
  if (direct?.id.startsWith(GUARD_PENDING_PREFIX) || guard?.[2]) {
    const [cancel, clear] = GUARD_PENDING_CHOICES
    return { kind: 'guard-decision', ...(guard && { action: guard[1] === cancel ? cancel : clear, id: guard[2] }) }
  }
  const decision = readTextDecision(text)
  if (decision) return { kind: 'decision', decision }
  if (direct?.kind === 'confirmation' && /^(?:好|好的|可以|ok)[。！!\s]*$/iu.test(text)) return { kind: 'confirmation-ack' }
  const unblocking = readTaskUnblock(text)
  if (unblocking) return { kind: 'unblock', command: unblocking }
  return route ? { kind: 'route-control', command: route } : { kind: 'conversation' }
}
