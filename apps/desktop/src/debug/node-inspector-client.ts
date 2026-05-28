// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Minimal Chrome DevTools Protocol (CDP) discovery for `node --inspect` targets.
 *
 * Phase 13 ships the *discovery* half end-to-end (poll `/json/list`, parse the
 * targets, attach the result to the DebugSessionEmitter as a 'system' event so
 * the UI can show "Attached to <pid>" chrome).  The full duplex WS pipe that
 * subscribes to `Runtime.consoleAPICalled` is scaffolded but gated behind
 * `enableWireProtocol: true` — connecting a real WebSocket to v8 needs a live
 * node process to test against, which we'll wire in Phase 13b alongside the
 * desktop integration tests.  Everything below is unit-tested through the
 * deterministic `fetch` injection point.
 *
 * Why not just spawn a fresh node process inside the test?  Because we want
 * this file to be importable from the renderer too (the discovery URL is
 * shown in the UI when no target is attached, as a hint).  Spawning belongs
 * in the main process; the discovery / URL building lives here and is pure.
 */

import { DebugSessionEmitter } from './session-emitter'

/** Shape of one entry in v8's `GET /json/list` response. */
export interface InspectorTarget {
  description: string
  /** `node`, `worker`, etc. */
  type: string
  title: string
  url: string
  /** `ws://127.0.0.1:9229/<uuid>` — what you'd connect a CDP client to. */
  webSocketDebuggerUrl: string
  /** UUID assigned by v8. */
  id: string
}

/** Per-target plus the host we found it on. */
export interface DiscoveredTarget extends InspectorTarget {
  host: string
  port: number
}

/**
 * Build the URL the inspector advertises its targets on.  Exposed for tests
 * and for the UI hint when no target is attached.
 */
export function inspectorListUrl(port: number, host = '127.0.0.1'): string {
  return `http://${host}:${port}/json/list`
}

/** Default port for `--inspect` (and the first auto-bound port v8 tries). */
export const DEFAULT_INSPECTOR_PORT = 9229
/** v8's documented auto-bind range: 9229 → 9229 + n. */
export const INSPECTOR_PORT_RANGE: readonly number[] = [
  9229, 9230, 9231, 9232, 9233, 9234, 9235, 9236,
]

/** Pluggable for tests. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface DiscoverOptions {
  /** Ports to scan, in order.  Defaults to INSPECTOR_PORT_RANGE. */
  ports?: readonly number[]
  /** Host to probe.  Default '127.0.0.1' (loopback only — never expose). */
  host?: string
  /** Injectable fetch for tests / non-DOM environments. */
  fetch?: FetchLike
  /** Per-port timeout in ms.  Default 250 — the inspector is local and snappy. */
  timeoutMs?: number
}

/**
 * Probe loopback inspector ports and return every live target we found.
 *
 * Returns an empty array (not null) when nothing is running, which keeps
 * callers from having to nullcheck for the common "no debug session" path.
 *
 * Network errors are swallowed per-port (the most common case: ECONNREFUSED
 * because nothing is listening) — only the *parsed* response counts.
 */
export async function discoverInspectorTargets(
  opts: DiscoverOptions = {}
): Promise<DiscoveredTarget[]> {
  const ports = opts.ports ?? INSPECTOR_PORT_RANGE
  const host = opts.host ?? '127.0.0.1'
  const timeoutMs = opts.timeoutMs ?? 250
  const fetchImpl: FetchLike =
    opts.fetch ?? ((typeof fetch !== 'undefined' ? (fetch as unknown as FetchLike) : (() => {
      throw new Error('fetch is not available in this environment; inject opts.fetch')
    })))

  const results: DiscoveredTarget[] = []
  await Promise.all(
    ports.map(async (port) => {
      const url = inspectorListUrl(port, host)
      const controller =
        typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer =
        controller != null
          ? setTimeout(() => controller.abort(), timeoutMs)
          : null
      try {
        const res = await fetchImpl(url, { signal: controller?.signal })
        if (!res.ok) return
        const body = (await res.json()) as unknown
        if (!Array.isArray(body)) return
        for (const raw of body) {
          if (!isInspectorTarget(raw)) continue
          results.push({ ...raw, host, port })
        }
      } catch {
        // ECONNREFUSED, abort, parse failure — all "no target on this port".
      } finally {
        if (timer != null) clearTimeout(timer)
      }
    })
  )
  return results
}

function isInspectorTarget(raw: unknown): raw is InspectorTarget {
  if (!raw || typeof raw !== 'object') return false
  const o = raw as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.type === 'string' &&
    typeof o.webSocketDebuggerUrl === 'string' &&
    typeof o.title === 'string' &&
    typeof o.url === 'string' &&
    typeof o.description === 'string'
  )
}

/**
 * Poll-and-attach loop.  Calls `discoverInspectorTargets()` every `intervalMs`,
 * and when the *set* of targets changes (by webSocketDebuggerUrl) emits an
 * 'attached' or 'detached' system event to the supplied emitter.
 *
 * Returns a stop() handle.  The poll timer is unref'd so it doesn't pin the
 * Electron main event loop alive.
 *
 * Real CDP wire-up (subscribing to `Runtime.enable` + `Runtime.consoleAPICalled`)
 * is gated behind `enableWireProtocol: true`.  The current shipped path is just
 * the discovery half — enough for the UI to show "Attached to /path/to/script.js"
 * chrome when a debug session is live.  Console-line streaming lands in 13b.
 */
export interface StartDebugAttacherOptions extends DiscoverOptions {
  emitter: DebugSessionEmitter
  /** Cadence in ms.  Default 2000 (cheap — local HTTP). */
  intervalMs?: number
  /**
   * If true, *eventually* opens a CDP WS for each target and forwards
   * Runtime.consoleAPICalled into the emitter.  Not yet implemented — see
   * the file-header note.
   */
  enableWireProtocol?: boolean
}

export interface DebugAttacherHandle {
  stop(): void
  /** Force a discovery cycle immediately — useful for the "refresh" button. */
  refresh(): Promise<void>
  /** Current set of attached target keys (webSocketDebuggerUrl). */
  attachedKeys(): readonly string[]
}

export function startDebugAttacher(opts: StartDebugAttacherOptions): DebugAttacherHandle {
  const interval = opts.intervalMs ?? 2000
  const attached = new Map<string, DiscoveredTarget>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const cycle = async (): Promise<void> => {
    if (stopped) return
    const targets = await discoverInspectorTargets(opts)
    const nextKeys = new Set(targets.map((t) => t.webSocketDebuggerUrl))

    for (const [key, prev] of attached) {
      if (!nextKeys.has(key)) {
        attached.delete(key)
        opts.emitter.markDetached(prev.title || prev.url || key)
      }
    }
    for (const t of targets) {
      if (!attached.has(t.webSocketDebuggerUrl)) {
        attached.set(t.webSocketDebuggerUrl, t)
        opts.emitter.markAttached(t.title || t.url || t.webSocketDebuggerUrl)
      }
    }

    if (!stopped) {
      timer = setTimeout(() => { void cycle() }, interval)
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        ;(timer as { unref?: () => void }).unref!()
      }
    }
  }

  // Kick off immediately; subsequent cycles are scheduled inside cycle().
  void cycle()

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    async refresh(): Promise<void> {
      await cycle()
    },
    attachedKeys(): readonly string[] {
      return [...attached.keys()]
    },
  }
}
