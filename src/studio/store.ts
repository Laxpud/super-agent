import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { studioRecordRole, studioRecords, studioSession } from './domain.ts'
import {
  ASSISTANT_CONVERSATION, STUDIO_PAGE_SIZE, STUDIO_TEXT_LIMIT,
  type StudioArtifact, type StudioMessage, type StudioModel, type StudioPage, type StudioPending,
  type StudioSend, type StudioSessionRecord, type StudioSettings, type StudioSource,
} from './protocol.ts'

export interface StudioFeishuInput {
  scope: string
  id: string
  sourceTimeMs: number
  text: string
  parentId?: string
  rootId?: string
  threadId?: string
}

export interface StudioFeishuDelivery {
  id: string
  kind: 'message' | 'pending' | 'pending-update'
  text?: string
  channel?: 'gui' | 'studio'
  pending?: StudioPending
  parentId?: string
  /** An ordinary Assistant answer can reply in the main chat without creating a new topic. */
  inThread?: boolean
  cardMessageId?: string
}

/** Identifies expected conflicts without exposing raw SQLite errors to the caller's transport. */
export class StudioStoreError extends Error {
  constructor(readonly code: 'SETTINGS_CONFLICT' | 'REQUEST_CONFLICT' | 'REPLY_PARENT_NOT_FOUND' | 'QUOTE_NOT_FOUND' | 'MESSAGE_STATUS_CONFLICT',
    message: string) { super(message); this.name = 'StudioStoreError' }
}

type UserInput = StudioSend & {
  channel: 'gui' | 'feishu'
  createdAt?: number
  feishu?: { scope: string; id: string; threadId?: string }
}
type TerminalMessage = 'completed' | 'failed' | 'interrupted'
type PendingDecision = 'resolved' | 'expired'
type DeliveryState = 'queued' | 'claimed' | 'sent' | 'unconfirmed'

