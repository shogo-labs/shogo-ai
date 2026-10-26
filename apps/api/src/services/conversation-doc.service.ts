// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Channel docs: one shared markdown document per channel, shown as a tab
 * beside the timeline (Slack's channel canvas; unrelated to project canvases).
 *
 * Writers send the `version` they edited (`baseVersion`, 0 to create). A stale
 * version is rejected with a 409 carrying the current doc so the client can
 * resolve the conflict. Every save bumps the version, records a revision
 * (coalescing rapid saves by the same author), and publishes `doc.updated`.
 */

import { prisma } from '../lib/prisma'
import {
  ConversationError,
  agentDisplayName,
  canManage,
  canPost,
  conversationAudience,
  loadAccess,
  postMessage,
  type ConversationAccess,
} from './conversation.service'
import { publishConversationEvent } from '../lib/conversation-bus'

const db = prisma as any

export const MAX_DOC_CHARS = 200_000
export const MAX_DOC_TITLE_CHARS = 200
export const MAX_DOC_REVISIONS = 50
/** Percentage of `MAX_DOC_CHARS` where a doc starts warning, then failing loudly. */
export const DOC_WARN_PCT = 70
export const DOC_CRITICAL_PCT = 85
/**
 * A single *new* section bigger than this is a card narrative, not a durable
 * rule: the channel doc is injected into every agent's prompt, so the card
 * thread is the cheaper home. `force` overrides.
 */
export const MAX_APPENDED_SECTION_CHARS = 4_000
/** Saves by the same author within this window update the latest revision instead of adding one. */
export const REVISION_COALESCE_MS = 2 * 60_000
/** At most one "updated the doc" notice per channel in this window. */
export const DOC_NOTICE_INTERVAL_MS = 60 * 60_000

const DOC_KINDS = new Set(['public', 'private'])

export type DocActor =
  | { type: 'user'; userId: string }
  | { type: 'agent'; projectId: string | null }

export interface SaveDocInput {
  title?: string
  content: string
  baseVersion: number
}

// ─── Budget ──────────────────────────────────────────────────────────────────

export type DocBudgetLevel = 'ok' | 'warn' | 'critical'

export interface DocBudget {
  chars: number
  limit: number
  /** Percent used, one decimal. */
  pct: number
  level: DocBudgetLevel
}

export function docBudget(chars: number, limit: number = MAX_DOC_CHARS): DocBudget {
  const pct = limit > 0 ? Math.round((chars / limit) * 1000) / 10 : 0
  const level: DocBudgetLevel = chars >= (limit * DOC_CRITICAL_PCT) / 100
    ? 'critical'
    : chars >= (limit * DOC_WARN_PCT) / 100
      ? 'warn'
      : 'ok'
  return { chars, limit, pct, level }
}

const number = (n: number) => n.toLocaleString('en-US')

/** The refusal for a write that does not fit, carrying the way out instead of a bare 400. */
function docFullError(chars: number): ConversationError {
  const budget = docBudget(chars)
  return new ConversationError(
    400,
    'doc_full',
    `This doc holds ${number(budget.limit)} characters and this write would make it ${number(chars)} ` +
      `(${number(chars - budget.limit)} over). Archive a section with mode "archive_section", patch a smaller ` +
      'section, or keep per-card notes in the card thread with work_item_comment.',
    { chars, limit: budget.limit, over_by: chars - budget.limit, budget, next: ['archive_section', 'patch_section', 'work_item_comment'] },
  )
}

// ─── Serialization ───────────────────────────────────────────────────────────

async function actorInfo(workspaceId: string, row: any) {
  if (row.updatedByType === 'agent') {
    return {
      type: 'agent' as const,
      id: row.updatedByProjectId ?? null,
      name: await agentDisplayName(workspaceId, row.updatedByProjectId ?? null),
    }
  }
  if (!row.updatedByUserId) return null
  const user = await db.user.findUnique({
    where: { id: row.updatedByUserId },
    select: { id: true, name: true, email: true },
  })
  return { type: 'user' as const, id: row.updatedByUserId, name: user?.name || user?.email || 'Someone' }
}

export async function serializeDoc(row: any) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title,
    content: row.content,
    version: row.version,
    locked: !!row.locked,
    budget: docBudget((row.content ?? '').length),
    updatedBy: await actorInfo(row.workspaceId, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export type SerializedDoc = Awaited<ReturnType<typeof serializeDoc>>

// ─── Access ──────────────────────────────────────────────────────────────────

export function supportsDoc(kind: string): boolean {
  return DOC_KINDS.has(kind)
}

function assertDocKind(conversation: { kind: string }) {
  if (!supportsDoc(conversation.kind)) {
    throw new ConversationError(400, 'unsupported', 'Docs are only available in channels')
  }
}

export function canEditDoc(access: ConversationAccess, doc: { locked: boolean } | null): boolean {
  if (!canPost(access)) return false
  return !doc?.locked || canManage(access)
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getDoc(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const row = await db.conversationDoc.findUnique({ where: { conversationId } })
  return {
    doc: row ? await serializeDoc(row) : null,
    canEdit: canEditDoc(access, row),
    canManage: canManage(access),
  }
}

/**
 * Doc for an agent; null when the channel has none. `conversation` must
 * already be resolved as visible to the agent (`resolveAgentConversation`).
 */
export async function getDocForAgent(conversation: any) {
  assertDocKind(conversation)
  const row = await db.conversationDoc.findUnique({ where: { conversationId: conversation.id } })
  return row ? serializeDoc(row) : null
}

/** Doc text for prompt context, without access checks (callers already run inside the channel). */
export async function docContextFor(conversationId: string): Promise<{ title: string; content: string; version: number; budget: DocBudget } | null> {
  const row = await db.conversationDoc.findUnique({
    where: { conversationId },
    select: { title: true, content: true, version: true },
  })
  if (!row || !row.content.trim()) return null
  return { ...row, budget: docBudget(row.content.length) }
}

// ─── Archives ────────────────────────────────────────────────────────────────

export interface SerializedArchive {
  id: string
  conversationId: string
  title: string
  heading: string
  chars: number
  archivedBy: Awaited<ReturnType<typeof actorInfo>>
  createdAt: Date
  /** Only on a single-archive read: the body that was taken out of the doc. */
  content?: string
}

async function serializeArchive(row: any, withContent = false): Promise<SerializedArchive> {
  const archive: SerializedArchive = {
    id: row.id,
    conversationId: row.conversationId,
    title: row.title,
    heading: row.heading,
    chars: row.chars,
    archivedBy: await actorInfo(row.workspaceId, {
      updatedByType: row.archivedByType,
      updatedByUserId: row.archivedByUserId,
      updatedByProjectId: row.archivedByProjectId,
    }),
    createdAt: row.createdAt,
  }
  if (withContent) archive.content = row.content
  return archive
}

async function archiveRows(conversationId: string, take = 100) {
  return db.conversationDocArchive.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take,
  })
}

/** Archived sections of a channel's doc, newest first, without their bodies. */
export async function listArchives(conversationId: string, userId: string): Promise<SerializedArchive[]> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  return Promise.all((await archiveRows(conversationId)).map((row: any) => serializeArchive(row)))
}

