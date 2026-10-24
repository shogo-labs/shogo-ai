// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn boundaries — one definition of "the previous turn" for every layer that
 * decides what history survives.
 *
 * Every compaction layer used to count **assistant messages** and call that
 * "the last N turns". An assistant message is a *tool round*, not a turn: a
 * 12-round turn is one entry from the model's point of view and twelve from
 * the boundary's. So the boundary slid forward as the turn ran and the
 * "protected" window ended up inside the turn it was meant to protect — a
 * 516-message session came back from a compaction as 12 messages, with the
 * previous turn's request and early tool calls gone (SHO-122).
 *
 * The turn start is the **user message** that opened it. That index is
 * append-only: as messages arrive it never moves, so a boundary computed from
 * it is stable within a turn. That is what `stable-compaction.ts`'s
 * write-once-per-tool_call_id invariant needs, and it is what makes the
 * prompt-cache prefix survive a compaction instead of being rebuilt.
 *
 * Turn starts are also the only place a compaction may cut: a head that ends
 * mid-turn leaves a toolResult whose toolCall was summarized away, which is an
 * invalid request and, in `compact()`, exactly the 516 → 12 collapse.
 */

import type {
  AssistantMessage,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
} from '@mariozechner/pi-ai'

/**
 * Kill switch for the turn-anchored boundary (`AGENT_TURN_AWARE_COMPACTION`,
 * default on). It exists so the release can be read A/B on real traffic: the
 * telemetry carries `variant: 'turn-aware' | 'legacy'`, and the flag is
 * deleted once those numbers are recorded.
 */
export function turnAwareCompactionEnabled(): boolean {
  const raw = process.env.AGENT_TURN_AWARE_COMPACTION
  return raw !== '0' && raw !== 'false'
}

/** `variant` for every telemetry record this behaviour emits. */
export function compactionVariant(): 'turn-aware' | 'legacy' {
  return turnAwareCompactionEnabled() ? 'turn-aware' : 'legacy'
}

/** Placeholders a flattening layer writes in place of a tool result's text. */
const PLACEHOLDER_RE =
  /^\[(Tool output processed|Tool result cleared|Earlier .+ result cleared|File content read|round \d+\/\d+ ·|[Cc]ontext summarized)/

/** True when the message is a tool result this repo's layers already flattened. */
export function isFlattenedResult(msg: Message): boolean {
  if (msg.role !== 'toolResult') return false
  const text = (msg as ToolResultMessage).content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trimStart()
  return PLACEHOLDER_RE.test(text)
}

/**
 * A message that opens a turn.
 *
 * Injected background notes are also `user` messages and land *inside* a
 * running turn (`takeInjectedMessages` steers them mid-loop), so they must not
 * be mistaken for a turn boundary — that would put the boundary in the middle
 * of the turn again.
 */
function isTurnStart(msg: Message): boolean {
  if (msg.role !== 'user') return false
  const tagged = msg as { __shogoBackgroundNote?: boolean; __shogoRoundPlaceholder?: boolean }
  if (tagged.__shogoBackgroundNote || tagged.__shogoRoundPlaceholder) return false
  return true
}

/** Text characters a message contributes (no tool-call JSON: that is not output). */
export function messageChars(msg: Message): number {
  const content = (msg as { content: unknown }).content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let chars = 0
  for (const block of content as Array<Record<string, any>>) {
    if (block?.type === 'text') chars += block.text?.length ?? 0
    else if (block?.type === 'thinking') chars += block.thinking?.length ?? 0
  }
  return chars
}

/**
 * Index of the user message that starts the most recent turn (0 when the
 * history holds no user message at all).
 */
export function lastTurnStart(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isTurnStart(messages[i])) return i
  }
  return 0
}

/** How many user turns the history contains. */
export function turnCount(messages: readonly Message[]): number {
  let count = 0
  for (const msg of messages) if (isTurnStart(msg)) count++
  return count
}

/** Start index of the `n`th-from-last *user turn* (0 when there are fewer). */
export function nthTurnStart(messages: readonly Message[], n: number): number {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isTurnStart(messages[i])) continue
    if (++seen === n) return i
  }
  return 0
}

