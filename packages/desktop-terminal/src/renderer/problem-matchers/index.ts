// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ProblemMatcher, TerminalDiagnostic } from './types'

export const BUILT_IN_MATCHERS: ProblemMatcher[] = [
  {
    id: 'tsc',
    pattern: /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/,
    file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6,
  },
  {
    id: 'eslint-stylish',
    pattern: /^\s*(.+?):(\d+):(\d+):\s+(error|warning)\s+(.+?)(?:\s+([@\w/-]+))?$/,
    file: 1, line: 2, column: 3, severity: 4, message: 5, code: 6,
  },
  {
    id: 'unix',
    pattern: /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/,
    file: 1, line: 2, column: 3, severity: 4, message: 5,
  },
  {
    id: 'python',
    pattern: /^\s*File "(.+?)", line (\d+)(?:, in .*)?$/,
    file: 1, line: 2, column: 0, severity: 'error', message: 0,
  },
  {
    id: 'go',
    pattern: /^(.+?\.go):(\d+):(\d+):\s+(.+)$/,
    file: 1, line: 2, column: 3, severity: 'error', message: 4,
  },
  {
    id: 'rustc',
    pattern: /^\s+-->\s+(.+?):(\d+):(\d+)$/,
    file: 1, line: 2, column: 3, severity: 'error', message: 0,
  },
]

export class MatcherEngine {
  constructor(private readonly matchers: readonly ProblemMatcher[] = BUILT_IN_MATCHERS) {}

  run(commandId: number, output: string): TerminalDiagnostic[] {
    const diagnostics: TerminalDiagnostic[] = []
    const seen = new Set<string>()
    for (const line of output.split(/\r?\n/)) {
      for (const matcher of this.matchers) {
        const m = matcher.pattern.exec(line)
        if (!m) continue
        const file = clean(m[matcher.file] ?? '')
        const row = toInt(m[matcher.line], 1)
        const col = matcher.column ? toInt(m[matcher.column], 1) : 1
        const message = clean(matcher.message === 0 ? line : (m[matcher.message] ?? line))
        const severity = typeof matcher.severity === 'number'
          ? normalizeSeverity(m[matcher.severity])
          : matcher.severity ?? 'error'
        const code = matcher.code ? clean(m[matcher.code] ?? '') : undefined
        const key = `${file}:${row}:${col}:${message}`
        if (!file || seen.has(key)) continue
        seen.add(key)
        diagnostics.push({
          id: `terminal-${commandId}-${diagnostics.length}`,
          source: 'terminal',
          severity,
          file,
          line: row,
          column: col,
          code,
          message,
        })
      }
    }
    return diagnostics
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function clean(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

function normalizeSeverity(value: string | undefined): TerminalDiagnostic['severity'] {
  if (value === 'warning' || value === 'warn') return 'warning'
  if (value === 'info' || value === 'note') return 'info'
  return 'error'
}

export type { ProblemMatcher, TerminalDiagnostic }
