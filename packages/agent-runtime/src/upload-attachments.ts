// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Upload attachment routing for the /agent/chat endpoint.
 *
 * Persists base64 data-URL file parts to disk inside the agent workspace.
 *
 * Routing:
 *   - .zip archives go to the workspace root (so the agent can `unzip` them
 *     in place without first chasing them down inside files/).
 *   - Everything else still lands in files/ alongside the index engine.
 *
 * The save routine returns enough metadata for the caller to (a) build a
 * hidden system-context note and (b) wire each non-zip file into the index
 * engine without this module having to know about that subsystem.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve, join } from 'path'
import {
  VIDEO_PROCESSING_LIMITS,
  isVideoAttachmentType,
} from '@shogo-ai/core/video-attachment-contract'

export interface UploadedFilePart {
  type: string
  mediaType?: string
  url?: string
  name?: string
  /** Mutated in-place by saveUploadedFileParts on success. */
  savedPath?: string
}

export interface SavedAttachment {
  /** True when the upload was routed to the workspace root as a .zip archive. */
  isZip: boolean
  /** Sanitised filename used on disk. */
  baseName: string
  /** Path relative to the workspace root, e.g. "archive.zip" or "files/foo.txt". */
  savedPath: string
  /** Absolute path on disk. */
  absolutePath: string
  /** Effective MIME type. */
  mediaType: string
  /** Decoded byte count. */
  bytes: number
}

export interface RejectedAttachment {
  /** Sanitised filename used for reporting. */
  baseName: string
  /** Effective MIME type. */
  mediaType: string
  /** Machine-readable reason suitable for tests and future UI/API wiring. */
  reason: 'video_too_large' | 'too_many_videos'
  /** Human-readable message suitable for hidden model context. */
  message: string
  /** Decoded byte count when available. */
  bytes?: number
}

export interface SaveUploadedFilePartsResult {
  saved: SavedAttachment[]
  rejected: RejectedAttachment[]
  /** One markdown bullet per saved file, ready to splice into a system note. */
  savedSummaries: string[]
  /** One markdown bullet per rejected file, ready to splice into a system note. */
  rejectedSummaries: string[]
  /** True if at least one .zip was routed to the workspace root. */
  zipUploaded: boolean
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/x-matroska': '.mkv',
  'video/mpeg': '.mpeg',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/html': '.html',
  'text/css': '.css',
  'application/javascript': '.js',
  'application/typescript': '.ts',
  'application/zip': '.zip',
}

function mimeToExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] || `.${mimeType.split('/').pop() || 'bin'}`
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function sanitiseUploadName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}

export function isZipUpload(name: string | undefined, mediaType: string | undefined): boolean {
  if (mediaType === 'application/zip' || mediaType === 'application/x-zip-compressed') return true
  return !!name && name.toLowerCase().endsWith('.zip')
}

function resolveInsideRoot(rootDir: string, subPath: string): string | null {
  const root = resolve(rootDir)
  const resolved = resolve(root, subPath)
  if (resolved === root) return null
  if (!resolved.startsWith(root + '/') && !resolved.startsWith(root + '\\')) return null
  return resolved
}

export interface SaveUploadedFilePartsOptions {
  workspaceDir: string
  parts: UploadedFilePart[]
  /** Subdirectory (relative to workspaceDir) for non-zip uploads. Defaults to 'files'. */
  filesSubdir?: string
  /** Logger for per-file save messages. Defaults to console.log; pass () => {} to silence. */
  log?: (msg: string) => void
  /** Logger for save failures. Defaults to console.error. */
  logError?: (msg: string, err: unknown) => void
}

/**
 * Persist every base64 data-URL file part to the agent workspace and mutate
 * each successfully-saved part in place to set its `savedPath`.
 *
 * Returns metadata the caller can use to (a) compose the hidden user-text
 * note and (b) trigger any post-save side effects like indexing.
 */
