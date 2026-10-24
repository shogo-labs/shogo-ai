// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One answer to "what can we render for this file?".
 *
 * Every host that shows a file — the IDE, the workspace viewer, a `share_file`
 * link, a conversation attachment — asks this instead of growing its own
 * extension list, so a type we learn to render is renderable everywhere and a
 * file the server mislabels (`application/octet-stream` for an `.mp4` on
 * desktop) still opens as what it is.
 */

import { isBinaryFilePath } from "@shogo-ai/sdk/file-types"
import { previewLanguageFor, type PreviewLanguage } from "../project/panels/ide/FilePreview"
import { LANG_BY_EXT, extOf } from "../project/panels/ide/workspace/language"

/**
 * `image | sqlite | pdf | audio | video | font` render through the IDE's
 * preview components; `markdown` gets Preview + Source; `text` is Monaco;
 * `binary` is the honest "no preview" + download.
 */
export type FileViewKind = PreviewLanguage | "markdown" | "text" | "binary"

const MARKDOWN_EXT = /\.mdx?$/i

const SQLITE_MIMES = new Set(["application/vnd.sqlite3", "application/x-sqlite3"])
const FONT_MIMES = new Set([
  "application/font-woff",
  "application/font-woff2",
  "application/x-font-woff",
  "application/x-font-ttf",
  "application/x-font-opentype",
  "application/vnd.ms-fontobject",
])
const TEXTUAL_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/x-httpd-php",
  "application/sql",
  "application/toml",
  "application/x-sh",
])

function kindFromMime(mime?: string | null): FileViewKind | null {
  const value = (mime ?? "").toLowerCase().split(";")[0]!.trim()
  if (!value) return null
  if (value.startsWith("video/")) return "video"
  if (value.startsWith("audio/")) return "audio"
  if (value.startsWith("image/")) return "image"
  if (value === "application/pdf") return "pdf"
  if (value.startsWith("font/") || FONT_MIMES.has(value)) return "font"
  if (SQLITE_MIMES.has(value)) return "sqlite"
  if (value.startsWith("text/")) return "text"
  if (value.endsWith("+json") || value.endsWith("+xml") || value.endsWith("+yaml")) return "text"
  if (TEXTUAL_APPLICATION_MIMES.has(value)) return "text"
  return null
}

/**
 * The view for `name`, using `mime` only when the extension does not decide
 * it. An extension we render always wins: a `.mp4` served as
 * `application/octet-stream` is still a video.
 */
export function fileViewKind(name: string, mime?: string | null): FileViewKind {
  const preview = previewLanguageFor(name)
  if (preview) return preview
  if (MARKDOWN_EXT.test(name)) return "markdown"
  const ext = extOf(name)
  if (ext && LANG_BY_EXT[ext]) return "text"
  if (isBinaryFilePath(name)) return "binary"
  return kindFromMime(mime) ?? "text"
}

/**
 * The type to stamp on a blob URL for `name`. A response that says
 * `application/octet-stream` (the desktop `/api/f` route before its MIME
 * table knew media, or an upstream storage bucket that does not) leaves
 * `<video>` and `<audio>` unable to pick a decoder, so the name fills in.
 */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
}

const GENERIC_MIMES = new Set(["application/octet-stream", "binary/octet-stream", ""])

export function blobMimeType(name: string, mime?: string | null): string {
  const reported = (mime ?? "").toLowerCase().split(";")[0]!.trim()
  if (reported && !GENERIC_MIMES.has(reported)) return reported
  return MIME_BY_EXT[extOf(name)] ?? (reported || "application/octet-stream")
}
