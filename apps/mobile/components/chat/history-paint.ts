// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether a transcript rebuilt from saved history may replace the one on
 * screen (SHO-85).
 *
 * The assistant row is written by the API *after* the stream EOFs —
 * `trackUsageFromStream` → `persistAssistantSnapshot`, i.e. EOF, then billing
 * close, then a possible auto-resume. `onFinish` in the panel therefore usually
 * fires while the reply exists **only on screen**. Any paint from `/chat-messages`
 * in that window replaces the transcript with rows that end on the user's
 * prompt, and the reply the person just watched finish disappears until the
 * panel is reopened.
 *
 * The revalidate fetch itself must stay (it adopts canonical server ids and
 * picks up replies written elsewhere, SHO-31/SHO-53); it is the *paint* that
 * has to know when history is behind the screen. This module is that decision,
 * kept pure so it can be tested without a React tree or a running API.
 */

/** One part of a live SDK message. */
export interface PaintablePart {
  type?: string | null
  text?: string | null
}

/** The shape the decision needs from a message — a server row or a live SDK message. */
export interface PaintableMessage {
  id?: string | null
  role?: string | null
  content?: string | null
  parts?: readonly PaintablePart[] | null
}

export interface HistoryPaintInput<T extends PaintableMessage> {
  /** Transcript rebuilt purely from saved server rows, oldest first. */
  history: readonly T[]
  /** Transcript on screen now, oldest first — may end on a reply that only exists live. */
  current: readonly T[]
  /**
   * This panel streamed or joined the turn whose reply is on screen, so that
   * reply is real even though the server has not written it yet.
   */
  keepsLiveTail: boolean
}

export type HistoryPaintReason =
  /** Nothing on screen to protect. */
  | "no-live-tail"
  /** The on-screen tail is not an assistant reply (a prompt, or empty). */
  | "tail-not-a-reply"
  /** History already holds the on-screen reply, so painting it is safe. */
  | "history-has-reply"
  /** History holds fewer replies than the screen: it is missing the newest one. */
  | "history-behind"
  /** History has no trailing reply but this panel streamed the turn. */
  | "streamed-turn"
  /**
   * History holds a prompt this screen has never shown: a turn started after
   * the one on screen (SHO-147). The paint still happens — see `resolveHistoryPaint`.
   */
  | "history-has-newer-prompt"

export interface HistoryPaintResult<T extends PaintableMessage> {
  /**
   * The array to paint. Identical to `input.current` when the live tail is
   * kept, so a caller can skip `setMessages` on reference equality and avoid a
   * re-render storm.
   */
  messages: readonly T[]
  /** True when the paint was refused to protect a reply the server has not written. */
  keptLiveTail: boolean
  /**
   * The returned messages still carry a reply that exists only on screen, so
   * the caller must not treat history as having adopted it yet.
   */
  carriedLiveReply: boolean
  reason: HistoryPaintReason
}

function isAssistant(message: PaintableMessage | undefined): boolean {
  return message?.role === "assistant"
}

/**
 * Whether a message has anything to show. The panel opens a turn with an empty
 * assistant bubble so its stream has somewhere to land, and a reload can leave
 * those bubbles behind with synthetic ids; counting them as replies makes
 * history look permanently "behind" and the paint below refuses forever
 * (SHO-260). A bubble earns its place once it carries text or a real part.
 */
export function carriesReplyContent(message: PaintableMessage | undefined): boolean {
  if (typeof message?.content === "string" && message.content.trim() !== "") return true
  const parts = message?.parts
  if (!Array.isArray(parts)) return false
  return parts.some((part) =>
    part?.type === "text" ? typeof part.text === "string" && part.text.trim() !== "" : Boolean(part),
  )
}

function assistantCount(messages: readonly PaintableMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (isAssistant(message) && carriesReplyContent(message)) count += 1
  }
  return count
}

function holdsId(messages: readonly PaintableMessage[], id: string): boolean {
  return messages.some((message) => String(message?.id ?? "") === id)
}

function userCount(messages: readonly PaintableMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message?.role === "user") count += 1
  }
  return count
}

