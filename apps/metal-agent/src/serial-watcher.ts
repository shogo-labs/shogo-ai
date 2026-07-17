// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Guest serial-log error watcher.
 *
 * In-guest failures are the class of incident we were BLIND to: a Firecracker
 * guest logs to its serial console (ttyS0), which the host appends to a per-VM
 * `*.serial` file — and nothing shipped those files anywhere. The guest's own
 * OTLP export is the intended path, but it is best-effort and, crucially, a
 * guest broken badly enough to matter (e.g. every outbound HTTPS handshake
 * failing with "certificate is not yet valid" after a resume clock-skew) often
 * cannot ship its own telemetry at all. So the exact failures we most need to
 * see never reached SigNoz.
 *
 * This watcher runs in the always-up, always-observable host agent. It tails
 * each live VM's serial file, matches a curated set of failure signatures, and
 * re-emits each match as a host-side log line with a syslog level prefix
 * (`<3>`/`<4>`) plus a per-category counter. The metal-agent runs under systemd
 * with SyslogLevelPrefix on, so `<3>` -> journald PRIORITY 3 -> otelcol-metal
 * severity=error -> SigNoz. That is the SAME proven path the host agent's own
 * logs already travel (journald -> otelcol-metal -> SigNoz), so guest breakage
 * becomes centrally queryable + alertable without adding any guest dependency.
 *
 * Metrics count EVERY match; emitted log lines are throttled per project+
 * category (with a suppressed= count) so a hot-looping guest can't flood the
 * journal. Only lines matching a signature are forwarded, and each is truncated,
 * so we don't ship arbitrary guest stdout (volume / PII).
 */

import { closeSync, openSync, readSync, statSync } from 'fs'
import { config } from './config'
import { LiveRegistry } from './live-registry'
import { M, metrics } from './metrics'

/** The minimal view of a live VM the watcher needs. */
export interface WatchedVm {
  projectId: string
  vmId: string
  serialLog: string
}

/** A serial-console failure signature we surface centrally. */
export interface SerialSignature {
  /** Stable category label used in the emitted log line. */
  category: string
  /** Per-category counter name (see metrics.ts M.*). */
  metric: string
  /** Syslog severity for the emitted line: 3 = error, 4 = warning. */
  level: 3 | 4
  re: RegExp
}

/**
 * Ordered most-specific-first; the first match wins per line so a single error
 * is counted under exactly one category. Patterns intentionally target the
 * strings the runtime actually emits (see packages/agent/src/agent-loop.ts,
 * packages/agent-runtime/src/gateway.ts) plus the TLS/network errors Node/undici
 * raise from the guest's HTTPS clients.
 */
export const SERIAL_SIGNATURES: readonly SerialSignature[] = [
  {
    category: 'tls_clock_skew',
    metric: M.guestTlsClockSkew,
    level: 3,
    // Resume clock-skew: the guest wall-clock is behind the cert's notBefore.
    re: /certificate is not yet valid|CERT_NOT_YET_VALID|certificate has expired|CERT_HAS_EXPIRED/i,
  },
  {
    category: 'provider_error',
    metric: M.guestProviderError,
    level: 3,
    re: /Provider error:|no output\s*[—-]\s*possible provider error/i,
  },
  {
    category: 'connection_error',
    metric: M.guestConnectionError,
    level: 3,
    re: /\bConnection error\b|APIConnectionError|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|getaddrinfo/i,
  },
  {
    category: 'inference_retry',
    metric: M.guestInferenceRetry,
    level: 4,
    re: /INFERENCE_RETRY/,
  },
] as const

/** Strip CR, ANSI escapes and other control chars a serial console injects. */
export function sanitizeSerialLine(s: string): string {
  return s
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim()
}

/**
 * Pure classifier: which signature (if any) a serial line matches. Exported so
 * the signature set is unit-testable without any filesystem/VM state.
 */
export function classifySerialLine(line: string): SerialSignature | null {
  for (const sig of SERIAL_SIGNATURES) {
    if (sig.re.test(line)) return sig
  }
  return null
}

interface FileState {
  /** Byte offset in the serial file we've consumed up to. */
  offset: number
  /** Trailing partial line carried to the next read (no newline yet). */
  partial: string
  /** category -> last emit epoch ms (metrics always count; emits are throttled). */
  lastEmit: Map<string, number>
  /** category -> matches suppressed since the last emit. */
  suppressed: Map<string, number>
}

