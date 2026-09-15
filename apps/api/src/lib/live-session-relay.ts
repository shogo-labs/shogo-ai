// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { ProxyTokenPayload } from './ai-proxy-token'
import { getShogoCloudUrl } from './cloud-urls'
import { getNativeProviderApiKeySync } from '../services/provider-credentials.service'
import { prisma } from './prisma'
import {
  ensureLiveSessionMeter,
  finalizeLiveSessionMeter,
  observeLiveEvent,
  type LiveSessionMeterContext,
} from './live-session-meter'
import { validateLiveSessionStart, type LiveSessionStart } from './live-session'

export interface LiveRelayData {
  kind: 'live-relay'
  tokenPayload: ProxyTokenPayload
  sessionId?: string
  attach?: boolean
}

interface RelayState {
  client: any
  upstream: any
  data: LiveRelayData
  upstreamReady: boolean
  validated: boolean
  validating: boolean
  firstClientMessage: boolean
  pending: unknown[]
  firstForwardedMessage?: string
  model?: string
  backendModel?: string
  meter?: LiveSessionMeterContext
  finalized: boolean
}

const states = new Map<any, RelayState>()

function cloudForwarding(): boolean {
  if (process.env.SHOGO_LOCAL_MODE !== 'true' || !process.env.SHOGO_API_KEY) return false
  const mode = process.env.AI_MODE
  return mode !== 'api-keys' && mode !== 'local-llm'
}

function cloudWebSocketUrl(path: string): string {
  return `${getShogoCloudUrl().replace(/^http/, 'ws')}${path}`
}

function openSocket(url: string, authorization: string): any {
  const Socket = (globalThis as any).WebSocket
  return new Socket(url, { headers: { Authorization: authorization } })
}

function toJson(raw: unknown): Record<string, any> | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : String(raw)
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function sendError(client: any, status: number, code: string, message: string): void {
  try {
    client.send(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', code, message, status },
    }))
  } catch {}
}

function closeSocket(socket: any): void {
  try {
    socket?.close()
  } catch {}
}

async function validatePrimaryStart(state: RelayState, raw: unknown): Promise<boolean> {
  const event = toJson(raw)
  if (!event || event.type !== 'session.start' || !event.session || typeof event.session !== 'object') {
    sendError(state.client, 400, 'session_start_required', 'The first Live event must be session.start.')
    closeSocket(state.client)
    return false
  }

  const session = event.session as LiveSessionStart
  const result = await validateLiveSessionStart(state.data.tokenPayload, session, {
    allowCloudForwarding: cloudForwarding(),
  })
  if (!result.ok) {
    sendError(state.client, result.status, result.code, result.message)
    closeSocket(state.client)
    return false
  }

  if (process.env.SHOGO_LOCAL_MODE !== 'true') {
    // The normal chat proxy performs this gate before contacting a provider.
    // Live sessions are long-lived, so admit them once at session start.
    const { checkUsageBalance } = await import('../services/billing.service')
    const balance = await checkUsageBalance(state.data.tokenPayload.workspaceId)
    if (!balance.ok) {
      sendError(state.client, 402, 'usage_limit_reached', 'Workspace usage limit reached.')
      closeSocket(state.client)
      return false
    }
  }

  state.model = session.model
  state.backendModel = result.backendModel
  const forwardedSession: LiveSessionStart = {
    ...session,
    model: result.upstreamModel,
    ...(result.upstreamBackendModel && session.delegation?.responses
      ? {
          delegation: {
            ...session.delegation,
            responses: {
              ...session.delegation.responses,
              model: result.upstreamBackendModel,
            },
          },
        }
      : {}),
  }
  state.firstForwardedMessage = JSON.stringify({ ...event, session: forwardedSession })
  state.validated = true
  return true
}

function createMeter(state: RelayState, sessionId: string): LiveSessionMeterContext {
  const context: LiveSessionMeterContext = {
    sessionId,
    tokenPayload: state.data.tokenPayload,
    model: state.model || 'gpt-live-1',
    backendModel: state.backendModel,
    transport: state.data.attach ? 'sideband' : 'websocket',
    responseIds: new Set(),
  }
  state.meter = context
  return context
}

async function observeUpstream(state: RelayState, raw: unknown): Promise<void> {
  const event = toJson(raw)
  if (!state.meter && event?.type === 'session.started' && typeof event.session?.id === 'string') {
    state.meter = createMeter(state, event.session.id)
    await ensureLiveSessionMeter(state.meter)
  }
  if (state.meter) await observeLiveEvent(state.meter, raw)

  if (event?.type === 'session.closed' && state.meter && !state.finalized) {
    state.finalized = true
    const seconds = typeof event.usage?.seconds === 'number' ? event.usage.seconds : undefined
    void finalizeLiveSessionMeter(state.meter, { confirmed: true, seconds }).catch((error) => {
      console.error('[Live] final billing failed:', error)
    })
  }
}

function flush(state: RelayState): void {
  if (!state.upstreamReady) return
  while (state.pending.length > 0) {
    const message = state.pending.shift()
    try {
      state.upstream.send(message)
    } catch {
      state.pending.unshift(message)
      return
    }
  }
}

function attachHandlers(socket: any, handlers: {
  open: () => void
  message: (event: any) => void
  close: () => void
  error: (error: unknown) => void
}): void {
  socket.onopen = handlers.open
  socket.onmessage = handlers.message
  socket.onclose = handlers.close
  socket.onerror = handlers.error
}