/** Index of the `n`th (1-based) user row, or -1 when the array has fewer. */
function nthUserIndex(messages: readonly PaintableMessage[], n: number): number {
  let seen = 0
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue
    seen += 1
    if (seen === n) return index
  }
  return -1
}

/** The replies on screen that follow its newest prompt — the live, unsaved tail. */
function liveReplyTail<T extends PaintableMessage>(current: readonly T[]): readonly T[] {
  let lastPrompt = -1
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (current[index]?.role === "user") {
      lastPrompt = index
      break
    }
  }
  return current
    .slice(lastPrompt + 1)
    .filter((message) => isAssistant(message) && carriesReplyContent(message))
}

/**
 * Decide what to paint. History wins whenever it can account for what is on
 * screen; the live tail wins only when the screen is provably ahead of it.
 */
export function resolveHistoryPaint<T extends PaintableMessage>(
  input: HistoryPaintInput<T>,
): HistoryPaintResult<T> {
  // History is the newest page (`MESSAGE_PAGE_SIZE` rows), while the screen
  // can also hold older pages the person scrolled up to. Counted over the whole
  // screen, a 50-row page always looks "behind" once a chat passes 50 rows and
  // every paint is refused (Sentry chat_history_paint_dropped_reply,
  // historyRows=50 vs screenRows=52–56). Decide over the part of the screen
  // that page covers, and keep the older rows above it.
  const windowStart = historyWindowStart(input.history, input.current)
  if (windowStart > 0) {
    const decision = resolveWindowedHistoryPaint({
      ...input,
      current: input.current.slice(windowStart),
      // Which turn a reply belongs to is counted in prompts over the whole
      // screen, not over the window: the rows above it hold prompts too, and
      // forgetting them makes a live reply look like it answers the wrong turn.
      promptsBefore: userCount(input.current.slice(0, windowStart)),
    })
    if (decision.keptLiveTail) return { ...decision, messages: input.current }
    return {
      ...decision,
      messages: [...input.current.slice(0, windowStart), ...decision.messages],
    }
  }
  return resolveWindowedHistoryPaint(input)
}

/**
 * Index on screen of the first row of history's page, or 0 when history starts
 * at (or before) the top of the screen.
 *
 * The page is the newest `MESSAGE_PAGE_SIZE` rows while the screen can hold
 * older pages above it, so the decision has to run over the stretch of screen
 * the page covers and leave the rows above it alone. Align on the first page row
 * that is also on screen — a row whose id the client has not adopted yet is a
 * gap, not the end of the match, because the page and the screen can disagree on
 * the id of the same reply (an SDK or temp id, SHO-260).
 *
 * When the two share no id at all, both are oldest-first, so the page covers the
 * screen's newest rows. Aligning that way replaced the old fallback of comparing
 * the whole screen, which made a 50-row page look `history-behind` against a
 * 55-row screen on every paint — exactly the shape of Sentry
 * `chat_history_paint_dropped_reply` (`historyRows:50, screenRows:55`, SHO-328).
 */
function historyWindowStart(
  history: readonly PaintableMessage[],
  current: readonly PaintableMessage[],
): number {
  if (history.length === 0) return 0
  const screenIndex = new Map<string, number>()
  current.forEach((message, index) => {
    const id = String(message?.id ?? "")
    if (id && !screenIndex.has(id)) screenIndex.set(id, index)
  })
  for (const message of history) {
    const id = String(message?.id ?? "")
    if (!id) continue
    const index = screenIndex.get(id)
    if (index === undefined) continue
    return index > 0 ? index : 0
  }
  return current.length > history.length ? current.length - history.length : 0
}

