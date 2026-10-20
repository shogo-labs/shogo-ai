// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the file viewer can do with a file, from its type and name.
 *
 * Kept out of the component so the decision can be checked on its own: which
 * files get a real renderer, which fall back to their extracted text, and
 * which are honestly just a download.
 */

/** How the viewer shows a file. `download` means "there is nothing to show". */
export type ViewerMode = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'download'

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'json', 'jsonc', 'csv', 'tsv', 'log', 'yml', 'yaml',
  'toml', 'ini', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx',
  'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'prisma', 'diff', 'patch',
])

export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function isPlainTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    mime.endsWith('+yaml')
  )
}

/**
 * The renderer for this file. `hasText` is the server's answer to whether it
 * holds — or can extract — the file's text, which is what turns a deck or a
 * report into something readable instead of an opaque download.
 */
export function viewerModeFor(mimeType: string, name: string, hasText: boolean): ViewerMode {
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (isPlainTextMime(mime) || TEXT_EXTENSIONS.has(fileExtension(name))) return 'text'
  return hasText ? 'text' : 'download'
}

/** Whether the text on screen was extracted from the file rather than being it. */
export function isExtractedPreview(mimeType: string, name: string): boolean {
  const mime = (mimeType || '').toLowerCase()
  return !isPlainTextMime(mime) && !TEXT_EXTENSIONS.has(fileExtension(name))
}
