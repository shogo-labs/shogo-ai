// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * PTY WebSocket bridge — Studio gateway ↔ per-project runtime pod.
 *
 * In Kubernetes the browser opens a WS at
 *   /api/projects/:projectId/terminal/sessions/:sessionId/ws?since=N
 * which `apps/api/src/server.ts` upgrades into a Bun.serve socket tagged with
 * `PTY_PROXY_KIND`. The handlers below then dial the per-project pod at
 *   ws(s)://<podUrl>/terminal/sessions/:sessionId/ws?since=N
 * and pipe binary frames each way.
 *
 * The pod side speaks the same binary protocol the browser already
 * speaks (`apps/mobile/components/project/panels/ide/terminal/pty-protocol.ts`),
 * so this bridge is intentionally protocol-agnostic — it just relays frames.
 *
 * Resilience contract:
 *   1. Pod-WS dial fails synchronously → close browser 1011 'pod-unreachable'.
 *   2. Pod-WS errors before opening → onclose fires, browser closes 1011
 *      with reason 'pod-unreachable' so the client retries (pod may be cold).
 *   3. Browser frames arriving before pod-WS opens are queued and flushed
 *      on outbound onopen (lossless first paint, no race).
 *   4. Browser closes first → outbound is closed with the same code/reason
 *      so the pod sees a clean teardown (and can drop scrollback).
 *   5. Pod closes first → close code+reason are forwarded verbatim. This is
 *      load-bearing for the client's `terminalCloseReasons` map (1000
 *      'pty:exited' / 'pty:killed' suppress reconnect).
 *   6. `since=N` is appended on the outbound URL only — scrollback lives in
 *      the pod.
 *
 * This module never touches the desktop terminal: it is reached only when
 * `isKubernetes()` is true on the studio gateway, and desktop terminals go
 * through Electron IPC (`globalThis.shogoDesktopTerminal`), not via WS.
 */

import type { ServerWebSocket } from 'bun'

export const PTY_PROXY_KIND = '__pty_proxy_ws__'

/** Stored on `ws.data` for the multiplexed Bun.serve websocket{} dispatcher. */
export interface PtyPodBridgeData {
  readonly __kind: typeof PTY_PROXY_KIND
  /** http(s):// origin of the per-project runtime pod. Resolved at upgrade time. */
  podUrl: string
  /** Pod-generated session id from the prior REST POST. */
  sessionId: string
  /** Client's last byte offset for replay (0 = full replay or fresh session). */
  since: number
  /** `deriveRuntimeToken(projectId)` — sent as `x-runtime-token` on outbound dial. */
  runtimeToken: string

  outbound: WebSocket | null
  outboundReady: boolean
  outboundQueue: Array<ArrayBuffer | string>
  browserClosed: boolean
}

export function isPtyPodBridgeData(data: unknown): data is PtyPodBridgeData {
  return !!data && typeof data === 'object' && (data as { __kind?: string }).__kind === PTY_PROXY_KIND
}

/**
 * Build the initial `PtyPodBridgeData` for `server.upgrade({ data })`. The
 * mutable fields (`outbound`, `outboundReady`, `outboundQueue`, `browserClosed`)
 * are seeded with their idle defaults; `open()` populates `outbound` on dial.
 */
export function buildPtyPodBridgeData(input: {
  podUrl: string
  sessionId: string
  since: number
  runtimeToken: string
}): PtyPodBridgeData {
  return {
    __kind: PTY_PROXY_KIND,
    podUrl: input.podUrl,
    sessionId: input.sessionId,
    since: input.since,
    runtimeToken: input.runtimeToken,
    outbound: null,
    outboundReady: false,
    outboundQueue: [],
    browserClosed: false,
  }
}

export interface PtyPodBridgeHandlers {
  open(ws: ServerWebSocket<PtyPodBridgeData>): void
  message(ws: ServerWebSocket<PtyPodBridgeData>, msg: ArrayBuffer | string | Uint8Array): void
  close(ws: ServerWebSocket<PtyPodBridgeData>, code?: number, reason?: string): void
}

export interface CreateBridgeOptions {
  /**
   * Override the outbound WebSocket constructor. Tests inject a fake.
   * Defaults to the global `WebSocket` (Bun provides a fetch-style client).
   */
  WebSocketCtor?: typeof WebSocket
  /** Optional sink for diagnostics. Defaults to `console`. */
  logger?: { error(...args: unknown[]): void }
}

