// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { isShogoAgentIdentity, shogoCoAuthorTrailer } from '@shogo/shared-runtime/agent-attribution'

interface ShellToken {
  value: string
  start: number
  end: number
  quoted: boolean
  operator: boolean
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let index = 0

  while (index < command.length) {
    while (/\s/.test(command[index] ?? '')) index += 1
    if (index >= command.length) break

    const start = index
    const twoCharacterOperator = command.slice(index, index + 2)
    if (twoCharacterOperator === '&&' || twoCharacterOperator === '||') {
      tokens.push({ value: twoCharacterOperator, start, end: index + 2, quoted: false, operator: true })
      index += 2
      continue
    }
    if (';|<>\n'.includes(command[index] ?? '')) {
      tokens.push({ value: command[index]!, start, end: index + 1, quoted: false, operator: true })
      index += 1
      continue
    }

    let value = ''
    let quoted = false
    while (index < command.length) {
      const character = command[index]!
      if (/\s/.test(character) || ';|<>\n'.includes(character)) break
      if (character === '\\' && index + 1 < command.length) {
        value += command[index + 1]
        index += 2
        continue
      }
      if (character === "'" || character === '"') {
        quoted = true
        const quote = character
        index += 1
        while (index < command.length && command[index] !== quote) {
          if (quote === '"' && command[index] === '\\' && index + 1 < command.length) {
            value += command[index + 1]
            index += 2
          } else {
            value += command[index]
            index += 1
          }
        }
        if (command[index] === quote) index += 1
        continue
      }
      value += character
      index += 1
    }
    tokens.push({ value, start, end: index, quoted, operator: false })
  }

  return tokens
}

function hasShogoTrailer(segment: ShellToken[], trailer: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index]?.value === '--trailer' && segment[index + 1]?.value === trailer) return true
    if (segment[index]?.value === `--trailer=${trailer}`) return true
  }
  return false
}

const CO_AUTHOR_TRAILER_RE = /^co-authored-by:\s*(.*)$/i
const TRAILER_IDENTITY_RE = /^(.*?)\s*<([^>]+)>$/

/** True when a `--trailer` value is a co-author line naming a Shogo identity. */
function isShogoCoAuthorValue(value: string): boolean {
  const coAuthor = CO_AUTHOR_TRAILER_RE.exec(value.trim())
  if (!coAuthor) return false
  const identity = TRAILER_IDENTITY_RE.exec(coAuthor[1] ?? '')
  return identity
    ? isShogoAgentIdentity(identity[1], identity[2])
    : isShogoAgentIdentity(coAuthor[1], '')
}

/**
 * Span of an existing `--trailer` value that names a Shogo co-author. It is
 * repaired in place: a hand-written `Shogo <noreply@shogo.ai>` is what produced
 * the two-co-author commits on `main` (the canonical line was added *beside*
 * it), so it must be replaced, never joined.
 */
function findShogoTrailer(
  segment: ShellToken[],
): { start: number; end: number; value: string } | null {
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]!
    if (token.value === '--trailer') {
      const value = segment[index + 1]
      if (value && !value.operator && isShogoCoAuthorValue(value.value)) {
        return { start: value.start, end: value.end, value: value.value }
      }
      index += 1
      continue
    }
    const inline = /^--trailer=([\s\S]*)$/.exec(token.value)
    if (inline && isShogoCoAuthorValue(inline[1] ?? '')) {
      return { start: token.start + '--trailer='.length, end: token.end, value: inline[1] ?? '' }
    }
  }
  return null
}

function findGitCommitSubcommand(segment: ShellToken[], gitIndex: number): number {
  const optionsWithValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path', '--namespace'])
  let index = gitIndex + 1
  while (index < segment.length) {
    const token = segment[index]!
    if (token.value === '--') return -1
    if (token.value.startsWith('-')) {
      if (optionsWithValues.has(token.value)) index += 2
      else index += 1
      continue
    }
    return token.value === 'commit' && !token.quoted ? index : -1
  }
  return -1
}

/**
 * Add Shogo's co-author trailer to every plainly-written `git commit` in a
 * shell command. Tokenizing first avoids rewriting examples inside quoted
 * strings and supports chained commands (`&&`, `;`, and pipes).
 */
export function injectCommitTrailer(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tokens = tokenizeShell(command)
  const edits: Array<{ start: number; end: number; text: string }> = []
  let segmentStart = 0

  const inspectSegment = (segment: ShellToken[]) => {
    if (segment.length === 0) return
    const gitIndex = segment.findIndex((token) => token.value === 'git' && !token.quoted)
    if (gitIndex < 0) return
    const commitIndex = findGitCommitSubcommand(segment, gitIndex)
    if (commitIndex < 0) return

    const canonical = shogoCoAuthorTrailer(env)
    const existing = findShogoTrailer(segment)
    if (existing) {
      if (existing.value.trim() === canonical) return
      edits.push({ start: existing.start, end: existing.end, text: `"${canonical.replaceAll('"', '\\"')}"` })
      return
    }
    if (hasShogoTrailer(segment, canonical)) return

    const commitToken = segment[commitIndex]!
    edits.push({
      start: commitToken.end,
      end: commitToken.end,
      text: ` --trailer "${canonical}"`,
    })
  }

  for (let index = 0; index <= tokens.length; index += 1) {
    const token = tokens[index]
    if (index === tokens.length || token?.operator) {
      inspectSegment(tokens.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }

  let result = command
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`
  }
  return result
}
