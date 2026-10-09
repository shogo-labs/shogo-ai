// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace customization for channels: user groups (`@design`) and custom
 * emoji (`:shipit:`).
 */

import { prisma } from '../lib/prisma'
import { loadAccess } from '../lib/authz'
import { publishConversationEvent } from '../lib/conversation-bus'
import {
  buildConversationFileKey,
  deleteConversationFile,
  putConversationFile,
  signConversationFileToken,
} from '../lib/conversation-files'
import { ConversationError, getWorkspaceRole } from './conversation.service'

const db = prisma as any

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/
const EMOJI_NAME_RE = /^[a-z0-9_+-]{2,32}$/
const RESERVED_HANDLES = new Set(['here', 'channel', 'everyone', 'all', 'shogo', 'agent', 'agents'])
export const MAX_EMOJI_BYTES = 256 * 1024
const EMOJI_TYPES = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp'])

async function requireContributor(workspaceId: string, userId: string) {
  const role = await getWorkspaceRole(workspaceId, userId)
  if (!role) throw new ConversationError(403, 'forbidden', 'No access to this workspace')
  if (role === 'viewer') throw new ConversationError(403, 'forbidden', 'Viewers cannot change this')
}

async function canModerate(workspaceId: string, userId: string): Promise<boolean> {
  return (await loadAccess({ userId, via: 'session' }, { workspaceId })).permissions.has('workspace.settings:manage')
}

// ─── User groups ─────────────────────────────────────────────────────────────

function serializeGroup(row: any) {
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    description: row.description ?? null,
    createdById: row.createdById,
    memberIds: (row.members ?? []).map((m: any) => m.userId),
  }
}

function cleanHandle(raw: unknown): string {
  const handle = String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    throw new ConversationError(400, 'invalid_handle', 'Handles are 2–40 lowercase letters, numbers, - or _')
  }
  if (RESERVED_HANDLES.has(handle)) throw new ConversationError(400, 'invalid_handle', `@${handle} is reserved`)
  return handle
}

async function workspaceUserIds(workspaceId: string, ids: unknown): Promise<string[]> {
  const list = Array.isArray(ids) ? [...new Set(ids.map(String))].slice(0, 500) : []
  if (!list.length) return []
  const members = await db.member.findMany({ where: { workspaceId, projectId: null, userId: { in: list } }, select: { userId: true } })
  return [...new Set<string>(members.map((m: any) => m.userId))]
}

export async function listGroups(workspaceId: string) {
  const rows = await db.userGroup.findMany({
    where: { workspaceId },
    orderBy: { handle: 'asc' },
    include: { members: { select: { userId: true } } },
  })
  return rows.map(serializeGroup)
}

function publishGroups(workspaceId: string) {
  publishConversationEvent(workspaceId, { type: 'groups.changed' })
}

export async function createGroup(
  workspaceId: string,
  userId: string,
  input: { handle?: unknown; name?: unknown; description?: unknown; memberIds?: unknown },
) {
  await requireContributor(workspaceId, userId)
  const handle = cleanHandle(input.handle)
  const name = String(input.name ?? '').trim().slice(0, 80) || handle
  const existing = await db.userGroup.findFirst({ where: { workspaceId, handle } })
  if (existing) throw new ConversationError(409, 'handle_taken', `@${handle} already exists`)
  const memberIds = await workspaceUserIds(workspaceId, input.memberIds)
  const created = await db.userGroup.create({
    data: {
      workspaceId,
      handle,
      name,
      description: typeof input.description === 'string' ? input.description.trim().slice(0, 300) || null : null,
      createdById: userId,
    },
  })
  for (const id of memberIds) await db.userGroupMember.create({ data: { groupId: created.id, userId: id } })
  publishGroups(workspaceId)
  const row = await db.userGroup.findUnique({ where: { id: created.id }, include: { members: { select: { userId: true } } } })
  return serializeGroup(row)
}

async function editableGroup(groupId: string, userId: string) {
  const row = await db.userGroup.findUnique({ where: { id: groupId } })
  if (!row) throw new ConversationError(404, 'not_found', 'Group not found')
  await requireContributor(row.workspaceId, userId)
  return { row }
}

