// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Icon for a file chip, chosen by extension. Glyph paths are drawn on a
 * 24x24 grid as 2px strokes (lucide geometry, ISC); badges are a filled
 * rounded square with short text, the way Office and most editors mark
 * documents and languages.
 */

export type FileGlyph =
  | "file"
  | "text"
  | "atom"
  | "braces"
  | "code"
  | "hash"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "terminal"
  | "database"
  | "sliders"
  | "lock"

export type FileTypeIconSpec =
  | { kind: "glyph"; glyph: FileGlyph; color: string }
  | { kind: "badge"; text: string; color: string; textColor: string }

export interface GlyphShape {
  paths: string[]
  circles?: { cx: number; cy: number; r: number }[]
}

const FILE_OUTLINE = [
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
  "M14 2v4a2 2 0 0 0 2 2h4",
]
const SQUARE = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"

export const GLYPHS: Record<FileGlyph, GlyphShape> = {
  file: { paths: FILE_OUTLINE },
  text: { paths: [...FILE_OUTLINE, "M8 13h8", "M8 17h6"] },
  atom: {
    paths: [
      "M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z",
      "M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z",
    ],
    circles: [{ cx: 12, cy: 12, r: 1 }],
  },
  braces: {
    paths: [
      "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1",
      "M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1",
    ],
  },
  code: { paths: ["m16 18 6-6-6-6", "m8 6-6 6 6 6"] },
  hash: { paths: ["M4 9h16", "M4 15h16", "M10 3 8 21", "M16 3l-2 18"] },
  image: {
    paths: [SQUARE, "m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"],
    circles: [{ cx: 9, cy: 9, r: 2 }],
  },
  video: { paths: [SQUARE, "m10 8 6 4-6 4Z"] },
  audio: {
    paths: ["M9 18V5l12-2v13"],
    circles: [
      { cx: 6, cy: 18, r: 3 },
      { cx: 18, cy: 16, r: 3 },
    ],
  },
  archive: { paths: ["M21 8v13H3V8", "M1 3h22v5H1Z", "M10 12h4"] },
  terminal: { paths: [SQUARE, "m7 11 2-2-2-2", "M11 13h4"] },
  database: {
    paths: [
      "M3 5a9 3 0 1 0 18 0 9 3 0 1 0-18 0",
      "M3 5v14a9 3 0 0 0 18 0V5",
      "M3 12a9 3 0 0 0 18 0",
    ],
  },
  sliders: {
    paths: ["M20 7h-9", "M14 17H5"],
    circles: [
      { cx: 17, cy: 17, r: 3 },
      { cx: 7, cy: 7, r: 3 },
    ],
  },
  lock: {
    paths: [
      "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z",
      "M7 11V7a5 5 0 0 1 10 0v4",
    ],
  },
}

const glyph = (g: FileGlyph, color: string): FileTypeIconSpec => ({ kind: "glyph", glyph: g, color })
const badge = (text: string, color: string, textColor = "#ffffff"): FileTypeIconSpec => ({
  kind: "badge",
  text,
  color,
  textColor,
})

