// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn file paths that an agent mentions in chat into links the UI can open.
 *
 * Workspace runtimes keep each project in a top-level folder named by project
 * id, so a path like `<uuid>/BILLING-AUDIT.md` is workspace-relative. Paths
 * without that prefix stay relative to the chat's current project.
 */

/**
 * Relative href with no URL scheme. Streamdown's sanitizer drops unknown
 * protocols (`shogo-file:`) and renders them as blocked text, so the path
 * rides in a query string instead.
 */
export const FILE_HREF_PREFIX = "/shogo-file?path="

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A single path segment the agent would actually write. */
const SEGMENT = String.raw`[A-Za-z0-9_.@+-]+`
const FILE_WITH_EXT = new RegExp(
  `^(?:${SEGMENT}/)*${SEGMENT}\\.[A-Za-z0-9]{1,12}$`,
)
const ABS_FILE_WITH_EXT = new RegExp(
  `^(?:/|[A-Za-z]:[/\\\\])(?:${SEGMENT}/)*${SEGMENT}\\.[A-Za-z0-9]{1,12}$`,
)

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const EXISTING_LINK_RE = /\[[^\]]*\]\([^)\n]*\)/g
const INLINE_CODE_RE = /`([^`\n]+)`/g
const BARE_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_./:-])(?!https?:\\/\\/|www\\.)(?:${SEGMENT}/)+${SEGMENT}\\.[A-Za-z0-9]{1,12}(?![A-Za-z0-9_/])`,
  "g",
)

export function fileHref(path: string): string {
  return `${FILE_HREF_PREFIX}${encodeURIComponent(path)}`
}

export function pathFromFileHref(href: string): string | null {
  try {
    const url = new URL(href, "http://shogo.local")
    if (url.pathname !== "/shogo-file") return null
    const path = url.searchParams.get("path")
    return path && path.length > 0 ? path : null
  } catch {
    return null
  }
}

function isUrl(value: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(value)
}

/** A backticked or bare token that names a file, or null. */
export function filePathCandidate(
  raw: string,
  opts: { requireSlash: boolean },
): string | null {
  const trimmed = raw.trim().replace(/^[('"]+|[)'",.;:]+$/g, "")
  if (!trimmed || /\s/.test(trimmed) || isUrl(trimmed)) return null
  const normalized = trimmed.replace(/\\/g, "/")
  const looksLikeFile =
    FILE_WITH_EXT.test(normalized) || ABS_FILE_WITH_EXT.test(normalized)
  if (!looksLikeFile) return null
  if (opts.requireSlash && !normalized.includes("/")) return null
  return normalized
}

function mask(
  source: string,
  pattern: RegExp,
  bucket: string[],
  tag: string,
): string {
  return source.replace(pattern, (match) => {
    bucket.push(match)
    return `\u0000${tag}${bucket.length - 1}\u0000`
  })
}

function unmask(source: string, bucket: string[], tag: string): string {
  return source.replace(
    new RegExp(`\u0000${tag}(\\d+)\u0000`, "g"),
    (_, index: string) => bucket[Number(index)] ?? "",
  )
}

/**
 * Wrap detected file paths in markdown links whose href is `/shogo-file?path=`.
 * Fenced code blocks and links that are already present are left alone.
 */
export function linkifyFilePaths(markdown: string): string {
  const fences: string[] = []
  const links: string[] = []
  let text = mask(markdown, FENCE_RE, fences, "FENCE")
  text = mask(text, EXISTING_LINK_RE, links, "LINK")

  text = text.replace(INLINE_CODE_RE, (full, inner: string) => {
    const path = filePathCandidate(inner, { requireSlash: false })
    if (!path) return full
    return `[\`${inner}\`](${fileHref(path)})`
  })

  text = mask(text, EXISTING_LINK_RE, links, "LINK")
  text = text.replace(BARE_PATH_RE, (match) => {
    const path = filePathCandidate(match, { requireSlash: true })
    if (!path) return match
    return `[${match}](${fileHref(path)})`
  })

  text = unmask(text, links, "LINK")
  text = unmask(text, fences, "FENCE")
  return text
}

export interface ResolvedChatFile {
  projectId: string | null
  relPath: string
}

/**
 * Split a path the agent wrote into the project that owns it and the path
 * relative to that project's root. A leading (or embedded, for absolute
 * paths) UUID segment is the project id used by the merged workspace root.
 */
export function resolveChatFilePath(
  path: string,
  fallbackProjectId?: string | null,
): ResolvedChatFile | null {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if (!normalized) return null

  const segments = normalized.split("/").filter((segment) => segment.length > 0)
  const uuidAt = segments.findIndex((segment) => UUID_RE.test(segment))
  if (uuidAt >= 0 && uuidAt < segments.length - 1) {
    return {
      projectId: segments[uuidAt]!,
      relPath: segments.slice(uuidAt + 1).join("/"),
    }
  }

  const relPath = normalized.replace(/^\/+/, "")
  if (!relPath || !fallbackProjectId) return null
  return { projectId: fallbackProjectId, relPath }
}
