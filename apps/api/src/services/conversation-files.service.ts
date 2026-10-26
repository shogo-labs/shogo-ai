// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Listing files shared in conversations, for the Files pane and for agents.
 * Visibility comes from `conversation-file-access`.
 */

import { prisma } from '../lib/prisma'
import { conversationFileUrl } from '../lib/conversation-files'
import { slugify } from './conversation.service'
import { VISIBLE_FILE_WHERE, readableConversationIds, type FilePrincipal } from './conversation-file-access'

const db = prisma as any
const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

export type FileKind = 'image' | 'document' | 'other'

const DOCUMENT_WHERE = {
  OR: [
    { mimeType: { startsWith: 'text/' } },
    { mimeType: 'application/pdf' },
    { mimeType: { contains: 'officedocument' } },
    { mimeType: { contains: 'msword' } },
    { mimeType: { contains: 'ms-excel' } },
    { mimeType: { contains: 'ms-powerpoint' } },
    { mimeType: { in: ['application/json', 'application/xml', 'application/rtf', 'application/x-yaml', 'application/yaml'] } },
  ],
}
const IMAGE_WHERE = { mimeType: { startsWith: 'image/' } }

function kindWhere(kind: FileKind | undefined): Record<string, unknown> {
  if (kind === 'image') return IMAGE_WHERE
  if (kind === 'document') return DOCUMENT_WHERE
  if (kind === 'other') return { NOT: [IMAGE_WHERE, DOCUMENT_WHERE] }
  return {}
}

export function fileKindOf(mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (/^text\/|pdf|officedocument|msword|ms-excel|ms-powerpoint|json|xml|rtf|yaml/.test(mimeType)) return 'document'
  return 'other'
}

export function parseFileKind(raw: unknown): FileKind | undefined {
  return raw === 'image' || raw === 'document' || raw === 'other' ? raw : undefined
}

export interface ListFilesOptions {
  conversationId?: string
  q?: string
  kind?: FileKind
  /** Id of the last file on the previous page. */
  cursor?: string
  limit?: number
}

const FILE_SELECT = {
  id: true,
  conversationId: true,
  messageId: true,
  name: true,
  mimeType: true,
  size: true,
  width: true,
  height: true,
  createdAt: true,
  storageKey: true,
  uploaderUserId: true,
  message: { select: { threadRootId: true, authorType: true, authorAgentRef: true, authorUser: { select: { id: true, name: true, email: true } } } },
  _count: { select: { chunks: true } },
}

/** Newest first, across every conversation the principal can read (or one of them). */
export async function listFiles(principal: FilePrincipal, workspaceId: string, opts: ListFilesOptions = {}) {
  const conversationIds = await readableConversationIds(principal, workspaceId, { conversationId: opts.conversationId })
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  if (!conversationIds.length) return { files: [] as any[], nextCursor: null as string | null }
  const q = opts.q?.trim()
  const rows = await db.conversationAttachment.findMany({
    where: {
      conversationId: { in: conversationIds },
      ...VISIBLE_FILE_WHERE,
      ...(q ? { name: isLocalMode() ? { contains: q } : { contains: q, mode: 'insensitive' } } : {}),
      ...kindWhere(opts.kind),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: FILE_SELECT,
  })
  const page = rows.slice(0, limit)
  return { files: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null }
}

function uploaderOf(row: any): { id: string | null; name: string } {
  const m = row.message
  if (m?.authorType === 'agent') return { id: null, name: `${m.authorAgentRef?.name ?? 'Agent'} (agent)` }
  const user = m?.authorUser
  return { id: user?.id ?? row.uploaderUserId ?? null, name: user ? user.name || user.email : 'Someone' }
}

/** The shape the Files pane shows. */
export function serializeFileForUser(row: any) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    threadRootId: row.message?.threadRootId ?? null,
    name: row.name,
    mimeType: row.mimeType,
    kind: fileKindOf(row.mimeType),
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    uploadedBy: uploaderOf(row),
    createdAt: row.createdAt,
    url: conversationFileUrl(row),
  }
}

/** The shape agents get: no capability URL, since agents fetch through their own routes. */
export function serializeFileForAgent(row: any, folders: Map<string, string>) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    name: row.name,
    mimeType: row.mimeType,
    kind: fileKindOf(row.mimeType),
    size: row.size,
    uploadedBy: uploaderOf(row).name,
    createdAt: row.createdAt,
    hasText: (row._count?.chunks ?? 0) > 0,
    folder: folders.get(row.conversationId) ?? row.conversationId,
  }
}

/**
 * Conversations with files that the principal can read, with a stable folder
 * name for each (used for the agent's download folder).
 */
export async function listFileConversations(principal: FilePrincipal, workspaceId: string) {
  const ids = await readableConversationIds(principal, workspaceId)
  if (!ids.length) return []
  const counts = await db.conversationAttachment.groupBy({
    by: ['conversationId'],
    where: { conversationId: { in: ids }, ...VISIBLE_FILE_WHERE },
    _count: { _all: true },
    _max: { createdAt: true },
  })
  if (!counts.length) return []
  const conversations = await db.conversation.findMany({
    where: { id: { in: counts.map((c: any) => c.conversationId) } },
    select: {
      id: true, kind: true, name: true, slug: true,
      members: { where: { memberType: 'user' }, select: { user: { select: { id: true, name: true, email: true } } } },
    },
  })
  const folders = folderNames(conversations, principal)
  const byId = new Map(counts.map((c: any) => [c.conversationId, c]))
  return conversations
    .map((c: any) => {
      const count: any = byId.get(c.id)
      return {
        id: c.id,
        kind: c.kind,
        name: displayName(c, principal),
        folder: folders.get(c.id)!,
        fileCount: count?._count?._all ?? 0,
        lastFileAt: count?._max?.createdAt ?? null,
      }
    })
    .sort((a: any, b: any) => new Date(b.lastFileAt ?? 0).getTime() - new Date(a.lastFileAt ?? 0).getTime())
}

function otherPeople(conversation: any, principal: FilePrincipal): any[] {
  const users = (conversation.members ?? []).map((m: any) => m.user).filter(Boolean)
  return principal.kind === 'user' ? users.filter((u: any) => u.id !== principal.userId) : users
}

function displayName(conversation: any, principal: FilePrincipal): string {
  if (conversation.kind === 'dm' || conversation.kind === 'group_dm') {
    const names = otherPeople(conversation, principal).map((u: any) => u.name || u.email)
    return names.length ? names.join(', ') : 'Direct message'
  }
  return conversation.name ?? conversation.slug ?? 'channel'
}

/** `<channel-slug>`, `dm-<person>`, or `group-<id>`, made unique within the set. */
export function folderNames(conversations: any[], principal: FilePrincipal): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  // A fixed order, so a name doesn't move to another conversation between calls.
  for (const c of [...conversations].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let base: string
    if (c.kind === 'dm') {
      const person = otherPeople(c, principal)[0]
      base = `dm-${slugify(person?.name || person?.email || 'someone') || 'someone'}`
    } else if (c.kind === 'group_dm') {
      base = `group-${c.id.slice(0, 8)}`
    } else {
      base = c.slug || slugify(c.name ?? '') || c.id.slice(0, 8)
    }
    const name = used.has(base) ? `${base}-${c.id.slice(0, 6)}` : base
    used.add(name)
    out.set(c.id, name)
  }
  return out
}
