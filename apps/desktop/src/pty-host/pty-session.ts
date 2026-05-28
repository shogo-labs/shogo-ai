// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One PtySession wraps a single `node-pty` instance + a ScrollbackRing.
 *
 * Why we mirror agent-runtime's PtySession instead of importing it:
 *   - that one uses `Bun.spawn({ terminal })`, this one uses `node-pty`
 *   - that one runs inside a Bun server, this one runs inside an Electron
 *     `utilityProcess` (Node, not Bun)
 *
 * The shared invariants (chunk-keyed seq, never split mid-chunk, defensive
 * copy of each kernel chunk) live in `@shogo/pty-core`'s `ScrollbackRing`
 * — so we don't duplicate those.
 */

import { spawn as ptySpawn, type IPty } from 'node-pty'
import { ScrollbackRing } from '@shogo/pty-core'
import {
  COLS_MAX,
  COLS_MIN,
  ROWS_MAX,
  ROWS_MIN,
  clampDim,
  type SessionInfo,
  type SpawnOptions,
} from './protocol'

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024 // mirrors agent-runtime default
const TEXT_ENC = new TextEncoder()

let HeadlessTerminal: any = null
try {
  // Optional at runtime: packaged builds include it, tests can run without it.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  HeadlessTerminal = require('xterm-headless').Terminal
} catch {
  HeadlessTerminal = null
}

/** Subscriber on a data port — see attach()/detach() in the host. */
export interface DataSubscriber {
  /** Stable id used for detach. Opaque to the session. */
  channelId: string
  /** Called for every chunk after subscription, in order. */
  onData(seq: number, bytes: Uint8Array): void
  /** Called once on exit; subscriber will not receive further data. */
  onExit(code: number | null, signal: string | null, reason: string): void
}

export class PtySession {
  readonly id: string
  readonly createdAt: number
  readonly shell: string
  readonly opts: SpawnOptions

  private pty: IPty
  private ring: ScrollbackRing
  private chunkSeq = 0
  private subs = new Map<string, DataSubscriber>()
  private lastWriteAt: number
  private exited = false
  private exitCode: number | null = null
  private exitSignal: string | null = null
  private cols: number
  private rows: number
  private headless: any = null

  constructor(id: string, opts: SpawnOptions, scrollbackBytes: number = DEFAULT_SCROLLBACK_BYTES) {
    this.id = id
    this.opts = opts
    this.shell = opts.shell
    this.createdAt = Date.now()
    this.lastWriteAt = this.createdAt
    this.cols = clampDim(opts.cols, COLS_MIN, COLS_MAX)
    this.rows = clampDim(opts.rows, ROWS_MIN, ROWS_MAX)
    this.ring = new ScrollbackRing(scrollbackBytes)
    if (HeadlessTerminal) {
      try {
        this.headless = new HeadlessTerminal({
          cols: this.cols,
          rows: this.rows,
          scrollback: 100,
          allowProposedApi: true,
        })
      } catch {
        this.headless = null
      }
    }

    this.pty = ptySpawn(opts.shell, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      cols: this.cols,
      rows: this.rows,
      // node-pty emits utf8 strings by default. We immediately encode to
      // bytes — keystrokes and PTY output may not be valid UTF-8 mid-chunk
      // (e.g. a multi-byte glyph split across two reads), but node-pty's
      // utf8 decoder is lenient and replaces with U+FFFD which we accept
      // as a known platform constraint. ConPTY on Windows is even more
      // opinionated. Once `encoding: null` raw-byte mode is widely
      // available in the chosen fork we'll switch to that.
      encoding: 'utf8',
      // Conservative ConPTY gate (Phase 3 will refine via os.release()).
      useConpty: process.platform === 'win32',
    })

