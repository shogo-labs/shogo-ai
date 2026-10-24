// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Media an agent embeds in its ordinary turn reply.
 *
 * A reply's text is written by the dispatcher, not by a tool, so nothing has
 * published the workspace images it points at. Each ref is read from the
 * agent's runtime, stored as a conversation file, linked to the reply message
 * and rewritten to its signed URL — the same shape a tool-posted attachment
 * takes, so the thread renders it and it survives the agent sleeping.
 *
 * A ref that cannot be published is left as written and reported: media never
 * fails a turn.
 */

import { maskMarkdownCode, workspaceMediaPath } from '../lib/chat-attachments'
import { MAX_CONVERSATION_FILE_BYTES, conversationFileUrl } from '../lib/conversation-files'
import { storeAgentAttachment } from './agent-attachments'

const MARKDOWN_MEDIA_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g

export const MAX_REPLY_MEDIA_FILES = 10
export const MAX_REPLY_MEDIA_BYTES = 50 * 1024 * 1024

/** Reads a workspace file through the runtime that owns the replying agent. */
export type WorkspaceFileFetcher = (path: string) => Promise<Response | null>

export interface ReplyMediaInput {
  workspaceId: string
  conversationId: string
  /** The reply the media belongs to. */
  messageId: string
  /** `workspace`, or `project:<id>` for a project agent. */
  agentRef: string
  text: string
  fetchFile: WorkspaceFileFetcher
}

export interface ReplyMediaResult {
  text: string
  uploaded: number
  errors: string[]
}

export async function publishReplyMedia(input: ReplyMediaInput): Promise<ReplyMediaResult> {
  if (!input.text.includes('![')) return { text: input.text, uploaded: 0, errors: [] }
  const { masked, restore } = maskMarkdownCode(input.text)

  const paths: string[] = []
  for (const match of masked.matchAll(MARKDOWN_MEDIA_RE)) {
    const path = workspaceMediaPath(match[2]!)
    if (path && !paths.includes(path)) paths.push(path)
  }
  if (!paths.length) return { text: input.text, uploaded: 0, errors: [] }

  const stored = new Map<string, string>()
  const errors: string[] = []
  let bytes = 0
  for (const path of paths.slice(0, MAX_REPLY_MEDIA_FILES)) {
    try {
      const response = await input.fetchFile(path)
      if (!response?.ok) {
        errors.push(`${path}: file not found`)
        continue
      }
      const mediaType = (response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
      if (!mediaType.startsWith('image/') && !mediaType.startsWith('video/')) {
        errors.push(`${path}: only images and videos can be attached`)
        continue
      }
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > MAX_CONVERSATION_FILE_BYTES) {
        errors.push(`${path}: larger than 50 MB`)
        continue
      }
      const data = new Uint8Array(await response.arrayBuffer())
      if (!data.byteLength) {
        errors.push(`${path}: empty file`)
        continue
      }
      if (bytes + data.byteLength > MAX_REPLY_MEDIA_BYTES) {
        errors.push(`${path}: over the 50 MB reply budget`)
        continue
      }
      const name = path.split('/').filter(Boolean).pop() || 'file'
      const attachment = await storeAgentAttachment({
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        agentRef: input.agentRef,
        messageId: input.messageId,
        file: new File([data], name, { type: mediaType }),
      })
      bytes += data.byteLength
      // The fragment carries the file name: stored URLs have no extension, and
      // renderers read it to tell a video from an image.
      stored.set(path, `${conversationFileUrl(attachment)}#${encodeURIComponent(name)}`)
    } catch (err: any) {
      errors.push(`${path}: ${err?.message ?? 'could not be published'}`)
    }
  }
  if (paths.length > MAX_REPLY_MEDIA_FILES) {
    errors.push(`Only the first ${MAX_REPLY_MEDIA_FILES} files were published`)
  }

  const rewritten = masked.replace(MARKDOWN_MEDIA_RE, (full, alt: string, target: string, title: string) => {
    const path = workspaceMediaPath(target)
    const url = path ? stored.get(path) : undefined
    return url ? `![${alt}](${url}${title})` : full
  })
  return { text: restore(rewritten), uploaded: stored.size, errors }
}
