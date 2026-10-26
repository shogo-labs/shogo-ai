// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The canvas-error "Debug" button seeds a fresh chat with a markdown prompt.
 * The same text is what the model reads and what the transcript card parses,
 * so a debug chat opened before the card existed still renders as a card.
 */

/** Cap any single error / log line so the seed prompt stays bounded. */
export const CANVAS_ERROR_MAX_LINE = 1200

const HEADER_PATTERN =
  /^🐞 The canvas just hit a (compile-time|runtime) error(?: \(page `([^`]*)`\))?\. /

export interface CanvasErrorDebugPromptInput {
  phase: "compile" | "runtime"
  error: string
  /** Iframe `pathname + search + hash` at the moment of the error. */
  route?: string
  /** Recent user-interaction breadcrumb from `canvas-bridge.js`, oldest first. */
  recentActions?: ReadonlyArray<{
    ts: number
    kind: string
    target?: string
    route?: string
  }>
  recentLogs: ReadonlyArray<{
    source: string
    level: string
    text: string
    ts: number
  }>
}

/** Parsed view of a canvas-error debug prompt. The model still sees the raw markdown. */
export interface CanvasErrorPrompt {
  phase: "compile" | "runtime"
  route?: string
  error: string
  actions: string[]
  logs: string[]
}

/**
 * Build the seed message that gets auto-sent into a fresh chat when the
 * user clicks "Debug" on a canvas-error toast.
 *
 * The prompt includes the iframe's current page, the phase (compile vs
 * runtime), the error string, the breadcrumb of recent user actions, and
 * the tail of the runtime log buffer.
 */
export function buildCanvasErrorDebugPrompt(
  args: CanvasErrorDebugPromptInput,
): string {
  const { phase, error, route, recentActions, recentLogs } = args
  const truncate = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`
  const phaseLabel = phase === "compile" ? "compile-time" : "runtime"
  const pageLabel = route ? ` (page \`${route}\`)` : ""

  const lines: string[] = []
  lines.push(
    `🐞 The canvas just hit a ${phaseLabel} error${pageLabel}. Please diagnose the root cause and propose / apply a minimal fix.`,
  )
  lines.push("")
  lines.push("**Error**")
  lines.push("```")
  lines.push(truncate(error, CANVAS_ERROR_MAX_LINE))
  lines.push("```")

  if (recentActions && recentActions.length > 0) {
    lines.push("")
    lines.push(
      `**Recent user actions** (last ${recentActions.length}, oldest first — most recent immediately before the error)`,
    )
    lines.push("```")
    for (const action of recentActions) {
      const ts = Number.isFinite(action.ts)
        ? new Date(action.ts).toISOString().slice(11, 23)
        : "--:--:--.---"
      const target = action.target ? ` ${action.target}` : ""
      const onPage =
        action.route && action.route !== route ? ` @ ${action.route}` : ""
      lines.push(
        truncate(
          `${ts} ${action.kind}${target}${onPage}`,
          CANVAS_ERROR_MAX_LINE,
        ),
      )
    }
    lines.push("```")
  }

  if (recentLogs.length > 0) {
    lines.push("")
    lines.push(
      `**Recent runtime logs** (last ${recentLogs.length}, oldest first)`,
    )
    lines.push("```")
    for (const entry of recentLogs) {
      const ts = new Date(entry.ts).toISOString().slice(11, 23)
      lines.push(
        `${ts} [${entry.source}] ${
          entry.level !== "info" ? `${entry.level.toUpperCase()} ` : ""
        }${truncate(entry.text, CANVAS_ERROR_MAX_LINE)}`,
      )
    }
    lines.push("```")
  }

  lines.push("")
  lines.push(
    "Read the relevant files, identify the offending change, and either propose a fix or apply it directly. Keep the change minimal and explain what went wrong.",
  )
  return lines.join("\n")
}

function fencedBlock(lines: readonly string[], from: number): string | null {
  let open = -1
  for (let i = from; i < lines.length; i++) {
    if (lines[i] === "```") {
      open = i
      break
    }
    if (lines[i].startsWith("**")) return null
  }
  if (open < 0) return null
  const close = lines.findIndex((line, index) => index > open && line === "```")
  if (close < 0) return null
  return lines.slice(open + 1, close).join("\n")
}

function sectionBody(
  lines: readonly string[],
  heading: (line: string) => boolean,
): string | null {
  const index = lines.findIndex(heading)
  if (index < 0) return null
  return fencedBlock(lines, index + 1)
}

function linesOf(body: string | null): string[] {
  if (!body) return []
  return body.split("\n")
}

/** The card payload for a canvas-error debug prompt, or null for any other message. */
export function parseCanvasErrorDebugPrompt(
  text: string,
): CanvasErrorPrompt | null {
  const trimmed = text.trim()
  const header = trimmed.match(HEADER_PATTERN)
  if (!header) return null
  const lines = trimmed.split(/\r?\n/)
  const error = sectionBody(lines, (line) => line === "**Error**")
  if (error == null) return null
  const route = header[2]
  return {
    phase: header[1] === "compile-time" ? "compile" : "runtime",
    ...(route ? { route } : {}),
    error,
    actions: linesOf(
      sectionBody(lines, (line) => line.startsWith("**Recent user actions**")),
    ),
    logs: linesOf(
      sectionBody(lines, (line) => line.startsWith("**Recent runtime logs**")),
    ),
  }
}
