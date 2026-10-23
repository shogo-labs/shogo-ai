// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Files an agent uploads into a conversation: images and videos it attaches
 * to a channel post or card comment, or embeds in a card description.
 *
 * The row records the agent (`uploaderAgentRef`) instead of a user. Posting a
 * message with the row's id links it, like the composer does for people;
 * description media stays unlinked and is reached through its signed URL.
 */
import { prisma } from '../lib/prisma'
import {
  MAX_CONVERSATION_FILE_BYTES,
  buildConversationFileKey,
  conversationFileUrl,
  putConversationFile,
} from '../lib/conversation-files'
import { ConversationError } from './conversation.service'
import { canExtract, extractAndStoreAttachmentText } from './conversation-file-text'

const db = prisma as any

export interface AgentAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  url: string
}

/** Reads the multipart `file` field an agent runtime sends. */
export async function readAgentUpload(c: any): Promise<{ file: File; form: FormData }> {
  const form = await c.req.formData().catch(() => null)
  const file = form?.get('file')
  if (!form || !file || typeof file === 'string') {
    throw new ConversationError(400, 'invalid_file', 'Attach a file in the "file" field')
  }
  if (file.size > MAX_CONVERSATION_FILE_BYTES) {
    throw new ConversationError(400, 'too_large', 'Files are limited to 50 MB')
  }
  return { file: file as File, form }
}

export async function storeAgentAttachment(input: {
  workspaceId: string
  conversationId: string
  agentRef: string
  file: File
  /** Message the file belongs to, when it is published with one (an agent reply). */
  messageId?: string
}): Promise<AgentAttachment> {
  const name = (input.file.name || 'file').slice(0, 255)
  const mimeType = input.file.type || 'application/octet-stream'
  const key = buildConversationFileKey(input.workspaceId, input.conversationId, name)
  const bytes = new Uint8Array(await input.file.arrayBuffer())
  await putConversationFile(key, bytes, mimeType)
  const row = await db.conversationAttachment.create({
    data: {
      conversationId: input.conversationId,
      messageId: input.messageId ?? null,
      uploaderUserId: null,
      uploaderAgentRef: input.agentRef,
      storageKey: key,
      name,
      mimeType,
      size: bytes.byteLength,
    },
  })
  if (canExtract(mimeType, name, bytes.byteLength)) {
    void extractAndStoreAttachmentText(row.id, bytes, mimeType, name).catch(() => {})
  }
  return { id: row.id, name: row.name, mimeType: row.mimeType, size: row.size, url: conversationFileUrl(row) }
}

export function attachmentIdsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 20)
}
