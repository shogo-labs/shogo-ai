// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface TerminalDiagnostic {
  id: string
  source: 'terminal'
  severity: ProblemSeverity
  file: string
  line: number
  column: number
  code?: string
  message: string
}

export interface ProblemMatcher {
  id: string
  pattern: RegExp
  file: number
  line: number
  column?: number
  message: number
  code?: number
  severity?: ProblemSeverity | number
}
