// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PtySession — one persistent shell per IDE terminal tab.
 *
 * Wraps `Bun.spawn({ terminal: { ... } })` (Bun >= 1.3.5; openpty on
 * Linux/macOS, ConPTY on Windows) so the session is a real TTY: `vim`,
 * `htop`, `less`, tab completion, job control, persistent env / cwd —
 * all the things the previous per-command-spawn model couldn't do.
 *
 * Two responsibilities the underlying API doesn't give us for free:
 *
 *   1. Monotonic seq numbering on every output chunk so the WS handler
 *      can stamp DATA frames; the client tracks `lastSeq` and reconnects
 *      with `?since=N`. We assign seq at the boundary where bytes leave
 *      this class (in `onData(cb)`) — not earlier — because nothing
 *      meaningful happens to the bytes inside.
 *
 *   2. A bounded scrollback ring (~256 KB by default) so a tab refresh /
 *      brief network blip doesn't lose the user's command history.
 *      Older bytes get dropped; the client is told via a TRUNC frame
 *      so it can render a marker instead of silently re-painting from
 *      the middle of an escape sequence.
 *
 * What this class deliberately does NOT do:
 *   - WebSocket framing (that's pty-protocol.ts + the WS handler).
 *   - Authentication / session lookup (that's PtySessionManager).
 *   - Shell-integration injection (caller picks the shell + rcfile).
 */

import type { Subprocess } from 'bun'
import { ScrollbackRing } from './pty-scrollback'

export interface PtySpawnOptions {
  /** Shell + args. Defaults to interactive bash on POSIX, pwsh on win32. */
  cmd?: string[]
  cwd: string
  /** Extra env on top of the safe defaults; caller wins on conflict. */
  env?: Record<string, string | undefined>
  cols: number
  rows: number
  /** Max bytes of recent output retained for reconnect-replay. */
  scrollbackBytes?: number
}

export interface ExitInfo {
  code: number | null
  signal: string | null
}

export type DataListener = (chunk: { seq: number; bytes: Uint8Array }) => void
export type ExitListener = (info: ExitInfo) => void

const DEFAULT_SCROLLBACK = 256 * 1024 // 256 KB

/**
 * Pick a sensible default shell. Caller can override via `cmd`.
 * `--norc --noprofile` keep startup deterministic across host configs;
 * downstream callers that want shell-integration can pass their own cmd.
 */
function defaultShellCmd(): string[] {
  if (process.platform === 'win32') {
    return ['powershell.exe', '-NoLogo', '-NoProfile']
  }
  // Prefer $SHELL if it points to a known interactive shell; fall back to bash.
  const shellEnv = process.env.SHELL
  if (shellEnv && /\/(bash|zsh|fish|sh)$/.test(shellEnv)) {
    if (/zsh$/.test(shellEnv)) return [shellEnv, '-i']
    if (/fish$/.test(shellEnv)) return [shellEnv, '-i']
    return [shellEnv, '--norc', '--noprofile', '-i']
  }
  return ['/bin/bash', '--norc', '--noprofile', '-i']
}

/**
 * Build the env the shell sees. Real PTY → no need to fake colors with
 * FORCE_COLOR; tools detect isatty themselves. We only set baseline TERM,
 * COLORTERM, and the prompt so things look reasonable when no rcfile loads.
 */
function buildEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) base[k] = v
  }
  // Sensible defaults; caller-provided extras override.
  base.TERM = base.TERM || 'xterm-256color'
  base.COLORTERM = base.COLORTERM || 'truecolor'
  // Bracketed paste indicator + a minimal prompt so a `--norc` bash isn't
  // greeted by the literal string `bash-5.2$`.
  base.PS1 = base.PS1 || '\\w $ '
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) delete base[k]
    else base[k] = v
  }
  return base
}

export class PtySession {
  readonly cwd: string
  cols: number
  rows: number

  private readonly proc: Subprocess<'ignore', 'inherit', 'inherit'> & {
    terminal: NonNullable<Subprocess['terminal']>
  }
  private readonly term: NonNullable<Subprocess['terminal']>
  private readonly scrollback: ScrollbackRing
  // Chunk counter — every emitted DATA chunk gets the next integer.
  // 0 is reserved for "haven't seen anything yet" so a client that
  // reconnects with ?since=0 gets the full ring.
  private chunkSeq = 0
  private dataListeners = new Set<DataListener>()
  private exitListeners = new Set<ExitListener>()
  private exited: ExitInfo | null = null
  private disposed = false
  private lastActivityMs = Date.now()
  /** A note from the last spawn attempt, e.g. fallback used. Diagnostic only. */
  readonly diagnostics: { shell: string }

