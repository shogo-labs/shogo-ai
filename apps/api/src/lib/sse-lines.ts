// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Incremental SSE line splitting (SHO-277).
 *
 * The relays used to do `buffer += decoder.decode(chunk)` and then
 * `buffer.split('\n')` over the whole buffer on every chunk. That re-scans and
 * re-allocates everything received so far, so a long-lived stream (an agent
 * turn is minutes) grew quadratically — on the same event loop that serves the
 * user's other requests.
 *
 * This keeps only the trailing partial line between chunks. It is deliberately
 * a pure function so both relays can use it: `project-chat.ts` (the project
 * chat stream) and `conversation-agent-dispatcher.ts` (team-agent replies).
 */
export interface CompleteLines {
  /** Every `\n`-terminated line in the buffer, without its terminator. */
  lines: string[]
  /** The trailing partial line, to prepend to the next chunk. */
  rest: string
}

/** Split `buffer` at its newlines, keeping only the unterminated tail. */
export function takeCompleteLines(buffer: string, opts: { stripCr?: boolean } = {}): CompleteLines {
  const firstNewline = buffer.indexOf('\n')
  if (firstNewline === -1) return { lines: [], rest: buffer }

  const lines: string[] = []
  let start = 0
  let newline = firstNewline
  while (newline !== -1) {
    let line = buffer.slice(start, newline)
    // SSE frames may be CRLF-terminated; the `\r` belongs to the terminator.
    if (opts.stripCr && line.endsWith('\r')) line = line.slice(0, -1)
    lines.push(line)
    start = newline + 1
    newline = buffer.indexOf('\n', start)
  }
  return { lines, rest: buffer.slice(start) }
}
