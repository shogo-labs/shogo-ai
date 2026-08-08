// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type SignozRuntimeLogSource = 'build.log' | 'console.log'

export interface SafeSignozRuntimeLog {
  msg: string
  category: string
  redacted: boolean
}

function normalize(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()
}

function classifyBuildLine(line: string): SafeSignozRuntimeLog {
  if (/\b(error|failed|failure|uncaught|exception|is not defined|cannot find|ts\d{4}:)\b/i.test(line)) {
    return { msg: 'desktop runtime build error', category: 'build.error', redacted: true }
  }
  if (/\b(warn|warning)\b/i.test(line)) {
    return { msg: 'desktop runtime build warning', category: 'build.warning', redacted: true }
  }
  if (/\b(built in|compiled successfully|build complete|✓ built)\b/i.test(line)) {
    return { msg: 'desktop runtime build completed', category: 'build.completed', redacted: true }
  }
  if (/\b(starting|rebuilding|transforming|bundling|generating|installing)\b/i.test(line)) {
    return { msg: 'desktop runtime build progress', category: 'build.progress', redacted: true }
  }
  return { msg: 'desktop runtime build log', category: 'build.log', redacted: true }
}

function classifyConsoleLine(line: string): SafeSignozRuntimeLog {
  if (/\b(error|failed|failure|uncaught|exception|typeerror|referenceerror|syntaxerror)\b/i.test(line)) {
    return { msg: 'desktop runtime console error', category: 'console.error', redacted: true }
  }
  if (/\b(warn|warning)\b/i.test(line)) {
    return { msg: 'desktop runtime console warning', category: 'console.warning', redacted: true }
  }
  if (/\b(fetch|xhr|http|api|network|4\d\d|5\d\d)\b/i.test(line)) {
    return { msg: 'desktop runtime console network log', category: 'console.network', redacted: true }
  }
  return { msg: 'desktop runtime console log', category: 'console.log', redacted: true }
}

export function sanitizeRuntimeLineForSignoz(line: string, source: SignozRuntimeLogSource): SafeSignozRuntimeLog | null {
  const normalized = normalize(line)
  if (!normalized) return null
  return source === 'build.log'
    ? classifyBuildLine(normalized)
    : classifyConsoleLine(normalized)
}