export interface TurnSummary {
  /** Messages from the turn start to the end of the history. */
  messages: number
  /** Assistant tool rounds in the turn. */
  rounds: number
  /** Tool calls emitted by those rounds. */
  toolCalls: number
  /** Distinct tool names, in first-use order — the names the model will be offered next turn. */
  toolNames: string[]
  /** Tool results already replaced by a placeholder. */
  placeholders: number
  /** Text characters carried by the turn. */
  chars: number
}

/** What the turn starting at `from` contains. Pure; never mutates. */
export function summariseTurn(messages: readonly Message[], from: number): TurnSummary {
  const start = Math.max(0, Math.min(from, messages.length))
  const names: string[] = []
  let rounds = 0
  let toolCalls = 0
  let placeholders = 0
  let chars = 0

  for (let i = start; i < messages.length; i++) {
    const msg = messages[i]
    chars += messageChars(msg)
    if (isFlattenedResult(msg)) placeholders++
    if (msg.role !== 'assistant') continue
    const content = (msg as AssistantMessage).content
    if (!Array.isArray(content)) continue
    let hasToolCall = false
    for (const block of content) {
      if (block?.type !== 'toolCall') continue
      hasToolCall = true
      toolCalls++
      const name = (block as ToolCall).name
      if (name && !names.includes(name)) names.push(name)
    }
    if (hasToolCall) rounds++
  }

  return { messages: messages.length - start, rounds, toolCalls, toolNames: names, placeholders, chars }
}

/**
 * True when the last message belongs to a turn that is still running.
 *
 * The agent loop always appends the new prompt (`user`), the rounds
 * (`toolResult`, assistant-with-toolCalls) as it goes, and only closes a turn
 * with an assistant message that makes no tool call. So "the history ends on a
 * tool-call-free assistant message" is the completed-turn signal.
 */
export function turnInProgress(messages: readonly Message[]): boolean {
  const last = messages[messages.length - 1]
  if (!last) return false
  if (last.role === 'user' || last.role === 'toolResult') return true
  if (last.role === 'assistant') {
    const content = (last as AssistantMessage).content
    return Array.isArray(content) && content.some((block) => block?.type === 'toolCall')
  }
  return false
}

/**
 * Index from which history is protected from compaction.
 *
 * `assistantTurns` is the layer's own N-assistant-message window (unchanged,
 * so every existing expectation about *older* turns still holds). The turn
 * start is applied on top and wins when it is earlier: a turn is one unit and
 * is never cut in half.
 *
 *   - history ends on a finished turn → its start is the boundary
 *     (`buildHistory` at a turn boundary, which is where the previous turn
 *     used to be summarized away). This holds for a history of exactly one
 *     finished turn too — the shape of *every* pre-turn boundary;
 *   - the turn is still running → the boundary moves back one turn, so the
 *     previous turn survives while the current one is being worked on;
 *   - a single in-progress turn (no earlier turn to protect) → the layer's own
 *     sliding window, so a runaway turn still gets bounded in-loop. Such a turn
 *     is folded by `SessionManager.compact()` instead (the budget valve).
 *
 * With `AGENT_TURN_AWARE_COMPACTION` off, the legacy assistant-count boundary
 * is returned unchanged.
 */
export function protectedStart(messages: readonly Message[], assistantTurns: number): number {
  const boundary = assistantWindowStart(messages, assistantTurns)
  if (!turnAwareCompactionEnabled()) return boundary
  const turns = turnCount(messages)
  if (turns === 0) return boundary
  if (turnInProgress(messages)) {
    // Nothing older to protect while the first turn is still running: keep the
    // layer's own sliding window so a single runaway turn gets bounded in-loop.
    return turns < 2 ? boundary : Math.min(boundary, nthTurnStart(messages, 2))
  }
  // A FINISHED turn is never cut, however many turns the history holds.
  return Math.min(boundary, lastTurnStart(messages))
}

/** The pre-SHO-122 boundary: the first message of the last `assistantTurns` assistant messages. */
export function assistantWindowStart(messages: readonly Message[], assistantTurns: number): number {
  if (assistantTurns <= 0) return messages.length
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue
    if (++seen === assistantTurns) return i
  }
  return 0
}

// ---------------------------------------------------------------------------
// Folding one oversized turn
// ---------------------------------------------------------------------------

/** One assistant tool round plus the results it produced. */
interface Round {
  start: number
  end: number
  toolNames: string[]
  args: Record<string, any>
  chars: number
}

