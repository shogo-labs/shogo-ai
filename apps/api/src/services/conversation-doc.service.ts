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
export async function docContextFor(conversationId: string): Promise<{ title: string; content: string; version: number } | null> {
  const row = await db.conversationDoc.findUnique({
    where: { conversationId },
    select: { title: true, content: true, version: true },
  })
  if (!row || !row.content.trim()) return null
  return row
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
  if (content.length > MAX_DOC_CHARS) {
    throw new ConversationError(400, 'too_long', `Docs are limited to ${MAX_DOC_CHARS} characters`)
  }
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

export type AgentDocMode = 'replace' | 'append' | 'patch_section'

export interface AgentDocUpdate {
  mode: AgentDocMode
  content: string
  title?: string
  /** Heading text (without #) of the section to replace for `patch_section`. */
  section?: string
  /** Required for `replace`; optional otherwise (append/patch apply to the latest version). */
  baseVersion?: number
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

/** Write as an agent. `conversation` must already be resolved as visible to it (`resolveAgentConversation`). */
export async function updateDocAsAgent(conversation: any, projectId: string | null, update: AgentDocUpdate) {
  assertDocKind(conversation)
  if (conversation.archivedAt) throw new ConversationError(403, 'forbidden', 'This conversation is archived')
  if (typeof update.content !== 'string') throw new ConversationError(400, 'invalid_input', 'content is required')
  const conversationId = conversation.id

  const current = await db.conversationDoc.findUnique({ where: { conversationId } })
  if (current?.locked) throw new ConversationError(403, 'forbidden', 'This doc is locked; only channel managers can edit it')
  const base = current?.content ?? ''
  const baseVersion = current?.version ?? 0
  if (update.mode === 'replace' && update.baseVersion !== undefined && update.baseVersion !== baseVersion) {
    await conflict(conversationId)
  }
  let content: string
  if (update.mode === 'append') {
    content = base.trim() ? `${base.replace(/\s+$/, '')}\n\n${update.content.trim()}\n` : update.content
  } else if (update.mode === 'patch_section') {
    if (!update.section?.trim()) throw new ConversationError(400, 'invalid_section', 'section is required for patch_section')
    content = patchSection(base, update.section, update.content)
  } else {
    content = update.content
  }
  return writeDoc(conversation, { type: 'agent', projectId }, {
    title: update.title ?? current?.title ?? '',
    content,
    baseVersion,
  })
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
