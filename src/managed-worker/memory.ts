import { z } from 'zod'
import type { MemoryStore } from './memory-store.ts'

export const MEMORY_COMMAND = 'studio-memory'
export const MEMORY_HINT = 'list [project-id] | show <JSON> | save <JSON> | update <JSON> | forget <JSON>'
const scope = z.uuid().exactOptional()
const keys = { key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), projectId: scope }
const text = z.string().min(1).max(4_000)
const version = z.int().positive()

/** 支持明确的用户命令；不监听或自动推断自然语言偏好。 */
export function memoryCommand(store: MemoryStore, rawInput: string, allowed: (projectId: string | null) => boolean) {
  const [, verb = '', argument = ''] = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(rawInput.trim()) ?? []
  const reject = () => ({ kind: 'error' as const, text: `Use /${MEMORY_COMMAND} ${MEMORY_HINT}. Changes require the exact preference scope and current version.` })
  try {
    if (verb === 'list') {
      const project = argument ? z.uuid().parse(argument) : null
      if (!allowed(project)) return reject()
      return { kind: 'success' as const, text: store.list(project).map(item => `${item.prefKey} (v${item.version}): ${item.text}`).join('\n') || 'No active preferences in this scope.' }
    }
    if (!['show', 'save', 'update', 'forget'].includes(verb)) return reject()
    const json: unknown = JSON.parse(argument)
    const { key, projectId } = z.object(keys).parse(json)
    const project = projectId ?? null
    if (!allowed(project)) return reject()
    const item = (() => {
      if (verb === 'show') { z.strictObject(keys).parse(json); return store.get(key, project) }
      if (verb === 'save') return store.save(key, z.strictObject({ ...keys, text }).parse(json).text, project)
      if (verb === 'forget') return store.forget(key, z.strictObject({ ...keys, version }).parse(json).version, project)
      const fields = z.strictObject({ ...keys, text, version }).parse(json)
      return store.update(key, fields.version, fields.text, project)
    })()
    return item ? { kind: 'success' as const, text: `${item.prefKey} (v${item.version}, ${item.state})${item.text ? `: ${item.text}` : ''}` }
      : { kind: 'error' as const, text: 'The preference does not exist or is no longer at that version.' }
  } catch { return reject() }
}
