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

/** Href that marks a markdown link as an @-mention, drawn as a highlight rather than a link. */
export const MENTION_HREF_PREFIX = "/shogo-mention"

/**
 * Who a mention points at: a person, an agent, a user group, or a channel.
 * The id rides in the href so a tap can open that target's profile or take
 * the reader to the channel; a mention with no target (`@here`, `@channel`,
 * and a `#channel` the reader cannot see) keeps the bare prefix.
 */
export type MentionTargetKind = "u" | "a" | "g" | "c"

export interface MentionTarget {
  kind: MentionTargetKind
  id: string
}

export function isMentionHref(href: string | undefined | null): boolean {
  return typeof href === "string" && href.startsWith(MENTION_HREF_PREFIX)
}

/** Agent keys are `ws` or `p:<projectId>`, so the id is always escaped. */
export function mentionHref(kind: MentionTargetKind, id: string): string {
  return `${MENTION_HREF_PREFIX}/${kind}/${encodeURIComponent(id)}`
}

/** The target a mention points at, or null for a bare or malformed href. */
export function mentionTargetFromHref(
  href: string | undefined | null,
): MentionTarget | null {
  if (!isMentionHref(href)) return null
  const match = /^\/(u|a|g|c)\/([^/?#]+)$/.exec(href!.slice(MENTION_HREF_PREFIX.length))
  if (!match) return null
  try {
    return { kind: match[1] as MentionTargetKind, id: decodeURIComponent(match[2]!) }
  } catch {
    return null
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A single path segment the agent would actually write. */
const SEGMENT = String.raw`[A-Za-z0-9_.@+-]+`
/**
 * A file extension: 1-12 alphanumerics that must contain a letter. Without
 * the letter, a version number is read as a file type and `Qwen3.8` or
 * `v1.2` becomes a link to a file that does not exist.
 */
const EXT = String.raw`(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,12}`
const FILE_WITH_EXT = new RegExp(
  `^(?:${SEGMENT}/)*${SEGMENT}\\.${EXT}$`,
)
const ABS_FILE_WITH_EXT = new RegExp(
  `^(?:/|[A-Za-z]:[/\\\\])(?:${SEGMENT}/)*${SEGMENT}\\.${EXT}$`,
)

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const EXISTING_LINK_RE = /\[[^\]]*\]\([^)\n]*\)/g
const INLINE_CODE_RE = /`([^`\n]+)`/g
const BARE_PATH_RE = new RegExp(
  `(?<![A-Za-z0-9_./:@+-])(?!https?:\\/\\/|www\\.)(?:${SEGMENT}/)+${SEGMENT}\\.${EXT}(?![A-Za-z0-9_/@+-]|\\.[A-Za-z0-9])`,
  "g",
)
const BARE_URL_RE =
  /(?<![<A-Za-z0-9_@./:-])((?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s<>"'`*]*)?)/g
const PUBLIC_TLD_RE =
  /^(?:com|org|net|io|ai|co|dev|edu|gov|me|ly|xyz|info|biz|tech|cloud|ca|uk|us|de|fr|in|jp|au)$/i

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
  // `../x.md` climbs out of the workspace: it never names a file we can serve,
  // and the file routes reject it anyway (SHO-242).
  if (normalized.split("/").some((segment) => segment === "..")) return null
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
 * Fenced code blocks, inline code that is not itself a path, and links that
 * are already present are left alone.
 */
export function linkifyFilePaths(markdown: string): string {
  const fences: string[] = []
  const links: string[] = []
  const inlineCode: string[] = []
  let text = mask(markdown, FENCE_RE, fences, "FENCE")
  text = mask(text, EXISTING_LINK_RE, links, "LINK")

  text = text.replace(INLINE_CODE_RE, (full, inner: string) => {
    const path = filePathCandidate(inner, { requireSlash: false })
    if (!path) return full
    return `[\`${inner}\`](${fileHref(path)})`
  })

  text = mask(text, EXISTING_LINK_RE, links, "LINK")
  // A code span that is not a path is code, not prose: masking it keeps the
  // bare-path pass from writing markdown inside the backticks, where it would
  // render as literal text (`bun run [src/server.ts](/shogo-file?...)`).
  text = mask(text, INLINE_CODE_RE, inlineCode, "CODE")
  text = text.replace(BARE_PATH_RE, (match) => {
    const path = filePathCandidate(match, { requireSlash: true })
    if (!path) return match
    return `[${match}](${fileHref(path)})`
  })

  text = unmask(text, inlineCode, "CODE")
  text = unmask(text, links, "LINK")
  text = unmask(text, fences, "FENCE")
  return text
}