export async function getArchive(conversationId: string, userId: string, archiveId: string): Promise<SerializedArchive> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  return readArchiveRow(conversationId, archiveId)
}

async function readArchiveRow(conversationId: string, archiveId: string): Promise<SerializedArchive> {
  const row = await db.conversationDocArchive.findUnique({ where: { id: archiveId } })
  if (!row || row.conversationId !== conversationId) {
    throw new ConversationError(404, 'not_found', 'Archived section not found')
  }
  return serializeArchive(row, true)
}

/** Archived sections of a channel's doc for an agent (access already resolved). */
export async function listArchivesForAgent(conversation: any): Promise<SerializedArchive[]> {
  assertDocKind(conversation)
  return Promise.all((await archiveRows(conversation.id)).map((row: any) => serializeArchive(row)))
}

export async function getArchiveForAgent(conversation: any, archiveId: string): Promise<SerializedArchive> {
  assertDocKind(conversation)
  return readArchiveRow(conversation.id, archiveId)
}

export async function listRevisions(conversationId: string, userId: string) {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const doc = await db.conversationDoc.findUnique({ where: { conversationId }, select: { id: true } })
  if (!doc) return []
  const rows = await db.conversationDocRevision.findMany({
    where: { docId: doc.id },
    orderBy: { createdAt: 'desc' },
    take: MAX_DOC_REVISIONS,
  })
  const workspaceId = access.conversation.workspaceId
  return Promise.all(rows.map(async (r: any) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    content: r.content,
    updatedBy: await actorInfo(workspaceId, r),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  })))
}

