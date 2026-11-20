/** Owner-controlled Studio preferences. The Host verifies the persisted native source and its authorization before writing here. */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { types } from 'node:util'
import { appendCitation, citationRow } from './memory-citation-store.js'
import { PREFERENCE_PROPOSAL_INTENT_LIMIT, decidePreferenceProposal, insertPreferenceProposal, preferenceProposalById,
  preferenceProposalBySource, preferenceProposalReceiptId, type PreferenceProposal, type PreferenceProposalInput } from './preference-proposal-store.js'
import type { ManagedResult } from './store.js'
import { assistantSourceUsed } from './study-store.js'

export { PREFERENCE_PROPOSAL_INTENT_LIMIT, PREFERENCE_PROPOSAL_RECEIPT_PREFIX, preferenceProposalReceiptId,
  type PreferenceProposal, type PreferenceProposalInput } from './preference-proposal-store.js'

/** Exact coordinates of a persisted Assistant event. The opaque audit key identifies a command or a confirmed proposal. */
export interface MemorySource {
  sessionId: string
  commandId: string
  eventSeq: number
}

/** Metadata returned by mutations and owner history. Only an exact current read may return text. */
export interface StudioPreference {
  key: string
  revision: number
  state: 'active' | 'forgotten'
  operation: 'remember' | 'correct' | 'restrict' | 'forget'
  projectId?: string
  source: MemorySource
  at: string
}

/** Immutable reference to a preference revision, with its use context and the source of the citation itself. */
export interface PreferenceCitation {
  citationId: string
  key: string
  revision: number
  projectId?: string
  source: MemorySource
  at: string
}

export type MemoryChange = { kind: 'correct'; text: string } | { kind: 'restrict'; projectId: string } | { kind: 'forget' }

/** Maximum preference length in UTF-16 code units. */
export const MEMORY_TEXT_LIMIT = 2000
const PAGE_SIZE = 8

export function isMemoryKey(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

const credentialPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|(?:sk_(?:live|test)_|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/,
  /\bBearer\s+[A-Za-z0-9+/_.=-]{8,}|\bauthorization["']?\s*[:=]\s*["']?Basic\s+[A-Za-z0-9+/=]{8,}/i,
  /(?:^|[^A-Za-z0-9])(?:password|passwd|client[_ -]?secret|(?:api|private|secret)[_ -]?key|(?:access|auth|refresh)[_ -]?token)["']?\s*[:=]\s*["']?[^"'\s,;}{]+/i,
  /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:@/\s]+:[^@/\s]+@/i,
]

/** Reject malformed text and recognizable credential forms. This cannot detect arbitrary secrets; owners must not submit them. */
export function isPreferenceText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MEMORY_TEXT_LIMIT && value.isWellFormed()
    && !value.includes('\0') && value.trim().length > 0 && !credentialPatterns.some(pattern => pattern.test(value))
}

// Both projection write triggers require the newest journal row and its exact visibility metadata.
const HEAD_MATCHES_LATEST = `EXISTS (
  SELECT 1 FROM studio_memory_revision AS latest
  WHERE latest.key = NEW.key AND latest.revision = NEW.revision AND latest.state = NEW.state AND latest.project_id IS NEW.project_id
    AND NOT EXISTS (SELECT 1 FROM studio_memory_revision AS newer WHERE newer.key = latest.key AND newer.revision > latest.revision)
)`

