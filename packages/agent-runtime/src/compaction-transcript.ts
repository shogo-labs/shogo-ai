// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The transcript a compaction summarizer is shown.
 *
 * The summarizer used to be handed narration and nothing else: user text cut
 * at 500 chars, assistant prose at 500, tool results at 200, and **`toolCall`
 * blocks not at all** — then the whole prompt truncated to 12,000 chars. A
 * model that is shown only "Let me check X. Now Y." and asked what happened
 * writes narration back, and when the next turn asks it to act, it guesses a
 * tool name. It guessed `str_replace`, eight times in a row (SHO-122).
 *
 * So every frame here carries what an agent needs to *continue*:
 *   `User:` — the full text; requirements are the one thing never truncated
 *   `Assistant:` — prose, bounded
 *   `→ tool: name({...})` — every tool call, always, with args
 *   `← name result (N chars[, ERROR]): head … tail`
 *
 * Past `COMPACTION_SUMMARY_INPUT_CHARS` (default 120k) the OLDEST rounds
 * degrade to a single line each; the tail is never cut, because the tail is
 * what the next turn is about to act on.
 */

import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai'
import { compactToolArgs } from './turn-boundary'

/** Max chars of transcript handed to the summarizer in one call. */
export const DEFAULT_COMPACTION_SUMMARY_INPUT_CHARS = 120_000
/** Assistant prose kept per frame. */
const ASSISTANT_TEXT_CHARS = 1_000
/** Tool result head/tail in an ordinary frame. */
const RESULT_HEAD_CHARS = 300
const RESULT_TAIL_CHARS = 100

/** `COMPACTION_SUMMARY_INPUT_CHARS`, defaulting to 120k. */
export function compactionSummaryInputChars(): number {
  const raw = Number(process.env.COMPACTION_SUMMARY_INPUT_CHARS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_COMPACTION_SUMMARY_INPUT_CHARS
}

function textBlocks(msg: Message): string {
  const content = (msg as { content: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, any>>)
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)} … ${text.slice(text.length - tail)}`
}

interface Frame {
  /** Round index this frame belongs to (-1 = outside any tool round). */
  round: number
  text: string
  chars: number
}

/**
 * Render `messages` as the summarizer's input. Deterministic: same messages in,
 * same string out (no timestamps, no ids).
 */
export function renderTranscriptForSummary(
  messages: readonly Message[],
  opts: { maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? compactionSummaryInputChars()

  // tool_call id -> tool name, so a result can be labelled with the tool that
  // produced it even when the assistant frame is degraded later.
  const nameById = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of (msg as AssistantMessage).content ?? []) {
      if (block?.type === 'toolCall') nameById.set((block as ToolCall).id, (block as ToolCall).name)
    }
  }

  const frames: Frame[] = []
  let round = -1
  const push = (text: string) => {
    if (!text.trim()) return
    frames.push({ round, text, chars: text.length })
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      push(`User: ${textBlocks(msg)}`)
      continue
    }
    if (msg.role === 'assistant') {
      const content = (msg as AssistantMessage).content
      const calls = (Array.isArray(content) ? content : []).filter(
        (b): b is ToolCall => b?.type === 'toolCall',
      )
      if (calls.length > 0) round++
      const prose = textBlocks(msg)
      if (prose.trim()) push(`Assistant: ${clip(prose, ASSISTANT_TEXT_CHARS)}`)
      for (const call of calls) {
        push(`→ tool: ${call.name}(${compactToolArgs(call.arguments)})`)
      }
      continue
    }
    if (msg.role === 'toolResult') {
      const result = msg as ToolResultMessage
      const name = result.toolName || nameById.get(result.toolCallId) || 'tool'
      const text = textBlocks(msg)
      const flag = result.isError ? ', ERROR' : ''
      push(`← ${name} result (${text.length} chars${flag}): ${headTail(text, RESULT_HEAD_CHARS, RESULT_TAIL_CHARS)}`)
    }
  }

  let total = frames.reduce((sum, f) => sum + f.chars + 1, 0)
  if (total <= maxChars) return frames.map((f) => f.text).join('\n')

  // Degrade the oldest rounds first, one line each. The tail stays verbatim.
  const rounds = [...new Set(frames.map((f) => f.round).filter((r) => r >= 0))].sort((a, b) => a - b)
  const collapsed = new Set<number>()
  for (const r of rounds) {
    if (total <= maxChars) break
    const members = frames.filter((f) => f.round === r)
    if (members.length < 2) continue
    const line = oneLineForRound(members)
    total -= members.reduce((sum, m) => sum + m.chars + 1, 0) - (line.length + 1)
    collapsed.add(r)
  }

  const out: string[] = []
  const emitted = new Set<number>()
  for (const frame of frames) {
    if (frame.round < 0 || !collapsed.has(frame.round)) {
      out.push(frame.text)
      continue
    }
    if (emitted.has(frame.round)) continue
    emitted.add(frame.round)
    out.push(oneLineForRound(frames.filter((f) => f.round === frame.round)))
  }
  return out.join('\n')
}

/** One line standing in for a whole degraded round: the tools it called, never invented. */
function oneLineForRound(members: readonly Frame[]): string {
  const tools = members.filter((m) => m.text.startsWith('→ tool: ')).map((m) => m.text)
  const chars = members.reduce((sum, m) => sum + m.chars, 0)
  return `[round · ${tools.join(' | ').slice(0, 160)} · ${chars} chars]`
}
