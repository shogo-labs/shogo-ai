// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Storage for files shared in workspace channels. Cloud stores objects in the
 * artifact bucket; desktop/local mode writes under the Shogo data directory.
 *
 * Read URLs are capability URLs (HMAC of the attachment id) because image and
 * video elements and native image loaders cannot attach session credentials.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { mkdirSync } from 'fs'
import { readFile, writeFile, rm } from 'fs/promises'
import { dirname, join, normalize } from 'path'
import { homedir } from 'os'
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getArtifactBucket, getArtifactPresignedReadUrl, getArtifactS3Client } from './s3'

export const MAX_CONVERSATION_FILE_BYTES = 50 * 1024 * 1024
export const CONVERSATION_FILE_PREFIX = 'artifacts/conversations/'

const isLocalMode = () => process.env.SHOGO_LOCAL_MODE === 'true'

function signingSecret(): string {
  const secret = process.env.AI_PROXY_SECRET || process.env.BETTER_AUTH_SECRET || process.env.PREVIEW_TOKEN_SECRET
  if (secret) return secret
  if (process.env.NODE_ENV === 'production') throw new Error('[ConversationFiles] No signing secret configured')
  return 'shogo-dev-only-conversation-file-secret'
}

export function signConversationFileToken(attachmentId: string): string {
  return createHmac('sha256', signingSecret()).update(`conversation-file:${attachmentId}`).digest('hex')
}

export function verifyConversationFileToken(attachmentId: string, token: string | undefined | null): boolean {
  if (!token) return false
  const expected = Buffer.from(signConversationFileToken(attachmentId))
  const actual = Buffer.from(token)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function conversationFileUrl(attachment: { id: string }): string {
  return `/api/conversation-files/${attachment.id}?t=${signConversationFileToken(attachment.id)}`
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[/\\?%*:|"<>\u0000-\u001f]+/g, '_').trim().slice(-120)
  return cleaned || 'file'
}

export function buildConversationFileKey(workspaceId: string, conversationId: string, name: string): string {
  return `${CONVERSATION_FILE_PREFIX}${workspaceId}/${conversationId}/${crypto.randomUUID()}-${sanitizeName(name)}`
}

function localRoot(): string {
  return join(process.env.SHOGO_DATA_DIR || join(homedir(), '.shogo'), 'conversation-files')
}

function localPath(key: string): string {
  const root = localRoot()
  const full = normalize(join(root, key))
  if (!full.startsWith(root)) throw new Error('Invalid storage key')
  return full
}

export async function putConversationFile(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
  if (isLocalMode()) {
    const path = localPath(key)
    mkdirSync(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    return
  }
  await getArtifactS3Client().send(new PutObjectCommand({
    Bucket: getArtifactBucket(),
    Key: key,
    Body: bytes,
    ContentType: mimeType,
  }))
}

export type ConversationFileRead =
  | { kind: 'redirect'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array }

export async function readConversationFile(key: string): Promise<ConversationFileRead> {
  if (isLocalMode()) return { kind: 'bytes', bytes: await readFile(localPath(key)) }
  return { kind: 'redirect', url: await getArtifactPresignedReadUrl(key, { expiresIn: 300 }) }
}

export async function deleteConversationFile(key: string): Promise<void> {
  if (isLocalMode()) {
    await rm(localPath(key), { force: true })
    return
  }
  await getArtifactS3Client().send(new DeleteObjectCommand({ Bucket: getArtifactBucket(), Key: key }))
}
