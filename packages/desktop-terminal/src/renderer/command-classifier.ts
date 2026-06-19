// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CommandClassifier — determines if a command is short (one-shot) or
 * long (background/dev server) based on heuristic analysis.
 *
 * This drives the agent's decision:
 *   - SHORT → write to user's visible terminal, capture output, return to chat
 *   - LONG  → spawn a new "Shogo" agent terminal tab, monitor output
 */

/** Patterns that indicate a long-running / background command. */
const LONG_RUNNING_PATTERNS = [
  /\bdev\b/,
  /\bstart\b/,
  /\bserve\b/,
  /\bserving\b/,
  /\bwatch\b/,
  /\bwebpack-dev\b/,
  /\bvite\b/,
  /\bexpo\b/,
  /\bmetro\b/,
  // Only dev-server-ish `bun run` scripts are long; CI scripts like
  // `bun run typecheck|test|build|lint` are one-shot (see SHORT_PATTERNS).
  /\bbun\s+run\s+(dev|start|serve|preview)\b/,
  /\bnpm\s+run\s+(dev|start|serve|preview)\b/,
  /\bnpx\s+((next|vite|expo|metro|webpack).*)\b/,
  /\byarn\s+(dev|start|serve)\b/,
  /\bpnpm\s+(dev|start|serve)\b/,
  /\bdocker-compose\s+up\b/,
  /\bdocker\s+compose\s+up\b/,
  /\bdocker\s+run\b/,
  /\bforever\b/,
  /\bsupervisor\b/,
  /\bpm2\s+(start|serve)\b/,
  /\bsystemctl\s+start\b/,
  /\bpython\s+-m\s+http\.server\b/,
  /\brails\s+server\b/,
  /\bflask\s+run\b/,
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\bnginx\b/,
  /\bhttpd\b/,
]

/** Patterns that indicate a foreground / one-shot command. */
const SHORT_PATTERNS = [
  /^echo\b/,
  /^cat\b/,
  /^ls\b/,
  /^pwd\b/,
  /^which\b/,
  /^whoami\b/,
  /^date\b/,
  /^env\b/,
  /^printenv\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^grep\b/,
  /^find\b/,
  /^git\s+(status|diff|log|branch|show|remote|add|commit|push|pull|fetch|stash|checkout|switch|merge|rebase|blame|shortlog)\b/,
  /^npm\s+(test|run\s+test|lint|run\s+lint|run\s+build|build|info|list|outdated)\b/,
  /^bun\s+(test|lint|build|typecheck|x\s+|run\s+(test|lint|build|typecheck|check|ci))\b/,
  /^yarn\s+(test|lint|build)\b/,
  /^pnpm\s+(test|lint|build)\b/,
  /^tsc\b/,
  /^eslint\b/,
  /^prettier\b/,
  /^bunx?\s+prisma\b/,
  /^cd\b/,
  /^mkdir\b/,
  /^touch\b/,
  /^cp\b/,
  /^mv\b/,
  /^rm\b/,
  /^chmod\b/,
  /^curl\b/,
  /^wget\b/,
  /^exit\b/,
  /^clear\b/,
]

export type CommandKind = 'short' | 'long'

export interface ClassificationResult {
  /** Whether the command is short (one-shot) or long (background). */
  kind: CommandKind
  /** The reason for the classification (for debugging). */
  reason: string
  /** Suggested terminal label for long-running commands. */
  terminalLabel?: string
}

/**
 * Classify a command as short (one-shot) or long (background).
 *
 * Heuristics:
 *   1. Explicit `&` at end → long
 *   2. Matches known long-running patterns → long
 *   3. Matches known short patterns → short
 *   4. No pipes or redirections + short length → short
 *   5. Default → short (conservative — don't spawn agent terminals unnecessarily)
 */
export function classifyCommand(command: string): ClassificationResult {
  const trimmed = command.trim()

  // 1. Background operator
  if (/\s*&\s*$/.test(trimmed)) {
    return { kind: 'long', reason: 'Background operator (&) at end of command', terminalLabel: buildTerminalLabel(trimmed) }
  }

  // 2. Pipe to nohup or background
  if (/\|\s*(nohup|bg|disown)\b/.test(trimmed)) {
    return { kind: 'long', reason: 'Piped to background handler' }
  }

  // 3. Check against long-running patterns
  for (const pattern of LONG_RUNNING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        kind: 'long',
        reason: `Matches long-running pattern: ${pattern.source}`,
        terminalLabel: buildTerminalLabel(trimmed),
      }
    }
  }

  // 4. Check against short patterns
  for (const pattern of SHORT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'short', reason: `Matches short pattern: ${pattern.source}` }
    }
  }

  // 5. Very short commands are likely short
  if (trimmed.length < 40 && !trimmed.includes('|') && !trimmed.includes('&&')) {
    return { kind: 'short', reason: 'Short command (< 40 chars, no pipes)' }
  }

  // 6. Default to short
  return { kind: 'short', reason: 'Default classification (no matching heuristic)' }
}

/**
 * Build a label for the agent terminal tab.
 * Format: "Shogo (cd /path && command...)"
 * Truncated to keep tab width reasonable.
 */
function buildTerminalLabel(command: string): string {
  const maxLen = 50
  const display = command.length > maxLen ? command.slice(0, maxLen) + '...' : command
  return `Shogo (${display})`
}

/** Check if a command is short (for tool callers). */
export function isShortCommand(command: string): boolean {
  return classifyCommand(command).kind === 'short'
}