const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * True when a link target names something inside the workspace rather than a
 * URL or an app route: no scheme, and not rooted (`/`, `//`) or a fragment.
 */
function isWorkspaceRelativeHref(href: string): boolean {
  if (!href) return false
  if (SCHEME_RE.test(href)) return false
  if (href.startsWith("/") || href.startsWith("#")) return false
  if (
    href.startsWith(FILE_HREF_PREFIX) ||
    href.startsWith(IMAGE_SRC_PREFIX) ||
    isMentionHref(href)
  ) {
    return false
  }
  return true
}

export interface ResolveRelativeLinksOptions {
  /** Turn a workspace-relative path into a `/shogo-file` link; false unwraps it. */
  fileLinks: boolean
}

/**
 * Resolve markdown links whose href is a workspace-relative path.
 *
 * A renderer cannot open a bare `plans/x.md`: Streamdown's link hardener
 * rejects any relative href that does not start with `/`, `./` or `../` and
 * prints `[blocked]` in its place, and a native tap hands the path to a URL
 * opener. So a link we wrote is rewritten to `fileHref(path)` when the host
 * can open files, and otherwise unwrapped to its text (as inline code when the
 * text is the path). `../` never becomes a file link — it leaves the workspace.
 * Fences and inline code are masked, so neither is touched.
 */
