/** Runs the Feishu bot CLI's live message stream without interpreting the message payloads. */
import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

const EVENT_BYTES = 1_048_576
const STARTUP_MS = 45_000
const STOP_GRACE_MS = 1000

/** Wait before restarting the event consumer: 1s after a run that stayed up for a minute, otherwise exponential backoff up to 60s. */
export const consumerRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

/** Frames UTF-8 lines by byte count, keeping only the bounded prefix of an oversized line until its delimiter. */
async function* lines(stream: Readable, limit: number): AsyncGenerator<{ text: string; oversized: boolean }> {
  const buffer = Buffer.allocUnsafe(limit)
  let length = 0; let oversized = false; let skipLF = false
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    for (const byte of chunk) {
      if (skipLF) { skipLF = false; if (byte === 10) continue }
      if (byte === 10 || byte === 13) {
        yield { text: buffer.toString('utf8', 0, length), oversized }
        length = 0; oversized = false; skipLF = byte === 13
      } else if (length < limit) buffer[length++] = byte
      else oversized = true
    }
  }
  if (length || oversized) yield { text: buffer.toString('utf8', 0, length), oversized }
}

/**
 * Runs one consumer with a locally trusted CLI executable and fixed bot arguments. `ready` reports a clean startup;
 * a late handshake still clears the startup timer but cannot replace an earlier `problem` from the same run.
 * Events are delivered in stdout order. Cancellation stops delivery, signals the in-flight callback, and waits for it
 * and the child's close event. Unexpected exits (including a startup timeout) reject after the readers settle.
 */
export async function consumeFeishuEvents(cli: string, signal: AbortSignal, callbacks: {
  ready(): void
  problem(detail: string): void
  receive(value: unknown, signal: AbortSignal): void | Promise<void>
}): Promise<void> {
  if (signal.aborted) return
  const child = spawn(cli, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
  const run = new AbortController()
  let ready = false; let reportedProblem = false; let diagnostic = ''; let startupFailure = ''
  let closed = false; let escalation: ReturnType<typeof setTimeout> | undefined
  let failure: { error: unknown } | undefined
  const closedChild = new Promise<number | null>(resolve => {
    child.on('error', error => { failure ??= { error } })
    child.once('close', code => {
      closed = true; clearTimeout(startup); clearTimeout(escalation); resolve(code)
    })
  })
  const stop = (reason: unknown): void => {
    if (run.signal.aborted) return
    run.abort(reason)
    clearTimeout(startup)
    if (closed) return
    // Close our pipe ends so inherited descriptors cannot hold `close` open. Escalate if the CLI ignores SIGTERM.
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      escalation = setTimeout(() => { child.kill('SIGKILL') }, STOP_GRACE_MS)
    }
  }
  const startup = setTimeout(() => {
    startupFailure = 'Feishu event consumer did not become ready within 45 seconds'
    stop(new Error(startupFailure))
  }, STARTUP_MS)
  const abort = (): void => stop(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const problem = (detail: string): void => {
    if (run.signal.aborted) return
    reportedProblem = true
    callbacks.problem(detail)
  }
  // Pull one stdout line at a time so a slow receive neither reorders events nor queues an unbounded set of callbacks.
  const readEvents = async (): Promise<void> => {
    for await (const { text, oversized } of lines(child.stdout, EVENT_BYTES)) {
      if (run.signal.aborted) return
      try {
        if (oversized) throw new Error('Feishu event exceeds 1 MiB')
        await callbacks.receive(JSON.parse(text), run.signal)
      } catch (error) { problem(String(error)) }
    }
  }
  const readDiagnostics = async (): Promise<void> => {
    for await (const { text } of lines(child.stderr, 16_000)) {
      if (run.signal.aborted) return
      diagnostic = text.slice(0, 4000)
      if (text.startsWith('[event] ready')) {
        ready = true; clearTimeout(startup)
        if (!reportedProblem) callbacks.ready()
      } else if (/WARN|drop|error/.test(text)) problem(diagnostic)
    }
  }
  const readerFailed = (error: unknown): void => {
    if (run.signal.aborted) return
    failure ??= { error }; stop(error)
  }
  try {
    const [code] = await Promise.all([closedChild, readEvents().catch(readerFailed), readDiagnostics().catch(readerFailed)])
    if (signal.aborted) return
    if (failure) throw failure.error
    throw new Error(`Feishu event consumer exited (${code}, ready=${ready}): ${startupFailure || diagnostic}`)
  } finally { signal.removeEventListener('abort', abort) }
}
