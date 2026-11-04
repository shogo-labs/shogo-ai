// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dropping tool results at summarize time (variant B, SHO-327).
 *
 * Measured across 104 compacted sessions on a real machine, tool results are a
 * median 73% of the characters left *after* compaction — the kept tail, not the
 * summarized head, is where the context now lives. The tail cannot be
 * summarized away (it is what the next turn acts on), so the only bulk left to
 * free is the raw output of results the agent has already read and acted on.
 *
 * Rules, all enforced by the tests:
 * - **Never delete a result.** The message stays, so every `toolCall` keeps its
 *   `toolResult` and the request stays valid for every provider.
 * - **Errors survive.** A failure and its fix is exactly what a summary is bad
 *   at, and it is small.
 * - **Small results survive.** Under `DROP_MIN_RESULT_CHARS` the saving is not
 *   worth the risk of making the agent re-run something cheap.
 * - **Unconsumed results survive.** A result with no assistant message after it
 *   is the round the model is about to read; dropping it would make the current
 *   step blind.
 * - **The stub names the tool and its args**, so the agent can re-run exactly
 *   what was dropped instead of guessing.
 *
 * Dropping happens at the same moment the summary already rewrites the prefix,
 * so it costs no extra cache break (see `applyCompaction`).
 */
import type { AssistantMessage, Message, TextContent, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai'
import { compactToolArgs } from './turn-boundary'

/** Results at least this large are worth dropping; smaller ones are kept. */
export const DROP_MIN_RESULT_CHARS = 500

/** Args shorter than this are rendered in full in the stub. */
const STUB_ARGS_MAX_CHARS = 200

export interface DroppedToolResult {
  toolName: string
  toolCallId: string
  /** Compacted arguments, so the agent can re-run the exact call. */
  args: string
  /** Characters of output the drop removed. */
  chars: number
}

/**
 * Index where the last `rounds` tool rounds begin — a round being an assistant
 * message that carries at least one tool call. With fewer rounds than asked
 * for, nothing is protected (index 0) rather than everything.
 */
function roundWindowStart(messages: readonly Message[], rounds: number): number {
  if (rounds <= 0) return messages.length
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = (msg as AssistantMessage).content
    if (!Array.isArray(content) || !content.some((b: any) => b?.type === 'toolCall')) continue
    if (++seen === rounds) return i
  }
  return 0
}

export interface DropToolResultsResult {
  messages: Message[]
  dropped: DroppedToolResult[]
}

function resultChars(msg: ToolResultMessage): number {
  return msg.content
    .filter((c): c is TextContent => c.type === 'text')
    .reduce((sum, c) => sum + c.text.length, 0)
}

/** The stub written in place of the output. */
export function droppedResultStub(dropped: DroppedToolResult): string {
  return (
    `[Tool output dropped at compaction — ${dropped.toolName}(${dropped.args}) ` +
    `returned ${dropped.chars.toLocaleString('en-US')} chars. Re-run it to see the output.]`
  )
}

/**
 * Replace consumed tool results in `messages` with a stub naming the call.
 *
 * `protectedTurns` names how many **tool rounds** at the end of this array are
 * never touched. It is an explicit round window, not the turn-aware boundary
 * the other layers use: the array being passed is normally one single turn, and
 * a turn-aware boundary would protect all of it (`lastTurnStart` is 0).
 */
export function dropToolResultsAtCompaction(
  messages: readonly Message[],
  opts: { protectedTurns: number },
): DropToolResultsResult {
  const protectedTurns = Math.max(0, opts.protectedTurns)
  const protectedStart = roundWindowStart(messages, protectedTurns)

  const callById = new Map<string, ToolCall>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = (msg as AssistantMessage).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'toolCall') callById.set((block as ToolCall).id, block as ToolCall)
    }
  }

  const dropped: DroppedToolResult[] = []
  const out = messages.map((msg, idx) => {
    if (msg.role !== 'toolResult') return msg
    if (idx >= protectedStart) return msg
    const result = msg as ToolResultMessage
    if (result.isError) return msg

    const chars = resultChars(result)
    if (chars < DROP_MIN_RESULT_CHARS) return msg

    // Consumed = something after it in this array read it.
    const consumed = messages.slice(idx + 1).some((m) => m.role === 'assistant')
    if (!consumed) return msg

    const call = callById.get(result.toolCallId)
    const toolName = result.toolName || call?.name || 'tool'
    const args = compactToolArgs(call?.arguments ?? {}, STUB_ARGS_MAX_CHARS)
    const entry: DroppedToolResult = { toolName, toolCallId: result.toolCallId, args, chars }
    dropped.push(entry)
    return {
      ...result,
      content: [{ type: 'text' as const, text: droppedResultStub(entry) }],
    } as ToolResultMessage
  })

  return { messages: out, dropped }
}