// ─── Writes ──────────────────────────────────────────────────────────────────

function normalizeInput(input: SaveDocInput) {
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.length > MAX_DOC_CHARS) throw docFullError(content.length)
  const title = (typeof input.title === 'string' ? input.title : '').trim().slice(0, MAX_DOC_TITLE_CHARS)
  const baseVersion = Number.isInteger(input.baseVersion) ? input.baseVersion : -1
  if (baseVersion < 0) throw new ConversationError(400, 'invalid_version', 'baseVersion is required')
  return { content, title, baseVersion }
}

function actorFields(actor: DocActor) {
  return actor.type === 'agent'
    ? { updatedByType: 'agent', updatedByUserId: null, updatedByProjectId: actor.projectId }
    : { updatedByType: 'user', updatedByUserId: actor.userId, updatedByProjectId: null }
}

async function conflict(conversationId: string): Promise<never> {
  const current = await db.conversationDoc.findUnique({ where: { conversationId } })
  throw new ConversationError(409, 'doc_conflict', 'This doc was changed by someone else', {
    doc: current ? await serializeDoc(current) : null,
  })
}

async function recordRevision(doc: any) {
  const author = {
    updatedByType: doc.updatedByType,
    updatedByUserId: doc.updatedByUserId,
    updatedByProjectId: doc.updatedByProjectId,
  }
  const latest = await db.conversationDocRevision.findFirst({
    where: { docId: doc.id },
    orderBy: { createdAt: 'desc' },
  })
  const sameAuthor = latest
    && latest.updatedByType === author.updatedByType
    && latest.updatedByUserId === author.updatedByUserId
    && latest.updatedByProjectId === author.updatedByProjectId
  if (sameAuthor && Date.now() - new Date(latest.updatedAt).getTime() < REVISION_COALESCE_MS) {
    await db.conversationDocRevision.update({
      where: { id: latest.id },
      data: { version: doc.version, title: doc.title, content: doc.content },
    })
    return
  }
  await db.conversationDocRevision.create({
    data: { docId: doc.id, version: doc.version, title: doc.title, content: doc.content, ...author },
  })
  const stale = await db.conversationDocRevision.findMany({
    where: { docId: doc.id },
    orderBy: { createdAt: 'desc' },
    skip: MAX_DOC_REVISIONS,
    select: { id: true },
  })
  if (stale.length) {
    await db.conversationDocRevision.deleteMany({ where: { id: { in: stale.map((s: any) => s.id) } } })
  }
}

const lastNoticeAt = new Map<string, number>()

async function postDocNotice(conversation: any, doc: SerializedDoc, created: boolean) {
  const now = Date.now()
  const last = lastNoticeAt.get(conversation.id) ?? 0
  if (!created && now - last < DOC_NOTICE_INTERVAL_MS) return
  lastNoticeAt.set(conversation.id, now)
  const who = doc.updatedBy?.name ?? 'Someone'
  const label = doc.title ? `the channel doc "${doc.title}"` : 'the channel doc'
  await postMessage({
    conversationId: conversation.id,
    authorType: 'system',
    text: `${who} ${created ? 'created' : 'updated'} ${label}`,
    blocks: { kind: 'doc_notice', version: doc.version },
  }).catch((err) => console.error('[ConversationDoc] notice failed:', (err as Error).message))
}

