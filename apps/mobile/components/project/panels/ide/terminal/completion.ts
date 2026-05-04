// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Pure helpers for shell-like path completion in the prompt. The terminal is
 * not a PTY, so the UI has to parse the current line and apply directory
 * candidates returned by the runtime.
 */

export interface TerminalCompletionEntry {
  name: string
  type: 'file' | 'directory'
}

export interface CdCompletionContext {
  replacementStart: number
  replacementEnd: number
  pathPrefix: string
  dirPrefix: string
  leafPrefix: string
  quote: '"' | "'" | null
  key: string
}

export interface CdCompletionState {
  key: string
  valueAfter: string
  replacementStart: number
  dirPrefix: string
  quote: '"' | "'" | null
  entries: TerminalCompletionEntry[]
  index: number
}

export interface CdCompletionResult {
  value: string
  candidates: TerminalCompletionEntry[]
  state: CdCompletionState
}

export function parseCdCompletion(line: string, cursor = line.length): CdCompletionContext | null {
  if (cursor !== line.length) return null

  let i = 0
  while (line[i] === ' ' || line[i] === '\t') i++
  if (line.slice(i, i + 2) !== 'cd') return null
  const afterCd = i + 2
  const after = line[afterCd]
  if (after && after !== ' ' && after !== '\t') return null

  let tokenStart = afterCd
  while (line[tokenStart] === ' ' || line[tokenStart] === '\t') tokenStart++
  if (tokenStart >= line.length) return null

  const rawToken = line.slice(tokenStart)
  if (rawToken === '-' || rawToken === '--') return null

  const parsed = parsePathToken(rawToken)
  if (!parsed) return null
  if (parsed.pathPrefix === '-' || parsed.pathPrefix === '--') return null

  const slash = parsed.pathPrefix.lastIndexOf('/')
  const dirPrefix = slash === -1 ? '' : parsed.pathPrefix.slice(0, slash + 1)
  const leafPrefix = slash === -1 ? parsed.pathPrefix : parsed.pathPrefix.slice(slash + 1)

  return {
    replacementStart: tokenStart,
    replacementEnd: line.length,
    pathPrefix: parsed.pathPrefix,
    dirPrefix,
    leafPrefix,
    quote: parsed.quote,
    key: `${tokenStart}:${parsed.quote ?? ''}:${parsed.pathPrefix}`,
  }
}

export function advanceCdCompletion(
  line: string,
  previous: CdCompletionState | null,
): CdCompletionResult | null {
  if (!previous || previous.entries.length <= 1 || line !== previous.valueAfter) return null
  const index = (previous.index + 1) % previous.entries.length
  return buildResult({
    line,
    replacementStart: previous.replacementStart,
    replacementEnd: line.length,
    dirPrefix: previous.dirPrefix,
    quote: previous.quote,
    entries: previous.entries,
    index,
    key: previous.key,
  })
}

export function applyCdCompletion(
  line: string,
  context: CdCompletionContext,
  entries: TerminalCompletionEntry[],
): CdCompletionResult | null {
  const candidates = entries
    .filter((entry) => entry.name.startsWith(context.leafPrefix))
    .sort(compareCompletionEntries)
  if (candidates.length === 0) return null

  if (candidates.length === 1) {
    return buildResult({
      line,
      replacementStart: context.replacementStart,
      replacementEnd: context.replacementEnd,
      dirPrefix: context.dirPrefix,
      quote: context.quote,
      entries: candidates,
      index: 0,
      key: context.key,
    })
  }

  const common = commonPrefix(candidates.map((entry) => entry.name))
  if (common.length > context.leafPrefix.length) {
    const value = replacePathToken(line, {
      replacementStart: context.replacementStart,
      replacementEnd: context.replacementEnd,
      dirPrefix: context.dirPrefix,
      leaf: common,
      quote: context.quote,
      isDirectory: false,
    })
    return {
      value,
      candidates,
      state: {
        key: context.key,
        valueAfter: value,
        replacementStart: context.replacementStart,
        dirPrefix: context.dirPrefix,
        quote: context.quote,
        entries: candidates,
        index: -1,
      },
    }
  }

  return buildResult({
    line,
    replacementStart: context.replacementStart,
    replacementEnd: context.replacementEnd,
    dirPrefix: context.dirPrefix,
    quote: context.quote,
    entries: candidates,
    index: 0,
    key: context.key,
  })
}

function parsePathToken(raw: string): { pathPrefix: string; quote: '"' | "'" | null } | null {
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null
  if (quote) {
    let escaped = false
    let out = ''
    for (let i = 1; i < raw.length; i++) {
      const ch = raw[i]
      if (quote === '"' && escaped) {
        out += ch
        escaped = false
        continue
      }
      if (quote === '"' && ch === '\\') {
        escaped = true
        continue
      }
      if (ch === quote) {
        return raw.slice(i + 1).trim() ? null : { pathPrefix: out, quote }
      }
      out += ch
    }
    if (escaped) out += '\\'
    return { pathPrefix: out, quote }
  }

  let escaped = false
  let out = ''
  for (const ch of raw) {
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === ' ' || ch === '\t') return null
    out += ch
  }
  if (escaped) out += '\\'
  return { pathPrefix: out, quote: null }
}

function buildResult(args: {
  line: string
  replacementStart: number
  replacementEnd: number
  dirPrefix: string
  quote: '"' | "'" | null
  entries: TerminalCompletionEntry[]
  index: number
  key: string
}): CdCompletionResult {
  const entry = args.entries[args.index]
  const value = replacePathToken(args.line, {
    replacementStart: args.replacementStart,
    replacementEnd: args.replacementEnd,
    dirPrefix: args.dirPrefix,
    leaf: entry.name,
    quote: args.quote,
    isDirectory: entry.type === 'directory',
  })
  return {
    value,
    candidates: args.entries,
    state: {
      key: args.key,
      valueAfter: value,
      replacementStart: args.replacementStart,
      dirPrefix: args.dirPrefix,
      quote: args.quote,
      entries: args.entries,
      index: args.index,
    },
  }
}

function replacePathToken(
  line: string,
  args: {
    replacementStart: number
    replacementEnd: number
    dirPrefix: string
    leaf: string
    quote: '"' | "'" | null
    isDirectory: boolean
  },
): string {
  const completed = `${args.dirPrefix}${args.leaf}${args.isDirectory ? '/' : ''}`
  const token = formatPathToken(completed, args.quote)
  return line.slice(0, args.replacementStart) + token + line.slice(args.replacementEnd)
}

function formatPathToken(path: string, quote: '"' | "'" | null): string {
  if (quote === "'") {
    return `'${path.replace(/'/g, `'\\''`)}`
  }
  if (quote === '"') {
    return `"${path.replace(/(["\\$`])/g, '\\$1')}"`
  }
  return path.replace(/([\\\s'"$`])/g, '\\$1')
}

function commonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0] ?? ''
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ''
    }
  }
  return prefix
}

function compareCompletionEntries(a: TerminalCompletionEntry, b: TerminalCompletionEntry): number {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}
