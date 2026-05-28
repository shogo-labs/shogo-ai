// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Streaming OSC decoder that recognises the three shell-integration
 * dialects we care about — VS Code's OSC 633, FinalTerm's OSC 133, and
 * iTerm2's OSC 1337 — and yields a stream of `{ passthrough, events }`
 * per `feed()` call.
 *
 * Design constraints (every one of these is enforced by adversarial
 * unit tests; do not relax without adding a test that proves the new
 * relaxation is safe):
 *
 *   1. The decoder is **byte-driven** and **chunk-agnostic**. The caller
 *      may split a sequence anywhere — between ESC and ']', mid-payload,
 *      between ESC and '\' of an ST terminator, etc. State persists
 *      across `feed()` calls until either a terminator is seen or the
 *      payload exceeds `maxPayloadBytes` (default 4 KiB) at which point
 *      the partial sequence is dropped and the byte that overflowed is
 *      handled as if no OSC were in progress.
 *
 *   2. Both **C0 (ESC ])** and **C1 (0x9D)** introducers are accepted.
 *      Both **BEL (0x07)** and **ST (ESC \ or 0x9C)** terminators are
 *      accepted. xterm spec allows all four mixes; real-world shells
 *      use BEL more often, but VS Code switched to ST in 2023.
 *
 *   3. **OSC bytes never appear in `passthrough`.** Once we commit to
 *      an OSC introducer the bytes through the terminator are consumed
 *      regardless of whether we recognise the Ps prefix. Stripping the
 *      OSC out of the byte stream is the whole point — xterm.js does
 *      not need to render an OSC 633 mark and the scrollback ring does
 *      not need to store it.
 *
 *   4. **Malformed → drop + resync.** A bare `ESC X` where X is not `]`
 *      or `\` flushes the suspended `ESC` byte to passthrough and
 *      processes X normally. A bare `ESC \` outside an OSC flushes
 *      both bytes (legal but uninteresting C1 ST).
 *
 *   5. **No allocations on the hot path.** `feed()` reuses a single
 *      internal payload buffer and grows it geometrically only on
 *      overflow. Output `passthrough` is a single defensive copy of
 *      the non-OSC bytes from the input chunk.
 *
 * The decoder yields semantically-typed events for OSC 633 and OSC 133
 * (the marks we actually need for command tracking), plus a generic
 * `unknown-osc` event for anything else (callers can ignore it; we
 * still strip the bytes).
 */

// ─── byte constants ─────────────────────────────────────────────────────

const BEL = 0x07
const ESC = 0x1b
const BACKSLASH = 0x5c // ']' = 0x5d, '\' = 0x5c
const BRACKET_CLOSE = 0x5d
const C1_OSC = 0x9d
const C1_ST = 0x9c
const SEMI = 0x3b // ';'

// ─── events ─────────────────────────────────────────────────────────────

/**
 * VS Code's per-command shell-integration marks. Letters match the
 * spec at https://code.visualstudio.com/docs/terminal/shell-integration
 *
 *   A — prompt start (before PS1 prints)
 *   B — prompt end / command line begin
 *   C — pre-execution (after Enter, before the command runs)
 *   D[;exit] — command complete with optional exit code
 *   E[;cmd] — command line (optional; redundant with B→C)
 *   P;key=value — property (e.g. P;Cwd=/tmp)
 */
export type Osc633Letter = 'A' | 'B' | 'C' | 'D' | 'E' | 'P'

export interface Osc633Event {
  kind: 'osc-633'
  letter: Osc633Letter
  /** Arguments after the letter, semi-colon separated, NOT including the letter. */
  args: string[]
}

/**
 * FinalTerm's OSC 133 marks. Same conceptual model as 633 but pre-dates
 * it. We translate to the same letters internally.
 *
 *   A — prompt start, B — prompt end, C — command start, D[;exit] — done
 */
export interface Osc133Event {
  kind: 'osc-133'
  letter: 'A' | 'B' | 'C' | 'D'
  args: string[]
}

/** Generic catch-all for any OSC that isn't 633/133. iTerm2's 1337 lands here. */
export interface OscUnknownEvent {
  kind: 'unknown-osc'
  /** First semicolon-delimited token (the Ps in `OSC Ps;Pt ST`). */
  ps: string
  /** Everything after the first ';'. Empty if the OSC was just `OSC Ps ST`. */
  pt: string
}

/**
 * Emitted when an OSC introducer was opened but no terminator arrived
 * before `maxPayloadBytes` was exceeded. The payload bytes are dropped.
 * Callers normally ignore this; it exists so adversarial tests can
 * assert "we resynced" without having to inspect internal state.
 */
export interface OscOverflowEvent {
  kind: 'overflow'
  droppedBytes: number
}

export type OscEvent = Osc633Event | Osc133Event | OscUnknownEvent | OscOverflowEvent

export interface OscDecodeResult {
  /** Non-OSC bytes from this feed call, in the order they were seen. */
  passthrough: Uint8Array
  /** Recognised OSC events from this feed call, in order. */
  events: OscEvent[]
}

// ─── state machine ──────────────────────────────────────────────────────

const enum S {
  /** Outside any escape. Bytes pass through. */
  Ground = 0,
  /** Saw ESC. Next byte decides: `]` → OSC, `\` → C1 ST (flush), else flush both. */
  Esc = 1,
  /** Inside an OSC payload, accumulating bytes until a terminator. */
  OscPayload = 2,
  /** Inside an OSC payload, just saw ESC — waiting on `\` (true ST) or anything-else (a real ESC inside the payload, legal). */
  OscPayloadEsc = 3,
}

const TEXT_DEC = new TextDecoder('utf-8', { fatal: false })

export interface OscDecoderOptions {
  /** Cap on OSC payload size before we declare overflow and drop. Default 4096. */
  maxPayloadBytes?: number
}

export class OscDecoder {
  private state: S = S.Ground
  /** Reused growable buffer for the in-progress OSC payload. */
  private payload: Uint8Array
  private payloadLen = 0
  private readonly maxPayload: number

  constructor(opts: OscDecoderOptions = {}) {
    this.maxPayload = Math.max(64, opts.maxPayloadBytes ?? 4096)
    this.payload = new Uint8Array(256)
  }

  /**
   * Feed a chunk of bytes from the PTY. Returns the non-OSC bytes plus
   * any complete OSC events found. Caller must NOT pass the same buffer
   * to mutate it before the return value is consumed — the passthrough
   * is sliced out of a fresh allocation.
   */
  feed(input: Uint8Array): OscDecodeResult {
    const events: OscEvent[] = []
    // Worst case: every byte is passthrough.
    const out = new Uint8Array(input.length)
    let outLen = 0

    for (let i = 0; i < input.length; i++) {
      const b = input[i]!
      switch (this.state) {
        case S.Ground: {
          if (b === ESC) {
            this.state = S.Esc
          } else if (b === C1_OSC) {
            this.beginOsc()
          } else {
            out[outLen++] = b
          }
          break
        }
        case S.Esc: {
          if (b === BRACKET_CLOSE) {
            this.beginOsc()
          } else if (b === BACKSLASH) {
            // ESC \ outside an OSC — a stray C1 ST. Drop both. (Real
            // terminals ignore it; not letting it through avoids xterm
            // emitting a noisy "unknown escape" log.)
            this.state = S.Ground
          } else {
            // Any other byte after a bare ESC: flush the ESC, then re-process this byte.
            out[outLen++] = ESC
            this.state = S.Ground
            i-- // re-process under Ground
          }
          break
        }
        case S.OscPayload: {
          if (b === BEL) {
            this.completeOsc(events)
          } else if (b === ESC) {
            this.state = S.OscPayloadEsc
          } else if (b === C1_ST) {
            this.completeOsc(events)
          } else {
            if (!this.appendPayload(b)) {
              // Overflow — emit overflow event, drop, return to Ground,
              // and re-process this byte (no preceding ESC consumed).
              const dropped = this.payloadLen
              this.payloadLen = 0
              this.state = S.Ground
              events.push({ kind: 'overflow', droppedBytes: dropped })
              i--
            }
          }
          break
        }
        case S.OscPayloadEsc: {
          if (b === BACKSLASH) {
            this.completeOsc(events)
          } else {
            // Embedded ESC inside an OSC payload — legal (some apps use
            // it inside the string). Keep both bytes in payload and
            // re-process this byte under OscPayload.
            if (!this.appendPayload(ESC) || !this.appendPayload(b)) {
              const dropped = this.payloadLen
              this.payloadLen = 0
              this.state = S.Ground
              events.push({ kind: 'overflow', droppedBytes: dropped })
            } else {
              this.state = S.OscPayload
            }
          }
          break
        }
      }
    }

    return { passthrough: out.slice(0, outLen), events }
  }

  /** Current state — exposed for tests; not part of the public API. */
  _stateForTest(): { state: number; payloadLen: number } {
    return { state: this.state, payloadLen: this.payloadLen }
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private beginOsc(): void {
    this.state = S.OscPayload
    this.payloadLen = 0
  }

  private appendPayload(b: number): boolean {
    if (this.payloadLen >= this.maxPayload) return false
    if (this.payloadLen >= this.payload.length) {
      const grown = new Uint8Array(Math.min(this.maxPayload, this.payload.length * 2))
      grown.set(this.payload.subarray(0, this.payloadLen))
      this.payload = grown
    }
    this.payload[this.payloadLen++] = b
    return true
  }

  private completeOsc(events: OscEvent[]): void {
    const text = TEXT_DEC.decode(this.payload.subarray(0, this.payloadLen))
    this.payloadLen = 0
    this.state = S.Ground

    // Split into Ps (digits before first ';') and Pt (everything after).
    const semi = text.indexOf(';')
    const psStr = semi === -1 ? text : text.slice(0, semi)
    const pt = semi === -1 ? '' : text.slice(semi + 1)

    if (psStr === '633') {
      events.push(this.parseDelimitedMark('osc-633', pt))
      return
    }
    if (psStr === '133') {
      events.push(this.parseDelimitedMark('osc-133', pt) as Osc133Event)
      return
    }
    events.push({ kind: 'unknown-osc', ps: psStr, pt })
  }

  private parseDelimitedMark(kind: 'osc-633' | 'osc-133', pt: string): Osc633Event | Osc133Event {
    // pt is e.g. "A" or "D;0" or "P;Cwd=/tmp" or "E;ls -la".
    // First char is the letter; remaining (if any, after a ';') are args.
    const letter = (pt[0] ?? '') as Osc633Letter
    let args: string[] = []
    if (pt.length > 1) {
      // Letter followed by ';arg1;arg2...' OR letter followed by no separator
      // (some emitters do `633;P;Cwd=...` — the P is letter, ; then args).
      const rest = pt[1] === ';' ? pt.slice(2) : pt.slice(1)
      args = rest.length === 0 ? [] : rest.split(';')
    }
    if (kind === 'osc-133') {
      // OSC 133 only defines A/B/C/D. Anything else: still emit so the
      // tracker can decide, but normalise the type.
      return { kind: 'osc-133', letter: (letter as 'A' | 'B' | 'C' | 'D'), args }
    }
    return { kind: 'osc-633', letter, args }
  }
}

// ─── convenience helpers for callers that don't need streaming ─────────

/**
 * One-shot decode helper for tests and callers that already have a full
 * chunk and don't care about streaming state. Creates a throwaway
 * decoder and feeds the chunk through it. NOT for hot-path use.
 */
export function decodeOscOneShot(bytes: Uint8Array): OscDecodeResult {
  return new OscDecoder().feed(bytes)
}