    this.pty.onData((data) => {
      // Copy the bytes — node-pty does not guarantee the string buffer is
      // stable across the next read (its internal pipe gets reused).
      const bytes = TEXT_ENC.encode(data)
      const copy = new Uint8Array(bytes) // fresh allocation, safe to retain
      this.chunkSeq += 1
      this.ring.append(this.chunkSeq, copy)
      try { this.headless?.write(data) } catch { /* mirror is best-effort */ }
      const seq = this.chunkSeq
      for (const s of this.subs.values()) {
        try { s.onData(seq, copy) } catch { /* subscriber errors must not kill the session */ }
      }
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.exitCode = typeof exitCode === 'number' ? exitCode : null
      this.exitSignal = typeof signal === 'number' && signal > 0 ? `SIG${signal}` : null
      const reason = 'pty:exited'
      for (const s of this.subs.values()) {
        try { s.onExit(this.exitCode, this.exitSignal, reason) } catch { /* swallow */ }
      }
      this.subs.clear()
    })
  }

  // ─── public API ───────────────────────────────────────────────────────

  info(): SessionInfo {
    return {
      id: this.id,
      shell: this.shell,
      cwd: this.opts.cwd,
      cols: this.cols,
      rows: this.rows,
      pid: this.pty.pid ?? null,
      createdAt: this.createdAt,
      lastSeq: this.chunkSeq,
    }
  }

  isExited(): boolean { return this.exited }
  attachedCount(): number { return this.subs.size }
  msSinceWrite(): number { return Date.now() - this.lastWriteAt }
  latestSeq(): number { return this.chunkSeq }

  write(data: string): void {
    if (this.exited) return
    this.pty.write(data)
    this.lastWriteAt = Date.now()
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    const c = clampDim(cols, COLS_MIN, COLS_MAX)
    const r = clampDim(rows, ROWS_MIN, ROWS_MAX)
    this.cols = c
    this.rows = r
    this.pty.resize(c, r)
    try { this.headless?.resize(c, r) } catch { /* best-effort */ }
  }

  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this.exited) return
    if (sig === 'INT') {
      // ^C — write to the PTY so it hits the foreground process group via
      // the terminal driver. Matches agent-runtime's behaviour.
      this.pty.write('\x03')
      this.lastWriteAt = Date.now()
      return
    }
    // SIGTERM / SIGKILL → node-pty's kill goes via process.kill on Unix
    // and the conhost handle on Windows.
    this.pty.kill(sig === 'KILL' ? 'SIGKILL' : 'SIGTERM')
  }

  /** Force-kill (used by manager on reap). */
  kill(reason: string): void {
    if (this.exited) {
      // Manager wants close semantics even if the process is gone — fan
      // out a synthetic exit so attached subscribers can clean up.
      for (const s of this.subs.values()) {
        try { s.onExit(this.exitCode, this.exitSignal, reason) } catch { /* swallow */ }
      }
      this.subs.clear()
      return
    }
    try { this.pty.kill('SIGTERM') } catch { /* may already be gone */ }
  }

  /**
   * Add a subscriber. Caller is responsible for shipping the replay
   * (via `replaySince`) BEFORE this method returns, so the subscriber
   * does not miss bytes that arrive between replay and live subscribe.
   *
   * Single-threadedness of node-pty's onData callback (it runs in the
   * libuv main loop) makes the gap provably empty as long as the call
   * order is: replaySince() → subs.set(). The same invariant agent-
   * runtime depends on.
   */
  subscribe(sub: DataSubscriber): void {
    this.subs.set(sub.channelId, sub)
  }

  unsubscribe(channelId: string): void {
    this.subs.delete(channelId)
  }

  /** Same shape as ScrollbackRing.replaySince — proxied for the host. */
  replaySince(sinceSeq: number): { bytes: Uint8Array; latestSeq: number; truncated: boolean } {
    return this.ring.replaySince(sinceSeq)
  }

  serializeHeadless(): string | null {
    if (!this.headless) return null
    try {
      if (typeof this.headless.serialize === 'function') return this.headless.serialize()
      if (this.headless.buffer?.active) {
        const b = this.headless.buffer.active
        const lines: string[] = []
        for (let i = 0; i < b.length; i += 1) {
          lines.push(b.getLine(i)?.translateToString(true) ?? '')
        }
        return lines.join('\r\n')
      }
    } catch {
      return null
    }
    return null
  }

  seedReplay(bytes: Uint8Array, latestSeq: number): void {
    const seq = Math.max(this.chunkSeq + 1, latestSeq || 1)
    this.chunkSeq = seq
    this.ring.append(seq, new Uint8Array(bytes))
    try { this.headless?.write(new TextDecoder().decode(bytes)) } catch { /* best-effort */ }
  }
}
