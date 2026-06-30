// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Deliverable file detection.
 *
 * Used to auto-offer a download affordance for files the agent produces that a
 * user is likely to want to save (a generated PPT/PDF/CSV/ZIP/video/image),
 * without a dedicated agent tool. The allowlist deliberately excludes source
 * and code files so the dozens of intermediate `write_file` calls during a
 * build don't each sprout a Download chip.
 */

// Curated allowlist of "the agent made me a thing" file extensions (no leading
// dot, lowercase). Keep this conservative — anything not here renders as a
// normal file widget with no download chip.
export const DELIVERABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents
  "pdf",
  "doc",
  "docx",
  // Presentations
  "ppt",
  "pptx",
  // Spreadsheets / data
  "csv",
  "xls",
  "xlsx",
  // Archives
  "zip",
  // Video
  "mp4",
  "mov",
  // Audio
  "mp3",
  "wav",
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
])

/**
 * Lowercased file extension (without the dot) for a path, or "" when there is
 * none. Handles both `/` and `\` separators and ignores leading-dot dotfiles
 * (e.g. `.env` has no extension here).
 */
export function getFileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return "" // no dot, or leading-dot dotfile
  return base.slice(dot + 1).toLowerCase()
}

/**
 * True when `path` looks like a user-facing deliverable worth offering as a
 * download. Returns false for empty/missing paths and for source/code files.
 */
export function isDeliverable(path: string | null | undefined): boolean {
  if (!path) return false
  return DELIVERABLE_EXTENSIONS.has(getFileExtension(path))
}
