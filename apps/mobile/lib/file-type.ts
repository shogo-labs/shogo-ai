// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What a shared file *is*, in the terms people recognise: a `PowerPoint
 * Presentation` badge rather than `application/vnd.openxmlformats-…`. Drives the
 * file tile on attachment cards and in the Files pane.
 *
 * The extension is consulted before the MIME type on purpose. Browsers send a
 * bare `application/octet-stream` for plenty of files, and `.shogo` project
 * archives have no registered type at all, while the extension is what the
 * person who shared the file actually sees in the name.
 */

export interface FileTypeMeta {
  /** What the file is, named the way file managers name it. */
  label: string
  /** Tile colour behind the glyph. */
  color: string
  /** One to four characters drawn in the tile. */
  glyph: string
}

type FileKind =
  | 'pdf'
  | 'word'
  | 'powerpoint'
  | 'excel'
  | 'archive'
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'text'
  | 'file'

const KIND_META: Record<FileKind, FileTypeMeta> = {
  pdf: { label: 'PDF', color: '#DC2626', glyph: 'PDF' },
  word: { label: 'Word Document', color: '#2563EB', glyph: 'W' },
  powerpoint: { label: 'PowerPoint Presentation', color: '#EA580C', glyph: 'P' },
  excel: { label: 'Spreadsheet', color: '#16A34A', glyph: 'X' },
  archive: { label: 'Archive', color: '#A16207', glyph: 'ZIP' },
  image: { label: 'Image', color: '#0891B2', glyph: 'IMG' },
  audio: { label: 'Audio', color: '#9333EA', glyph: 'AUD' },
  video: { label: 'Video', color: '#DB2777', glyph: 'VID' },
  code: { label: 'Code File', color: '#475569', glyph: 'CODE' },
  text: { label: 'Text File', color: '#57534E', glyph: 'TXT' },
  file: { label: 'File', color: '#64748B', glyph: 'FILE' },
}

/** Kinds that name themselves with the extension instead of a fixed glyph. */
const EXTENSION_GLYPH_KINDS = new Set<FileKind>(['archive', 'code', 'text', 'file'])

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  docm: 'word',
  odt: 'word',
  rtf: 'word',
  pages: 'word',
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  pptm: 'powerpoint',
  odp: 'powerpoint',
  key: 'powerpoint',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  ods: 'excel',
  csv: 'excel',
  tsv: 'excel',
  numbers: 'excel',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  shogo: 'archive',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  heic: 'image',
  bmp: 'image',
  svg: 'image',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  avi: 'video',
  mkv: 'video',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  ts: 'code',
  tsx: 'code',
  py: 'code',
  rb: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  sql: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  html: 'code',
  css: 'code',
  scss: 'code',
  ipynb: 'code',
  txt: 'text',
  log: 'text',
  md: 'text',
  markdown: 'text',
  rst: 'text',
}

/** Types that carry text but are not prose: configuration, markup, source. */
const CODE_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-sh',
  'application/x-httpd-php',
  'application/x-python',
])

function kindFromMimeType(mimeType: string): FileKind | null {
  const type = mimeType.toLowerCase().split(';')[0]!.trim()
  if (!type) return null
  if (type === 'application/pdf') return 'pdf'
  if (type.includes('wordprocessingml') || type.includes('msword') || type === 'application/rtf') return 'word'
  if (type.includes('presentationml') || type.includes('powerpoint')) return 'powerpoint'
  if (type.includes('spreadsheetml') || type.includes('ms-excel') || type === 'text/csv') return 'excel'
  if (type === 'application/zip' || type === 'application/x-zip-compressed' || type === 'application/gzip' || type === 'application/x-tar' || type === 'application/x-7z-compressed') {
    return 'archive'
  }
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('audio/')) return 'audio'
  if (type.startsWith('video/')) return 'video'
  if (type.endsWith('+json') || type.endsWith('+xml') || CODE_MIME_TYPES.has(type)) return 'code'
  if (type.startsWith('text/')) return type === 'text/plain' ? 'text' : 'code'
  return null
}

/** The trailing extension of a name, lowercased, or null when it has none worth reading. */
export function fileExtension(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  const extension = base.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : null
}

export function fileTypeMeta(name: string, mimeType?: string | null): FileTypeMeta {
  const extension = fileExtension(name)
  const kind = (extension ? KIND_BY_EXTENSION[extension] : undefined) ?? kindFromMimeType(mimeType ?? '') ?? 'file'
  const meta = KIND_META[kind]
  if (!EXTENSION_GLYPH_KINDS.has(kind) || !extension) return meta
  return { ...meta, glyph: extension.toUpperCase().slice(0, 4) }
}
