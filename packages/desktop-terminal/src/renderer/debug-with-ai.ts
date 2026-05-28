// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Debug with AI" — when the user right-clicks a ✗ decoration, we
 * bundle a snapshot of the failing command into a `DebugContext` and
 * hand it to the host's `openChatWithContext()` IPC. The host opens
 * its chat panel pre-filled with our markdown report.
 *
 * This module is pure: it builds a JSON context object plus a
 * markdown serialisation. The actual chat panel + IPC tube are owned
 * by apps/desktop.
 */

import type { Command } from './osc633-tracker'
import type { BufferReader } from './quick-fix/quick-fix-manager'
import { tailLines } from './quick-fix/quick-fix-engine'

// ─── types ────────────────────────────────────────────────────────

export interface DebugEnvSnapshot {
  /** `process.env`-shape, filtered to relevant keys. */
  vars: Record<string, string>
  /** Specific subset the user can opt-in / opt-out for redaction. */
  hadSecretsRedacted: boolean
}

export interface DebugContext {
  commandLine: string
  cwd: string | null
  exitCode: number | null
  /** Trailing output lines, newline-joined. Bounded by `tailRows`. */
  output: string
  /** Shell binary path (e.g. /bin/zsh) if known. */
  shell: string | null
  /** Number of rows the output was sliced from. */
  outputRows: number
  /** Optional environment snapshot. */
  env?: DebugEnvSnapshot
  /** Approximate wall-clock seconds the command ran for. */
  durationMs: number | null
  /** Stable id from the tracker. */
  commandId: number
}

export interface BuildDebugContextOptions {
  command: Command
  buffer: BufferReader
  /** Captured shell path (e.g. /bin/zsh). Null when unknown. */
  shell?: string | null
  /** Max trailing rows of output to include. Default 40. */
  tailRows?: number
  /** Snapshot of process.env at failure time (optional). */
  env?: Record<string, string>
  /** Redact env keys matching this regex. Defaults match common secrets. */
  envRedactPattern?: RegExp
}

// Conservative default redaction list — names that almost-always carry
// secrets. Keeps the snapshot useful without leaking keys.
const DEFAULT_SECRET_RX = /(?:_|^)(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|API_KEY|CREDENTIAL)$|^GH_TOKEN$|^OPENAI_API_KEY$|^ANTHROPIC_API_KEY$|^AWS_(?:SECRET|SESSION)/i

// ─── builder ──────────────────────────────────────────────────────

/**
 * Build a `DebugContext` from a tracker Command + buffer reader.
 * Synchronous; safe to call from a context-menu click handler.
 */
export function buildDebugContext(opts: BuildDebugContextOptions): DebugContext {
  const c = opts.command
  const tailRows = Math.max(1, opts.tailRows ?? 40)
  let output = ''
  let outputRows = 0
  const start = c.startMarker?.line ?? null
  const end = c.endMarker?.line ?? null
  if (start !== null && end !== null && end > start) {
    const rows = opts.buffer.readRows(start, end)
    outputRows = rows.length
    output = tailLines(rows.join('\n'), tailRows)
  }

  const env = opts.env ? redactEnv(opts.env, opts.envRedactPattern ?? DEFAULT_SECRET_RX) : undefined

  return {
    commandId: c.id,
    commandLine: (c.commandLine ?? '').trim(),
    cwd: c.cwd ?? null,
    exitCode: c.exitCode,
    output,
    outputRows,
    shell: opts.shell ?? null,
    env,
    durationMs: c.startedAt !== null && c.finishedAt !== null
      ? Math.max(0, c.finishedAt - c.startedAt)
      : null,
  }
}

function redactEnv(env: Record<string, string>, rx: RegExp): DebugEnvSnapshot {
  const out: Record<string, string> = {}
  let redacted = false
  for (const [k, v] of Object.entries(env)) {
    if (rx.test(k)) { out[k] = '<redacted>'; redacted = true }
    else out[k] = v
  }
  return { vars: out, hadSecretsRedacted: redacted }
}

// ─── markdown serialisation ───────────────────────────────────────

/**
 * Render the context as a chat-ready markdown block. apps/desktop's
 * chat panel can take this verbatim. Sections appear in this order:
 *
 *   - Title
 *   - Command + cwd + shell + duration + exit code
 *   - Output (fenced code block)
 *   - Env (optional, fenced code block — only when env was captured)
 */
export function serialiseDebugContext(ctx: DebugContext): string {
  const lines: string[] = []
  lines.push(`## Help me debug this failing command`)
  lines.push('')
  lines.push(`**Command:** \`${ctx.commandLine || '(unknown)'}\``)
  if (ctx.cwd) lines.push(`**Working dir:** \`${ctx.cwd}\``)
  if (ctx.shell) lines.push(`**Shell:** \`${ctx.shell}\``)
  lines.push(`**Exit code:** ${ctx.exitCode === null ? 'interrupted' : String(ctx.exitCode)}`)
  if (ctx.durationMs !== null) lines.push(`**Duration:** ${formatMs(ctx.durationMs)}`)
  lines.push('')
  lines.push(`### Output (last ${ctx.outputRows} rows)`)
  lines.push('```')
  lines.push(ctx.output.length > 0 ? ctx.output : '(no output captured)')
  lines.push('```')
  if (ctx.env) {
    lines.push('')
    lines.push(`### Environment${ctx.env.hadSecretsRedacted ? ' (secrets redacted)' : ''}`)
    lines.push('```')
    for (const [k, v] of Object.entries(ctx.env.vars)) {
      lines.push(`${k}=${v}`)
    }
    lines.push('```')
  }
  return lines.join('\n')
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

// ─── handler shape for hosts ──────────────────────────────────────

export interface DebugWithAiHandler {
  /**
   * Host callback. Receives both the structured context AND the
   * pre-rendered markdown. Most hosts use the markdown directly; the
   * struct is provided for hosts that want to drive richer UI.
   */
  (ctx: DebugContext, markdown: string): void
}

/**
 * Convenience: build + serialise + forward in one call. Useful from
 * Phase-4's CommandDecorations click handler:
 *
 *     onClick: (e) => debugWithAi({
 *       command: e.command,
 *       buffer: bufferAdapter,
 *       shell: '/bin/zsh',
 *       handler: openChatWithContext,
 *     })
 */
export function debugWithAi(opts: BuildDebugContextOptions & { handler: DebugWithAiHandler }): DebugContext {
  const ctx = buildDebugContext(opts)
  opts.handler(ctx, serialiseDebugContext(ctx))
  return ctx
}