function roundsOf(messages: readonly Message[], from: number): { rounds: Round[]; tailStart: number } {
  const rounds: Round[] = []
  let tailStart = messages.length

  for (let i = from; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue
    const content = (msg as AssistantMessage).content
    if (!Array.isArray(content)) continue
    const calls = content.filter((b) => b?.type === 'toolCall') as ToolCall[]
    if (calls.length === 0) continue

    let end = i + 1
    while (end < messages.length && messages[end].role === 'toolResult') end++
    const round: Round = {
      start: i,
      end,
      toolNames: calls.map((c) => c.name),
      args: (calls[0]?.arguments as Record<string, any>) ?? {},
      chars: 0,
    }
    // The final assistant text that closes the turn is not part of a round.
    if (end === messages.length) tailStart = messages.length
    for (let j = i; j < end; j++) round.chars += messageChars(messages[j])
    rounds.push(round)
    i = end - 1
  }

  return { rounds, tailStart }
}

/** `{"command":"bun test","path":"a.ts"}` — identity keys first, then the rest, capped. */
export function compactToolArgs(args: unknown, maxChars = 200): string {
  if (!args || typeof args !== 'object') return '{}'
  const record = args as Record<string, any>
  const priority = ['command', 'path', 'file_path', 'target_file', 'pattern', 'url', 'query']
  const ordered: Record<string, any> = {}
  for (const key of priority) {
    if (key in record) ordered[key] = record[key]
  }
  for (const key of Object.keys(record)) {
    if (!(key in ordered)) ordered[key] = record[key]
  }
  let json = JSON.stringify(ordered)
  if (json.length > maxChars) json = `${json.slice(0, Math.max(0, maxChars - 3))}...`
  return json
}

/** The one line that replaces a dropped round. */
export function roundPlaceholder(round: Round, index: number, total: number): string {
  const tools = round.toolNames.join('+') || 'tool'
  return `[round ${index}/${total} · ${tools} · ${round.chars.toLocaleString('en-US')} chars cleared · args: ${compactToolArgs(round.args)}]`
}

export interface FoldResult {
  messages: Message[]
  foldedRounds: number
  clearedChars: number
}

/**
 * Budget safety valve: never summarize a turn away, fold its middle instead.
 *
 * Keeps the turn's opening user message, its first round, the last
 * `keepRounds` rounds and the assistant text that closes it. Each dropped
 * round becomes one line that still carries the tool's **name and arguments**
 * — only the output is gone — so a model reading it can act on the real tool
 * set instead of guessing one (`str_replace` was never real).
 *
 * `maxChars` is checked against the folded result and more rounds are dropped
 * (down to first + last) until it fits.
 */
export function foldTurnMiddle(
  messages: readonly Message[],
  from: number,
  opts: { maxChars: number; keepRounds?: number },
): FoldResult {
  const start = Math.max(0, Math.min(from, messages.length - 1))
  const { rounds } = roundsOf(messages, start)
  if (rounds.length <= 1) return { messages: messages.slice(), foldedRounds: 0, clearedChars: 0 }

  const total = rounds.length
  let keepRounds = Math.max(0, opts.keepRounds ?? 2)

  for (;;) {
    const keep = new Set<number>()
    keep.add(0)
    for (let k = Math.max(1, total - keepRounds); k < total; k++) keep.add(k)

    const out: Message[] = []
    let foldedRounds = 0
    let clearedChars = 0
    let index = 0
    // Everything before the first round is the turn's own opening (the user
    // message, or messages steered in before the first tool call).
    out.push(...messages.slice(start, rounds[0].start))
    for (const round of rounds) {
      index++
      if (keep.has(index - 1)) {
        out.push(...messages.slice(round.start, round.end))
      } else {
        out.push({
          role: 'user',
          content: roundPlaceholder(round, index, total),
          timestamp: Date.now(),
          __shogoRoundPlaceholder: true,
        } as unknown as Message)
        foldedRounds++
        clearedChars += round.chars
      }
    }
    // The assistant text that closes the turn (and anything after the last
    // round) always survives: it is what the user saw.
    const lastEnd = rounds[rounds.length - 1].end
    out.push(...messages.slice(lastEnd))

    const chars = out.reduce((sum, m) => sum + messageChars(m), 0)
    if (chars <= opts.maxChars || keepRounds === 0) {
      return { messages: out, foldedRounds, clearedChars }
    }
    keepRounds--
  }
}
