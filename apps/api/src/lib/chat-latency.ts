// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Time-to-first-token for a proxied chat turn, broken down by where the time
 * went: resolving (and possibly waking) the runtime, waiting for the runtime's
 * response headers (which includes its own wait for the agent gateway), and
 * the model producing its first content.
 *
 * "First token" is the first frame that renders something — text, reasoning,
 * a tool call or an error — not the stream's `start` frame and not an SSE
 * keepalive comment, so a turn that stalls behind an immediate `start` still
 * reads as slow.
 */

import { context, metrics, trace, type Context, type Span } from '@opentelemetry/api'
import type { WakeInfo } from './wake-capture'

const meter = metrics.getMeter('shogo-api-chat')
const tracer = trace.getTracer('shogo-api-chat')

const ttftHistogram = meter.createHistogram('chat.ttft_ms', {
  description:
    'Chat request arrival → first rendered frame (text/reasoning/tool/error) from the runtime, labelled by route and how the runtime was woken',
  unit: 'ms',
})
const phaseHistogram = meter.createHistogram('chat.phase_ms', {
  description: 'Chat first-token breakdown: resolve (runtime lookup/wake), upstream_headers, gateway_wait (runtime-reported), model (headers → first token)',
  unit: 'ms',
})

const CONTENT_FRAME = /"type":"(?:text-delta|reasoning-delta|tool-input-start|tool-input-available|error)"/
const decoder = new TextDecoder()

export type ChatRoute = 'project' | 'workspace'

export class ChatLatency {
  private readonly t0 = performance.now()
  private readonly startedAtWall = Date.now()
  private readonly parent: Context = context.active()
  private resolveMs?: number
  private headersMs?: number
  private gatewayWaitMs?: number
  private wake?: WakeInfo
  private done = false
  private tail = ''
  /** Set once the first rendered frame has been seen. */
  ttftMs?: number

  constructor(private readonly route: ChatRoute, private readonly span?: Span) {}

  private since(): number {
    return Math.round(performance.now() - this.t0)
  }

  resolved(wake: WakeInfo | undefined): void {
    this.resolveMs = this.since()
    this.wake = wake
    this.span?.setAttribute('chat.resolve_ms', this.resolveMs)
    this.span?.setAttribute('wake.mode', wake?.mode ?? 'none')
    if (wake?.source) this.span?.setAttribute('wake.source', wake.source)
    if (wake?.staleReason) this.span?.setAttribute('wake.stale_reason', wake.staleReason)
    if (wake?.idleTier) this.span?.setAttribute('idle.tier', wake.idleTier)
  }

  upstreamHeaders(res: Response): void {
    this.headersMs = this.since()
    const g = Number(res.headers.get('x-shogo-gateway-wait-ms'))
    this.gatewayWaitMs = Number.isFinite(g) && res.headers.has('x-shogo-gateway-wait-ms') ? g : undefined
    this.span?.setAttribute('chat.upstream_headers_ms', this.headersMs)
    if (this.gatewayWaitMs !== undefined) this.span?.setAttribute('chat.gateway_wait_ms', this.gatewayWaitMs)
  }

  /** Feed every upstream chunk; cheap once the first token has been seen. */
  observe(chunk: Uint8Array): void {
    if (this.done) return
    const text = this.tail + decoder.decode(chunk, { stream: true })
    if (CONTENT_FRAME.test(text)) {
      this.firstToken()
      return
    }
    this.tail = text.slice(-64)
  }

  private attrs(): Record<string, string> {
    return {
      route: this.route,
      'wake.mode': this.wake?.mode ?? 'none',
      'wake.source': this.wake?.source ?? 'none',
      'idle.tier': this.wake?.idleTier ?? 'none',
    }
  }

  private firstToken(): void {
    this.done = true
    const ttft = this.since()
    this.ttftMs = ttft
    const attrs = this.attrs()
    ttftHistogram.record(ttft, attrs)
    const phases: Record<string, number | undefined> = {
      resolve: this.resolveMs,
      upstream_headers:
        this.headersMs !== undefined && this.resolveMs !== undefined ? this.headersMs - this.resolveMs : undefined,
      gateway_wait: this.gatewayWaitMs,
      model: this.headersMs !== undefined ? ttft - this.headersMs : undefined,
    }
    for (const [phase, ms] of Object.entries(phases)) {
      if (ms !== undefined && ms >= 0) phaseHistogram.record(ms, { ...attrs, phase })
    }
    // chat.proxy has ended by now (it closes when the stream is handed back),
    // so the first token gets its own span under it, back-dated to arrival.
    const s = tracer.startSpan('chat.first_token', { startTime: this.startedAtWall, attributes: attrs }, this.parent)
    s.setAttribute('chat.ttft_ms', ttft)
    for (const [phase, ms] of Object.entries(phases)) if (ms !== undefined) s.setAttribute(`chat.${phase}_ms`, ms)
    if (this.wake?.staleReason) s.setAttribute('wake.stale_reason', this.wake.staleReason)
    if (this.wake?.hostId) s.setAttribute('wake.host', this.wake.hostId)
    s.end()
    if (ttft >= 5000) {
      console.warn(
        `[ChatLatency] slow first token: ${ttft}ms route=${this.route} wake=${attrs['wake.mode']}/${attrs['wake.source']}` +
          (this.wake?.staleReason ? ` stale=${this.wake.staleReason}` : '') +
          ` resolve=${phases.resolve ?? '?'}ms headers=${phases.upstream_headers ?? '?'}ms` +
          ` gateway=${phases.gateway_wait ?? '?'}ms model=${phases.model ?? '?'}ms`,
      )
    }
  }
}