export function saveUploadedFileParts(
  opts: SaveUploadedFilePartsOptions,
): SaveUploadedFilePartsResult {
  const {
    workspaceDir,
    parts,
    filesSubdir = 'files',
    log = (m: string) => console.log(m),
    logError = (m: string, err: unknown) => console.error(m, err),
  } = opts

  const filesDir = join(workspaceDir, filesSubdir)
  mkdirSync(filesDir, { recursive: true })

  const saved: SavedAttachment[] = []
  const rejected: RejectedAttachment[] = []
  const savedSummaries: string[] = []
  const rejectedSummaries: string[] = []
  let zipUploaded = false
  let savedVideos = 0

  for (const fp of parts) {
    try {
      const url = fp.url
      if (!url) continue
      const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
      if (!base64Match) continue

      const mediaType = fp.mediaType || 'application/octet-stream'
      const ext = mimeToExtension(mediaType)
      const baseName = fp.name
        ? sanitiseUploadName(fp.name)
        : `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`
      const isVideo = isVideoAttachmentType(mediaType, fp.name)
      const bytes = Buffer.from(base64Match[1], 'base64')

      if (isVideo && savedVideos >= VIDEO_PROCESSING_LIMITS.maxVideosPerMessage) {
        const message = `Video upload skipped: maximum ${VIDEO_PROCESSING_LIMITS.maxVideosPerMessage} videos per message.`
        rejected.push({ baseName, mediaType, reason: 'too_many_videos', message, bytes: bytes.length })
        rejectedSummaries.push(`- \`${baseName}\` (${mediaType}, ${formatBytes(bytes.length)}): ${message}`)
        continue
      }

      if (isVideo && bytes.length > VIDEO_PROCESSING_LIMITS.maxServerVideoBytes) {
        const message = `Video upload skipped: ${formatBytes(bytes.length)} exceeds the server limit of ${formatBytes(VIDEO_PROCESSING_LIMITS.maxServerVideoBytes)}.`
        rejected.push({ baseName, mediaType, reason: 'video_too_large', message, bytes: bytes.length })
        rejectedSummaries.push(`- \`${baseName}\` (${mediaType}, ${formatBytes(bytes.length)}): ${message}`)
        continue
      }

      const isZip = isZipUpload(fp.name, fp.mediaType)
      const resolved = isZip
        ? resolveInsideRoot(workspaceDir, baseName)
        : resolveInsideRoot(filesDir, baseName)
      if (!resolved) continue

      mkdirSync(dirname(resolved), { recursive: true })
      writeFileSync(resolved, bytes)

      const relPath = isZip ? baseName : `${filesSubdir}/${baseName}`
      fp.savedPath = relPath

      const summary = `- \`${relPath}\` (${mediaType}, ${formatBytes(bytes.length)})`
      savedSummaries.push(summary)
      saved.push({
        isZip,
        baseName,
        savedPath: relPath,
        absolutePath: resolved,
        mediaType,
        bytes: bytes.length,
      })
      if (isZip) zipUploaded = true
      if (isVideo) savedVideos++

      log(`[AgentChat] Saved uploaded file to ${relPath} (${bytes.length} bytes, ${mediaType})`)
    } catch (err: any) {
      logError(`[AgentChat] Failed to save uploaded file:`, err?.message ?? err)
    }
  }

  return { saved, rejected, savedSummaries, rejectedSummaries, zipUploaded }
}

/**
 * Build the hidden system-context note appended to user text after uploads.
 * The wording deliberately tells the model "the user did not write this" so
 * that hidden context is not echoed back to the user, and explicitly calls
 * out the zip-at-workspace-root convention so the agent doesn't fall back to
 * `ls files/` (which is the wrong location for archives).
 */
export function buildUploadedFilesNote(
  savedSummaries: string[],
  zipUploaded: boolean,
  rejectedSummaries: string[] = [],
): string {
  if (savedSummaries.length === 0 && rejectedSummaries.length === 0) return ''
  const lines: string[] = [
    '[SYSTEM NOTE — not written by the user, do not echo: the runtime just processed these uploads:',
  ]
  if (savedSummaries.length > 0) lines.push(...savedSummaries)
  if (rejectedSummaries.length > 0) {
    lines.push('Rejected uploads:')
    lines.push(...rejectedSummaries)
  }
  if (zipUploaded) {
    lines.push(
      'Zip archives above are at the WORKSPACE ROOT (not files/). To inspect or extract, use the shell `exec` tool with `unzip <name>.zip` (optionally `-d <dir>`). Do NOT report the upload as missing if `ls files/` is empty — check the workspace root.',
    )
  }
  lines.push(']')
  return lines.join('\n')
}
