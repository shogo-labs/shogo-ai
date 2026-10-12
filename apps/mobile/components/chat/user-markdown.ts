// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Preserve the line breaks a user typed while still allowing markdown
 * paragraphs and fenced code blocks to be parsed normally.
 *
 * CommonMark treats a single newline as whitespace. Two trailing spaces turn
 * it into a hard break, which is the closest equivalent to the plain-text
 * user-message renderer previously used here.
 */
export function preserveUserLineBreaks(text: string): string {
  const lines = text.split(/\r?\n/)
  let fence: { character: "`" | "~"; length: number } | null = null

  return lines
    .map((line, index) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
      const isFenceLine = fenceMatch !== null
      const fenceToken = fenceMatch?.[1]

      if (isFenceLine && fenceToken) {
        const character = fenceToken[0] as "`" | "~"
        if (!fence) {
          fence = { character, length: fenceToken.length }
        } else if (
          fence.character === character &&
          fenceToken.length >= fence.length
        ) {
          fence = null
        }
      }

      if (index === lines.length - 1 || fence || isFenceLine) return line
      if (!line || !lines[index + 1]) return line
      return `${line}  `
    })
    .join("\n")
}
