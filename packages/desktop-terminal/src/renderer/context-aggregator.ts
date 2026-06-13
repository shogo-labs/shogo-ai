// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ContextAggregator — collects workspace context from the terminal
 * tracker, editor state, git status, and diagnostics to inject into
 * every outgoing chat message automatically.
 *
 * This is the "auto context injection" layer that closes the gap with
 * Cursor's agent loop: every user message automatically includes
 * relevant terminal output, active file, git status, and diagnostics
 * so the LLM has full workspace awareness without manual action.
 *
 * Enforces a token budget (~4K tokens ≈ 16K chars) by prioritizing:
 *   terminal errors > terminal output > diagnostics > git > active file
 *
 * Integration point: call `collect()` in the chat send path, serialize
 * the result with `serializeContext()`, and prepend to the user's message.
 */

import type { Command, Osc633Tracker } from './osc633-tracker'

// ─── public types ───────────────────────────────────────────────────────

export interface AggregatedContext {
  /** Recent command blocks from the terminal tracker. */
  terminalCommands: Command[]
  /** The currently active editor file. */
  activeFile: ActiveFileInfo | null
  /** Git workspace status. */
  gitStatus: GitStatus | null
  /** Errors/warnings from the Problems panel. */
  diagnostics: Diagnostic[]
  /** Estimated total tokens used by the serialized context. */
  tokenEstimate: number
  /** Sources that contributed context (for UI display). */
  sources: ContextSource[]
}

export interface ActiveFileInfo {
  /** Relative path from workspace root. */
  relativePath: string
  /** Language identifier (e.g. "typescriptreact", "python"). */
  language: string
  /** Selected text (if any). */
  selection?: string
}

export interface GitStatus {
  branch: string
  stagedCount: number
  modifiedCount: number
  untrackedCount: number
  conflictCount: number
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info'
  file: string
  line: number
  column: number
  message: string
}

export interface ContextSource {
  type: 'terminal' | 'file' | 'git' | 'diagnostics'
  label: string
  itemCount: number
}

// ─── collector interfaces ───────────────────────────────────────────────
// Abstract over the IPC bridge so tests can substitute fakes.

export interface EditorContextSource {
  getActiveFile(): Promise<ActiveFileInfo | null>
}

export interface GitContextSource {
  getStatus(): Promise<GitStatus | null>
}

export interface DiagnosticsContextSource {
  getDiagnostics(): Promise<Diagnostic[]>
}

// ─── aggregator ─────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = 4000
const CHARS_PER_TOKEN = 4
const DEFAULT_COMMAND_LIMIT = 5
const MAX_OUTPUT_CHARS = 2000
const MAX_DIAGNOSTICS = 10

export interface ContextAggregatorOptions {
  tracker: Osc633Tracker
  editor: EditorContextSource
  git: GitContextSource
  diagnostics: DiagnosticsContextSource
  tokenBudget?: number
}

export class ContextAggregator {
  private tracker: Osc633Tracker
  private editor: EditorContextSource
  private git: GitContextSource
  private diagnostics: DiagnosticsContextSource
  private tokenBudget: number

  constructor(opts: ContextAggregatorOptions) {
    this.tracker = opts.tracker
    this.editor = opts.editor
    this.git = opts.git
    this.diagnostics = opts.diagnostics
    this.tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  }

  /**
   * Collect all available context for an outgoing chat message.
   * Sources are collected in parallel; the token budget is enforced
   * by dropping lower-priority items when the budget is exceeded.
   */
  async collect(): Promise<AggregatedContext> {
    const snap = this.tracker.snapshot()
    const recent = snap.commands.slice(-DEFAULT_COMMAND_LIMIT)

    const [activeFile, gitStatus, diagnostics] = await Promise.all([
      this.editor.getActiveFile().catch(() => null),
      this.git.getStatus().catch(() => null),
      this.diagnostics.getDiagnostics().catch(() => []),
    ])

    const sources: ContextSource[] = []
    let usedTokens = 0

    // Priority 1: Terminal commands — skip shell-integration noise
    const includedCommands: Command[] = []
    for (const cmd of recent) {
      // Skip commands that are just shell-integration markers (empty commandLine)
      // These are PROMPT_COMMAND / DEBUG trap emissions, not user actions.
      const cl = (cmd.commandLine ?? '').trim()
      if (!cl) continue

      const tokens = estimateCommandTokens(cmd)
      if (usedTokens + tokens > this.tokenBudget) break
      includedCommands.push(cmd)
      usedTokens += tokens
    }
    if (includedCommands.length > 0) {
      sources.push({
        type: 'terminal',
        label: `${includedCommands.length} terminal command${includedCommands.length > 1 ? 's' : ''}`,
        itemCount: includedCommands.length,
      })
    }

    // Priority 2: Diagnostics (errors first)
    const sortedDiags = [
      ...diagnostics.filter((d) => d.severity === 'error'),
      ...diagnostics.filter((d) => d.severity === 'warning'),
      ...diagnostics.filter((d) => d.severity === 'info'),
    ].slice(0, MAX_DIAGNOSTICS).filter((d) => {
      const tokens = estimateDiagnosticTokens(d)
      if (usedTokens + tokens > this.tokenBudget) return false
      usedTokens += tokens
      return true
    })

    if (sortedDiags.length > 0) {
      sources.push({
        type: 'diagnostics',
        label: `${sortedDiags.length} diagnostic${sortedDiags.length > 1 ? 's' : ''}`,
        itemCount: sortedDiags.length,
      })
    }

    // Priority 3: Git status
    if (gitStatus) {
      const tokens = estimateGitTokens(gitStatus)
      if (usedTokens + tokens <= this.tokenBudget) {
        usedTokens += tokens
        sources.push({ type: 'git', label: gitStatus.branch, itemCount: 1 })
      }
    }

    // Priority 4: Active file
    if (activeFile) {
      const tokens = estimateFileTokens(activeFile)
      if (usedTokens + tokens <= this.tokenBudget) {
        usedTokens += tokens
        sources.push({ type: 'file', label: activeFile.relativePath, itemCount: 1 })
      }
    }

    return {
      terminalCommands: includedCommands,
      activeFile,
      gitStatus,
      diagnostics: sortedDiags,
      tokenEstimate: usedTokens,
      sources,
    }
  }
}

