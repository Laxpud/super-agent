/** Authenticated, owner-only JSON API for the Studio Client. It never accepts Feishu callbacks over HTTP. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { STUDIO_API, STUDIO_HEADER, STUDIO_TASK_STATUSES, STUDIO_TEXT_LIMIT, type StudioInput, type StudioOp, type StudioResult } from './protocol.ts'
import { StudioError } from './pending.ts'
import { configurationChange, feishuCheck } from './settings-schema.ts'
import { StudioStoreError } from './store.ts'
import { PROJECT_NAME_LIMIT } from '../managed-worker/project-store.ts'
import { WorkspacePathError } from '../managed-worker/workspace.ts'

// IDs are opaque but bounded; text is kept verbatim so native owner evidence can check exact excerpts.
const id = z.string().min(1).max(256).refine(value => value.isWellFormed() && !/[\s\0]/u.test(value))
const validText = (max: number) => z.string().max(max).refine(value => value.isWellFormed() && !value.includes('\0'))
const text = (max: number) => validText(max).refine(value => !!value.trim())
const coord = z.int().nonnegative()
const model = z.strictObject({ provider: id, model: id, reasoningEffort: id.exactOptional() })
const projectCoordinate = { projectId: id, expectedEpoch: coord.positive() }
const projectFields = { name: text(PROJECT_NAME_LIMIT), objective: text(2_000), workspacePath: text(4_096) }
const preferenceScope = { projectId: id.exactOptional() }
const preference = { ...preferenceScope, key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u) }
const version = { expectedVersion: coord.positive() }
const feishuMessage = z.strictObject({ messageId: z.string().max(256).regex(/^om_[a-zA-Z0-9_-]+$/u) })
const schemas = {
  state: z.strictObject({}),
  models: z.strictObject({}),
  configuration: z.strictObject({}),
  saveConfiguration: configurationChange,
  feishuCheck,
  settings: z.strictObject({ revision: coord, scope: z.string().regex(/^[a-f0-9]{64}$/u).exactOptional(), assistant: model.nullable(), leader: model.nullable() }),
  timeline: z.strictObject({ conversationId: id, topicId: id.exactOptional(), before: coord.positive().exactOptional() }),
  message: z.strictObject({ conversationId: id, id }),
  send: z.strictObject({ conversationId: id, requestId: id, text: text(STUDIO_TEXT_LIMIT), replyTo: id.exactOptional(), quoteId: id.exactOptional() }),
  messageStatus: z.strictObject({ conversationId: id, id }),
  feishuMessageStatus: feishuMessage,
  resubmitFeishuMessage: feishuMessage,
  createProject: z.strictObject({ ...projectFields, workspacePath: projectFields.workspacePath.exactOptional() }),
  updateProject: z.strictObject({ ...projectCoordinate, name: projectFields.name.exactOptional(), objective: projectFields.objective.exactOptional(),
    workspacePath: projectFields.workspacePath.nullable().exactOptional() }),
  replaceProjectLeader: z.strictObject(projectCoordinate),
  archiveProject: z.strictObject(projectCoordinate),
  reopenProject: z.strictObject(projectCoordinate),
  projectArchive: z.strictObject({ projectId: id }),
  updateProjectArchive: z.strictObject({ projectId: id, decisions: validText(8_000).exactOptional(), progress: validText(8_000).exactOptional(), openIssues: validText(8_000).exactOptional() }),
  preferences: z.strictObject(preferenceScope),
  savePreference: z.strictObject({ ...preference, text: text(4_000) }),
  updatePreference: z.strictObject({ ...preference, ...version, text: text(4_000) }),
  forgetPreference: z.strictObject({ ...preference, ...version }),
  tasks: z.strictObject({ conversationId: id.exactOptional(), scope: z.enum(['all', 'active', 'terminal']).exactOptional(),
    status: z.enum(STUDIO_TASK_STATUSES).exactOptional(), before: coord.positive().exactOptional() }),
  task: z.strictObject({ taskId: id }),
  stopTask: z.strictObject({ taskId: id }),
  pending: z.strictObject({ before: coord.positive().exactOptional() }),
  answer: z.strictObject({ id, value: text(4_000) }),
  records: z.strictObject({ query: z.string().max(256).exactOptional(), before: coord.positive().exactOptional() }),
  record: z.strictObject({ sessionId: id, from: coord.exactOptional() }),
} satisfies { [K in StudioOp]: z.ZodType<StudioInput<K>> }
const envelope = z.strictObject({ op: z.string(), input: z.unknown() })
export type StudioHttpOperations = { [K in StudioOp]: (input: StudioInput<K>, signal: AbortSignal) => StudioResult<K> | Promise<StudioResult<K>> }

/** Admissions are checked against DSH's signed cookie/Peer, not a header pretending to be a principal. */
interface BrowserConnection {
  readonly browserPeer: { id: string; principal: { kind: string } }
  admit(request: IncomingMessage): { peer: { id: string; principal: { kind: string } } } | { rejection: 401 | 403 }
}

