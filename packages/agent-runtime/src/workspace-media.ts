// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Publish workspace images and videos to Shogo so people see them in team
 * chat and on board cards without the agent being awake.
 *
 * Tools take workspace paths (`brand/logo.png`). Each file is read here,
 * uploaded through an agent upload route, and replaced by the signed URL the
 * API returns: as an attachment id for a post, or inline in markdown for a
 * card description.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { AgentUploadedFile, CheckpointCallResult } from './internal-api'

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024
export const MAX_MEDIA_FILES = 10

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
}

export function mediaTypeForPath(path: string): string | null {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? null
}

export interface WorkspaceMediaFile {
  path: string
  name: string
  mimeType: string
  bytes: Uint8Array
}

function within(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Read an image or video from the workspace. Relative paths resolve against
 * the workspace root, then its `files/` area (like the download route);
 * absolute paths must sit inside the workspace.
 */
export function readWorkspaceMedia(workspaceDir: string, rawPath: string): WorkspaceMediaFile | { error: string } {
  let path = rawPath.trim()
  if (path.startsWith('<') && path.endsWith('>')) path = path.slice(1, -1).trim()
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return { error: `${rawPath}: not a valid file URL` }
    }
  }
  if (!path) return { error: 'Empty path' }
  const root = resolve(workspaceDir)
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : [resolve(root, path), resolve(root, 'files', path)]
  const abs = candidates.find((p) => within(root, p) && existsSync(p))
  if (!abs) {
    return { error: candidates.some((p) => within(root, p)) ? `${rawPath}: file not found` : `${rawPath}: outside the workspace` }
  }
  const mimeType = mediaTypeForPath(abs)
  if (!mimeType) return { error: `${rawPath}: only images and videos can be attached` }
  const stat = statSync(abs)
  if (!stat.isFile()) return { error: `${rawPath}: not a file` }
  if (stat.size > MAX_MEDIA_BYTES) return { error: `${rawPath}: larger than 50 MB` }
  return {
    path,
    name: abs.split(/[\\/]/).pop() || 'file',
    mimeType,
    bytes: new Uint8Array(readFileSync(abs)),
  }
}

export type MediaUploader = (file: WorkspaceMediaFile) => Promise<CheckpointCallResult<AgentUploadedFile>>

/** Upload each path; returns the stored files and a line per path that failed. */
export async function uploadWorkspaceMedia(
  workspaceDir: string,
  paths: string[],
  upload: MediaUploader,
): Promise<{ files: AgentUploadedFile[]; errors: string[] }> {
  const files: AgentUploadedFile[] = []
  const errors: string[] = []
  for (const raw of paths.slice(0, MAX_MEDIA_FILES)) {
    const file = readWorkspaceMedia(workspaceDir, raw)
    if ('error' in file) {
      errors.push(file.error)
      continue
    }
    const r = await upload(file)
    if (r.ok && r.data?.id) files.push(r.data)
    else errors.push(`${raw}: ${r.error ?? 'upload failed'}`)
  }
  if (paths.length > MAX_MEDIA_FILES) errors.push(`Only the first ${MAX_MEDIA_FILES} files were attached`)
  return { files, errors }
}

const MARKDOWN_MEDIA_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g
const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const URL_RE = /^(?:[a-z][a-z0-9+.-]*:(?!\/\/\/)|\/\/|#|\/api\/)/i

/** Target of a markdown image that names a workspace file, or null for URLs. */
export function workspaceMediaRef(target: string): string | null {
  const value = target.trim().replace(/^<|>$/g, '').trim()
  if (!value || URL_RE.test(value)) return null
  return value
}

/**
 * Upload the workspace images and videos that `![alt](path)` refs in
 * `markdown` point at, and rewrite those refs to the stored URLs. Refs that
 * fail are left as written and reported in `errors`.
 */
export async function publishWorkspaceMedia(
  markdown: string,
  workspaceDir: string,
  upload: MediaUploader,
): Promise<{ markdown: string; uploaded: number; errors: string[] }> {
  if (!markdown.includes('![')) return { markdown, uploaded: 0, errors: [] }
  const fences: string[] = []
  const masked = markdown.replace(FENCE_RE, (m) => {
    fences.push(m)
    return `\u0000FENCE${fences.length - 1}\u0000`
  })

  const refs = [...new Set([...masked.matchAll(MARKDOWN_MEDIA_RE)].map((m) => workspaceMediaRef(m[2]!)).filter((r): r is string => !!r))]
  const { files, errors } = refs.length
    ? await uploadWorkspaceMediaByRef(workspaceDir, refs, upload)
    : { files: new Map<string, string>(), errors: [] as string[] }

  const rewritten = masked.replace(MARKDOWN_MEDIA_RE, (full, alt: string, target: string, title: string) => {
    const ref = workspaceMediaRef(target)
    const url = ref ? files.get(ref) : undefined
    return url ? `![${alt}](${url}${title})` : full
  })
  return {
    markdown: rewritten.replace(/\u0000FENCE(\d+)\u0000/g, (_, i: string) => fences[Number(i)] ?? ''),
    uploaded: files.size,
    errors,
  }
}

async function uploadWorkspaceMediaByRef(workspaceDir: string, refs: string[], upload: MediaUploader) {
  const files = new Map<string, string>()
  const errors: string[] = []
  for (const ref of refs.slice(0, MAX_MEDIA_FILES)) {
    const result = await uploadWorkspaceMedia(workspaceDir, [ref], upload)
    const stored = result.files[0]
    // Stored URLs carry no extension; the fragment tells renderers whether it's a video.
    if (stored) files.set(ref, `${stored.url}#${encodeURIComponent(stored.name)}`)
    errors.push(...result.errors)
  }
  if (refs.length > MAX_MEDIA_FILES) errors.push(`Only the first ${MAX_MEDIA_FILES} images were uploaded`)
  return { files, errors }
}
