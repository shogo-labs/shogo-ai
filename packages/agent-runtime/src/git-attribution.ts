// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { shogoCoAuthorTrailer } from '@shogo/shared-runtime/agent-attribution'

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
  const insertions: Array<{ position: number; text: string }> = []
  let segmentStart = 0

  const inspectSegment = (segment: ShellToken[]) => {
    if (segment.length === 0) return
    const gitIndex = segment.findIndex((token) => token.value === 'git' && !token.quoted)
    if (gitIndex < 0) return
    const commitIndex = findGitCommitSubcommand(segment, gitIndex)
    if (commitIndex < 0 || hasShogoTrailer(segment, shogoCoAuthorTrailer(env))) return

    const commitToken = segment[commitIndex]!
    insertions.push({
      position: commitToken.end,
      text: ` --trailer "${shogoCoAuthorTrailer(env).replaceAll('"', '\\"')}"`,
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
  for (const insertion of insertions.reverse()) {
    result = `${result.slice(0, insertion.position)}${insertion.text}${result.slice(insertion.position)}`
  }
  return result
}
