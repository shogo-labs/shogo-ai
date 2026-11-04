// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Which saved row is the reply this window just streamed (SHO-300).
 *
 * After a turn ends the panel refetches the chat's saved history so a reload
 * shows the reply. It used to look only for an assistant row that was *not*
 * there before, and treat that as "the reply was written". Since the API saves
 * the reply partway through the turn, that row can already be in the list by
 * the time the turn ends — so no new id ever appeared, the SHO-85 repaint never
 * ran, and every turn ended with
 * `[ChatPanel] Assistant message not yet persisted after reconcile retries`
 * even though the row had been saved the whole time.
 *
 * "The reply for this turn" is therefore a row that either appeared after the
 * send or changed since it — not just one whose id is new — and, when several
 * qualify, the one whose text matches what this window streamed.
 */

export interface ReconcileRow {
  id: string
  role?: string | null
  sessionId?: string | null
  content?: string | null
}

/** Whitespace-normalized, so a comparison never depends on formatting. */
function normalize(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * The assistant rows a chat had when a send started: id -> normalized text.
 * A row missing from this map, or a row whose text differs from what it held
 * here, was written during the turn.
 */
export function assistantRowsAtSend(
  rows: readonly ReconcileRow[],
  sessionId: string,
): Map<string, string> {
  const atSend = new Map<string, string>()
  for (const row of rows) {
    if (row.role !== 'assistant' || row.sessionId !== sessionId) continue
    atSend.set(row.id, normalize(row.content))
  }
  return atSend
}

/** Does `row` hold the reply this window streamed (`turnText`)? */
export function isReplyForTurn(
  rowContent: string | null | undefined,
  turnText: string,
): boolean {
  const row = normalize(rowContent)
  const turn = normalize(turnText)
  if (!row || !turn) return false
  if (row === turn) return true
  // The row saved mid-turn can be a prefix of what the window later streamed
  // (a step's text, not the whole turn). Compare only a substantial prefix so
  // a short greeting cannot stand in for a whole reply.
  const [shorter, longer] = row.length <= turn.length ? [row, turn] : [turn, row]
  return shorter.length >= 40 && longer.startsWith(shorter)
}

/**
 * The id of the saved row for this turn, or `null` when the server has not
 * written it yet. `atSend` is the snapshot from {@link assistantRowsAtSend},
 * taken when the send started.
 */
export function findTurnReplyRow({
  rows,
  sessionId,
  atSend,
  turnText,
}: {
  rows: readonly ReconcileRow[]
  sessionId: string
  atSend: ReadonlyMap<string, string>
  turnText: string
}): string | null {
  const turn = normalize(turnText)
  let fallback: string | null = null
  for (const row of rows) {
    if (row.role !== 'assistant' || row.sessionId !== sessionId) continue
    const text = normalize(row.content)
    if (!text) continue
    // A row that already said this before the send is not this turn's reply.
    if (atSend.get(row.id) === text) continue
    if (turn) {
      // The turn wrote text, so its saved row must hold that text. Anything
      // else is an earlier turn's reply — picking it repainted history over a
      // reply that had only ever been on screen, which deleted it (SHO-325).
      if (isReplyForTurn(row.content, turnText)) return row.id
      continue
    }
    // A turn with no text of its own (tool calls only): the best this window
    // can say is "a row that was not here when the send started".
    fallback = row.id
  }
  return fallback
}
