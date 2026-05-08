// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool Summary
 *
 * Maps tool calls (built-in tool names + Bash/exec commands) to a short
 * human-readable label like { verb: "Read", target: "package.json" } so
 * the chat thread can show "Read package.json" instead of dumping the
 * raw command string.
 *
 * Pure module — no React / RN imports. Safe to unit-test directly.
 */

import { getToolKeyArg } from "./types"

export interface ToolSummary {
  verb: string
  target?: string
  /**
   * Additional segments chained with `&&` after the primary verb.
   * Renderers should join with " && " for display, e.g.
   * `bun test && bun lint` -> { verb:"Run", target:"test", rest:[{verb:"Run", target:"lint"}] }.
   * Only populated by `parseShellCommand` for `&&`-joined shell commands.
   */
  rest?: ToolSummary[]
}

const TARGET_MAX = 40

function basename(path: string): string {
  if (!path) return path
  const cleaned = path.replace(/\/+$/, "")
  const segments = cleaned.split("/")
  return segments[segments.length - 1] || cleaned
}

function truncate(value: string, max = TARGET_MAX): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + "…"
}

function dequote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1)
    }
  }
  return value
}

function urlHost(url: string): string | undefined {
  if (!url) return undefined
  // Lightweight parse — `URL` works in RN/web but throws on bad input.
  try {
    const u = new URL(url)
    return u.host || undefined
  } catch {
    const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i)
    return match?.[1]
  }
}

/**
 * Tokenize a single shell command line, honoring single/double-quoted
 * args. Doesn't handle escapes or env-var expansion — we only need the
 * first few tokens for the summary.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    const ch = line[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      while (j < line.length && line[j] !== quote) j++
      tokens.push(line.slice(i + 1, j))
      i = j + 1
    } else {
      let j = i
      while (j < line.length && !/\s/.test(line[j])) j++
      tokens.push(line.slice(i, j))
      i = j
    }
  }
  return tokens
}

function firstNonFlagArg(tokens: string[], startIdx: number): string | undefined {
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.startsWith("-")) return dequote(t)
  }
  return undefined
}

interface SegmentWithSep {
  /** Trimmed text of the segment, e.g. "bun test". */
  text: string
  /** Separator that preceded this segment ("" for the first one). */
  sep: "" | "&&" | "||" | ";" | "|"
}

/**
 * Split the first line of `command` into top-level segments at `&&`, `||`,
 * `;`, and `|`, retaining the separator that precedes each segment.
 * Quote-awareness is intentionally rough — the verbs we care about rarely
 * contain these chars in their own args.
 */
function splitSegmentsWithSep(command: string): SegmentWithSep[] {
  const firstLine = command.split("\n")[0] ?? ""
  const out: SegmentWithSep[] = []
  let i = 0
  let start = 0
  let pendingSep: SegmentWithSep["sep"] = ""
  const flush = (end: number, nextSep: SegmentWithSep["sep"]) => {
    const text = firstLine.slice(start, end).trim()
    if (text) out.push({ text, sep: pendingSep })
    pendingSep = nextSep
  }
  while (i < firstLine.length) {
    const two = firstLine.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      flush(i, two as "&&" | "||")
      i += 2
      start = i
      continue
    }
    const ch = firstLine[i]
    if (ch === ";" || ch === "|") {
      flush(i, ch as ";" | "|")
      i += 1
      start = i
      continue
    }
    i += 1
  }
  flush(firstLine.length, "")
  return out
}

/**
 * Heuristic shell-command -> verb/target mapping. Always returns *some*
 * summary — falls back to "Run <first-token>" when the verb is unknown.
 *
 * For `&&`-joined chains, the leading `cd` (navigation preamble) is
 * skipped and additional `&&`-joined commands are returned as `rest`
 * so renderers can show them inline:
 *
 *   "ls | grep foo"               -> { verb:"List" }                      (pipe stops chaining)
 *   "echo a; echo b"              -> { verb:"echo", target:"a" }          (; stops chaining)
 *   "cd foo && bun test"          -> { verb:"Run", target:"test" }
 *   "bun test && bun lint"        -> { verb:"Run", target:"test", rest:[{verb:"Run", target:"lint"}] }
 *   "cd foo && bun test && bun lint"
 *                                 -> { verb:"Run", target:"test", rest:[{verb:"Run", target:"lint"}] }
 *   "cd foo"                      -> { verb:"cd", target:"foo" }          (only segment, keep it)
 */
export function parseShellCommand(command: string): ToolSummary {
  const segments = splitSegmentsWithSep(command)
  if (segments.length === 0) return { verb: "Run" }

  const isCd = (s: SegmentWithSep) => s.text.split(/\s+/)[0] === "cd"

  // Find first non-cd segment; that's the primary verb. If everything is
  // cd, fall back to summarising the last cd so we still show something.
  let primaryIdx = segments.findIndex((s) => !isCd(s))
  if (primaryIdx === -1) primaryIdx = segments.length - 1

  const primary = parseSingleSegment(segments[primaryIdx].text)

  // Walk forward collecting additional &&-joined segments (skipping any
  // mid-chain cds, which are still navigation preamble). A non-`&&`
  // separator (`;`, `||`, `|`) terminates the chain — those don't
  // express the same "do A then B" intent.
  const rest: ToolSummary[] = []
  for (let i = primaryIdx + 1; i < segments.length; i++) {
    const seg = segments[i]
    if (seg.sep !== "&&") break
    if (isCd(seg)) continue
    rest.push(parseSingleSegment(seg.text))
  }
  if (rest.length > 0) primary.rest = rest

  return primary
}

