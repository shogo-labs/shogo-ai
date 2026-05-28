// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QuickFixEngine — pure rule evaluator.
 *
 * Given a failed-command summary (commandLine, outputTail, cwd, exit
 * code) and a rule table, returns the suggestions to render. No
 * tracker, no xterm.js, no DOM — that's the manager's job. This split
 * makes the engine trivially testable: feed strings in, get
 * suggestions out.
 */

// ─── public types ──────────────────────────────────────────────────

export type QuickFixActionKind = 'run' | 'cmdk-fill' | 'link'

export interface QuickFixAction {
  /** What the host does when the user clicks the suggestion. */
  kind: QuickFixActionKind
  /**
   * For `run` → a shell command string the host sends to the PTY.
   *
   * For `cmdk-fill` → a string the host prefills its review popover
   * with.
   *
   * For `link` → an absolute URL the host opens in the default browser.
   */
  payload: string
}

/**
 * Subjective "how sure are we?" signal. Hosts can prioritise / colour
 * suggestions accordingly.
 *
 *   - `high`   → safe + likely-correct (kill busy port, set git upstream).
 *   - `medium` → likely-correct but assumes context (npm vs pnpm; sudo).
 *   - `low`    → a starting point (open the branch list).
 */
export type QuickFixConfidence = 'high' | 'medium' | 'low'

export interface QuickFixSuggestion {
  /** Echoes the rule that produced this suggestion. */
  ruleId: string
  /** Single-line title rendered next to the lightbulb. */
  title: string
  /** Optional sub-line shown when expanded. */
  detail?: string
  confidence: QuickFixConfidence
  action: QuickFixAction
}

/** Input context passed to a rule's `matches()` callback. */
export interface QuickFixContext {
  /** Original command line as recorded by the OSC 633 E mark, trimmed. */
  commandLine: string
  /**
   * Trailing N lines of output, newline-joined. Pre-trimmed of
   * trailing whitespace. Empty when output wasn't available.
   */
  outputTail: string
  /** Working directory the command ran in, when known. */
  cwd: string | null
  /** Exit code from OSC 633 D, or null if the command was interrupted. */
  exitCode: number | null
}

export interface QuickFixRule {
  /** Stable id used for telemetry + dedupe. */
  id: string
  /** Short, human-readable label (rule name, not suggestion title). */
  label: string
  /** Returns 0..N suggestions for the given context. Must be pure. */
  matches(ctx: QuickFixContext): QuickFixSuggestion[]
}

// ─── engine ────────────────────────────────────────────────────────

export interface QuickFixEngineOptions {
  /** Base rule set. Defaults to BUILT_IN_RULES if omitted. */
  rules?: readonly QuickFixRule[]
  /** Max suggestions returned per evaluation. Default 4. */
  maxSuggestions?: number
}

/**
 * The engine is just a list of rules + an evaluator. It is mutable so
 * hosts can register custom rules at runtime (e.g. a Vite plugin
 * could add a rule for "esbuild service crashed").
 */
export class QuickFixEngine {
  private rules: QuickFixRule[]
  private readonly maxSuggestions: number

  constructor(opts: QuickFixEngineOptions = {}) {
    this.rules = [...(opts.rules ?? [])]
    this.maxSuggestions = Math.max(1, opts.maxSuggestions ?? 4)
  }

  /** Insert a rule at the end of the table. */
  addRule(rule: QuickFixRule): void { this.rules.push(rule) }

  /** Remove rules whose id matches; returns the count removed. */
  removeRule(id: string): number {
    const before = this.rules.length
    this.rules = this.rules.filter((r) => r.id !== id)
    return before - this.rules.length
  }

  /** Current rule list (defensive copy). */
  listRules(): QuickFixRule[] { return [...this.rules] }

  /** Evaluate every rule against the context. Skips on exit code 0. */
  evaluate(ctx: QuickFixContext): QuickFixSuggestion[] {
    if (ctx.exitCode === 0) return []
    const out: QuickFixSuggestion[] = []
    for (const rule of this.rules) {
      let suggestions: QuickFixSuggestion[]
      try { suggestions = rule.matches(ctx) }
      catch { suggestions = [] } // a broken rule must not poison the engine
      for (const s of suggestions) {
        out.push(s)
        if (out.length >= this.maxSuggestions) return out
      }
    }
    return out
  }
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * Pull the last N non-empty lines from a raw output chunk, joined with
 * `\n`. Used by the manager when slicing the tail from xterm rows.
 */
export function tailLines(input: string, n: number): string {
  if (n <= 0 || input.length === 0) return ''
  const lines = input.split(/\r?\n/)
  const last: string[] = []
  for (let i = lines.length - 1; i >= 0 && last.length < n; i--) {
    const line = lines[i]!.trimEnd()
    if (line.length === 0 && last.length === 0) continue // trim trailing blanks
    last.push(line)
  }
  return last.reverse().join('\n')
}
