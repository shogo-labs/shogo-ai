// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The one-line next step behind the "Continue <project>" chip that greets a
 * person arriving from a lifecycle notification (build-ready / credits-reset).
 *
 * The line is derived from the last assistant turn alone — the question it
 * closed on, or failing that the short imperative line it ended with — so the
 * chip costs no model call and no extra API round trip: the transcript is
 * already client-side when it renders (SHO-266).
 */

/** Longest suggestion we render; anything longer is clipped at a word end. */
export const MAX_SUGGESTION_CHARS = 120

/** A line has to be at most this long to read as a next step, not a paragraph. */
const MAX_IMPERATIVE_CHARS = 80

/** …and at most this many words. */
const MAX_IMPERATIVE_WORDS = 12

/** A minimal message shape: what a chat turn needs to be read for a hint. */
export interface ContinueSourceMessage {
  role: string
  parts?: ReadonlyArray<{ type?: string; text?: string }> | null
  /** Legacy/plain content, used when a message carries no `parts`. */
  content?: string
}

/** Collapse every run of whitespace so a wrapped line reads as one line. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Drop the markdown that would otherwise be read as part of the sentence. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^>\s?/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .trim()
}

/** True for a line that carries no sentence at all (rule, table row, fence). */
function isNoise(line: string): boolean {
  return (
    line === '' ||
    /^[-=_*]{3,}$/.test(line) ||
    line.startsWith('|') ||
    line.startsWith('```')
  )
}

/**
 * Split a paragraph into sentences. The model hard-wraps long lines, so a
 * question can straddle three of them — the paragraph is joined first, then cut
 * at real sentence ends, and each sentence becomes its own candidate.
 */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])["'”’)\]]*\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

/**
 * Split a turn into the units a hint can come from: one per sentence of prose,
 * and one per list item or quote.
 */
function candidateBlocks(text: string): string[] {
  const blocks: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length === 0) return
    blocks.push(...sentences(collapse(paragraph.join(' '))))
    paragraph = []
  }

  for (const raw of text.replace(/```[\s\S]*?```/g, '\n').split('\n')) {
    const line = raw.trim()
    // A heading names a section; it is never the next step the agent offered.
    if (isNoise(line) || line.startsWith('#')) {
      flush()
      continue
    }
    const ownBlock = /^([-*+]|\d+[.)])\s+/.test(line) || line.startsWith('>')
    const cleaned = stripMarkdown(line)
    if (!cleaned) continue
    if (ownBlock) {
      flush()
      blocks.push(collapse(cleaned))
    } else {
      paragraph.push(cleaned)
    }
  }
  flush()
  return blocks.filter((block) => block !== '' && !isNoise(block))
}

/** Squeeze a line into the chip's single line, at a word boundary. */
function clip(line: string): string {
  const text = collapse(line)
  if (text.length <= MAX_SUGGESTION_CHARS) return text
  const cut = text.slice(0, MAX_SUGGESTION_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** The last block that ends in a question mark — the question it asked. */
function lastQuestion(blocks: string[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.endsWith('?')) return clip(block)
  }
  return null
}

/**
 * The last block that reads as an instruction: short, not a full sentence
 * (no closing period), and not the lead-in to a list (no closing colon).
 */
function lastImperative(blocks: string[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    if (block.length > MAX_IMPERATIVE_CHARS) continue
    if (block.split(/\s+/).length > MAX_IMPERATIVE_WORDS) continue
    if (/[.:!?]$/.test(block)) continue
    if (/^https?:\/\//i.test(block)) continue
    if (!/[a-z]/i.test(block)) continue
    return clip(block)
  }
  return null
}

/**
 * One suggested next step for an assistant turn, or `null` when the turn ended
 * with neither a question nor a short imperative line.
 */
export function suggestionFromAssistantText(text: string | null | undefined): string | null {
  if (!text || !text.trim()) return null
  const blocks = candidateBlocks(text)
  if (blocks.length === 0) return null
  return lastQuestion(blocks) ?? lastImperative(blocks)
}

/** The text of a message, from `parts` (preferred) or plain `content`. */
function messageText(message: ContinueSourceMessage): string {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts
      .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return typeof message.content === 'string' ? message.content : ''
}

/**
 * The suggestion for a whole transcript: the last assistant turn that said
 * anything is the only one read, so the chip describes where the conversation
 * stopped rather than some older exchange. A tool-only row (no text at all) is
 * not a turn and is skipped; anything before the first row with text is not
 * consulted, because a turn that ended plainly left nothing open.
 */
export function continueSuggestionFromMessages(
  messages: ReadonlyArray<ContinueSourceMessage> | null | undefined,
): string | null {
  if (!messages || messages.length === 0) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const text = messageText(message)
    if (!text.trim()) continue
    return suggestionFromAssistantText(text)
  }
  return null
}

/** The chip's own label, e.g. `Continue Surfer`. */
export function continueChipLabel(projectName: string | null | undefined): string {
  const name = typeof projectName === 'string' ? projectName.trim() : ''
  return name ? `Continue ${name}` : 'Continue'
}