// The journal owns text and provenance. The projection contains only the latest pointer and its indexed visibility.
// Explicit duplicate checks in BEFORE INSERT also cover OR REPLACE when recursive triggers are off.
export const MEMORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_memory_revision (
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64 AND instr(key, char(0)) = 0
      AND key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9-]*'),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    state TEXT NOT NULL CHECK (state IN ('active', 'forgotten')),
    operation TEXT NOT NULL CHECK (operation IN ('remember', 'correct', 'restrict', 'forget')),
    project_id TEXT REFERENCES studio_project (project_id),
    text TEXT,
    source_session_id TEXT NOT NULL REFERENCES studio_assistant_binding (session_id),
    command_id TEXT NOT NULL UNIQUE,
    source_event_seq INTEGER NOT NULL CHECK (source_event_seq BETWEEN 0 AND 9007199254740991),
    at TEXT NOT NULL,
    PRIMARY KEY (key, revision),
    UNIQUE (source_session_id, source_event_seq),
    CHECK ((revision = 1) = (operation = 'remember')),
    CHECK ((state = 'forgotten' AND operation = 'forget' AND text IS NULL)
      OR (state = 'active' AND operation <> 'forget' AND text IS NOT NULL
        AND length(text) BETWEEN 1 AND ${MEMORY_TEXT_LIMIT} AND instr(text, char(0)) = 0))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS studio_memory_head (
    key TEXT NOT NULL PRIMARY KEY,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    project_id TEXT REFERENCES studio_project (project_id),
    FOREIGN KEY (key, revision) REFERENCES studio_memory_revision (key, revision)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_memory_active_scope_key
    ON studio_memory_head (project_id, key) WHERE state = 'active';
  CREATE TRIGGER IF NOT EXISTS studio_memory_no_update BEFORE UPDATE ON studio_memory_revision BEGIN
    SELECT RAISE(ABORT, 'Studio memory journal is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_no_delete BEFORE DELETE ON studio_memory_revision BEGIN
    SELECT RAISE(ABORT, 'Studio memory journal is append-only');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_guard_insert BEFORE INSERT ON studio_memory_revision BEGIN
    SELECT RAISE(ABORT, 'Duplicate Studio memory revision or source')
      WHERE EXISTS (SELECT 1 FROM studio_memory_revision WHERE key = NEW.key AND revision = NEW.revision)
        OR EXISTS (SELECT 1 FROM studio_memory_revision WHERE command_id = NEW.command_id)
        OR EXISTS (SELECT 1 FROM studio_memory_revision
          WHERE source_session_id = NEW.source_session_id AND source_event_seq = NEW.source_event_seq);
    SELECT RAISE(ABORT, 'Invalid Studio memory transition')
      WHERE NEW.revision > 1 AND NOT EXISTS (
        SELECT 1 FROM studio_memory_revision AS previous
        WHERE previous.key = NEW.key AND previous.revision = NEW.revision - 1 AND previous.state = 'active'
          AND ((NEW.operation IN ('correct', 'forget') AND NEW.project_id IS previous.project_id)
            OR (NEW.operation = 'restrict' AND previous.project_id IS NULL AND NEW.project_id IS NOT NULL
              AND NEW.text = previous.text))
      );
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_head_guard_insert BEFORE INSERT ON studio_memory_head
    WHEN NOT ${HEAD_MATCHES_LATEST} BEGIN
    SELECT RAISE(ABORT, 'Studio memory head must match the latest revision');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_head_guard_update BEFORE UPDATE ON studio_memory_head
    WHEN NEW.key IS NOT OLD.key OR NOT ${HEAD_MATCHES_LATEST} BEGIN
    SELECT RAISE(ABORT, 'Studio memory head must match the latest revision');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_head_no_delete BEFORE DELETE ON studio_memory_head BEGIN
    SELECT RAISE(ABORT, 'Studio memory head cannot be deleted');
  END;
  CREATE TRIGGER IF NOT EXISTS studio_memory_project_head AFTER INSERT ON studio_memory_revision BEGIN
    INSERT INTO studio_memory_head (key, revision, state, project_id)
      VALUES (NEW.key, NEW.revision, NEW.state, NEW.project_id)
      ON CONFLICT (key) DO UPDATE SET revision = excluded.revision, state = excluded.state, project_id = excluded.project_id;
  END;
`

type Rejection = Extract<ManagedResult<never>, { ok: false }>
type Row = Record<string, SQLOutputValue>
const accept = <T>(value: T): ManagedResult<T> => ({ ok: true, value })
const deny = (reason: string): Rejection => ({ ok: false, reason })
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.isWellFormed() && !value.includes('\0')
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
const isEventSeq = (value: unknown): value is number => value === 0 || isRevision(value)
const isProjectId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)

/** Copy own data fields only, without coercion, inherited properties, accessors, or proxy traps. */
function plainData(value: unknown, maxFields: number): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || types.isProxy(value)) return
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return
  const keys = Reflect.ownKeys(value)
  if (keys.length > maxFields) return
  const data: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string') return
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) return
    data[key] = field.value
  }
  return data
}

function readSource(value: unknown): MemorySource | undefined {
  const fields = plainData(value, 3)
  if (!fields) return
  const { sessionId, commandId, eventSeq } = fields
  if (isId(sessionId) && isId(commandId) && isEventSeq(eventSeq)) return { sessionId, commandId, eventSeq }
}

function readChange(value: unknown): MemoryChange | undefined {
  const fields = plainData(value, 2)
  if (!fields) return
  const { kind, text, projectId } = fields
  if (kind === 'correct' && isPreferenceText(text)) return { kind, text }
  if (kind === 'restrict' && isProjectId(projectId)) return { kind, projectId }
  if (kind === 'forget' && Object.keys(fields).length === 1) return { kind }
}

/** Check the exact body against the complete Host-supplied intent without normalizing either string. */
function proposalInput(fields: Record<string, unknown>): PreferenceProposalInput | undefined {
  const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, toolCallId, key, intentText, text } = fields
  if (isId(assistantSessionId) && isId(sourceRequestId) && isId(sourceMessageId) && isEventSeq(sourceEventSeq)
    && isRevision(turn) && isId(toolCallId) && isMemoryKey(key) && isId(intentText) && intentText.length <= PREFERENCE_PROPOSAL_INTENT_LIMIT
    && isPreferenceText(text) && intentText.includes(text)) {
    return { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, turn, toolCallId, key, intentText, text }
  }
}

/** Decode persisted intent and provenance, keeping the run and binding metadata internal. */
function readProposal(row: Row): PreferenceProposal {
  const input = proposalInput(row)
  const { proposalId, assistantBotId, runId, state, proposedAt, decidedAt } = row
  if (!input || !isId(proposalId) || !isId(assistantBotId) || !isId(runId) || !isId(proposedAt)
    || (state !== 'pending' && state !== 'confirmed' && state !== 'closed')
    || (state === 'pending' ? decidedAt !== null : !isId(decidedAt))) throw new Error('Invalid Studio memory proposal')
  return { ...input, proposalId, state }
}

function sameProposalInput(input: PreferenceProposalInput, proposal: PreferenceProposal): boolean {
  return (Object.keys(input) as (keyof PreferenceProposalInput)[]).every(key => input[key] === proposal[key])
}

const METADATA = 'r.key, r.revision, r.state, r.operation, r.project_id, r.source_session_id, r.command_id, r.source_event_seq, r.at'
const HEAD = `FROM studio_memory_head h JOIN studio_memory_revision r ON r.key = h.key AND r.revision = h.revision`

/** Decode useful provenance without accidentally returning any SQL text column to a metadata caller. */
function metadata(row: Row): StudioPreference {
  const { key, revision, state, operation, project_id: projectId, source_session_id: sessionId, command_id: commandId,
    source_event_seq: eventSeq, at } = row
  if (!isMemoryKey(key) || !isRevision(revision) || (state !== 'active' && state !== 'forgotten')
    || (operation !== 'remember' && operation !== 'correct' && operation !== 'restrict' && operation !== 'forget')
    || (state === 'forgotten') !== (operation === 'forget') || (revision === 1) !== (operation === 'remember')
    || (projectId !== null && !isProjectId(projectId)) || !isId(sessionId) || !isId(commandId) || !isEventSeq(eventSeq) || !isId(at)) {
    throw new Error('Invalid Studio memory revision')
  }
  return { key, revision, state, operation, ...(projectId === null ? {} : { projectId }), source: { sessionId, commandId, eventSeq }, at }
}

/** Decode citation coordinates without looking up the original preference or its text. */
function citationMetadata(row: Row): PreferenceCitation {
  const { citation_id: citationId, key, revision, project_id: projectId, source_session_id: sessionId, command_id: commandId,
    source_event_seq: eventSeq, at } = row
  if (!isId(citationId) || !isMemoryKey(key) || !isRevision(revision) || (projectId !== null && !isProjectId(projectId))
    || !isId(sessionId) || !isId(commandId) || !isEventSeq(eventSeq) || !isId(at)) {
    throw new Error('Invalid Studio memory citation')
  }
  return { citationId, key, revision, ...(projectId === null ? {} : { projectId }), source: { sessionId, commandId, eventSeq }, at }
}

interface MemoryStoreAccess {
  db(): DatabaseSync
  write<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  snapshot<T>(operation: () => ManagedResult<T>): ManagedResult<T>
  assistantBinding(sessionId: string): string | undefined
  ordinaryAssistantBinding(sessionId: string): string | undefined
  runId: string
}

/** Internal preference facet. Host call sites must enforce owner authorization, including for metadata-only trace. */
export class MemoryStore {
  constructor(private readonly access: MemoryStoreAccess) {}

  /** Reserve one exact current owner source. Only `created: true` may open a new confirmation question. */
  propose(input: PreferenceProposalInput): ManagedResult<{ proposal: PreferenceProposal; created: boolean }> {
    const fields = plainData(input, 9)
    if (!fields || !isId(fields.assistantSessionId)) return deny('INVALID_INPUT')
    const { assistantSessionId, sourceRequestId, sourceMessageId, sourceEventSeq, toolCallId } = fields
    const exact = proposalInput(fields)
    return this.access.write<{ proposal: PreferenceProposal; created: boolean }>(() => {
      const assistantBotId = this.access.ordinaryAssistantBinding(assistantSessionId)
      if (!assistantBotId) return deny('SESSION_NOT_BOUND')
      const db = this.access.db()
      // Any one matching source coordinate is consumed. Return the earlier receipt only if every input field agrees.
      const previous = preferenceProposalBySource(db, assistantSessionId, isId(sourceRequestId) ? sourceRequestId : null,
        isId(sourceMessageId) ? sourceMessageId : null, isEventSeq(sourceEventSeq) ? sourceEventSeq : null,
        isId(toolCallId) ? toolCallId : null)
      if (previous) {
        const proposal = readProposal(previous)
        return exact && previous.assistantBotId === assistantBotId && sameProposalInput(exact, proposal)
          ? accept({ proposal, created: false }) : deny('SOURCE_ALREADY_USED')
      }
      if (!exact) return deny('INVALID_INPUT')
      if (this.proposalSourceUsed(exact)) return deny('SOURCE_ALREADY_USED')
      if (this.head(exact.key)) return deny('MEMORY_KEY_EXISTS')
      const proposalId = randomUUID()
      const at = new Date().toISOString()
      insertPreferenceProposal(db, exact, proposalId, assistantBotId, this.access.runId, at)
      const row = preferenceProposalById(db, assistantSessionId, proposalId)
      if (!row || row.assistantBotId !== assistantBotId || row.runId !== this.access.runId || row.proposedAt !== at) {
        throw new Error('Studio memory proposal insert was not retained')
      }
      const proposal = readProposal(row)
      if (proposal.state !== 'pending' || !sameProposalInput(exact, proposal)) {
        throw new Error('Studio memory proposal insert did not retain exact input')
      }
      return accept({ proposal, created: true })
    })
  }

  /** Host-only: call after direct native owner consent for this exact proposal ID. Never expose this as a model tool. */
  confirmProposal(assistantSessionId: string, proposalId: string): ManagedResult<StudioPreference> {
    if (!isId(assistantSessionId) || !isId(proposalId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const assistantBotId = this.access.ordinaryAssistantBinding(assistantSessionId)
      if (!assistantBotId) return deny('SESSION_NOT_BOUND')
      const db = this.access.db()
      const row = preferenceProposalById(db, assistantSessionId, proposalId)
      if (!row || row.assistantBotId !== assistantBotId) return deny('PROPOSAL_NOT_FOUND')
      const proposal = readProposal(row)
      if (proposal.state === 'closed') return deny('PROPOSAL_CLOSED')
      if (proposal.state === 'confirmed') return deny('PROPOSAL_ALREADY_CONFIRMED')
      if (row.runId !== this.access.runId) return deny('STALE_HOST_RUN')
      // Recheck the key and source in the same fenced transaction as both writes; another route may have acted meanwhile.
      if (this.head(proposal.key)) return deny('MEMORY_KEY_EXISTS')
      if (this.proposalSourceUsed(proposal)) return deny('SOURCE_ALREADY_USED')
      const source = { sessionId: assistantSessionId, commandId: preferenceProposalReceiptId(proposalId), eventSeq: proposal.sourceEventSeq }
      if (this.commandUsed(source.commandId)) return deny('DUPLICATE_COMMAND')
      const preference = this.append(proposal.key, 1, 'remember', undefined, proposal.text, source)
      decidePreferenceProposal(db, assistantSessionId, proposalId, this.access.runId, 'confirmed')
      return accept(preference)
    })
  }

  /** Record a refusal or an abandoned question. A repeated close returns metadata without any content write. */
  closeProposal(assistantSessionId: string, proposalId: string): ManagedResult<{ proposalId: string; state: 'closed' }> {
    if (!isId(assistantSessionId) || !isId(proposalId)) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const assistantBotId = this.access.ordinaryAssistantBinding(assistantSessionId)
      if (!assistantBotId) return deny('SESSION_NOT_BOUND')
      const db = this.access.db()
      const row = preferenceProposalById(db, assistantSessionId, proposalId)
      if (!row || row.assistantBotId !== assistantBotId) return deny('PROPOSAL_NOT_FOUND')
      const proposal = readProposal(row)
      if (proposal.state === 'confirmed') return deny('PROPOSAL_ALREADY_CONFIRMED')
      if (proposal.state === 'pending') {
        if (row.runId !== this.access.runId) return deny('STALE_HOST_RUN')
        decidePreferenceProposal(db, assistantSessionId, proposalId, this.access.runId, 'closed')
      }
      return accept({ proposalId, state: 'closed' })
    })
  }

  /** Create a never-before-used key, optionally scoped to one exact Studio project. */
  remember(key: string, text: string, projectId: string | undefined, source: MemorySource): ManagedResult<StudioPreference> {
    const exact = readSource(source)
    if (!isMemoryKey(key) || !isPreferenceText(text) || (projectId !== undefined && !isProjectId(projectId)) || !exact) {
      return deny('INVALID_INPUT')
    }
    return this.access.write(() => {
      const rejected = this.checkSource(exact)
      if (rejected) return rejected
      if (projectId !== undefined && !this.projectExists(projectId)) return deny('PROJECT_NOT_FOUND')
      if (this.head(key)) return deny('MEMORY_KEY_EXISTS')
      return accept(this.append(key, 1, 'remember', projectId, text, exact))
    })
  }

  /** Append to the exact current active revision. A forgotten key cannot move or receive another revision. */
  change(key: string, expectedRevision: number, change: MemoryChange, source: MemorySource): ManagedResult<StudioPreference> {
    const exact = readSource(source)
    const action = readChange(change)
    if (!isMemoryKey(key) || !isRevision(expectedRevision) || !action || !exact) return deny('INVALID_INPUT')
    return this.access.write(() => {
      const rejected = this.checkSource(exact)
      if (rejected) return rejected
      const row = this.head(key)
      if (!row) return deny('MEMORY_NOT_CURRENT')
      const current = metadata(row)
      if (current.state !== 'active') return deny('MEMORY_NOT_CURRENT')
      if (current.revision !== expectedRevision) return deny('STALE_MEMORY_REVISION')
      const revision = current.revision + 1
      if (!isRevision(revision)) return deny('MEMORY_REVISION_LIMIT')
      if (action.kind === 'correct') return accept(this.append(key, revision, action.kind, current.projectId, action.text, exact))
      if (action.kind === 'forget') return accept(this.append(key, revision, action.kind, current.projectId, null, exact))

      // Restriction only narrows visibility. Preserve the previous revision's exact text without reinterpreting it as a correction.
      if (current.projectId !== undefined) return deny('MEMORY_SCOPE_CONFLICT')
      if (!this.projectExists(action.projectId)) return deny('PROJECT_NOT_FOUND')
      const text = this.access.db().prepare('SELECT text FROM studio_memory_revision WHERE key = ? AND revision = ?')
        .get(key, current.revision)?.text
      if (!isPreferenceText(text)) throw new Error('Invalid Studio memory text')
      return accept(this.append(key, revision, action.kind, action.projectId, text, exact))
    })
  }

  /** Return at most eight current metadata records, in binary key order, after an exclusive key cursor. */
  list(projectId?: string, after?: string): ManagedResult<{ items: StudioPreference[]; next?: string }> {
    if ((projectId !== undefined && !isProjectId(projectId)) || (after !== undefined && !isMemoryKey(after))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      if (projectId !== undefined && !this.projectExists(projectId)) return deny('PROJECT_NOT_FOUND')
      // Read at most one page plus lookahead per indexed scope. Revisions outside these two small slices are never loaded.
      const query = this.access.db().prepare(`SELECT ${METADATA} ${HEAD}
        WHERE h.state = 'active' AND h.project_id IS ? AND h.key > ? ORDER BY h.key LIMIT ?`)
      const items = query.all(null, after ?? '', PAGE_SIZE + 1).map(metadata)
      if (projectId !== undefined) {
        items.push(...query.all(projectId, after ?? '', PAGE_SIZE + 1).map(metadata))
        items.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      }
      return accept(items.length > PAGE_SIZE ? { items: items.slice(0, PAGE_SIZE), next: items[PAGE_SIZE - 1]!.key } : { items })
    })
  }

  /** Read exactly one active key in its visible context; an unavailable key never reveals its scope or history. */
  read(key: string, projectId?: string): ManagedResult<StudioPreference & { text: string }> {
    if (!isMemoryKey(key) || (projectId !== undefined && !isProjectId(projectId))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const current = this.current(key, projectId)
      return current ? accept(this.currentText(current)) : deny('MEMORY_NOT_CURRENT')
    })
  }

  /** Record a visible current revision for an exact use context, without reading or copying its text. */
  cite(key: string, revision: number, projectId: string | undefined, source: MemorySource): ManagedResult<PreferenceCitation> {
    const exact = readSource(source)
    if (!isMemoryKey(key) || !isRevision(revision) || (projectId !== undefined && !isProjectId(projectId)) || !exact) {
      return deny('INVALID_INPUT')
    }
    return this.access.write(() => {
      const rejected = this.checkSource(exact)
      if (rejected) return rejected
      const current = this.current(key, projectId)
      if (!current) return deny('MEMORY_NOT_CURRENT')
      if (current.revision !== revision) return deny('STALE_MEMORY_REVISION')
      const citation: PreferenceCitation = { citationId: randomUUID(), key, revision,
        ...(projectId === undefined ? {} : { projectId }), source: exact, at: new Date().toISOString() }
      appendCitation(this.access.db(), citation)
      return accept(citation)
    })
  }

  /** Resolve only in the recorded use context and only while the exact original revision remains current and visible. */
  resolveCitation(citationId: string, projectId?: string): ManagedResult<{
    citation: PreferenceCitation; preference: StudioPreference & { text: string }
  }> {
    if (!isId(citationId) || (projectId !== undefined && !isProjectId(projectId))) return deny('CITATION_NOT_CURRENT')
    return this.access.snapshot(() => {
      // Match the use scope first; never look up a different project on behalf of the caller.
      const row = citationRow(this.access.db(), citationId, projectId ?? null)
      if (!row) return deny('CITATION_NOT_CURRENT')
      const citation = citationMetadata(row)
      const current = this.current(citation.key, projectId)
      if (!current || current.revision !== citation.revision) return deny('CITATION_NOT_CURRENT')
      // Only the matched current revision can reach the text query in this snapshot.
      return accept({ citation, preference: this.currentText(current) })
    })
  }

  /** Read immutable citation metadata even after the original revision is no longer current. */
  traceCitation(citationId: string): ManagedResult<PreferenceCitation> {
    if (!isId(citationId)) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const row = citationRow(this.access.db(), citationId)
      return row ? accept(citationMetadata(row)) : deny('CITATION_NOT_CURRENT')
    })
  }

  /** Owner-only history lookup by exact revision (or latest, including tombstones). Never select historical text. */
  trace(key: string, revision?: number): ManagedResult<StudioPreference> {
    if (!isMemoryKey(key) || (revision !== undefined && !isRevision(revision))) return deny('INVALID_INPUT')
    return this.access.snapshot(() => {
      const row = revision === undefined ? this.head(key) : this.access.db()
        .prepare(`SELECT ${METADATA} FROM studio_memory_revision r WHERE r.key = ? AND r.revision = ?`).get(key, revision)
      return row ? accept(metadata(row)) : deny('MEMORY_NOT_CURRENT')
    })
  }

  /** Raw duplicate lookup for callers already inside the parent Store's fenced transaction. */
  commandUsed(commandId: string): boolean {
    if (!isId(commandId)) throw new Error('Invalid Studio memory command ID')
    return !!this.access.db().prepare(`SELECT 1 FROM studio_memory_revision WHERE command_id = ?
      UNION ALL SELECT 1 FROM studio_memory_citation WHERE command_id = ? LIMIT 1`).get(commandId, commandId)
  }

  /** Find visible current metadata inside the caller's transaction; a missing project never falls back to global. */
  private current(key: string, projectId: string | undefined): StudioPreference | undefined {
    if (projectId !== undefined && !this.projectExists(projectId)) return
    const row = this.access.db().prepare(`SELECT ${METADATA} ${HEAD}
      WHERE h.key = ? AND h.state = 'active' AND r.state = h.state AND r.project_id IS h.project_id
        AND (h.project_id IS NULL OR h.project_id = ?)`).get(key, projectId ?? null)
    if (row) return metadata(row)
  }

  /** Read text only after verifying the exact current revision in the same transaction. */
  private currentText(current: StudioPreference): StudioPreference & { text: string } {
    const text = this.access.db().prepare('SELECT text FROM studio_memory_revision WHERE key = ? AND revision = ?')
      .get(current.key, current.revision)?.text
    if (!isPreferenceText(text)) throw new Error('Invalid Studio memory text')
    return { ...current, text }
  }

  private head(key: string): Row | undefined {
    return this.access.db().prepare(`SELECT ${METADATA} ${HEAD} WHERE h.key = ?`).get(key)
  }

  private projectExists(projectId: string): boolean {
    return !!this.access.db().prepare('SELECT 1 FROM studio_project WHERE project_id = ?').get(projectId)
  }

  private checkSource(source: MemorySource): Rejection | undefined {
    if (!this.access.assistantBinding(source.sessionId)) return deny('SESSION_NOT_BOUND')
    if (this.commandUsed(source.commandId)) return deny('DUPLICATE_COMMAND')
    if (this.sourceEventUsed(source.sessionId, source.eventSeq)) return deny('SOURCE_ALREADY_USED')
  }

  private sourceEventUsed(sessionId: string, eventSeq: number): boolean {
    return !!this.access.db().prepare(`SELECT 1 FROM studio_memory_revision WHERE source_session_id = ? AND source_event_seq = ?
      UNION ALL SELECT 1 FROM studio_memory_citation WHERE source_session_id = ? AND source_event_seq = ? LIMIT 1`)
      .get(sessionId, eventSeq, sessionId, eventSeq)
  }

  /** A source consumed by an existing Assistant route or memory operation cannot materialize a proposal. */
  private proposalSourceUsed(input: PreferenceProposalInput): boolean {
    return this.sourceEventUsed(input.assistantSessionId, input.sourceEventSeq) || assistantSourceUsed(this.access.db(), input)
  }

  /** Check both the journal row and its projected head before the parent transaction can commit. */
  private append(key: string, revision: number, operation: StudioPreference['operation'], projectId: string | undefined,
    text: string | null, source: MemorySource): StudioPreference {
    const db = this.access.db()
    const state = operation === 'forget' ? 'forgotten' : 'active'
    const at = new Date().toISOString()
    const { changes } = db.prepare(`INSERT INTO studio_memory_revision
      (key, revision, state, operation, project_id, text, source_session_id, command_id, source_event_seq, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, revision, state, operation, projectId ?? null, text, source.sessionId, source.commandId, source.eventSeq, at)
    if (changes !== 1 && changes !== 1n) throw new Error('Studio memory append did not affect exactly one row')
    const row = db.prepare(`SELECT ${METADATA}, r.text ${HEAD}
      WHERE h.key = ? AND h.revision = ? AND h.state = r.state AND h.project_id IS r.project_id`).get(key, revision)
    if (!row || row.text !== text) throw new Error('Studio memory append was not retained')
    const stored = metadata(row)
    if (stored.state !== state || stored.operation !== operation || stored.projectId !== projectId || stored.at !== at
      || stored.source.sessionId !== source.sessionId || stored.source.commandId !== source.commandId || stored.source.eventSeq !== source.eventSeq) {
      throw new Error('Studio memory append did not retain exact metadata')
    }
    return stored
  }
}