// The prefix separates the conversation ledger from existing managed work and Feishu route ledgers on the same connection.
export const STUDIO_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_studio_assistant (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), session_id TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), revision INTEGER NOT NULL CHECK (revision > 0),
    assistant TEXT NOT NULL, leader TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_message (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'leader')),
    channel TEXT NOT NULL CHECK (channel IN ('gui', 'feishu', 'studio')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    topic_id TEXT REFERENCES agent_studio_message(id),
    reply_to TEXT REFERENCES agent_studio_message(id),
    quote_id TEXT REFERENCES agent_studio_message(id),
    quote_text TEXT,
    request_id TEXT,
    status TEXT CHECK (status IN ('queued', 'running', 'completed', 'failed', 'interrupted')),
    error TEXT,
    run_session_id TEXT,
    source_session_id TEXT,
    source_event_seq INTEGER,
    artifacts TEXT,
    feishu_scope TEXT,
    feishu_id TEXT,
    feishu_thread_id TEXT,
    feishu_generation INTEGER,
    UNIQUE (source_session_id, source_event_seq),
    UNIQUE (feishu_scope, feishu_id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS agent_studio_gui_request ON agent_studio_message(request_id) WHERE channel = 'gui';
  CREATE INDEX IF NOT EXISTS agent_studio_timeline ON agent_studio_message(conversation_id, topic_id, sequence);
  CREATE UNIQUE INDEX IF NOT EXISTS agent_studio_inbound ON agent_studio_message(feishu_generation, feishu_id) WHERE channel = 'feishu';
  CREATE INDEX IF NOT EXISTS agent_studio_thread ON agent_studio_message(feishu_generation, feishu_thread_id, sequence);
  CREATE TABLE IF NOT EXISTS agent_studio_parallel_turn (
    request_id TEXT PRIMARY KEY REFERENCES agent_studio_message(id), session_id TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_route_control (
    target_id TEXT PRIMARY KEY REFERENCES agent_studio_message(id), request_id TEXT NOT NULL UNIQUE REFERENCES agent_studio_message(id),
    kind TEXT NOT NULL CHECK (kind IN ('stop', 'redirect'))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_session (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_pending (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'question', 'blocked')),
    conversation_id TEXT NOT NULL,
    topic_id TEXT,
    message_id TEXT,
    task_id TEXT,
    requester TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    options TEXT NOT NULL,
    accepts_text INTEGER NOT NULL CHECK (accepts_text IN (0, 1)),
    mobile TEXT NOT NULL CHECK (mobile IN ('card', 'topic', 'unsupported')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
    created_at INTEGER NOT NULL,
    answer TEXT,
    answered_by TEXT CHECK (answered_by IN ('gui', 'feishu'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS agent_studio_pending_page ON agent_studio_pending((state = 'pending'), sequence);
  CREATE TABLE IF NOT EXISTS agent_studio_feishu_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    scope TEXT,
    generation INTEGER NOT NULL,
    cutover INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS agent_studio_feishu_outbox (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'pending', 'pending-update')),
    message_id TEXT UNIQUE REFERENCES agent_studio_message(id),
    pending_id TEXT REFERENCES agent_studio_pending(id),
    parent_message_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'sent', 'unconfirmed')),
    remote_id TEXT,
    UNIQUE (pending_id, kind),
    CHECK ((kind = 'message') = (message_id IS NOT NULL) AND (kind = 'message') = (pending_id IS NULL)),
    CHECK ((state = 'sent') = (remote_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS agent_studio_outbox_queue ON agent_studio_feishu_outbox(generation, sequence) WHERE state = 'queued';
  CREATE UNIQUE INDEX IF NOT EXISTS agent_studio_outbox_remote ON agent_studio_feishu_outbox(generation, remote_id)
    WHERE state = 'sent' AND kind <> 'pending-update';
`

interface MessageRow {
  id: string
  sequence: number
  conversation_id: string
  role: StudioMessage['role']
  channel: StudioMessage['channel']
  text: string
  created_at: number
  topic_id: string | null
  reply_to: string | null
  quote_id: string | null
  quote_text: string | null
  reply_count: number
  status: StudioMessage['status'] | null
  error: string | null
  source_session_id: string | null
  source_event_seq: number | null
  artifacts: string | null
  feishu_delivery: DeliveryState | null
}

interface PendingRow {
  sequence: number
  id: string
  kind: StudioPending['kind']
  conversation_id: string
  topic_id: string | null
  message_id: string | null
  task_id: string | null
  requester: string
  title: string
  detail: string
  options: string
  accepts_text: number
  mobile: StudioPending['mobile']
  state: StudioPending['state']
  created_at: number
  answer: string | null
  answered_by: StudioPending['answeredBy'] | null
}

interface SessionRow {
  sequence: number
  id: string
  conversation_id: string
  role: StudioSessionRecord['role']
  created_at: number
}

interface BindingRow { scope: string; generation: number; cutover: number }
interface DeliveryRow {
  id: string
  generation: number
  kind: StudioFeishuDelivery['kind']
  state: DeliveryState
  message_id: string | null
  pending_id: string | null
  parent_message_id: string | null
}
interface CandidateRow extends DeliveryRow { parent_remote: string | null; card_remote: string | null }

// Count topic descendants, not links from automatic responses on the main timeline.
const MESSAGES = `SELECT m.*,
  (SELECT COUNT(*) FROM agent_studio_message child WHERE child.conversation_id = m.conversation_id AND child.topic_id = m.id) AS reply_count,
  (SELECT state FROM agent_studio_feishu_outbox WHERE message_id = m.id) AS feishu_delivery
  FROM agent_studio_message m`

function decodeMessage(row: MessageRow): StudioMessage {
  const delivery = row.feishu_delivery
  return {
    id: row.id, sequence: row.sequence, conversationId: row.conversation_id, role: row.role, channel: row.channel,
    text: row.text, createdAt: row.created_at, replyCount: row.reply_count,
    ...(row.topic_id !== null && { topicId: row.topic_id }),
    ...(row.reply_to !== null && { replyTo: row.reply_to }),
    ...(row.quote_id !== null && row.quote_text !== null && { quote: { messageId: row.quote_id, text: row.quote_text } }),
    ...(row.status && { status: row.status }),
    ...(row.error !== null && { error: row.error }),
    ...(row.source_session_id !== null && row.source_event_seq !== null && {
      source: { sessionId: row.source_session_id, eventSeq: row.source_event_seq },
    }),
    ...(row.artifacts !== null && { artifacts: JSON.parse(row.artifacts) as StudioArtifact[] }),
    ...(delivery !== null && { feishuDelivery: delivery === 'queued' || delivery === 'claimed' ? 'pending' : delivery }),
  }
}

function decodePending(row: PendingRow): StudioPending {
  return {
    id: row.id, kind: row.kind, conversationId: row.conversation_id, requester: row.requester,
    title: row.title, detail: row.detail, options: JSON.parse(row.options) as string[], acceptsText: row.accepts_text === 1,
    mobile: row.mobile, state: row.state, createdAt: row.created_at,
    ...(row.topic_id !== null && { topicId: row.topic_id }), ...(row.message_id !== null && { messageId: row.message_id }),
    ...(row.task_id !== null && { taskId: row.task_id }), ...(row.answer !== null && { answer: row.answer }),
    ...(row.answered_by && { answeredBy: row.answered_by }),
  }
}

function decodeSession(row: SessionRow): StudioSessionRecord {
  return { id: row.id, conversationId: row.conversation_id, role: studioRecordRole(row.role), createdAt: row.created_at }
}

function page<Row, Item>(rows: Row[], decode: (row: Row) => Item, cursor: (row: Row) => number, ascending = false): StudioPage<Item> {
  const items = rows.slice(0, STUDIO_PAGE_SIZE).map(decode)
  const boundary = rows.length > STUDIO_PAGE_SIZE ? rows[STUDIO_PAGE_SIZE - 1] : undefined
  return { items: ascending ? items.reverse() : items, ...(boundary !== undefined && { next: cursor(boundary) }) }
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || value.includes('\0')) throw new Error(`Invalid Studio ${field}`)
}

function requireTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Studio ${field}`)
}

/** Capture a short prefix, without ending on half of a Unicode character. */
function quoteSnippet(text: string): string {
  const prefix = text.slice(0, 280)
  return prefix.isWellFormed() ? prefix : prefix.slice(0, -1)
}

/** 网页保留一条可直接回复的确认消息；它与飞书卡片及待处理列表是一项决定，而不是新请求。 */
function confirmationNotice(item: StudioPending): string {
  const status = item.state === 'pending' ? '待你确认'
    : item.state === 'expired' ? '确认事项已失效' : item.answer === item.options[0] ? '已记录批准' : '已记录拒绝'
  const hint = item.state === 'pending' ? '\n\n可直接回复本条消息说「批准」或「拒绝」。' : ''
  return `${status} · ${item.requester}\n${item.title}${item.detail ? `\n\n${item.detail}` : ''}${hint}`
    .slice(0, STUDIO_TEXT_LIMIT).toWellFormed()
}

/** Conversations and their outbox share the caller's connection, but own their synchronous write transactions. */
export class StudioStore {
  constructor(private readonly db: DatabaseSync, private readonly assertActive: () => void, private readonly unifiedSessions = false) {
    if (!unifiedSessions) this.write(() => db.exec(STUDIO_SCHEMA))
  }

  private write<T>(operation: () => T): T {
    this.assertActive()
    if (this.db.isTransaction) throw new Error('Studio mutations require a new transaction')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Recheck ownership under the writer lock: another run may have taken over while BEGIN waited.
      this.assertActive()
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  assistantSession(): string | undefined {
    this.assertActive()
    return this.db.prepare('SELECT session_id FROM agent_studio_assistant WHERE singleton = 1').get()?.session_id as string | undefined
  }

  setAssistantSession(sessionId: string): void {
    this.write(() => {
      requireId(sessionId, 'Assistant session ID')
      this.db.prepare(`INSERT INTO agent_studio_assistant VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET session_id = excluded.session_id`).run(sessionId)
    })
  }

  settings(defaults: Pick<StudioSettings, 'assistant' | 'leader'>): StudioSettings {
    this.assertActive()
    const row = this.db.prepare('SELECT revision, assistant, leader FROM agent_studio_settings WHERE singleton = 1').get()
    return row ? { revision: row.revision as number, assistant: JSON.parse(row.assistant as string) as StudioModel | null,
      leader: JSON.parse(row.leader as string) as StudioModel | null } : { ...defaults, revision: 0 }
  }

  /** Compare against revision zero until settings have actually been saved. */
  saveSettings(input: StudioSettings): StudioSettings {
    return this.write(() => {
      const current = this.db.prepare('SELECT revision FROM agent_studio_settings WHERE singleton = 1').get()?.revision as number | undefined
      if (input.revision !== (current ?? 0)) {
        throw new StudioStoreError('SETTINGS_CONFLICT', 'Studio settings revision conflict; reload settings and try again')
      }
      const revision = input.revision + 1
      requireTime(revision, 'settings revision')
      this.db.prepare(`INSERT INTO agent_studio_settings VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
        revision = excluded.revision, assistant = excluded.assistant, leader = excluded.leader`)
        .run(revision, JSON.stringify(input.assistant), JSON.stringify(input.leader))
      return { revision, assistant: input.assistant, leader: input.leader }
    })
  }

  /** Store a user message and any eligible outbound delivery as one operation. Retries cannot change either. */
  addUser(input: UserInput): { message: StudioMessage; created: boolean } {
    return this.write(() => {
      const { conversationId, channel, requestId, feishu } = input
      requireId(conversationId, 'conversation ID')
      const binding = this.binding()
      let duplicate: MessageRow | undefined
      if (channel === 'feishu') {
        if (!feishu || conversationId !== ASSISTANT_CONVERSATION || binding?.scope !== feishu.scope) {
          throw new Error('Studio Feishu input requires the active Assistant binding')
        }
        requireId(feishu.id, 'Feishu message ID')
        duplicate = this.db.prepare(`${MESSAGES} WHERE m.feishu_scope = ? AND m.feishu_id = ?`)
          .get(feishu.scope, feishu.id) as unknown as MessageRow | undefined
      } else {
        if (channel !== 'gui' || feishu) throw new Error('Invalid Studio input channel')
        requireId(requestId, 'request ID')
        duplicate = this.db.prepare(`${MESSAGES} WHERE m.channel = 'gui' AND m.request_id = ?`).get(requestId) as unknown as MessageRow | undefined
      }
      if (duplicate) {
        if (duplicate.conversation_id !== conversationId) {
          throw new StudioStoreError('REQUEST_CONFLICT', 'Studio request ID already belongs to another conversation')
        }
        return { message: decodeMessage(duplicate), created: false }
      }

      const createdAt = input.createdAt ?? Date.now()
      requireTime(createdAt, 'message timestamp')
      if (!input.text.trim() || input.text.length > STUDIO_TEXT_LIMIT || !input.text.isWellFormed() || input.text.includes('\0')) {
        throw new Error('Studio message must contain valid, non-blank text within the text limit')
      }
      if (feishu) {
        if (!binding || createdAt <= binding.cutover) throw new Error('Studio Feishu message is not newer than the active binding')
        if (this.sentRemote(binding.generation, feishu.id)) throw new Error('Studio Feishu message ID already belongs to an outbound delivery')
        if (feishu.threadId !== undefined) requireId(feishu.threadId, 'Feishu thread ID')
      }

      // An explicit parent defines the topic. A known Feishu thread can also provide a root; a quote never does.
      const parent = input.replyTo === undefined
        ? feishu?.threadId === undefined || !binding ? undefined : this.threadRoot(binding.generation, feishu.threadId)
        : this.messageRow(input.replyTo, conversationId)
      if (input.replyTo !== undefined && !parent) {
        throw new StudioStoreError('REPLY_PARENT_NOT_FOUND', 'Studio reply parent not found in this conversation')
      }
      const quote = input.quoteId === undefined ? undefined : this.messageRow(input.quoteId, conversationId)
      if (input.quoteId !== undefined && !quote) throw new StudioStoreError('QUOTE_NOT_FOUND', 'Studio quote not found in this conversation')
      const id = randomUUID()
      this.db.prepare(`INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, topic_id, reply_to,
        quote_id, quote_text, request_id, status, feishu_scope, feishu_id, feishu_thread_id, feishu_generation)
        VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(id, conversationId, channel, input.text, createdAt, parent?.topic_id ?? parent?.id ?? null, parent?.id ?? null,
          quote?.id ?? null, quote ? quoteSnippet(quote.text) : null, channel === 'gui' ? requestId : null,
          feishu?.scope ?? null, feishu?.id ?? null, feishu?.threadId ?? null, feishu ? binding!.generation : null)
      if (channel === 'gui' && conversationId === ASSISTANT_CONVERSATION && binding && createdAt >= binding.cutover) {
        this.enqueue(binding.generation, 'message', id, null, parent?.id)
      }
      return { message: decodeMessage(this.messageRow(id)!), created: true }
    })
  }

  message(conversationId: string, id: string): StudioMessage | undefined {
    this.assertActive()
    const row = this.messageRow(id, conversationId)
    return row && decodeMessage(row)
  }

  /** Fetch the newest matching page below the exclusive sequence, then display that page oldest first. */
  messages(conversationId: string, topicId?: string, before?: number): StudioPage<StudioMessage> {
    this.assertActive()
    const rows = this.db.prepare(`${MESSAGES} WHERE m.conversation_id = ? AND m.topic_id IS ? ${before === undefined ? '' : 'AND m.sequence < ?'}
      ORDER BY m.sequence DESC LIMIT ?`).all(conversationId, topicId ?? null, ...(before === undefined ? [] : [before]), STUDIO_PAGE_SIZE + 1) as unknown as MessageRow[]
    return page(rows, decodeMessage, row => row.sequence, true)
  }

  startMessage(id: string, sessionId: string, parallel = false): void {
    this.write(() => {
      requireId(sessionId, 'run session ID')
      const { changes } = this.db.prepare(`UPDATE agent_studio_message SET status = 'running', run_session_id = ?
        WHERE id = ? AND status = 'queued'`).run(sessionId, id)
      if (!changes) throw new StudioStoreError('MESSAGE_STATUS_CONFLICT', 'Studio message is not queued')
      // 并行 Session 只拥有这条在途输入，不替换 Assistant 的主 Session 指针或取得历史输入的权限。
      if (parallel) this.db.prepare('INSERT INTO agent_studio_parallel_turn VALUES (?, ?)').run(id, sessionId)
    })
  }

  /** 将确切的较新用户指令登记到被控制的原轮次，拒绝跨对话、重放和已知迟到的控制。 */
  recordRouteControl(targetId: string, requestId: string, kind: 'stop' | 'redirect'): boolean {
    return this.write(() => this.db.prepare(`INSERT INTO agent_studio_route_control (target_id, request_id, kind)
      SELECT t.id, s.id, ? FROM agent_studio_message t JOIN agent_studio_message s ON s.id = ?
      WHERE t.id = ? AND s.conversation_id = t.conversation_id AND s.role = 'user' AND t.role = 'user'
        AND s.sequence > t.sequence AND s.created_at >= t.created_at ON CONFLICT DO NOTHING`)
      .run(kind, requestId, targetId).changes === 1)
  }

  routeControlled(id: string): boolean {
    this.assertActive()
    return !!this.db.prepare('SELECT 1 FROM agent_studio_route_control WHERE target_id = ?').get(id)
  }

  /** Bind native provenance once; recording it after completion is allowed, but changing it is not. */
  recordMessageSource(id: string, source: StudioSource): void {
    this.write(() => {
      this.validateSource(source)
      const current = this.db.prepare(`SELECT source_session_id, source_event_seq FROM agent_studio_message WHERE id = ? AND role = 'user'`).get(id)
      if (!current) throw new Error('Studio user message not found')
      if (current.source_session_id === source.sessionId && current.source_event_seq === source.eventSeq) return
      if (current.source_session_id !== null || this.messageBySource(source)) throw new Error('Studio message source already bound')
      this.db.prepare('UPDATE agent_studio_message SET source_session_id = ?, source_event_seq = ? WHERE id = ?')
        .run(source.sessionId, source.eventSeq, id)
    })
  }

  finishMessage(id: string, status: TerminalMessage, error?: string): void {
    this.write(() => {
      if (status !== 'completed' && status !== 'failed' && status !== 'interrupted') throw new Error('Invalid Studio terminal status')
      const { changes } = this.db.prepare(`UPDATE agent_studio_message SET status = ?, error = ? WHERE id = ? AND status IN ('queued', 'running')`)
        .run(status, error ?? null, id)
      if (!changes) throw new StudioStoreError('MESSAGE_STATUS_CONFLICT', 'Studio message is not live')
    })
  }

  /** 原生前台结束后，只有仍归属这条请求的受管工作可保留并行 Session，直到实际清理。 */
  endParallelTurn(id: string): void {
    this.write(() => this.db.prepare('DELETE FROM agent_studio_parallel_turn WHERE request_id = ?').run(id))
  }

  /** Use the Studio input for addressing, not the Session that supplied the new native output. */
  addReply(requestMessageId: string, text: string, source?: StudioSource, artifacts?: StudioArtifact[]): StudioMessage {
    return this.write(() => {
      const request = this.messageRow(requestMessageId)
      if (request?.role !== 'user') throw new Error('Studio input message not found')
      if (source) {
        this.validateSource(source)
        const duplicate = this.messageBySource(source)
        if (duplicate) {
          if (duplicate.role === 'user' || duplicate.reply_to !== request.id) throw new Error('Studio reply source already belongs to another message')
          return decodeMessage(duplicate)
        }
      }
      const id = randomUUID()
      const createdAt = Date.now()
      const assistant = request.conversation_id === ASSISTANT_CONVERSATION
      this.db.prepare(`INSERT INTO agent_studio_message (id, conversation_id, role, channel, text, created_at, topic_id, reply_to,
        source_session_id, source_event_seq, artifacts) VALUES (?, ?, ?, 'studio', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, request.conversation_id, assistant ? 'assistant' : 'leader', text, createdAt, request.topic_id, request.id,
          source?.sessionId ?? null, source?.eventSeq ?? null, artifacts === undefined ? null : JSON.stringify(artifacts))
      const binding = assistant && text.trim() ? this.binding() : undefined
      if (binding && createdAt >= binding.cutover) this.enqueue(binding.generation, 'message', id, null, request.id)
      return decodeMessage(this.messageRow(id)!)
    })
  }

  /** Recover only known facts: live turns stopped, old native prompts cannot grant consent, and claimed sends may have happened. */
  recover(): void {
    this.write(() => {
      this.db.exec(`UPDATE agent_studio_message SET status = 'interrupted' WHERE status IN ('queued', 'running');
        DELETE FROM agent_studio_parallel_turn;
        UPDATE agent_studio_feishu_outbox SET state = 'unconfirmed' WHERE state = 'claimed'`)
      const expired = this.db.prepare(`UPDATE agent_studio_pending SET state = 'expired', answer = NULL, answered_by = NULL
        WHERE state = 'pending' AND kind IN ('confirmation', 'question') RETURNING *`).all() as unknown as PendingRow[]
      for (const row of expired) {
        this.updateConfirmationNotice(decodePending(row))
        this.enqueuePendingUpdate(row.id)
      }
    })
  }

  /** A Session may be rediscovered, but it cannot be reassigned to a different conversation or role. */
  registerSession(record: StudioSessionRecord): void {
    this.write(() => {
      requireId(record.id, 'session ID')
      requireId(record.conversationId, 'conversation ID')
      requireTime(record.createdAt, 'session timestamp')
      const existing = this.sessionRow(record.id)
      if (existing) {
        if (existing.conversation_id !== record.conversationId || existing.role !== record.role) {
          throw new Error('Studio session already registered with a different conversation or role')
        }
        return
      }
      this.db.prepare('INSERT INTO agent_studio_session (id, conversation_id, role, created_at) VALUES (?, ?, ?, ?)')
        .run(record.id, record.conversationId, record.role, record.createdAt)
    })
  }

  session(id: string): StudioSessionRecord | undefined {
    this.assertActive()
    if (this.unifiedSessions) return studioSession(this.db, id)
    const row = this.sessionRow(id)
    return row && decodeSession(row)
  }

  records(query?: string, before?: number): StudioPage<StudioSessionRecord> {
    this.assertActive()
    if (this.unifiedSessions) return studioRecords(this.db, query, before)
    const match = query?.trim().toLowerCase() ?? ''
    const rows = this.db.prepare(`SELECT * FROM agent_studio_session WHERE
      (? = '' OR instr(lower(id), ?) > 0 OR instr(lower(conversation_id), ?) > 0 OR instr(lower(role), ?) > 0)
      ${before === undefined ? '' : 'AND sequence < ?'} ORDER BY sequence DESC LIMIT ?`)
      .all(match, match, match, match, ...(before === undefined ? [] : [before]), STUDIO_PAGE_SIZE + 1) as unknown as SessionRow[]
    return page(rows, decodeSession, row => row.sequence)
  }

  /** Persist each pending item once, including items from conversations whose timeline is not mirrored. */
  addPending(item: StudioPending): StudioPending {
    return this.write(() => {
      requireId(item.id, 'pending item ID')
      requireId(item.conversationId, 'conversation ID')
      const existing = this.pendingRow(item.id)
      if (existing) {
        if (existing.conversation_id !== item.conversationId) throw new Error('Studio pending item already belongs to another conversation')
        return decodePending(existing)
      }
      requireTime(item.createdAt, 'pending item timestamp')
      this.db.prepare(`INSERT INTO agent_studio_pending (id, kind, conversation_id, topic_id, message_id, task_id, requester,
        title, detail, options, accepts_text, mobile, state, created_at, answer, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(item.id, item.kind, item.conversationId, item.topicId ?? null, item.messageId ?? null, item.taskId ?? null, item.requester,
          item.title, item.detail, JSON.stringify(item.options), Number(item.acceptsText), item.mobile, item.state, item.createdAt,
          item.answer ?? null, item.answeredBy ?? null)
      if (item.kind === 'confirmation' && item.messageId) {
        const request = this.messageRow(item.messageId, item.conversationId)
        if (request?.role === 'user') this.db.prepare(`INSERT INTO agent_studio_message
          (id, conversation_id, role, channel, text, created_at, topic_id, reply_to) VALUES (?, ?, ?, 'studio', ?, ?, ?, ?)`)
          .run(item.id, item.conversationId, item.conversationId === ASSISTANT_CONVERSATION ? 'assistant' : 'leader',
            confirmationNotice(item), item.createdAt, request.topic_id, request.id)
      }
      const binding = this.binding()
      if (binding && item.createdAt >= binding.cutover) {
        // 重要确认和实际阻塞必须在私聊主聊天可见，不依赖原话题或其投递回执。
        const parent = item.kind === 'question' && item.conversationId === ASSISTANT_CONVERSATION ? item.messageId ?? item.topicId : undefined
        this.enqueue(binding.generation, 'pending', null, item.id, parent)
      }
      return decodePending(this.pendingRow(item.id)!)
    })
  }

  pendingItem(id: string): StudioPending | undefined {
    this.assertActive()
    const row = this.pendingRow(id)
    return row && decodePending(row)
  }

  /** 文字确认必须找全当前候选，不能因为分页截断就把多个匹配误判成唯一。 */
  openConfirmations(): StudioPending[] {
    this.assertActive()
    return (this.db.prepare(`SELECT * FROM agent_studio_pending WHERE state = 'pending' AND kind = 'confirmation'
      ORDER BY sequence DESC`).all() as unknown as PendingRow[]).map(decodePending)
  }

  recentDecisions(): StudioPending[] {
    this.assertActive()
    return (this.db.prepare(`SELECT * FROM agent_studio_pending WHERE state <> 'pending' AND kind = 'confirmation'
      ORDER BY sequence DESC LIMIT ?`).all(STUDIO_PAGE_SIZE) as unknown as PendingRow[]).map(decodePending)
  }

  pendingCount(): number {
    this.assertActive()
    return this.db.prepare("SELECT COUNT(*) AS count FROM agent_studio_pending WHERE (state = 'pending') = 1").get()?.count as number
  }

  /** Expose only active durable blockers for reconciliation against the owning domain ledger. */
  openBlockers(): StudioPending[] {
    this.assertActive()
    const rows = this.db.prepare(`SELECT * FROM agent_studio_pending WHERE kind = 'blocked' AND (state = 'pending') = 1
      ORDER BY sequence DESC`).all() as unknown as PendingRow[]
    return rows.map(decodePending)
  }

  /** Pack priority in the low bit so a cursor can cross into history even if the boundary item was just settled. */
  pending(before?: number): StudioPage<StudioPending> {
    this.assertActive()
    const rows = this.db.prepare(`SELECT * FROM agent_studio_pending
      ${before === undefined ? '' : "WHERE ((state = 'pending'), sequence) < (?, ?)"}
      ORDER BY (state = 'pending') DESC, sequence DESC LIMIT ?`)
      .all(...(before === undefined ? [] : [before % 2, Math.floor(before / 2)]), STUDIO_PAGE_SIZE + 1) as unknown as PendingRow[]
    return page(rows, decodePending, row => row.sequence * 2 + Number(row.state === 'pending'))
  }

  settlePending(id: string, status: PendingDecision, answer?: string, answeredBy?: StudioPending['answeredBy']): StudioPending | undefined {
    return this.write(() => {
      if (status !== 'resolved' && status !== 'expired') throw new Error('Invalid Studio pending decision')
      const row = this.db.prepare(`UPDATE agent_studio_pending SET state = ?, answer = ?, answered_by = ?
        WHERE id = ? AND state = 'pending' RETURNING *`).get(status, answer ?? null, answeredBy ?? null, id) as unknown as PendingRow | undefined
      if (!row) return undefined
      const item = decodePending(row)
      this.updateConfirmationNotice(item)
      this.enqueuePendingUpdate(id)
      return item
    })
  }

  private updateConfirmationNotice(item: StudioPending): void {
    if (item.kind === 'confirmation') this.db.prepare("UPDATE agent_studio_message SET text = ? WHERE id = ? AND channel = 'studio'")
      .run(confirmationNotice(item), item.id)
  }

  /** Reconnecting the same scope preserves its cutover. A changed or rebound scope starts a fresh delivery generation. */
  activateFeishu(scope: string, now: number): number {
    return this.write(() => {
      requireId(scope, 'Feishu scope')
      requireTime(now, 'Feishu cutover')
      const current = this.binding()
      if (current?.scope === scope) return current.cutover
      if (current) this.retireFeishuGeneration(current.generation)
      this.db.prepare(`INSERT INTO agent_studio_feishu_binding VALUES (1, ?, 1, ?) ON CONFLICT(singleton) DO UPDATE SET
        scope = excluded.scope, generation = agent_studio_feishu_binding.generation + 1, cutover = excluded.cutover`).run(scope, now)
      return now
    })
  }

  /** With Feishu disabled or a different scope configured, retire the active binding before accepting new work. */
  deactivateFeishu(scopeToKeep?: string): void {
    this.write(() => {
      const current = this.binding()
      if (!current || current.scope === scopeToKeep) return
      this.retireFeishuGeneration(current.generation)
      // Retain the generation counter while unbound so re-enabling the same scope cannot resurrect old mappings.
      this.db.exec('UPDATE agent_studio_feishu_binding SET scope = NULL WHERE singleton = 1')
    })
  }

  feishuMessage(scope: string, remoteId: string): StudioMessage | undefined {
    this.assertActive()
    const binding = this.binding(scope)
    const row = binding && this.feishuMessageRow(binding.generation, remoteId)
    return row && decodeMessage(row)
  }

  feishuThread(scope: string, threadId: string): StudioMessage | undefined {
    this.assertActive()
    const binding = this.binding(scope)
    const root = binding && this.threadRoot(binding.generation, threadId)
    return root && decodeMessage(root)
  }

  feishuQuestion(scope: string, remoteId: string): StudioPending | undefined {
    this.assertActive()
    const binding = this.binding(scope)
    const delivery = binding && this.sentRemote(binding.generation, remoteId)
    const item = delivery?.kind === 'pending' && delivery.pending_id ? this.pendingRow(delivery.pending_id) : undefined
    return item && decodePending(item)
  }

  /** Claim one send before handing it to the asynchronous transport. Leave dependent writes waiting for an in-flight anchor. */
  nextFeishu(scope: string): StudioFeishuDelivery | undefined {
    return this.write(() => {
      const binding = this.binding(scope)
      if (!binding) return undefined
      const candidate = this.db.prepare(`SELECT d.*,
          COALESCE(CASE WHEN parent.feishu_generation = d.generation THEN parent.feishu_id END, parent_send.remote_id, parent_card.remote_id) AS parent_remote,
          card.remote_id AS card_remote
        FROM agent_studio_feishu_outbox d
        LEFT JOIN agent_studio_message parent ON parent.id = d.parent_message_id
        LEFT JOIN agent_studio_feishu_outbox parent_send ON parent_send.message_id = parent.id AND parent_send.generation = d.generation
        LEFT JOIN agent_studio_feishu_outbox parent_card ON parent_card.pending_id = parent.id AND parent_card.generation = d.generation AND parent_card.kind = 'pending'
        LEFT JOIN agent_studio_feishu_outbox card ON d.kind = 'pending-update' AND card.pending_id = d.pending_id
          AND card.kind = 'pending' AND card.generation = d.generation
        WHERE d.generation = ? AND d.state = 'queued'
          AND COALESCE(parent_send.state, '') NOT IN ('queued', 'claimed') AND COALESCE(parent_card.state, '') NOT IN ('queued', 'claimed')
          AND COALESCE(card.state, '') NOT IN ('queued', 'claimed')
        ORDER BY d.sequence LIMIT 1`)
      while (true) {
        const row = candidate.get(binding.generation) as unknown as CandidateRow | undefined
        if (!row) return undefined
        if ((row.parent_message_id !== null && row.parent_remote === null) || (row.kind === 'pending-update' && row.card_remote === null)) {
          // No known route to the intended thread or card. Never flatten the message or guess a remote ID.
          this.db.prepare("UPDATE agent_studio_feishu_outbox SET state = 'unconfirmed' WHERE id = ?").run(row.id)
          continue
        }
        let delivery: StudioFeishuDelivery
        if (row.kind === 'message') {
          const message = this.messageRow(row.message_id!)!
          const text = message.quote_text === null ? message.text : `引用：${message.quote_text}\n\n${message.text}`
          delivery = { id: row.id, kind: row.kind, text, channel: message.channel === 'gui' ? 'gui' : 'studio',
            ...(row.parent_remote !== null && { parentId: row.parent_remote, ...(message.topic_id === null ? { inThread: false } : {}) }) }
        } else {
          const pending = decodePending(this.pendingRow(row.pending_id!)!)
          delivery = { id: row.id, kind: row.kind, pending, ...(row.parent_remote !== null && { parentId: row.parent_remote }),
            ...(row.card_remote !== null && { cardMessageId: row.card_remote }) }
        }
        this.db.prepare("UPDATE agent_studio_feishu_outbox SET state = 'claimed' WHERE id = ?").run(row.id)
        return delivery
      }
    })
  }

  /** Missing or conflicting receipts remain unconfirmed. A late receipt cannot revive an invalidated claim. */
  finishFeishu(id: string, remoteId?: string): void {
    this.write(() => {
      const delivery = this.db.prepare('SELECT * FROM agent_studio_feishu_outbox WHERE id = ?').get(id) as unknown as DeliveryRow | undefined
      if (!delivery) throw new Error('Studio Feishu delivery not found')
      if (delivery.state === 'queued') throw new Error('Studio Feishu delivery has not been claimed')
      if (delivery.state !== 'claimed') return
      const binding = this.binding()
      let verified = false
      if (remoteId && remoteId.isWellFormed() && !remoteId.includes('\0') && binding?.generation === delivery.generation) {
        const existing = this.sentRemote(delivery.generation, remoteId)
        verified = delivery.kind === 'pending-update'
          ? existing?.kind === 'pending' && existing.pending_id === delivery.pending_id
          : !existing && !this.inboundId(delivery.generation, remoteId)
      }
      this.db.prepare('UPDATE agent_studio_feishu_outbox SET state = ?, remote_id = ? WHERE id = ?')
        .run(verified ? 'sent' : 'unconfirmed', verified ? remoteId! : null, id)
    })
  }

  // Helpers below are used only after the public operation has checked the active-run fence.
  private messageRow(id: string, conversationId?: string): MessageRow | undefined {
    return (conversationId === undefined
      ? this.db.prepare(`${MESSAGES} WHERE m.id = ?`).get(id)
      : this.db.prepare(`${MESSAGES} WHERE m.id = ? AND m.conversation_id = ?`).get(id, conversationId)) as unknown as MessageRow | undefined
  }

  private validateSource(source: StudioSource): void {
    requireId(source.sessionId, 'source session ID')
    requireTime(source.eventSeq, 'source event sequence')
  }

  private messageBySource(source: StudioSource): MessageRow | undefined {
    return this.db.prepare(`${MESSAGES} WHERE m.source_session_id = ? AND m.source_event_seq = ?`)
      .get(source.sessionId, source.eventSeq) as unknown as MessageRow | undefined
  }

  private sessionRow(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM agent_studio_session WHERE id = ?').get(id) as unknown as SessionRow | undefined
  }

  private pendingRow(id: string): PendingRow | undefined {
    return this.db.prepare('SELECT * FROM agent_studio_pending WHERE id = ?').get(id) as unknown as PendingRow | undefined
  }

  private binding(scope?: string): BindingRow | undefined {
    const row = this.db.prepare('SELECT scope, generation, cutover FROM agent_studio_feishu_binding WHERE singleton = 1 AND scope IS NOT NULL')
      .get() as unknown as BindingRow | undefined
    return scope === undefined || row?.scope === scope ? row : undefined
  }

  private retireFeishuGeneration(generation: number): void {
    this.db.prepare(`UPDATE agent_studio_feishu_outbox SET state = 'unconfirmed'
      WHERE generation = ? AND state IN ('queued', 'claimed')`).run(generation)
  }

  private sentRemote(generation: number, remoteId: string): DeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM agent_studio_feishu_outbox WHERE generation = ? AND remote_id = ? AND state = 'sent' AND kind <> 'pending-update'`)
      .get(generation, remoteId) as unknown as DeliveryRow | undefined
  }

  private inboundId(generation: number, remoteId: string): string | undefined {
    return this.db.prepare(`SELECT id FROM agent_studio_message WHERE channel = 'feishu' AND feishu_generation = ? AND feishu_id = ?`)
      .get(generation, remoteId)?.id as string | undefined
  }

  private feishuMessageRow(generation: number, remoteId: string): MessageRow | undefined {
    const id = this.inboundId(generation, remoteId) ?? this.sentRemote(generation, remoteId)?.message_id
    return id ? this.messageRow(id) : undefined
  }

  private threadRoot(generation: number, threadId: string): MessageRow | undefined {
    // A Feishu root may be given as a message ID or as an opaque thread ID observed on an inbound turn.
    const match = this.db.prepare(`SELECT id, topic_id FROM agent_studio_message WHERE feishu_generation = ? AND feishu_thread_id = ?
      ORDER BY sequence LIMIT 1`).get(generation, threadId)
    const message = match ?? this.feishuMessageRow(generation, threadId)
    const id = message?.topic_id ?? message?.id
    return typeof id === 'string' ? this.messageRow(id, ASSISTANT_CONVERSATION) : undefined
  }

  private enqueue(generation: number, kind: StudioFeishuDelivery['kind'], messageId: string | null, pendingId: string | null, parentId?: string): void {
    this.db.prepare(`INSERT INTO agent_studio_feishu_outbox (id, generation, kind, message_id, pending_id, parent_message_id, state)
      VALUES (?, ?, ?, ?, ?, ?, 'queued')`).run(randomUUID(), generation, kind, messageId, pendingId, parentId ?? null)
  }

  private enqueuePendingUpdate(id: string): void {
    const binding = this.binding()
    if (!binding) return
    const notice = this.db.prepare(`SELECT 1 FROM agent_studio_feishu_outbox WHERE kind = 'pending' AND pending_id = ?
      AND generation = ? AND state IN ('claimed', 'sent')`).get(id, binding.generation)
    // A queued initial card renders current state when claimed. A patch needs a confirmed ID, or an in-flight card that can still supply one.
    if (notice) this.enqueue(binding.generation, 'pending-update', null, id)
  }
}
