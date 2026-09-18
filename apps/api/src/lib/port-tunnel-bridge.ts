// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Port-tunnel WebSocket bridge — client (desktop/CLI) ↔ per-project runtime's
 * raw TCP port bridge (Phase 3, Tier 2 plan).
 *
 * Structurally identical to `pty-pod-bridge.ts` (same queue/close/backpressure
 * contract — see that file's doc comment for the full resilience rundown);
 * the only differences are what's being bridged (raw bytes to an arbitrary
 * guest-local TCP port, not a PTY session) and the auth model (this is
 * reachable by anyone with full project access — via a `shogo_sk_*` API key,
 * see the WS-upgrade auth check in server.ts — not just a live browser
 * session), because a declared port might be a database with its own
 * credentials the caller already needs to supply.
 *
 * The client opens `wss://api/api/projects/:projectId/ports/:port/tunnel`;
 * this bridge dials `wss://{podUrl}/agent/ports/:port/ws` with
 * `x-runtime-token` and relays frames verbatim in both directions.
 */

import type { ServerWebSocket } from 'bun'

export const PORT_TUNNEL_BRIDGE_KIND = '__port_tunnel_bridge_ws__'

export interface PortTunnelBridgeData {
  readonly __kind: typeof PORT_TUNNEL_BRIDGE_KIND
  /** http(s):// origin of the per-project runtime (mesh IP for metal, pod URL for k8s). */
  podUrl: string
  port: number
  /** `deriveProjectRuntimeToken(projectId)` — sent as `x-runtime-token` on outbound dial. */
  runtimeToken: string

  outbound: WebSocket | null
  outboundReady: boolean
  outboundQueue: Array<ArrayBuffer | string>
  clientClosed: boolean
}

export function isPortTunnelBridgeData(data: unknown): data is PortTunnelBridgeData {
  return !!data && typeof data === 'object' && (data as { __kind?: string }).__kind === PORT_TUNNEL_BRIDGE_KIND
}

export function buildPortTunnelBridgeData(input: {
  podUrl: string
  port: number
  runtimeToken: string
}): PortTunnelBridgeData {
  return {
    __kind: PORT_TUNNEL_BRIDGE_KIND,
    podUrl: input.podUrl,
    port: input.port,
    runtimeToken: input.runtimeToken,
    outbound: null,
    outboundReady: false,
    outboundQueue: [],
    clientClosed: false,
  }
}

export interface PortTunnelBridgeHandlers {
  open(ws: ServerWebSocket<PortTunnelBridgeData>): void
  message(ws: ServerWebSocket<PortTunnelBridgeData>, msg: ArrayBuffer | string | Uint8Array): void
  close(ws: ServerWebSocket<PortTunnelBridgeData>, code?: number, reason?: string): void
}

export interface CreateBridgeOptions {
  /** Override the outbound WebSocket constructor. Tests inject a fake. */
  WebSocketCtor?: typeof WebSocket
  logger?: { error(...args: unknown[]): void }
}

export function createPortTunnelBridgeHandlers(opts: CreateBridgeOptions = {}): PortTunnelBridgeHandlers {
  const Ctor = opts.WebSocketCtor ?? WebSocket
  const log = opts.logger ?? console

  return {
    open(ws) {
      const { podUrl, port, runtimeToken } = ws.data
      const target = buildRuntimePortWsUrl(podUrl, port)

      let outbound: WebSocket
      try {
        outbound = new Ctor(target, {
          headers: { 'x-runtime-token': runtimeToken },
        } as unknown as string[])
      } catch (err: unknown) {
        log.error('[PortTunnelBridge] dial threw:', describeErr(err))
        safeClose(ws, 1011, 'runtime-unreachable')
        return
      }
      try { (outbound as { binaryType?: BinaryType }).binaryType = 'arraybuffer' } catch {}
      ws.data.outbound = outbound

      outbound.onopen = () => {
        ws.data.outboundReady = true
        if (ws.data.clientClosed) {
          try { outbound.close(1000, 'client-gone') } catch {}
          return
        }
        for (const frame of ws.data.outboundQueue) {
          try { outbound.send(frame) } catch (err) {
            log.error('[PortTunnelBridge] flush queued frame failed:', describeErr(err))
          }
        }
        ws.data.outboundQueue.length = 0
      }

      outbound.onmessage = (evt: MessageEvent) => {
        if (ws.data.clientClosed) return
        const payload = evt.data
        try {
          if (payload instanceof ArrayBuffer) {
            ws.send(new Uint8Array(payload), true)
          } else if (typeof payload === 'string') {
            ws.send(payload)
          } else if (payload && typeof (payload as Blob).arrayBuffer === 'function') {
            ;(payload as Blob).arrayBuffer()
              .then((buf) => { if (!ws.data.clientClosed) ws.send(new Uint8Array(buf), true) })
              .catch((err) => log.error('[PortTunnelBridge] blob→ab failed:', describeErr(err)))
          }
        } catch (err) {
          log.error('[PortTunnelBridge] forward runtime→client failed:', describeErr(err))
        }
      }

      outbound.onerror = (evt: Event) => {
        log.error('[PortTunnelBridge] outbound error:', (evt as { message?: string }).message ?? evt.type)
      }

      outbound.onclose = (evt: CloseEvent) => {
        if (ws.data.clientClosed) return
        const code = sanitizeCloseCode(evt.code)
        const reason = evt.reason || (ws.data.outboundReady ? 'runtime-closed' : 'runtime-unreachable')
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
          log.error('[PortTunnelBridge] forward client→runtime failed:', describeErr(err))
        }
        return
      }
      if (outbound.readyState === Ctor.CONNECTING) {
        outboundQueue.push(frame)
      }
    },

    close(ws, code, reason) {
      ws.data.clientClosed = true
      const { outbound } = ws.data
      if (!outbound) return
      if (outbound.readyState === Ctor.CLOSED || outbound.readyState === Ctor.CLOSING) return
      try { outbound.close(sanitizeCloseCode(code), reason || 'client-closed') } catch {}
    },
  }
}

/** Scheme is flipped http(s)→ws(s); path targets the runtime's port-bridge upgrade route. */
export function buildRuntimePortWsUrl(podUrl: string, port: number): string {
  const base = podUrl.endsWith('/') ? podUrl.slice(0, -1) : podUrl
  const wsBase = base.startsWith('https://') ? 'wss://' + base.slice('https://'.length)
    : base.startsWith('http://') ? 'ws://' + base.slice('http://'.length)
    : base
  return `${wsBase}/agent/ports/${port}/ws`
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

/** See pty-pod-bridge.ts's identical helper for the RFC 6455 rationale. */
function sanitizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1011
  if (code === 1005 || code === 1006) return 1011
  if (code < 1000 || code > 4999) return 1011
  return code
}

function safeClose(ws: ServerWebSocket<PortTunnelBridgeData>, code: number, reason: string): void {
  try { ws.close(code, reason) } catch {}
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