function resolveWindowedHistoryPaint<T extends PaintableMessage>(
  input: HistoryPaintInput<T> & { promptsBefore?: number },
): HistoryPaintResult<T> {
  const { history, current, keepsLiveTail } = input
  const paint = (reason: HistoryPaintReason): HistoryPaintResult<T> => ({
    messages: history,
    keptLiveTail: false,
    carriedLiveReply: false,
    reason,
  })
  const keep = (reason: HistoryPaintReason): HistoryPaintResult<T> => ({
    messages: current,
    keptLiveTail: true,
    carriedLiveReply: true,
    reason,
  })

  const currentTail = current[current.length - 1]
  if (!currentTail) return paint("no-live-tail")
  if (!isAssistant(currentTail)) {
    // A prompt on the tail of a transcript that still carries a reply history
    // has not written: the reply was spliced in ahead of that prompt by the
    // SHO-147 paint below. Keep both until the server catches up.
    if (keepsLiveTail && assistantCount(history) < assistantCount(current)) {
      return keep("history-behind")
    }
    return paint("tail-not-a-reply")
  }

  // Same reply already saved (canonical id adopted, or a live paint that landed
  // on the server row): painting history is what keeps a single copy.
  const currentTailId = String(currentTail.id ?? "")
  if (currentTailId && holdsId(history, currentTailId)) return paint("history-has-reply")

  // Same reply under an id the client has not adopted yet (SHO-328). The page
  // read comes back with the server's row while the screen still streams the
  // reply under an SDK/temp id, so no id matches and the reply count is off by
  // one — the paint was refused as `history-behind` on every pass.
  //
  // Text alone is not enough to call two transcripts the same ("Done." is a
  // whole reply), so this only trusts a page that lines up row for row with the
  // window it covers and ends on the same reply. Then painting is not just safe,
  // it is the paint that adopts the server's row.
  const tailText = replyText(currentTail)
  if (
    tailText &&
    current.length === history.length &&
    userCount(history) === userCount(current)
  ) {
    const newestSavedReply = [...history]
      .reverse()
      .find((message) => isAssistant(message) && carriesReplyContent(message))
    if (newestSavedReply && replyText(newestSavedReply) === tailText) {
      return paint("history-has-reply")
    }
  }

  // History that is *ahead* of the screen wins (SHO-147). A turn started right
  // after this panel's own — a tag, a `[Task update]` wake, a queued row — writes
  // its user row before it starts, so `/chat-messages` can come back ending on a
  // prompt this screen has never shown. Refusing that paint (the `streamed-turn`
  // rule below) leaves the prompt off screen while the panel still attaches to
  // the new turn's stream, which carries *only* the reply: the SDK then appends
  // it after the previous reply with no user row between them, and the turn
  // grouping gives the one bubble to the newer reply. So paint, and splice the
  // reply that exists only on screen in front of the newer prompt.
  const screenPrompts = userCount(current) + (input.promptsBefore ?? 0)
  if (userCount(history) > screenPrompts) {
    const newerPromptIndex = nthUserIndex(history, screenPrompts + 1)
    if (newerPromptIndex < 0) return paint("history-has-newer-prompt")
    // Everything after the previous prompt: if history already holds a reply
    // there, nothing on screen is missing from it (and splicing would show the
    // same answer twice), so the paint is enough.
    const promptIndex = screenPrompts > 0 ? nthUserIndex(history, screenPrompts) : -1
    const replyAlreadySaved = history.some(
      (message, index) => index > promptIndex && isAssistant(message),
    )
    const liveTail = replyAlreadySaved
      ? []
      : liveReplyTail(current).filter(
          (message) => !message.id || !holdsId(history, String(message.id)),
        )
    if (liveTail.length === 0) return paint("history-has-newer-prompt")
    return {
      messages: [
        ...history.slice(0, newerPromptIndex),
        ...liveTail,
        ...history.slice(newerPromptIndex),
      ],
      keptLiveTail: false,
      carriedLiveReply: true,
      reason: "history-has-newer-prompt",
    }
  }

  const historyTail = history[history.length - 1]
  // The turn's reply is the only thing history lacks and it ends in prose, so
  // this panel's own stream is enough to know the tail is real.
  if (keepsLiveTail && !isAssistant(historyTail)) return keep("streamed-turn")

  // Fall back to counting replies: fewer on the server than on screen means the
  // newest one (or more) exists only live — whether history stops on the prompt
  // that produced it or on an earlier turn's reply.
  if (assistantCount(history) < assistantCount(current)) return keep("history-behind")

  return paint("history-has-reply")
}