async function publishDocUpdated(conversation: any, doc: SerializedDoc) {
  const audience = await conversationAudience(conversation)
  publishConversationEvent(conversation.workspaceId, {
    type: 'doc.updated',
    conversationId: conversation.id,
    version: doc.version,
    title: doc.title,
    locked: doc.locked,
    updatedBy: doc.updatedBy,
  }, audience)
}

async function writeDoc(conversation: any, actor: DocActor, input: SaveDocInput): Promise<SerializedDoc> {
  const { content, title, baseVersion } = normalizeInput(input)
  const author = actorFields(actor)
  let row: any
  let created = false

  if (baseVersion === 0) {
    const existing = await db.conversationDoc.findUnique({ where: { conversationId: conversation.id }, select: { id: true } })
    if (existing) await conflict(conversation.id)
    try {
      row = await db.conversationDoc.create({
        data: { conversationId: conversation.id, workspaceId: conversation.workspaceId, title, content, ...author },
      })
      created = true
    } catch (err: any) {
      if (err?.code === 'P2002') await conflict(conversation.id)
      throw err
    }
  } else {
    const { count } = await db.conversationDoc.updateMany({
      where: { conversationId: conversation.id, version: baseVersion },
      data: { title, content, version: { increment: 1 }, ...author },
    })
    if (!count) await conflict(conversation.id)
    row = await db.conversationDoc.findUnique({ where: { conversationId: conversation.id } })
  }

  await recordRevision(row)
  const doc = await serializeDoc(row)
  await publishDocUpdated(conversation, doc)
  await postDocNotice(conversation, doc, created)
  return doc
}

export async function saveDoc(conversationId: string, userId: string, input: SaveDocInput): Promise<SerializedDoc> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const existing = await db.conversationDoc.findUnique({ where: { conversationId }, select: { locked: true } })
  if (!canEditDoc(access, existing)) {
    throw new ConversationError(403, 'forbidden', existing?.locked
      ? 'This doc is locked; only channel managers can edit it'
      : 'You cannot edit this doc')
  }
  return writeDoc(access.conversation, { type: 'user', userId }, input)
}

export type AgentDocMode = 'replace' | 'append' | 'patch_section' | 'archive_section'

