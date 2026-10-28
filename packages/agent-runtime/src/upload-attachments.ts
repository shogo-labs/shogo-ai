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

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve, join, sep } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

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

export interface SaveUploadedFilePartsResult {
  saved: SavedAttachment[]
  /** One markdown bullet per saved file, ready to splice into a system note. */
  savedSummaries: string[]
  /** True if at least one .zip was routed to the workspace root. */
  zipUploaded: boolean
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
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

/** Workspace-relative path for an absolute path inside `rootDir`, else null. */
export function workspaceRelativePath(rootDir: string, absolutePath: string): string | null {
  const root = resolve(rootDir)
  const resolved = resolve(absolutePath)
  if (resolved === root) return null
  if (!resolved.startsWith(root + sep)) return null
  return resolved.slice(root.length + 1).split(sep).join('/')
}

/**
 * Filename used on disk for an upload: everything that could act as a path
 * separator is replaced, so `../../etc/passwd` lands as a single segment.
 */
export function sanitizeAttachmentName(
  name: string | undefined,
  mediaType: string | undefined,
): string {
  if (name) {
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_')
    if (sanitized && sanitized !== '.' && sanitized !== '..') return sanitized
  }
  const ext = mimeToExtension(mediaType || 'application/octet-stream')
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`
}

export interface AttachmentRoute {
  /** True when the upload is routed to the workspace root as a .zip archive. */
  isZip: boolean
  /** Sanitised filename used on disk (without any collision suffix). */
  baseName: string
  /** Path relative to the workspace root, e.g. "archive.zip" or "files/foo.txt". */
  savedPath: string
  /** Absolute path on disk. */
  absolutePath: string
}

/**
 * Where an attachment of this name/type belongs inside the workspace.
 *
 * One rule for both the base64 path (`/agent/chat`) and the streamed upload
 * route, so the same file never lands in two different places depending on
 * which transport a client used:
 *   - `.zip` archives go to the workspace root (the agent unzips them in
 *     place without first chasing them down inside `files/`);
 *   - everything else lands in `files/` alongside the index engine.
 */
export function routeAttachment(
  workspaceDir: string,
  name: string | undefined,
  mediaType: string | undefined,
  filesSubdir = 'files',
): AttachmentRoute | null {
  const baseName = sanitizeAttachmentName(name, mediaType)
  const isZip = isZipUpload(name, mediaType)
  const resolved = isZip
    ? resolveInsideRoot(workspaceDir, baseName)
    : resolveInsideRoot(join(workspaceDir, filesSubdir), baseName)
  if (!resolved) return null
  return {
    isZip,
    baseName,
    savedPath: isZip ? baseName : `${filesSubdir}/${baseName}`,
    absolutePath: resolved,
  }
}

/**
 * Same as {@link routeAttachment}, but never overwrites an existing file:
 * `report.pdf` becomes `report-1.pdf`, `report-2.pdf`, … Instead of clobbering
 * an upload the agent may still be reading, the new file gets a suffix.
 */
export function routeAttachmentUnique(
  workspaceDir: string,
  name: string | undefined,
  mediaType: string | undefined,
  filesSubdir = 'files',
): AttachmentRoute | null {
  const first = routeAttachment(workspaceDir, name, mediaType, filesSubdir)
  if (!first) return null
  if (!existsSync(first.absolutePath)) return first

  const dot = first.baseName.lastIndexOf('.')
  const stem = dot > 0 ? first.baseName.slice(0, dot) : first.baseName
  const ext = dot > 0 ? first.baseName.slice(dot) : ''
  for (let n = 1; n <= 1000; n++) {
    const candidate = `${stem}-${n}${ext}`
    const resolved = first.isZip
      ? resolveInsideRoot(workspaceDir, candidate)
      : resolveInsideRoot(join(workspaceDir, filesSubdir), candidate)
    if (!resolved) return null
    if (!existsSync(resolved)) {
      return {
        isZip: first.isZip,
        baseName: candidate,
        savedPath: first.isZip ? candidate : `${filesSubdir}/${candidate}`,
        absolutePath: resolved,
      }
    }
  }
  return null
}

/** One markdown bullet for `buildUploadedFilesNote`, identical for both transports. */
export function attachmentSummaryLine(savedPath: string, mediaType: string, bytes: number): string {
  return `- \`${savedPath}\` (${mediaType}, ${formatBytes(bytes)})`
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
  const savedSummaries: string[] = []
  let zipUploaded = false

  for (const fp of parts) {
    try {
      const url = fp.url
      if (!url) continue
      const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
      if (!base64Match) continue

      const mediaType = fp.mediaType || 'application/octet-stream'
      const route = routeAttachment(workspaceDir, fp.name, fp.mediaType, filesSubdir)
      if (!route) continue

      mkdirSync(dirname(route.absolutePath), { recursive: true })
      const bytes = Buffer.from(base64Match[1], 'base64')
      writeFileSync(route.absolutePath, bytes)

      const relPath = route.savedPath
      fp.savedPath = relPath

      const summary = attachmentSummaryLine(relPath, mediaType, bytes.length)
      savedSummaries.push(summary)
      saved.push({
        isZip: route.isZip,
        baseName: route.baseName,
        savedPath: relPath,
        absolutePath: route.absolutePath,
        mediaType,
        bytes: bytes.length,
      })
      if (route.isZip) zipUploaded = true

      log(`[AgentChat] Saved uploaded file to ${relPath} (${bytes.length} bytes, ${mediaType})`)
    } catch (err: any) {
      logError(`[AgentChat] Failed to save uploaded file:`, err?.message ?? err)
    }
  }

  return { saved, savedSummaries, zipUploaded }
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
): string {
  if (savedSummaries.length === 0) return ''
  const lines: string[] = [
    '[SYSTEM NOTE — not written by the user, do not echo: the runtime just persisted these uploads to disk:',
    ...savedSummaries,
  ]
  if (zipUploaded) {
    lines.push(
      'Zip archives above are at the WORKSPACE ROOT (not files/). To inspect or extract, use the shell `exec` tool with `unzip <name>.zip` (optionally `-d <dir>`). Do NOT report the upload as missing if `ls files/` is empty — check the workspace root.',
    )
  }
  lines.push(']')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Streamed upload (PUT /agent/chat/attachments)
// ---------------------------------------------------------------------------

/** Default cap for one chat attachment; overridable per runtime. */
export const DEFAULT_MAX_CHAT_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024

/** `MAX_CHAT_ATTACHMENT_BYTES` env override, falling back to the default cap. */
export function maxChatAttachmentBytes(): number {
  const raw = process.env.MAX_CHAT_ATTACHMENT_BYTES
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHAT_ATTACHMENT_BYTES
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`Attachment is larger than the ${formatBytes(maxBytes)} limit`)
    this.name = 'AttachmentTooLargeError'
  }
}