export type LiveTurnAttachReason =
  /** Nothing on screen yet (a cold open into a running turn). */
  | "nothing-on-screen"
  /** The screen ends on a prompt: the live turn's own user row is here. */
  | "screen-ends-on-prompt"
  /** The screen ends on a reply and history adds no prompt: a refocus mid-turn. */
  | "screen-streams-this-turn"
  /** History holds a prompt the screen has never shown. Reload before attaching. */
  | "history-has-newer-prompt"

export interface LiveTurnAttachInput<T extends PaintableMessage> {
  /** The transcript on screen, exactly as it would be painted. */
  screen: readonly T[]
  /** Rows rebuilt from saved history, oldest first. */
  history: readonly T[]
}

export interface LiveTurnAttachResult {
  attach: boolean
  reason: LiveTurnAttachReason
}

/**
 * Whether a live turn found by a probe may be attached to (SHO-147).
 *
 * The stream carries the assistant reply only; the turn's user row is what
 * separates it from the reply above it. Attaching while history holds a prompt
 * the screen has not painted puts the new reply straight after the previous
 * one, and the transcript's one-assistant-per-turn grouping shows it in that
 * turn's bubble. So attach when the prompt is here (the screen ends on it), or
 * when this window is already streaming the reply it ends on; otherwise paint
 * history first and let that load's own probe attach.
 */
export function resolveLiveTurnAttach<T extends PaintableMessage>(
  input: LiveTurnAttachInput<T>,
): LiveTurnAttachResult {
  const { screen, history } = input
  if (screen.length === 0) return { attach: true, reason: "nothing-on-screen" }
  if (userCount(history) > userCount(screen)) {
    return { attach: false, reason: "history-has-newer-prompt" }
  }
  const tail = screen[screen.length - 1]
  if (!isAssistant(tail)) return { attach: true, reason: "screen-ends-on-prompt" }
  return { attach: true, reason: "screen-streams-this-turn" }
}

/** One reply the screen shows that a painted transcript no longer carries. */
export interface RemovedReply {
  id: string
  contentLength: number
}

/** What a message says, whatever shape it arrived in (row or live SDK message). */
function replyText(message: PaintableMessage | undefined): string {
  if (typeof message?.content === "string" && message.content.trim() !== "") {
    return message.content.trim()
  }
  const parts = message?.parts
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => (part.text ?? "").trim())
    .join(" ")
    .trim()
}

/**
 * Replies that are on screen but missing from a transcript about to be painted
 * (SHO-328).
 *
 * This is the invariant the "my reply vanished" reports never had an event for:
 * `chat_history_paint_dropped_reply` fires from the guard that *keeps* the live
 * reply, so the paint that actually deleted it left no trace at all. A caller
 * reports this before it paints and never blocks the paint on it — a transcript
 * still has to be replaced when the server deleted rows (an edit, a truncate).
 *
 * What counts is the number of replies, not which ids they have. Adopting the
 * server's row, or painting a regenerated answer, swaps a reply for another reply
 * and must not read as a loss; a paint that leaves the transcript with fewer
 * replies than the screen has, or that ends on a prompt where the screen ended on
 * an answer, is the vanish this looks for.
 */
export function findRemovedReplies(
  previous: readonly PaintableMessage[],
  next: readonly PaintableMessage[],
): RemovedReply[] {
  const repliesOnScreen = previous.filter(
    (message) => isAssistant(message) && carriesReplyContent(message),
  )
  const repliesPainted = next.filter(
    (message) => isAssistant(message) && carriesReplyContent(message),
  ).length
  if (repliesOnScreen.length <= repliesPainted) return []
  const nextIds = new Set(next.map((message) => String(message?.id ?? "")).filter(Boolean))
  const nextTexts = new Set(
    next.filter((message) => isAssistant(message) && carriesReplyContent(message)).map(replyText),
  )
  const missing = repliesOnScreen.filter((message) => {
    const id = String(message?.id ?? "")
    if (id && nextIds.has(id)) return false
    return !nextTexts.has(replyText(message))
  })
  // Only the shortfall is a loss; a repaint may legitimately keep every id.
  return missing.slice(0, repliesOnScreen.length - repliesPainted).map((message) => ({
    id: String(message?.id ?? ""),
    contentLength: replyText(message).length,
  }))
}