export async function updateGroup(
  groupId: string,
  userId: string,
  patch: { handle?: unknown; name?: unknown; description?: unknown; memberIds?: unknown },
) {
  const { row } = await editableGroup(groupId, userId)
  const data: Record<string, unknown> = {}
  if (patch.handle !== undefined) {
    const handle = cleanHandle(patch.handle)
    if (handle !== row.handle) {
      const clash = await db.userGroup.findFirst({ where: { workspaceId: row.workspaceId, handle } })
      if (clash) throw new ConversationError(409, 'handle_taken', `@${handle} already exists`)
      data.handle = handle
    }
  }
  if (typeof patch.name === 'string') data.name = patch.name.trim().slice(0, 80) || row.handle
  if (patch.description !== undefined) {
    data.description = typeof patch.description === 'string' ? patch.description.trim().slice(0, 300) || null : null
  }
  if (Object.keys(data).length) await db.userGroup.update({ where: { id: groupId }, data })
  if (patch.memberIds !== undefined) {
    const next = await workspaceUserIds(row.workspaceId, patch.memberIds)
    await db.userGroupMember.deleteMany({ where: { groupId, userId: { notIn: next } } })
    const have = new Set((await db.userGroupMember.findMany({ where: { groupId }, select: { userId: true } })).map((m: any) => m.userId))
    for (const id of next) if (!have.has(id)) await db.userGroupMember.create({ data: { groupId, userId: id } })
  }
  publishGroups(row.workspaceId)
  const full = await db.userGroup.findUnique({ where: { id: groupId }, include: { members: { select: { userId: true } } } })
  return serializeGroup(full)
}

export async function deleteGroup(groupId: string, userId: string) {
  const { row } = await editableGroup(groupId, userId)
  if (row.createdById !== userId && !(await canModerate(row.workspaceId, userId))) {
    throw new ConversationError(403, 'forbidden', 'Only the creator or a workspace admin can delete this group')
  }
  await db.userGroup.delete({ where: { id: groupId } })
  publishGroups(row.workspaceId)
  return { deleted: true }
}

// ─── Custom emoji ────────────────────────────────────────────────────────────

export function customEmojiUrl(row: { id: string }): string {
  return `/api/custom-emoji/${row.id}?t=${signConversationFileToken(`emoji:${row.id}`)}`
}

function serializeEmoji(row: any) {
  return { id: row.id, name: row.name, url: customEmojiUrl(row), createdById: row.createdById }
}

export async function listEmoji(workspaceId: string) {
  const rows = await db.customEmoji.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, take: 2000 })
  return rows.map(serializeEmoji)
}

export async function createEmoji(
  workspaceId: string,
  userId: string,
  input: { name: unknown; bytes: Uint8Array; mimeType: string },
) {
  await requireContributor(workspaceId, userId)
  const name = String(input.name ?? '').trim().replace(/^:|:$/g, '').toLowerCase()
  if (!EMOJI_NAME_RE.test(name)) {
    throw new ConversationError(400, 'invalid_name', 'Emoji names are 2–32 lowercase letters, numbers, _, + or -')
  }
  if (!EMOJI_TYPES.has(input.mimeType)) throw new ConversationError(400, 'invalid_type', 'Use a PNG, GIF, JPEG, or WebP image')
  if (input.bytes.byteLength > MAX_EMOJI_BYTES) throw new ConversationError(400, 'too_large', 'Emoji images must be 256 KB or smaller')
  const existing = await db.customEmoji.findFirst({ where: { workspaceId, name } })
  if (existing) throw new ConversationError(409, 'name_taken', `:${name}: already exists`)
  const storageKey = buildConversationFileKey(workspaceId, 'emoji', `${name}.${input.mimeType.split('/')[1]}`)
  await putConversationFile(storageKey, input.bytes, input.mimeType)
  const row = await db.customEmoji.create({
    data: { workspaceId, name, storageKey, mimeType: input.mimeType, createdById: userId },
  })
  publishConversationEvent(workspaceId, { type: 'emoji.changed' })
  return serializeEmoji(row)
}

export async function deleteEmoji(emojiId: string, userId: string) {
  const row = await db.customEmoji.findUnique({ where: { id: emojiId } })
  if (!row) throw new ConversationError(404, 'not_found', 'Emoji not found')
  await requireContributor(row.workspaceId, userId)
  if (row.createdById !== userId && !(await canModerate(row.workspaceId, userId))) {
    throw new ConversationError(403, 'forbidden', 'Only the uploader or a workspace admin can remove this emoji')
  }
  await db.customEmoji.delete({ where: { id: emojiId } })
  await deleteConversationFile(row.storageKey).catch(() => {})
  publishConversationEvent(row.workspaceId, { type: 'emoji.changed' })
  return { deleted: true }
}