// ─── serialization ──────────────────────────────────────────────────────

/**
 * Serialize an AggregatedContext into a text block suitable for
 * prepending to a chat message. The LLM receives this as a
 * [CONTEXT — auto-generated] block and uses it for reasoning.
 */
/** Serialize recent terminal commands (OSC633) for agent context / IPC bridge. */
export function serializeTerminalCommands(commands: readonly Command[]): string {
  const sections: string[] = []
  const usable = commands.filter((c) => (c.commandLine ?? '').trim().length > 0)
  if (usable.length === 0) return ''

  sections.push('## Terminal (desktop IDE — user session)')
  for (const cmd of usable) {
    const exitLabel = cmd.exitCode === null
      ? 'interrupted'
      : cmd.exitCode === 0
        ? '✓'
        : `exit ${cmd.exitCode}`
    const duration = (cmd.startedAt != null && cmd.finishedAt != null)
      ? formatDuration(cmd.finishedAt - cmd.startedAt)
      : null

    sections.push(`$ ${cmd.commandLine.trim()}`)
    if (cmd.cwd) sections.push(`  cwd: ${cmd.cwd}`)
    if (duration) sections.push(`  ${exitLabel} (${duration})`)
    else sections.push(`  ${exitLabel}`)
    sections.push('')
  }
  return sections.join('\n').trimEnd()
}

export function serializeContext(ctx: AggregatedContext): string {
  const sections: string[] = []

  const terminalBlock = serializeTerminalCommands(ctx.terminalCommands)
  if (terminalBlock) sections.push(terminalBlock)

  if (ctx.diagnostics.length > 0) {
    sections.push('## Diagnostics')
    for (const d of ctx.diagnostics) {
      const icon = d.severity === 'error' ? '❌' : d.severity === 'warning' ? '⚠️' : 'ℹ️'
      sections.push(`${icon} ${d.file}:${d.line}:${d.column} — ${d.message}`)
    }
    sections.push('')
  }

  if (ctx.gitStatus) {
    const g = ctx.gitStatus
    const parts: string[] = [`Branch: ${g.branch}`]
    const changes = [
      g.stagedCount && `${g.stagedCount} staged`,
      g.modifiedCount && `${g.modifiedCount} modified`,
      g.untrackedCount && `${g.untrackedCount} untracked`,
      g.conflictCount && `${g.conflictCount} conflicts`,
    ].filter(Boolean).join(', ')
    parts.push(changes || 'clean working tree')
    sections.push(`## Git\n${parts.join(' — ')}\n`)
  }

  if (ctx.activeFile) {
    const f = ctx.activeFile
    let line = `## Active File\n${f.relativePath} (${f.language})`
    if (f.selection) {
      const preview = f.selection.slice(0, 200)
      line += `\nSelected: "${preview}${f.selection.length > 200 ? '...' : ''}"`
    }
    sections.push(line + '\n')
  }

  return sections.join('\n')
}

/**
 * Format the full message with context block prepended.
 * The [CONTEXT] block is clearly delimited so the LLM knows
 * it's auto-generated and should not cite it directly.
 *
 * The user's actual message is SEPARATE from the context block.
 */
export function formatContextMessage(contextBlock: string, userMessage: string): string {
  return [
    '[CONTEXT — auto-generated, do not cite directly]',
    contextBlock.trim(),
    '[END CONTEXT]',
    '',
    userMessage,
  ].join('\n')
}

// ─── helpers ────────────────────────────────────────────────────────────

function estimateCommandTokens(cmd: Command): number {
  // Rough: commandLine + output lines between startMarker and endMarker
  // Since we don't capture output text in the tracker (just markers),
  // we estimate based on command length + a generous output allowance.
  const cmdLen = cmd.commandLine.length
  // Estimate ~200 chars of output per command (conservative)
  return Math.ceil((cmdLen + 200 + 50) / CHARS_PER_TOKEN)
}

function estimateDiagnosticTokens(d: Diagnostic): number {
  return Math.ceil((d.message.length + d.file.length + 30) / CHARS_PER_TOKEN)
}

function estimateGitTokens(g: GitStatus): number {
  return Math.ceil((g.branch.length + 100) / CHARS_PER_TOKEN)
}

function estimateFileTokens(f: ActiveFileInfo): number {
  return Math.ceil((f.relativePath.length + (f.selection?.length ?? 0) + 50) / CHARS_PER_TOKEN)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