export interface SaveStreamedAttachmentOptions {
  workspaceDir: string
  name: string | undefined
  mediaType: string | undefined
  /** Raw request body. Never buffered: it is piped straight to disk. */
  body: ReadableStream<Uint8Array> | null
  maxBytes?: number
  filesSubdir?: string
}

/**
 * Pipe an upload straight to its workspace path.
 *
 * The bytes never pass through base64 or a whole-file buffer: the request
 * stream is piped to disk, so a 200 MB archive costs a socket read and a file
 * write rather than a 267 MB JSON string plus a decoded copy.
 *
 * A partial file is removed when the cap is exceeded or the client aborts, so
 * a failed upload never leaves a truncated file for the agent to read.
 */
export async function saveStreamedAttachment(
  opts: SaveStreamedAttachmentOptions,
): Promise<SavedAttachment> {
  const { workspaceDir, name, mediaType, body, filesSubdir = 'files' } = opts
  const maxBytes = opts.maxBytes ?? maxChatAttachmentBytes()
  if (!body) throw new Error('Request body is empty')

  const route = routeAttachmentUnique(workspaceDir, name, mediaType, filesSubdir)
  if (!route) throw new Error('Could not resolve a path inside the workspace')
  mkdirSync(dirname(route.absolutePath), { recursive: true })

  const effectiveMediaType = mediaType || 'application/octet-stream'
  let written = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      if (written > maxBytes) {
        callback(new AttachmentTooLargeError(written, maxBytes))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(body as any),
      counter,
      createWriteStream(route.absolutePath),
    )
  } catch (err) {
    try {
      if (existsSync(route.absolutePath)) unlinkSync(route.absolutePath)
    } catch { /* best effort — a stale partial must not mask the real error */ }
    throw err
  }

  return {
    isZip: route.isZip,
    baseName: route.baseName,
    savedPath: route.savedPath,
    absolutePath: route.absolutePath,
    mediaType: effectiveMediaType,
    bytes: written,
  }
}

export interface ReferenceAttachment {
  savedPath: string
  absolutePath: string
  name?: string
  mediaType: string
  bytes: number
  isZip: boolean
}

/** A file part that carries a workspace reference instead of inline bytes. */
export function isReferenceAttachmentPart(part: UploadedFilePart): boolean {
  if (part.type !== 'file') return false
  if (!part.savedPath) return false
  return !part.url || !part.url.startsWith('data:')
}

/**
 * Resolve a reference part's `savedPath` against the workspace.
 *
 * Returns `'outside'` when the path escapes the workspace (a caller trying to
 * read the host filesystem — the route rejects the whole request), and
 * `'missing'` when the path is legal but the file is gone (a stale reference,
 * which is reported to the model rather than failing the turn).
 */
export function resolveReferenceAttachment(
  workspaceDir: string,
  part: UploadedFilePart,
): ReferenceAttachment | 'outside' | 'missing' {
  const savedPath = typeof part.savedPath === 'string' ? part.savedPath.trim() : ''
  if (!savedPath || savedPath.startsWith('/') || savedPath.startsWith('\\')) return 'outside'
  const resolved = resolveInsideRoot(workspaceDir, savedPath)
  if (!resolved) return 'outside'
  if (!existsSync(resolved)) return 'missing'
  let bytes = 0
  try {
    const stat = statSync(resolved)
    if (!stat.isFile()) return 'missing'
    bytes = stat.size
  } catch {
    return 'missing'
  }
  return {
    savedPath: savedPath.split('\\').join('/').replace(/^\.\//, ''),
    absolutePath: resolved,
    name: part.name,
    mediaType: part.mediaType || 'application/octet-stream',
    bytes,
    isZip: isZipUpload(part.name || savedPath, part.mediaType),
  }
}