  constructor(opts: PtySpawnOptions) {
    this.cwd = opts.cwd
    this.cols = clampDim(opts.cols, 1, 1000, 80)
    this.rows = clampDim(opts.rows, 1, 1000, 24)
    this.scrollback = new ScrollbackRing(opts.scrollbackBytes ?? DEFAULT_SCROLLBACK)

    const cmd = opts.cmd ?? defaultShellCmd()
    this.diagnostics = { shell: cmd[0] }
    const env = buildEnv(opts.env)

    // Bun.spawn with terminal: connects stdin/stdout/stderr to the PTY;
    // proc.stdin/stdout/stderr are null and we use proc.terminal instead.
    const proc = Bun.spawn({
      cmd,
      cwd: this.cwd,
      env,
      terminal: {
        cols: this.cols,
        rows: this.rows,
        // Per Bun docs: `data(terminal, data)` fires for every chunk read
        // from the PTY master. We stamp it with a seq and fan out.
        data: (_term, data: Uint8Array) => {
          if (this.disposed) return
          this.lastActivityMs = Date.now()
          // The bytes are owned by Bun's read buffer and may be reused on
          // the next tick. Copy now so listeners (and the scrollback ring)
          // can safely retain references.
          const copy = new Uint8Array(data.byteLength)
          copy.set(data)
          const seq = ++this.chunkSeq
          this.scrollback.append(seq, copy)
          // Snapshot the listener set: a listener (e.g. the manager's
          // reap-on-exit handler) may dispose this session, which clears
          // dataListeners — iterating the live Set would skip later
          // listeners on that tick.
          for (const cb of [...this.dataListeners]) {
            try { cb({ seq, bytes: copy }) } catch {}
          }
        },
      },
    })
    // Bun's spawn type doesn't perfectly capture the `terminal` option mode;
    // double-cast through `unknown` so TS doesn't flag the io-mode mismatch
    // (`pipe` vs `inherit`) and trust the runtime check below to catch the
    // case where Bun is too old to provide `proc.terminal`.
    this.proc = proc as unknown as typeof this.proc
    if (!this.proc.terminal) {
      throw new Error('PtySession: Bun.spawn did not return a terminal — bun >= 1.3.5 required')
    }
    this.term = this.proc.terminal

    // Wire up exit. proc.exited fulfills with the subprocess exit code; the
    // terminal `exit` callback fires for PTY-stream lifecycle (EOF/error)
    // and is not the same thing. We surface only the subprocess exit.
    void this.proc.exited.then((code) => {
      const info: ExitInfo = {
        code: typeof code === 'number' ? code : null,
        signal: this.proc.signalCode ?? null,
      }
      this.exited = info
      // Snapshot first: the manager's reap-on-exit listener will dispose()
      // this session, which clears exitListeners — without the snapshot
      // any listener registered AFTER the manager (e.g. the WS handler's
      // EXIT-frame sender) would be skipped.
      for (const cb of [...this.exitListeners]) {
        try { cb(info) } catch {}
      }
    })
  }

  /** Has the underlying shell exited? */
  get isExited(): boolean { return this.exited !== null }
  get exitInfo(): ExitInfo | null { return this.exited }
  get pid(): number | undefined { return this.proc.pid }
  get lastActivity(): number { return this.lastActivityMs }
  /** Bytes currently retained in the reconnect ring. Useful for tests. */
  get scrollbackSize(): number { return this.scrollback.size }
  /** Highest chunk seq ever assigned (0 if no output yet). */
  get latestSeq(): number { return this.chunkSeq }

  /** Send raw keystroke bytes (or any payload) to the shell's stdin. */
  write(bytes: Uint8Array | string): void {
    if (this.disposed || this.exited) return
    this.lastActivityMs = Date.now()
    this.term.write(bytes as Uint8Array)
  }

  /** Update the shell's view of the terminal size. */
  resize(cols: number, rows: number): void {
    if (this.disposed || this.exited) return
    this.cols = clampDim(cols, 1, 1000, this.cols)
    this.rows = clampDim(rows, 1, 1000, this.rows)
    this.term.resize(this.cols, this.rows)
  }

  /** Send a signal to the foreground process group. */
  signal(sig: 'INT' | 'TERM' | 'KILL'): void {
    if (this.exited) return
    if (sig === 'INT') this.write('\x03')
    else this.proc.kill(sig === 'KILL' ? 'SIGKILL' : 'SIGTERM')
  }

  /**
   * Subscribe to PTY output. Returns an unsubscribe handle. The listener
   * receives every new DATA chunk (with its assigned seq) but NOT the
   * scrollback — call `replaySince(0)` separately if you also want the
   * backlog (typical pattern: replay first, then subscribe).
   */
  onData(cb: DataListener): () => void {
    this.dataListeners.add(cb)
    return () => { this.dataListeners.delete(cb) }
  }

  onExit(cb: ExitListener): () => void {
    if (this.exited) {
      // Fire on next tick so the caller has a chance to set state up first.
      queueMicrotask(() => cb(this.exited!))
      return () => {}
    }
    this.exitListeners.add(cb)
    return () => { this.exitListeners.delete(cb) }
  }

  /**
   * Pull every chunk emitted since `sinceSeq` from the scrollback ring,
   * concatenated into one byte buffer for cheap WS framing. `latestSeq`
   * is the seq of the last chunk included (or `sinceSeq` if none).
   * `truncated` is true when chunks at or before `sinceSeq+1` have been
   * evicted — caller should send a TRUNC frame so the user sees a marker
   * instead of a confusing partial replay.
   *
   * After calling, subscribe via `onData()` to pick up live output
   * without a gap (each new DATA chunk has seq > latestSeq).
   */
  replaySince(sinceSeq: number): {
    bytes: Uint8Array
    latestSeq: number
    truncated: boolean
  } {
    return this.scrollback.replaySince(sinceSeq)
  }

  /** Terminate the shell and free PTY resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try { this.proc.kill('SIGTERM') } catch {}
    try { this.term.close() } catch {}
    this.dataListeners.clear()
    this.exitListeners.clear()
  }
}

function clampDim(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

