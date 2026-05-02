// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Stateful decoder for the body of `POST /terminal/run`. Strips the
 * trailing record-separator-framed metadata sentinel out of the visible
 * output and exposes the parsed `{ cwd, exitCode, signal }` so callers
 * can update synthetic-shell state.
 *
 * The decoder must hold back any partial sentinel tail across chunk
 * boundaries — TCP can split the framing bytes anywhere, and we MUST NOT
 * leak `\u001eSHOGO_TERM_META:…` into the visible terminal output.
 */
import {
  extractMeta,
  findIncompleteTailIndex,
  UNTERMINATED_SENTINEL_RE,
  type RunMeta,
} from './meta-sentinel'

export interface DecoderState {
  /** Accumulated bytes that haven't been classified as sentinel-or-not. */
  pending: string
  /** Last seen complete meta payload, if any. */
  meta: RunMeta | null
  /**
   * True when we've just consumed a sentinel and a trailing `\n` may
   * still be in transit (byte-by-byte streaming case). On the next push
   * or finish, swallow exactly one leading `\n` to keep both code paths
   * in sync with the all-at-once `\n?` regex.
   */
  swallowNextNewline: boolean
}

export function makeDecoderState(): DecoderState {
  return { pending: '', meta: null, swallowNextNewline: false }
}

export interface DecodeResult {
  /** Bytes safe to flush to the visible terminal output buffer. */
  visible: string
  /** Updated meta if a complete sentinel was decoded during this push. */
  meta: RunMeta | null
}

/**
 * Feed a decoded chunk into the decoder. Returns the bytes that are safe
 * to render (sentinels stripped, tail held back) plus any meta payload
 * decoded during this push.
 */
export function pushChunk(state: DecoderState, chunk: string): DecodeResult {
  state.pending += chunk

  // The on-wire framing is `…\u001e\n`. The regex's `\n?` swallows the
  // trailing newline when the chunk arrives all-at-once, but in a
  // streaming scenario the closing `\u001e` may arrive *before* the
  // `\n`. If our previous push consumed the sentinel without the `\n`,
  // drop a single leading `\n` here so both code paths produce identical
  // visible output.
  if (state.swallowNextNewline) {
    if (state.pending.startsWith('\n')) {
      state.pending = state.pending.slice(1)
    }
    // Whatever the next byte is, we've answered the question.
    state.swallowNextNewline = false
  }

  // Pull every complete sentinel out — there's typically one (emitted at
  // EOF by the server) but we loop defensively against future protocol
  // changes that might emit more.
  let metaThisPush: RunMeta | null = null
  while (true) {
    const { meta, rest } = extractMeta(state.pending)
    if (!meta && rest === state.pending) break
    if (meta) {
      metaThisPush = meta
      state.meta = meta
    }
    state.pending = rest
    if (!meta) break
    if (state.pending.startsWith('\n')) {
      // Same-chunk `\n` already in pending: strip it now.
      state.pending = state.pending.slice(1)
    } else {
      // The `\n` may arrive in the next chunk — arm the swallow flag.
      state.swallowNextNewline = true
    }
  }

  // Hold back any trailing 0x1E that *could* be the start of a sentinel
  // straddling a TCP chunk boundary.
  const tail = findIncompleteTailIndex(state.pending)
  let visible: string
  if (tail === -1) {
    visible = state.pending
    state.pending = ''
  } else {
    visible = state.pending.slice(0, tail)
    state.pending = state.pending.slice(tail)
  }

  return { visible, meta: metaThisPush }
}

/**
 * Drain at end-of-stream. Pulls any final meta out, then drops a
 * trailing fragment that still looks like an unterminated sentinel
 * rather than rendering control bytes to the user.
 */
export function finish(state: DecoderState): DecodeResult {
  // Honor a still-armed swallow flag — if the previous push consumed a
  // sentinel and the trailing `\n` ended up in pending right before EOF,
  // we'd otherwise leak it.
  if (state.swallowNextNewline && state.pending.startsWith('\n')) {
    state.pending = state.pending.slice(1)
  }
  state.swallowNextNewline = false

  let metaAtEnd: RunMeta | null = null
  const { meta, rest } = extractMeta(state.pending)
  if (meta) {
    metaAtEnd = meta
    state.meta = meta
    state.pending = rest
  }
  if (UNTERMINATED_SENTINEL_RE.test(state.pending)) {
    state.pending = ''
  }
  const visible = state.pending
  state.pending = ''
  return { visible, meta: metaAtEnd }
}