export function resolveRelativeLinks(
  markdown: string,
  opts: ResolveRelativeLinksOptions,
): string {
  if (!markdown.includes("](")) return markdown
  const fences: string[] = []
  const inlineCode: string[] = []
  let text = mask(markdown, FENCE_RE, fences, "FENCE")
  text = mask(text, INLINE_CODE_RE, inlineCode, "CODE")

  text = text.replace(
    MARKDOWN_LINK_RE,
    (full, image: string, label: string, target: string, title: string) => {
      if (image) return full
      const href = target.startsWith("<") ? target.slice(1, -1).trim() : target
      if (!isWorkspaceRelativeHref(href)) return full

      const bare = href.replace(/^\.\//, "")
      const path = href.startsWith("../") ? null : filePathCandidate(bare, { requireSlash: false })
      if (opts.fileLinks && path) return `[${label}](${fileHref(path)}${title})`

      const shown = label.trim()
      if (!shown) return ""
      return shown === href || shown === bare ? `\`${shown}\`` : label
    },
  )

  text = unmask(text, inlineCode, "CODE")
  return unmask(text, fences, "FENCE")
}

function hasUnmatchedOpening(value: string, opening: string, closing: string): boolean {
  let depth = 0
  for (const char of value) {
    if (char === opening) depth += 1
    if (char === closing) depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

function splitTrailingUrlPunctuation(match: string): {
  candidate: string
  trailing: string
} {
  let candidate = match
  let trailing = ""
  // A share token is base64url, so it can end in `_`. Stripping that one
  // character breaks the signature and the link comes back "invalid" (SHO-80).
  const shareLink = /\/f\//.test(match)

  while (candidate) {
    const char = candidate[candidate.length - 1]
    if (!/[.,!?;:)\]}*_~"'>]/.test(char)) break
    if (char === "_" && shareLink) break
    if (
      (char === ")" && hasUnmatchedOpening(candidate.slice(0, -1), "(", ")")) ||
      (char === "]" && hasUnmatchedOpening(candidate.slice(0, -1), "[", "]")) ||
      (char === "}" && hasUnmatchedOpening(candidate.slice(0, -1), "{", "}"))
    ) {
      break
    }
    candidate = candidate.slice(0, -1)
    trailing = char + trailing
  }

  return { candidate, trailing }
}

/**
 * Make the domains people naturally type in chat clickable too. Markdown
 * already handles explicit links, but bare `example.com` text otherwise
 * remains plain text. Fences, inline code, existing links, emails, and file
 * paths are masked so this does not alter code or workspace references.
 */
export function linkifyBareUrls(markdown: string): string {
  const fences: string[] = []
  const links: string[] = []
  const inlineCode: string[] = []
  let text = mask(markdown, FENCE_RE, fences, "FENCE")
  text = mask(text, EXISTING_LINK_RE, links, "LINK")
  text = mask(text, INLINE_CODE_RE, inlineCode, "CODE")

  text = text.replace(BARE_URL_RE, (match) => {
    const { candidate, trailing } = splitTrailingUrlPunctuation(match)
    const host = candidate.split("/")[0]?.split(".").pop() ?? ""
    const firstSegment = candidate.split("/")[0] ?? ""

    // `src/file.ts` is a file path, not a web address. Keep it available to
    // the file-path linkifier instead.
    if (
      !candidate ||
      firstSegment.includes("@") ||
      (candidate.includes("/") && !firstSegment.includes(".")) ||
      !PUBLIC_TLD_RE.test(host)
    ) {
      return match
    }

    const href = `https://${candidate}`
    return `[${candidate}](${href})${trailing}`
  })

  text = unmask(text, inlineCode, "CODE")
  text = unmask(text, links, "LINK")
  return unmask(text, fences, "FENCE")
}

/**
 * Relative src for a markdown image that points at a workspace file.
 * Streamdown's sanitizer replaces bare paths like `brand/x.png` with
 * "[Image blocked]", so the path rides in a query string instead.
 */
export const IMAGE_SRC_PREFIX = "/shogo-image?path="

const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g
const PASSTHROUGH_SRC_RE = /^(?:[a-z][a-z0-9+.-]*:(?!\/\/\/)|\/\/|#)/i
const VIDEO_EXT_RE = /\.(?:mp4|m4v|webm|mov|ogv)(?:[?#].*)?$/i

export function imageSrcHref(path: string): string {
  return `${IMAGE_SRC_PREFIX}${encodeURIComponent(path)}`
}

export function pathFromImageSrc(src: string | null | undefined): string | null {
  if (typeof src !== "string") return null
  try {
    const url = new URL(src, "http://shogo.local")
    if (url.pathname !== "/shogo-image") return null
    const path = url.searchParams.get("path")
    return path && path.length > 0 ? path : null
  } catch {
    return null
  }
}

export function isVideoSrc(src: string | null | undefined): boolean {
  return typeof src === "string" && VIDEO_EXT_RE.test(src)
}

/** Stored chat or channel file that loads without the agent being awake. */
export function isStoredMediaSrc(src: string): boolean {
  return src.startsWith("/api/chat-attachments/") || src.startsWith("/api/conversation-files/")
}

/**
 * Workspace path for a markdown media target, or null when the target is a
 * URL the browser can load as is.
 */
export function workspaceMediaTarget(target: string): string | null {
  let value = target.trim()
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim()
  if (!value) return null
  if (/^file:\/\//i.test(value)) {
    try {
      value = decodeURIComponent(new URL(value).pathname)
    } catch {
      return null
    }
  } else if (PASSTHROUGH_SRC_RE.test(value)) {
    return null
  }
  if (value.startsWith(IMAGE_SRC_PREFIX) || isStoredMediaSrc(value)) return null
  return value
}

/**
 * Workspace-relative path the runtime's download route expects. Absolute
 * sandbox paths keep only what follows the workspace root.
 */
export function normalizeWorkspaceMediaPath(path: string): string {
  let value = path.replace(/\\/g, "/").replace(/^\.\//, "")
  const rooted = /\/(?:app\/)?workspace\/(.+)$/.exec(value)
  if (value.startsWith("/") && rooted) value = rooted[1]!
  return value.replace(/^\/+/, "")
}

/**
 * Point markdown images at workspace files through `IMAGE_SRC_PREFIX`.
 * URLs, data and blob sources, and images inside code are left alone.
 */
export function rewriteWorkspaceMedia(markdown: string): string {
  if (!markdown.includes("![")) return markdown
  const fences: string[] = []
  const inlineCode: string[] = []
  let text = mask(markdown, FENCE_RE, fences, "FENCE")
  text = mask(text, INLINE_CODE_RE, inlineCode, "CODE")
  text = text.replace(MARKDOWN_IMAGE_RE, (full, alt: string, target: string, title: string) => {
    const path = workspaceMediaTarget(target)
    if (!path) return full
    return `![${alt}](${imageSrcHref(path)}${title})`
  })
  text = unmask(text, inlineCode, "CODE")
  return unmask(text, fences, "FENCE")
}

/**
 * Whether a path the agent wrote names a file in `files`, the runtime's
 * file list. Project runtimes list project-relative paths; workspace
 * runtimes list `<projectId>/...`, so both spellings are tried.
 */
export function fileIndexHas(
  files: ReadonlySet<string>,
  path: string,
  projectId?: string | null,
): boolean {
  if (files.size === 0) return false
  const normalized = normalizeWorkspaceMediaPath(path.trim())
  if (!normalized) return false
  const candidates = new Set<string>([normalized])
  const resolved = resolveChatFilePath(normalized, projectId)
  if (resolved) {
    if (!projectId || resolved.projectId === projectId) candidates.add(resolved.relPath)
    if (resolved.projectId) candidates.add(`${resolved.projectId}/${resolved.relPath}`)
  }
  for (const candidate of candidates) {
    if (files.has(candidate)) return true
  }
  return false
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