const BY_EXTENSION: Record<string, FileTypeIconSpec> = {
  tsx: glyph("atom", "#149eca"),
  jsx: glyph("atom", "#149eca"),
  ts: badge("TS", "#3178c6"),
  mts: badge("TS", "#3178c6"),
  cts: badge("TS", "#3178c6"),
  js: badge("JS", "#f7df1e", "#323330"),
  mjs: badge("JS", "#f7df1e", "#323330"),
  cjs: badge("JS", "#f7df1e", "#323330"),
  json: glyph("braces", "#d4a72c"),
  jsonc: glyph("braces", "#d4a72c"),
  md: badge("M↓", "#519aba"),
  mdx: badge("M↓", "#519aba"),
  doc: badge("W", "#2b579a"),
  docx: badge("W", "#2b579a"),
  xls: badge("X", "#217346"),
  xlsx: badge("X", "#217346"),
  csv: badge("CSV", "#217346"),
  tsv: badge("TSV", "#217346"),
  ppt: badge("P", "#d24726"),
  pptx: badge("P", "#d24726"),
  key: badge("K", "#1f8ced"),
  pdf: badge("PDF", "#e5252a"),
  txt: glyph("text", "#8b949e"),
  log: glyph("text", "#8b949e"),
  rtf: glyph("text", "#8b949e"),
  css: glyph("hash", "#42a5f5"),
  scss: glyph("hash", "#cd6799"),
  sass: glyph("hash", "#cd6799"),
  less: glyph("hash", "#1d365d"),
  html: glyph("code", "#e44d26"),
  htm: glyph("code", "#e44d26"),
  vue: glyph("code", "#41b883"),
  svelte: glyph("code", "#ff3e00"),
  xml: glyph("code", "#e37933"),
  py: badge("PY", "#3572a5"),
  go: badge("GO", "#00add8"),
  rs: badge("RS", "#b7410e"),
  rb: badge("RB", "#cc342d"),
  java: badge("JV", "#b07219"),
  kt: badge("KT", "#7f52ff"),
  swift: badge("SW", "#f05138"),
  php: badge("PHP", "#777bb4"),
  c: badge("C", "#555555"),
  h: badge("H", "#555555"),
  cpp: badge("C++", "#f34b7d"),
  cs: badge("C#", "#178600"),
  sh: glyph("terminal", "#4eaa25"),
  bash: glyph("terminal", "#4eaa25"),
  zsh: glyph("terminal", "#4eaa25"),
  ps1: glyph("terminal", "#012456"),
  sql: glyph("database", "#e38c00"),
  db: glyph("database", "#e38c00"),
  sqlite: glyph("database", "#e38c00"),
  prisma: glyph("database", "#5a67d8"),
  yml: glyph("sliders", "#cb171e"),
  yaml: glyph("sliders", "#cb171e"),
  toml: glyph("sliders", "#9c4221"),
  ini: glyph("sliders", "#8b949e"),
  env: glyph("lock", "#d4a72c"),
  png: glyph("image", "#26a269"),
  jpg: glyph("image", "#26a269"),
  jpeg: glyph("image", "#26a269"),
  gif: glyph("image", "#26a269"),
  webp: glyph("image", "#26a269"),
  avif: glyph("image", "#26a269"),
  ico: glyph("image", "#26a269"),
  svg: glyph("image", "#ffb13b"),
  mp4: glyph("video", "#e11d48"),
  mov: glyph("video", "#e11d48"),
  webm: glyph("video", "#e11d48"),
  m4v: glyph("video", "#e11d48"),
  mp3: glyph("audio", "#8b5cf6"),
  wav: glyph("audio", "#8b5cf6"),
  m4a: glyph("audio", "#8b5cf6"),
  ogg: glyph("audio", "#8b5cf6"),
  flac: glyph("audio", "#8b5cf6"),
  zip: glyph("archive", "#a16207"),
  tar: glyph("archive", "#a16207"),
  gz: glyph("archive", "#a16207"),
  tgz: glyph("archive", "#a16207"),
  rar: glyph("archive", "#a16207"),
  "7z": glyph("archive", "#a16207"),
}

const DEFAULT_SPEC = glyph("file", "#8b949e")

/** Badge text size on the 16x16 badge grid, so three letters still fit. */
export function badgeFontSize(text: string): number {
  return text.length >= 3 ? 5.6 : text.length === 2 ? 7.5 : 10
}

export function fileTypeIconFor(path: string): FileTypeIconSpec {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase()
  if (name === ".env" || name.startsWith(".env.")) return BY_EXTENSION.env!
  const dot = name.lastIndexOf(".")
  if (dot < 0) return DEFAULT_SPEC
  return BY_EXTENSION[name.slice(dot + 1)] ?? DEFAULT_SPEC
}