function parseSingleSegment(segment: string): ToolSummary {
  if (!segment) return { verb: "Run" }
  const tokens = tokenize(segment)
  if (tokens.length === 0) return { verb: "Run" }

  const head = tokens[0]
  const rest = tokens.slice(1)

  switch (head) {
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Read", target: target ? basename(target) : undefined }
    }
    case "ls": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "List", target: target ? truncate(basename(target)) : undefined }
    }
    case "cd": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "cd", target: target ? basename(target) : undefined }
    }
    case "pwd":
      return { verb: "pwd" }
    case "mkdir": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Create directory", target: target ? basename(target) : undefined }
    }
    case "rm":
    case "rmdir": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Remove", target: target ? basename(target) : undefined }
    }
    case "mv": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Move", target: target ? basename(target) : undefined }
    }
    case "cp": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Copy", target: target ? basename(target) : undefined }
    }
    case "touch": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Touch", target: target ? basename(target) : undefined }
    }
    case "grep":
    case "rg":
    case "ag": {
      const pattern = firstNonFlagArg(rest, 0)
      return { verb: "Search for", target: pattern ? truncate(pattern, 30) : undefined }
    }
    case "find": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Find in", target: target ? truncate(basename(target)) : undefined }
    }
    case "echo": {
      const target = rest.length > 0 ? dequote(rest.join(" ")) : undefined
      return { verb: "echo", target: target ? truncate(target, 30) : undefined }
    }
    case "curl":
    case "wget": {
      const url = firstNonFlagArg(rest, 0)
      return { verb: "Fetch", target: url ? (urlHost(url) ?? truncate(url)) : undefined }
    }
    case "git": {
      const sub = rest[0]
      return { verb: sub ? `git ${sub}` : "git" }
    }
    case "npm":
    case "bun":
    case "pnpm":
    case "yarn": {
      const sub = rest[0]
      if (!sub) return { verb: "Run", target: head }
      if (sub === "install" || sub === "add" || (head === "yarn" && sub === "add")) {
        const pkg = firstNonFlagArg(rest, 1)
        return { verb: "Install", target: pkg ? truncate(pkg, 30) : undefined }
      }
      if (sub === "run") {
        const script = firstNonFlagArg(rest, 1)
        return { verb: "Run", target: script ? truncate(script, 30) : undefined }
      }
      // `bun foo.ts`, `bun test`, etc.
      if (head === "bun" && sub) {
        const target = sub.endsWith(".ts") || sub.endsWith(".js") || sub.endsWith(".mjs")
          ? basename(sub)
          : sub
        return { verb: "Run", target: truncate(target, 30) }
      }
      return { verb: `${head} ${sub}` }
    }
    case "node":
    case "python":
    case "python3":
    case "tsx":
    case "deno": {
      const target = firstNonFlagArg(rest, 0)
      return { verb: "Run", target: target ? basename(target) : head }
    }
    default: {
      // Unknown verb — keep the command name as the verb so it's still
      // identifiable, no target.
      return { verb: "Run", target: truncate(head, 30) }
    }
  }
}

/**
 * Map a tool call (toolName + args) to a short human-readable summary.
 * Only handles the "minimal-variant" allow-list; callers are expected to
 * route MCP / bespoke tools elsewhere.
 */
export function getToolSummary(
  toolName: string,
  args?: Record<string, unknown>,
): ToolSummary {
  const a = args ?? {}

  switch (toolName) {
    case "Read":
    case "read_file": {
      const path = (a.file_path ?? a.path) as string | undefined
      return { verb: "Read", target: path ? basename(path) : undefined }
    }
    case "Delete": {
      const path = (a.file_path ?? a.path) as string | undefined
      return { verb: "Delete", target: path ? basename(path) : undefined }
    }
    case "Grep":
    case "grep":
    case "search": {
      const pattern = a.pattern as string | undefined
      return { verb: "Search for", target: pattern ? truncate(pattern, 30) : undefined }
    }
    case "Glob":
    case "glob": {
      const pattern = (a.glob_pattern ?? a.pattern) as string | undefined
      return { verb: "Find files matching", target: pattern ? truncate(pattern, 30) : undefined }
    }
    case "ReadLints":
    case "read_lints": {
      const paths = a.paths as unknown
      const first = Array.isArray(paths) && typeof paths[0] === "string" ? (paths[0] as string) : undefined
      return { verb: "Read lints", target: first ? basename(first) : undefined }
    }
    case "WebSearch": {
      const term = a.search_term as string | undefined
      return { verb: "Search the web for", target: term ? truncate(term, 40) : undefined }
    }
    case "WebFetch": {
      const url = a.url as string | undefined
      return { verb: "Fetch", target: url ? (urlHost(url) ?? truncate(url)) : undefined }
    }
    case "Bash":
    case "exec": {
      const command = a.command as string | undefined
      if (command) return parseShellCommand(command)
      return { verb: "Run" }
    }
    default: {
      // Last-resort fallback — keep the raw tool name as the verb and use
      // the existing key-arg helper for the target. Callers in the
      // allow-list shouldn't hit this branch.
      const target = getToolKeyArg(toolName, args) ?? undefined
      return { verb: toolName, target: target ?? undefined }
    }
  }
}