export interface AgentDocUpdate {
  mode: AgentDocMode
  content: string
  title?: string
  /** Heading text (without #) of the section for `patch_section` / `archive_section`. */
  section?: string
  /** Required for `replace`; optional otherwise (append/patch apply to the latest version). */
  baseVersion?: number
  /** Add a card-narrative or oversized section to the doc anyway. */
  force?: boolean
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/

function headingText(line: string): string | null {
  const m = line.match(HEADING_RE)
  return m ? m[2].trim() : null
}

/** Line indexes of every heading whose text matches `section` (case-insensitive). */
export function findSectionHeadings(markdown: string, section: string): number[] {
  const wanted = section.trim().replace(/^#+\s*/, '').toLowerCase()
  if (!wanted) return []
  const hits: number[] = []
  markdown.split('\n').forEach((line, i) => {
    const text = headingText(line)
    if (text !== null && text.toLowerCase() === wanted) hits.push(i)
  })
  return hits
}

export interface DocSection {
  heading: string
  level: number
  /** Line index of the heading line. */
  start: number
  /** Line index just past the section: its next same-or-higher heading, or the end of the doc. */
  end: number
  /** Body without the heading line. */
  body: string
  /** Heading line plus body, as it sits in the doc. */
  text: string
  chars: number
}

/** The section under `section` with its exact extent, or null when no heading matches. */
export function extractSection(markdown: string, section: string): DocSection | null {
  const [start] = findSectionHeadings(markdown, section)
  if (start === undefined) return null
  const lines = markdown.split('\n')
  const level = lines[start].match(/^#+/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/)
    if (m && m[1].length <= level) { end = i; break }
  }
  const text = lines.slice(start, end).join('\n').replace(/\s+$/, '')
  const body = text.split('\n').slice(1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  return { heading: headingText(lines[start])!, level, start, end, body, text, chars: text.length }
}

/** Swap a section for one pointer line, leaving every other section untouched. */
function sectionForPointer(markdown: string, section: DocSection, pointer: string): string {
  const lines = markdown.split('\n')
  const head = lines.slice(0, section.start)
  while (head.length && !head[head.length - 1].trim()) head.pop()
  const tail = lines.slice(section.end)
  while (tail.length && !tail[0].trim()) tail.shift()
  const out = [...head]
  if (out.length) out.push('')
  out.push(pointer)
  if (tail.length) out.push('', ...tail)
  return `${out.join('\n').replace(/\s+$/, '')}\n`
}

/** Put a section back at the end of the doc (it kept its body verbatim in the archive). */
function appendSection(markdown: string, heading: string, body: string): string {
  const trimmed = markdown.replace(/\s+$/, '')
  const section = `## ${heading}\n\n${body.trim()}\n`
  return trimmed ? `${trimmed}\n\n${section}` : section
}

const CARD_KEY_RE = /SHO-\d+/i
const CARD_STORY_RE = /\b(qa gate|round\s+\d+|shipped)\b/i

/** A heading that narrates a card: its durable home is the card thread, not the doc. */
export function isCardNarrativeHeading(heading: string): boolean {
  return CARD_KEY_RE.test(heading) || CARD_STORY_RE.test(heading)
}

function useCardThreadError(heading: string, reason: 'card_heading' | 'section_size', chars: number): ConversationError {
  const card = heading.match(CARD_KEY_RE)?.[0].toUpperCase() ?? null
  const message = reason === 'card_heading'
    ? `"${heading}" is a card narrative, not a durable rule. Every agent woken in this channel reads the doc, so ` +
      `put the story in the card thread with work_item_comment${card ? ` (${card})` : ''} and leave only the lasting ` +
      'rule here. Pass force: true if it really is a lasting rule.'
    : `A new section of ${number(chars)} characters is too big for the channel doc (max ` +
      `${number(MAX_APPENDED_SECTION_CHARS)}). Put the narrative in the card thread with work_item_comment and keep ` +
      'the lasting rule here; force: true overrides.'
  return new ConversationError(400, 'use_card_thread', message, {
    reason,
    heading,
    card,
    chars,
    limit: MAX_APPENDED_SECTION_CHARS,
    next: ['work_item_comment'],
  })
}

/** Sections a write would add: a new heading in an append, or the section patch_section would create. */
function addedSections(base: string, update: AgentDocUpdate): Array<{ heading: string; body: string }> {
  const content = typeof update.content === 'string' ? update.content : ''
  if (update.mode === 'patch_section') {
    const heading = (update.section ?? '').trim().replace(/^#+\s*/, '')
    if (!heading || findSectionHeadings(base, heading).length) return []
    return [{ heading, body: content.trim() }]
  }
  if (update.mode !== 'append') return []
  const existing = new Set(
    base.split('\n').map(headingText).filter((t): t is string => !!t).map((t) => t.toLowerCase()),
  )
  const out: Array<{ heading: string; body: string }> = []
  let current: { heading: string; body: string } | null = null
  let sawHeading = false
  for (const line of content.split('\n')) {
    const text = headingText(line)
    if (text !== null) {
      sawHeading = true
      current = existing.has(text.toLowerCase()) ? null : { heading: text, body: '' }
      if (current) out.push(current)
      continue
    }
    if (current) current.body += `${line}\n`
  }
  if (!sawHeading) out.push({ heading: '', body: content })
  return out.map((s) => ({ ...s, body: s.body.trim() }))
}

function assertNotCardLog(base: string, update: AgentDocUpdate) {
  if (update.force) return
  const added = addedSections(base, update)
  const card = added.find((s) => s.heading && isCardNarrativeHeading(s.heading))
  if (card) throw useCardThreadError(card.heading, 'card_heading', card.body.length)
  const big = added.find((s) => s.body.length > MAX_APPENDED_SECTION_CHARS)
  if (big) throw useCardThreadError(big.heading, 'section_size', big.body.length)
}

/** Replace the body under the heading named `section`, or append a new section when it is missing. */
export function patchSection(markdown: string, section: string, body: string): string {
  const lines = markdown.split('\n')
  const wanted = section.trim().replace(/^#+\s*/, '').toLowerCase()
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').trim().toLowerCase() === wanted)
  if (start === -1) {
    const sep = markdown.trim() ? '\n\n' : ''
    return `${markdown.replace(/\s+$/, '')}${sep}## ${section.trim()}\n\n${body.trim()}\n`
  }
  const level = lines[start].match(/^#+/)![0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/)
    if (m && m[1].length <= level) { end = i; break }
  }
  const tail = lines.slice(end)
  return [...lines.slice(0, start + 1), '', body.trim(), ...(tail.length ? [''] : []), ...tail].join('\n')
}

/** Move one section out of the doc into the channel's archive: one version bump, one archive row. */
async function archiveSectionCore(
  conversation: any,
  actor: DocActor,
  input: { section: string; baseVersion?: number },
): Promise<{ doc: SerializedDoc; archive: SerializedArchive }> {
  const conversationId = conversation.id
  const current = await db.conversationDoc.findUnique({ where: { conversationId } })
  if (!current) throw new ConversationError(404, 'not_found', 'This channel has no doc yet')
  if (current.locked) throw new ConversationError(403, 'forbidden', 'This doc is locked; only channel managers can edit it')
  if (input.baseVersion !== undefined && input.baseVersion !== current.version) await conflict(conversationId)

  const hits = findSectionHeadings(current.content, input.section)
  if (!hits.length) throw new ConversationError(404, 'section_not_found', `No section is headed "${input.section}"`)
  if (hits.length > 1) {
    throw new ConversationError(
      409,
      'ambiguous_section',
      `${hits.length} sections are headed "${input.section}" (lines ${hits.map((i) => i + 1).join(', ')}); ` +
        'rename them so exactly one matches, then archive it.',
      { matches: hits.map((i) => i + 1) },
    )
  }
  const section = extractSection(current.content, input.section)!
  const pointer = `_Archived "${section.heading}" (${number(section.chars)} chars) — see the doc's Archive panel._`
  const content = sectionForPointer(current.content, section, pointer)

  const author = actorFields(actor)
  const row = await db.conversationDocArchive.create({
    data: {
      conversationId,
      workspaceId: conversation.workspaceId,
      title: current.title,
      heading: section.heading,
      content: section.body,
      chars: section.chars,
      archivedByType: author.updatedByType,
      archivedByUserId: author.updatedByUserId,
      archivedByProjectId: author.updatedByProjectId,
    },
  })
  let doc: SerializedDoc
  try {
    doc = await writeDoc(conversation, actor, { title: current.title, content, baseVersion: current.version })
  } catch (err) {
    // The write lost a race: drop the archive row so the section is not in two places.
    await db.conversationDocArchive.delete({ where: { id: row.id } }).catch(() => {})
    throw err
  }
  return { doc, archive: await serializeArchive(row, true) }
}

/** Archive a section as a person (the doc's Archive panel). */
export async function archiveSection(
  conversationId: string,
  userId: string,
  input: { section: string; baseVersion?: number },
): Promise<{ doc: SerializedDoc; archive: SerializedArchive }> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const existing = await db.conversationDoc.findUnique({ where: { conversationId }, select: { locked: true } })
  if (!canEditDoc(access, existing)) {
    throw new ConversationError(403, 'forbidden', existing?.locked
      ? 'This doc is locked; only channel managers can edit it'
      : 'You cannot edit this doc')
  }
  return archiveSectionCore(access.conversation, { type: 'user', userId }, input)
}

/** Put an archived section back at the end of the doc. */
export async function restoreArchive(
  conversationId: string,
  userId: string,
  archiveId: string,
  baseVersion: number,
): Promise<SerializedDoc> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const existing = await db.conversationDoc.findUnique({ where: { conversationId } })
  if (!canEditDoc(access, existing)) {
    throw new ConversationError(403, 'forbidden', existing?.locked
      ? 'This doc is locked; only channel managers can edit it'
      : 'You cannot edit this doc')
  }
  if (!existing) throw new ConversationError(404, 'not_found', 'This channel has no doc yet')
  const row = await db.conversationDocArchive.findUnique({ where: { id: archiveId } })
  if (!row || row.conversationId !== conversationId) {
    throw new ConversationError(404, 'not_found', 'Archived section not found')
  }
  const doc = await writeDoc(access.conversation, { type: 'user', userId }, {
    title: existing.title,
    content: appendSection(existing.content, row.heading, row.content),
    baseVersion,
  })
  // The text is back in the doc (and in the revision history), so the archive row would only duplicate it.
  await db.conversationDocArchive.delete({ where: { id: row.id } }).catch(() => {})
  return doc
}

/** Write as an agent. `conversation` must already be resolved as visible to it (`resolveAgentConversation`). */
export async function updateDocAsAgent(
  conversation: any,
  projectId: string | null,
  update: AgentDocUpdate,
): Promise<{ doc: SerializedDoc; archive?: SerializedArchive }> {
  assertDocKind(conversation)
  if (conversation.archivedAt) throw new ConversationError(403, 'forbidden', 'This conversation is archived')
  const actor: DocActor = { type: 'agent', projectId }
  if (update.mode === 'archive_section') {
    if (!update.section?.trim()) {
      throw new ConversationError(400, 'invalid_section', 'section is required for archive_section')
    }
    return archiveSectionCore(conversation, actor, { section: update.section, baseVersion: update.baseVersion })
  }
  if (typeof update.content !== 'string') throw new ConversationError(400, 'invalid_input', 'content is required')
  const conversationId = conversation.id

  const current = await db.conversationDoc.findUnique({ where: { conversationId } })
  if (current?.locked) throw new ConversationError(403, 'forbidden', 'This doc is locked; only channel managers can edit it')
  const base = current?.content ?? ''
  const baseVersion = current?.version ?? 0
  if (update.mode === 'replace' && update.baseVersion !== undefined && update.baseVersion !== baseVersion) {
    await conflict(conversationId)
  }
  assertNotCardLog(base, update)
  let content: string
  if (update.mode === 'append') {
    content = base.trim() ? `${base.replace(/\s+$/, '')}\n\n${update.content.trim()}\n` : update.content
  } else if (update.mode === 'patch_section') {
    if (!update.section?.trim()) throw new ConversationError(400, 'invalid_section', 'section is required for patch_section')
    content = patchSection(base, update.section, update.content)
  } else {
    content = update.content
  }
  if (content.length > MAX_DOC_CHARS) throw docFullError(content.length)
  return { doc: await writeDoc(conversation, actor, {
    title: update.title ?? current?.title ?? '',
    content,
    baseVersion,
  }) }
}

export async function restoreRevision(conversationId: string, userId: string, revisionId: string, baseVersion: number) {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  const revision = await db.conversationDocRevision.findUnique({ where: { id: revisionId }, include: { doc: true } })
  if (!revision || revision.doc.conversationId !== conversationId) {
    throw new ConversationError(404, 'not_found', 'Revision not found')
  }
  return saveDoc(conversationId, userId, { title: revision.title, content: revision.content, baseVersion })
}

export async function setDocLocked(conversationId: string, userId: string, locked: boolean): Promise<SerializedDoc> {
  const access = await loadAccess(conversationId, userId)
  assertDocKind(access.conversation)
  if (!canManage(access)) {
    throw new ConversationError(403, 'forbidden', 'Only channel owners and workspace admins can do that')
  }
  const existing = await db.conversationDoc.findUnique({ where: { conversationId } })
  if (!existing) throw new ConversationError(404, 'not_found', 'This channel has no doc yet')
  const row = await db.conversationDoc.update({ where: { conversationId }, data: { locked } })
  const doc = await serializeDoc(row)
  await publishDocUpdated(access.conversation, doc)
  return doc
}