export function liveRelayOpen(ws: any): void {
  const data = ws.data as LiveRelayData
  const state: RelayState = {
    client: ws,
    upstream: null,
    data,
    upstreamReady: false,
    validated: Boolean(data.attach),
    validating: false,
    firstClientMessage: !data.attach,
    pending: [],
    finalized: false,
  }
  states.set(ws, state)

  const isCloud = cloudForwarding()
  const authorization = `Bearer ${isCloud ? process.env.SHOGO_API_KEY : getNativeProviderApiKeySync('openai') || ''}`
  if (!authorization.slice(7)) {
    sendError(ws, 503, 'provider_not_configured', 'The OpenAI provider is not configured.')
    closeSocket(ws)
    return
  }

  if (data.attach && !isCloud && data.sessionId) {
    void (async () => {
      const row = await (prisma as any).liveSessionMeter.findUnique({ where: { sessionId: data.sessionId } })
      if (!row || row.workspaceId !== data.tokenPayload.workspaceId) {
        sendError(ws, 403, 'session_not_found', 'Live session not found for this workspace.')
        closeSocket(ws)
        return
      }
      state.model = row.model
      state.backendModel = row.backendModel ?? undefined
      state.meter = {
        sessionId: row.sessionId,
        tokenPayload: data.tokenPayload,
        model: row.model,
        backendModel: row.backendModel ?? undefined,
        transport: 'sideband',
        responseIds: new Set(),
      }
      connectUpstream(state, authorization, isCloud)
    })().catch(() => closeSocket(ws))
    return
  }

  connectUpstream(state, authorization, isCloud)
}

function connectUpstream(state: RelayState, authorization: string, isCloud: boolean): void {
  const path = state.data.attach && state.data.sessionId
    ? `/api/ai/v1/live/sessions/${encodeURIComponent(state.data.sessionId)}/attach`
    : '/api/ai/v1/live/sessions'
  const url = isCloud ? cloudWebSocketUrl(path) : (
    state.data.attach && state.data.sessionId
      ? `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(state.data.sessionId)}/attach`
      : 'wss://api.openai.com/v1/live/sessions'
  )
  let upstream: any
  try {
    upstream = openSocket(url, authorization)
  } catch (error) {
    sendError(state.client, 502, 'upstream_connect_failed', String(error))
    closeSocket(state.client)
    return
  }
  state.upstream = upstream
  attachHandlers(upstream, {
    open: () => {
      state.upstreamReady = true
      flush(state)
    },
    message: (event) => {
      const raw = event?.data ?? event
      void observeUpstream(state, raw)
      try { state.client.send(raw) } catch {}
    },
    close: () => {
      if (state.meter && !state.finalized && !isCloud) {
        state.finalized = true
        void finalizeLiveSessionMeter(state.meter, { confirmed: false }).catch((error) => {
          console.error('[Live] unconfirmed billing failed:', error)
        })
      }
      closeSocket(state.client)
      states.delete(state.client)
    },
    error: (error) => {
      console.error('[Live] upstream socket error:', error)
    },
  })
}

export function liveRelayMessage(ws: any, raw: unknown): void {
  const state = states.get(ws)
  if (!state) return

  if (state.firstClientMessage) {
    state.firstClientMessage = false
    state.validating = true
    void validatePrimaryStart(state, raw).then((ok) => {
      state.validating = false
      if (!ok) return
      // Messages received while async validation was in flight are already
      // queued; session.start must remain ahead of them.
      state.pending.unshift(state.firstForwardedMessage ?? raw)
      flush(state)
    }).catch((error) => {
      sendError(ws, 400, 'invalid_session', error instanceof Error ? error.message : String(error))
      closeSocket(ws)
    })
    return
  }

  if (state.validating || !state.validated || !state.upstreamReady) {
    state.pending.push(raw)
    return
  }
  try { state.upstream.send(raw) } catch {}
}

export function liveRelayClose(ws: any): void {
  const state = states.get(ws)
  if (!state) return
  if (state.meter && !state.finalized) {
    state.finalized = true
    void finalizeLiveSessionMeter(state.meter, { confirmed: false }).catch(() => {})
  }
  closeSocket(state.upstream)
  states.delete(ws)
}

/**
 * Start a server-side sideband for WebRTC sessions so Shogo can meter the
 * duration even though audio travels directly between the browser and OpenAI.
 */
export function startLiveSidebandMeter(
  context: LiveSessionMeterContext,
  openaiApiKey: string,
): void {
  const Socket = (globalThis as any).WebSocket
  let socket: any
  try {
    socket = new Socket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(context.sessionId)}/attach`, {
      headers: { Authorization: `Bearer ${openaiApiKey}` },
    })
  } catch (error) {
    console.error('[Live] failed to attach metering sideband:', error)
    return
  }
  let finalized = false
  attachHandlers(socket, {
    open: () => {},
    message: (event) => {
      const raw = event?.data ?? event
      void observeLiveEvent(context, raw).then(() => {
        const parsed = toJson(raw)
        if (parsed?.type === 'session.closed' && !finalized) {
          finalized = true
          const seconds = typeof parsed.usage?.seconds === 'number' ? parsed.usage.seconds : undefined
          return finalizeLiveSessionMeter(context, { confirmed: true, seconds })
        }
      }).catch((error) => console.error('[Live] sideband event error:', error))
    },
    close: () => {
      // A sideband disconnect does not mean the browser's primary WebRTC
      // session ended. Keep the meter open; a later session.closed event (or
      // an explicit server-side cleanup path) is the billing boundary.
      if (!finalized) console.warn('[Live] metering sideband disconnected before session.closed')
    },
    error: (error) => console.error('[Live] sideband socket error:', error),
  })
}

export function isLiveRelayData(value: unknown): value is LiveRelayData {
  return !!value && typeof value === 'object' && (value as any).kind === 'live-relay'
}
