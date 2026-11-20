/** Answer one native owner preference query before any model request, without joining the model surface. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { memoryQuery } from './memory.ts'
import { publishOwnerInboxReceipt, type OwnerInboxInput } from './owner-inbox-input.ts'
import { preferenceQueryIntent } from './preference-query-intent.ts'
import type { ManagedWorkerStore } from './store.ts'

/** The supplied input has already been matched to the exact live owner's original queue insertion. */
export function answerPreferenceQuery(store: ManagedWorkerStore, agent: Agent, input: OwnerInboxInput): boolean {
  const query = preferenceQueryIntent(input.text)
  if (!query) return false
  // Resolve and publish synchronously so the queried revision cannot change in an await gap.
  publishOwnerInboxReceipt(agent, input, 'studio-memory-query', memoryQuery(store, query))
  return true
}