/**
 * Tails live guests' serial logs and forwards matched failure lines. Reads
 * incrementally from a per-file byte offset; a truncated/rotated file resets to
 * 0, and a file first seen starts at its current end (so a metal-agent restart
 * neither replays history nor double-counts — same posture as otelcol
 * `start_at: end`).
 */
export class SerialWatcher {
  private state = new Map<string, FileState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly listLive: () => WatchedVm[]

  constructor(
    private readonly maxRead = config.serialWatchMaxReadBytes,
    private readonly throttleMs = config.serialWatchEmitThrottleMs,
    /** Injectable sink (defaults to stdout) so tests can capture emitted lines. */
    private readonly emit: (line: string) => void = (line) => process.stdout.write(line + '\n'),
    /** Injectable source of live VMs (defaults to the on-disk LiveRegistry). */
    listLive?: () => WatchedVm[],
    /** Injectable clock (defaults to Date.now) so throttling is testable. */
    private readonly now: () => number = () => Date.now(),
  ) {
    if (listLive) {
      this.listLive = listLive
    } else {
      const registry = new LiveRegistry(config.runDir)
      this.listLive = () => registry.all()
    }
  }

  /** Run one scan pass immediately (exposed for tests / manual pokes). */
  scanOnce(): void {
    this.tick()
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), config.serialWatchIntervalMs)
    // Don't keep the process alive solely for this timer.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    try {
      const live = this.listLive()
      const activePaths = new Set<string>()
      for (const e of live) {
        if (!e.serialLog) continue
        activePaths.add(e.serialLog)
        this.scanFile(e.serialLog, e.projectId, e.vmId)
      }
      // Drop state for VMs that are no longer live so the map can't grow unbounded.
      for (const p of [...this.state.keys()]) {
        if (!activePaths.has(p)) this.state.delete(p)
      }
    } catch (err: any) {
      console.error('[serial-watch] tick error:', err?.message ?? err)
    }
  }

  private scanFile(path: string, projectId: string, vmId: string): void {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return // file gone (VM torn down mid-scan)
    }

    let st = this.state.get(path)
    if (!st) {
      // First sight: start at EOF — never replay pre-existing history.
      this.state.set(path, { offset: size, partial: '', lastEmit: new Map(), suppressed: new Map() })
      return
    }

    if (size < st.offset) {
      // Truncated / rotated — restart from the top.
      st.offset = 0
      st.partial = ''
    }
    if (size === st.offset) return

    let start = st.offset
    if (size - start > this.maxRead) {
      // Fell behind (or a burst): skip to the tail window, discard the stale
      // partial-line carry since we're no longer contiguous.
      start = size - this.maxRead
      st.partial = ''
    }

    const len = size - start
    const buf = Buffer.allocUnsafe(len)
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      readSync(fd, buf, 0, len, start)
    } catch {
      return
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    st.offset = size

    const text = st.partial + buf.toString('utf8')
    const lines = text.split('\n')
    st.partial = lines.pop() ?? '' // trailing (unterminated) fragment
    for (const raw of lines) this.inspect(st, projectId, vmId, raw)
  }

  private inspect(st: FileState, projectId: string, vmId: string, raw: string): void {
    const line = sanitizeSerialLine(raw)
    if (!line) return
    const sig = classifySerialLine(line)
    if (!sig) return

    metrics.inc(M.guestErrorTotal)
    metrics.inc(sig.metric)

    const now = this.now()
    const last = st.lastEmit.get(sig.category) ?? 0
    if (now - last < this.throttleMs) {
      st.suppressed.set(sig.category, (st.suppressed.get(sig.category) ?? 0) + 1)
      return
    }
    const supp = st.suppressed.get(sig.category) ?? 0
    st.suppressed.set(sig.category, 0)
    st.lastEmit.set(sig.category, now)

    const suffix = supp > 0 ? ` suppressed=${supp}` : ''
    // `<N>` syslog prefix -> journald PRIORITY -> otelcol severity. Keep the
    // message single-line and truncated so we never ship arbitrary guest output.
    this.emit(
      `<${sig.level}>[guest-error] category=${sig.category} project=${projectId} vm=${vmId}${suffix} :: ${line.slice(0, 500)}`,
    )
  }
}
