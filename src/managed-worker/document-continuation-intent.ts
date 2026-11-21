/** A request to continue existing document work, not to clear a pause or grant approval. */
export interface DocumentContinuationIntent {
  taskId?: string
}

const chinese = /^[ \t]*(?:请[ \t]*)?继续(?:那个任务|文档任务[ \t]+([0-9a-f-]{36}))[.。!！]?[ \t]*$/u
const english = /^[ \t]*(?:please[ \t]+)?continue[ \t]+(?:that[ \t]+task|document[ \t]+task[ \t]+([0-9a-f-]{36}))[.!]?[ \t]*$/i
const taskUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Match one standalone request; leave all other text available to the existing correction route. */
export function documentContinuationIntent(text: string): DocumentContinuationIntent | undefined {
  const match = chinese.exec(text) ?? english.exec(text)
  if (!match) return undefined
  const taskId = match[1]
  if (taskId === undefined) return {}
  // Validate the original token without normalizing its case; the caller resolves it against stored tasks.
  return taskUuid.test(taskId) ? { taskId } : undefined
}