async function body(request: IncomingMessage): Promise<unknown> {
  // 完整设置请求可包含最多 64 个 Worker 模型路由。
  const max = 512 * 1024
  if (Number(request.headers['content-length']) > max) throw new StudioError('REQUEST_TOO_LARGE', 'Studio request is too large.', 413)
  let bytes = 0
  const parts: Buffer[] = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const part = Buffer.from(chunk as Uint8Array)
    bytes += part.length
    if (bytes > max) throw new StudioError('REQUEST_TOO_LARGE', 'Studio request is too large.', 413)
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown }
  catch { throw new StudioError('INVALID_JSON', 'Expected a Studio JSON request.') }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(status === 405 ? { allow: 'POST' } : {}) })
  response.end(JSON.stringify(value))
}

function dispatch<K extends StudioOp>(op: K, input: unknown, operations: StudioHttpOperations, signal: AbortSignal) {
  const data = (schemas[op] as z.ZodType<StudioInput<K>>).parse(input)
  return operations[op](data, signal)
}

export function registerStudioHttp(ctx: Context, connection: BrowserConnection, ready: () => boolean, operations: StudioHttpOperations): () => void {
  if (typeof connection.admit !== 'function') throw new Error('Agent Studio needs a DSH Web host with browser authentication')
  return ctx.webServer.register({ path: STUDIO_API, kind: 'exact', async handler(request, response) {
    const admission = connection.admit(request)
    if ('rejection' in admission) { send(response, admission.rejection, { error: 'Sign in to the local DSH Web host.' }); return }
    if (admission.peer.principal.kind !== 'owner' || admission.peer.id !== connection.browserPeer.id || request.headers[STUDIO_HEADER] !== '1') {
      send(response, 403, { error: 'A same-origin Studio browser request is required.' }); return
    }
    if (request.method !== 'POST') { send(response, 405, { error: 'Expected POST.' }); return }
    if (!ready()) { send(response, 503, { error: 'Agent Studio is not available.' }); return }
    const abort = new AbortController()
    const closed = () => abort.abort()
    response.on('close', closed)
    try {
      const { op, input } = envelope.parse(await body(request))
      abort.signal.throwIfAborted()
      if (!ready()) throw new StudioError('STUDIO_UNAVAILABLE', 'Agent Studio is not available.', 503)
      if (!Object.hasOwn(schemas, op)) throw new StudioError('UNKNOWN_OPERATION', 'Studio operation not found.', 404)
      send(response, 200, await dispatch(op as StudioOp, input, operations, abort.signal))
    } catch (error) {
      if (abort.signal.aborted) return
      if (error instanceof StudioError) send(response, error.status, { error: error.message, code: error.code })
      else if (error instanceof WorkspacePathError) send(response, 400, { error: error.message, code: error.code })
      else if (error instanceof StudioStoreError) {
        const status = error.code === 'REPLY_PARENT_NOT_FOUND' || error.code === 'QUOTE_NOT_FOUND' ? 404 : 409
        send(response, status, { error: error.message, code: error.code })
      }
      else if (error instanceof z.ZodError) send(response, 400, { error: 'The Studio request contains invalid fields.', code: 'INVALID_INPUT' })
      else {
        // Native/SQLite errors may include paths, adapter diagnostics or message text. Do not expose them across HTTP.
        ctx.logger.warn('Agent Studio could not finish an API operation')
        send(response, 500, { error: 'The Studio operation could not be confirmed.', code: 'OPERATION_UNCONFIRMED' })
      }
    } finally { response.off('close', closed) }
  } })
}
