// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One PtySession wraps a single `node-pty` instance + a ScrollbackRing.
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

const DEFAULT_SCROLLBACK_BYTES = 256 * 1024
const TEXT_ENC = new TextEncoder()

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

  constructor(id: string, opts: SpawnOptions, scrollbackBytes: number = DEFAULT_SCROLLBACK_BYTES) {
    this.id = id
    this.opts = opts
    this.shell = opts.shell
    this.createdAt = Date.now()
    this.lastWriteAt = this.createdAt
    this.cols = clampDim(opts.cols, COLS_MIN, COLS_MAX)
    this.rows = clampDim(opts.rows, ROWS_MIN, ROWS_MAX)
    this.ring = new ScrollbackRing(scrollbackBytes)

    this.pty = ptySpawn(opts.shell, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      cols: this.cols,
      rows: this.rows,
      // node-pty emits utf8 strings by default. We immediately encode to
      // bytes — keystrokes and PTY output may not be valid UTF-8 mid-chunk
      // (e.g. a multi-byte glyph split across two reads), but node-pty's
      // utf8 decoder is lenient and replaces with U+FFFD which we accept
      // as a known platform constraint.
      encoding: 'utf8',
      useConpty: process.platform === 'win32',
    })

    this.pty.onData((data) => {
      const bytes = TEXT_ENC.encode(data)
      const copy = new Uint8Array(bytes)
      this.chunkSeq += 1
      this.ring.append(this.chunkSeq, copy)
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
  }

  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this.exited) return
    if (sig === 'INT') {
      // ^C — write to the PTY so it hits the foreground process group via
      // the terminal driver.
      this.pty.write('\x03')
      this.lastWriteAt = Date.now()
      return
    }
    this.pty.kill(sig === 'KILL' ? 'SIGKILL' : 'SIGTERM')
  }

  /** Force-kill (used by manager on reap). */
  kill(reason: string): void {
    if (this.exited) {
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
   * (via `replaySince`) BEFORE this method returns.
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
}
