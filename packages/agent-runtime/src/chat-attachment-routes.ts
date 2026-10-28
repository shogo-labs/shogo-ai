// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `PUT /agent/chat/attachments` — upload a chat attachment's bytes *before*
 * the turn that references them.
 *
 * Why this route exists: attaching a large file used to mean putting a base64
 * data URL into the `/chat` JSON body, which the client inflated by 33%, the
 * API re-serialised several times, and the runtime then decoded — all before
 * the agent started, which is what made a big zip time out. Here the raw
 * request body is piped straight to disk: no multipart, no base64, no
 * whole-file buffer.
 *
 * The turn that follows sends a *reference* part (`{ type: 'file', mediaType,
 * name, savedPath, url }`) that `/agent/chat` resolves from disk.
 *
 * It is an internal runtime route, not an agent tool: nothing here is part of
 * the agent surface.
 */

import { Hono } from 'hono'
import {
  AttachmentTooLargeError,
  attachmentSummaryLine,
  maxChatAttachmentBytes,
  saveStreamedAttachment,
  type SavedAttachment,
} from './upload-attachments'

export interface ChatAttachmentRoutesOptions {
  /** Absolute workspace root the uploads land inside. */
  workspaceDir: string
  /** Per-upload cap in bytes. Defaults to `maxChatAttachmentBytes()`. */
  maxBytes?: number
  /** Subdirectory for non-zip uploads. Defaults to `files`. */
  filesSubdir?: string
  /** Called once a file is on disk, so the host can index it. */
  onFileWritten?: (file: SavedAttachment) => void
  log?: (msg: string) => void
  logError?: (msg: string, err: unknown) => void
}

function headerSafeName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export function chatAttachmentRoutes(opts: ChatAttachmentRoutesOptions): Hono {
  const app = new Hono()
  const log = opts.log ?? ((msg: string) => console.log(msg))
  const logError = opts.logError ?? ((msg: string, err: unknown) => console.error(msg, err))
  const maxBytes = opts.maxBytes ?? maxChatAttachmentBytes()

  app.put('/agent/chat/attachments', async (c) => {
    const name = headerSafeName(c.req.query('name'))
    if (!name) {
      return c.json(
        { error: { code: 'attachment_name_required', message: 'Pass the file name as ?name=<file>' } },
        400,
      )
    }
    const mediaType = headerSafeName(c.req.header('content-type')) || 'application/octet-stream'

    // Refuse before reading a byte when the client already told us the size.
    const declared = Number.parseInt(c.req.header('content-length') || '', 10)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return c.json(
        {
          error: {
            code: 'attachment_too_large',
            message: `"${name}" is ${(declared / (1024 * 1024)).toFixed(1)} MB, over the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB attachment limit.`,
          },
        },
        413,
      )
    }

    try {
      const saved = await saveStreamedAttachment({
        workspaceDir: opts.workspaceDir,
        name,
        mediaType,
        body: c.req.raw.body,
        maxBytes,
        filesSubdir: opts.filesSubdir,
      })
      try {
        opts.onFileWritten?.(saved)
      } catch (err) {
        logError('[AgentChat] attachment index hook failed:', err)
      }
      log(`[AgentChat] Streamed attachment to ${saved.savedPath} (${saved.bytes} bytes, ${saved.mediaType})`)
      return c.json({
        savedPath: saved.savedPath,
        name: saved.baseName,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        summary: attachmentSummaryLine(saved.savedPath, saved.mediaType, saved.bytes),
      })
    } catch (err: any) {
      if (err instanceof AttachmentTooLargeError) {
        return c.json(
          {
            error: {
              code: 'attachment_too_large',
              message: `"${name}" is over the ${(maxBytes / (1024 * 1024)).toFixed(0)} MB attachment limit.`,
            },
          },
          413,
        )
      }
      logError('[AgentChat] attachment upload failed:', err)
      return c.json(
        {
          error: {
            code: 'attachment_upload_failed',
            message: err?.message || 'Could not save the attachment',
          },
        },
        500,
      )
    }
  })

  return app
}
