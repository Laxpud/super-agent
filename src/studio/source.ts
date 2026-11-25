/** Exact markers for owner input and supplemental context written by the Studio Host. */
import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const newStudioSessionId = (): SessionId => SessionId(`agent-studio-${randomUUID()}`)

export const STUDIO_OWNER_PREFIX = 'agent-studio-owner:'
export const STUDIO_CONTEXT_PREFIX = 'agent-studio-context:'

export function studioOwnerMessageId(id: string): string { return `${STUDIO_OWNER_PREFIX}${id}` }
export function isStudioOwnerMessage(message: UserMessage): boolean {
  return message.source.kind === 'user' && message.id.startsWith(STUDIO_OWNER_PREFIX)
}
/** Supplemental Host context cannot serve as a source of user instructions or consent. */
export function isStudioMessageContext(message: UserMessage): boolean {
  return message.source.kind === 'dsh-superagent' && message.id.startsWith(STUDIO_CONTEXT_PREFIX)
}