export function createPtyPodBridgeHandlers(opts: CreateBridgeOptions = {}): PtyPodBridgeHandlers {
  const Ctor = opts.WebSocketCtor ?? WebSocket
  const log = opts.logger ?? console

  return {
    open(ws) {
      const { podUrl, sessionId, since, runtimeToken } = ws.data
      const target = buildPodWsUrl(podUrl, sessionId, since)

      let outbound: WebSocket
      try {
        outbound = new Ctor(target, {
          headers: { 'x-runtime-token': runtimeToken },
        } as unknown as string[])
      } catch (err: unknown) {
        log.error('[PtyPodBridge] dial threw:', describeErr(err))
        safeClose(ws, 1011, 'pod-unreachable')
        return
      }
      try { (outbound as { binaryType?: BinaryType }).binaryType = 'arraybuffer' } catch {}
      ws.data.outbound = outbound

      outbound.onopen = () => {
        ws.data.outboundReady = true
        if (ws.data.browserClosed) {
          try { outbound.close(1000, 'browser-gone') } catch {}
          return
        }
        for (const frame of ws.data.outboundQueue) {
          try { outbound.send(frame) } catch (err) {
            log.error('[PtyPodBridge] flush queued frame failed:', describeErr(err))
          }
        }
        ws.data.outboundQueue.length = 0
      }

      outbound.onmessage = (evt: MessageEvent) => {
        if (ws.data.browserClosed) return
        const payload = evt.data
        try {
          if (payload instanceof ArrayBuffer) {
            ws.send(new Uint8Array(payload), true)
          } else if (typeof payload === 'string') {
            ws.send(payload)
          } else if (payload && typeof (payload as Blob).arrayBuffer === 'function') {
            ;(payload as Blob).arrayBuffer()
              .then((buf) => { if (!ws.data.browserClosed) ws.send(new Uint8Array(buf), true) })
              .catch((err) => log.error('[PtyPodBridge] blob→ab failed:', describeErr(err)))
          }
        } catch (err) {
          log.error('[PtyPodBridge] forward pod→browser failed:', describeErr(err))
        }
      }

      outbound.onerror = (evt: Event) => {
        log.error('[PtyPodBridge] outbound error:', (evt as { message?: string }).message ?? evt.type)
      }

      outbound.onclose = (evt: CloseEvent) => {
        if (ws.data.browserClosed) return
        const code = sanitizeCloseCode(evt.code)
        const reason = evt.reason || (ws.data.outboundReady ? 'pod-closed' : 'pod-unreachable')
        safeClose(ws, code, reason)
      }
    },

    message(ws, msg) {
      const frame = normaliseInboundFrame(msg)
      if (frame == null) return
      const { outbound, outboundReady, outboundQueue } = ws.data
      if (!outbound) return
      if (outboundReady && outbound.readyState === Ctor.OPEN) {
        try { outbound.send(frame) } catch (err) {
          log.error('[PtyPodBridge] forward browser→pod failed:', describeErr(err))
        }
        return
      }
      if (outbound.readyState === Ctor.CONNECTING) {
        outboundQueue.push(frame)
      }
    },

    close(ws, code, reason) {
      ws.data.browserClosed = true
      const { outbound } = ws.data
      if (!outbound) return
      if (outbound.readyState === Ctor.CLOSED || outbound.readyState === Ctor.CLOSING) return
      try { outbound.close(sanitizeCloseCode(code), reason || 'browser-closed') } catch {}
    },
  }
}

/**
 * Build the outbound WS URL targeting the pod. Scheme is flipped from
 * http(s)→ws(s); `since` is only appended when > 0 to keep test URLs
 * stable and avoid an empty `?since=0` on first connects.
 */
export function buildPodWsUrl(podUrl: string, sessionId: string, since: number): string {
  const base = podUrl.endsWith('/') ? podUrl.slice(0, -1) : podUrl
  const wsBase = base.startsWith('https://') ? 'wss://' + base.slice('https://'.length)
    : base.startsWith('http://') ? 'ws://' + base.slice('http://'.length)
    : base
  const sid = encodeURIComponent(sessionId)
  return since > 0
    ? `${wsBase}/terminal/sessions/${sid}/ws?since=${since}`
    : `${wsBase}/terminal/sessions/${sid}/ws`
}

function normaliseInboundFrame(msg: ArrayBuffer | string | Uint8Array): ArrayBuffer | string | null {
  if (typeof msg === 'string') return msg
  if (msg instanceof ArrayBuffer) return msg
  if (msg instanceof Uint8Array) {
    const copy = new Uint8Array(msg.byteLength)
    copy.set(msg)
    return copy.buffer
  }
  return null
}

/**
 * RFC 6455 reserves 1005 ('no status') and 1006 ('abnormal close') for the
 * protocol layer — app code is forbidden from sending them. Outside the
 * permitted range we fall back to 1011 ('internal error').
 */
function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1011
  if (code === 1005 || code === 1006) return 1011
  if (code < 1000 || code > 4999) return 1011
  return code
}

function safeClose(ws: ServerWebSocket<PtyPodBridgeData>, code: number, reason: string): void {
  try { ws.close(code, reason) } catch {}
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
