// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Apple Push Notification service (APNs) over HTTP/2, shared by every iPhone
 * push that bypasses Expo's push service: Live Activities and VoIP pushes that
 * ring the native incoming-call screen.
 *
 * Without APNs credentials in the environment every send here does nothing.
 */
import { createPrivateKey, sign } from 'node:crypto'

export interface ApnsConfig {
  keyId: string
  teamId: string
  /** PEM contents of the `.p8` key. */
  privateKey: string
  bundleId: string
  sandbox: boolean
}

/** APNs credentials from the environment, or null when APNs is not set up. */
export function apnsConfigFromEnv(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID?.trim()
  const teamId = env.APNS_TEAM_ID?.trim()
  const key = env.APNS_PRIVATE_KEY?.trim()
  if (!keyId || !teamId || !key) return null
  return {
    keyId,
    teamId,
    // Env files often hold the PEM on one line with literal \n.
    privateKey: key.replace(/\\n/g, '\n'),
    bundleId: env.APNS_BUNDLE_ID?.trim() || 'ai.shogo.app',
    sandbox: env.APNS_SANDBOX === 'true' || env.APNS_SANDBOX === '1',
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** The ES256 provider token APNs asks for. */
export function signApnsJwt(config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'privateKey'>, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }))
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }))
  const data = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(data), { key: createPrivateKey(config.privateKey), dsaEncoding: 'ieee-p1363' })
  return `${data}.${base64url(signature)}`
}

export interface ApnsRequest {
  host: string
  deviceToken: string
  headers: Record<string, string>
  body: string
}
export interface ApnsResponse {
  status: number
  reason?: string
}
export type ApnsTransport = (request: ApnsRequest) => Promise<ApnsResponse>

/** The headers and host for one APNs request, whatever the push type. */
export function buildApnsRequest(input: {
  config: ApnsConfig
  deviceToken: string
  /** `alert`, `liveactivity`, `voip`, and so on. */
  pushType: string
  /** Appended to the bundle id to form the topic: `''` for alerts, `.push-type.liveactivity`, `.voip`. */
  topicSuffix: string
  priority: '10' | '5'
  body: object
  nowSeconds: number
}): ApnsRequest {
  const { config } = input
  return {
    host: config.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com',
    deviceToken: input.deviceToken,
    headers: {
      authorization: `bearer ${signApnsJwt(config, input.nowSeconds)}`,
      'apns-push-type': input.pushType,
      'apns-topic': `${config.bundleId}${input.topicSuffix}`,
      'apns-priority': input.priority,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
  }
}

/** Sends one request over a fresh HTTP/2 connection. */
export async function http2Transport(request: ApnsRequest): Promise<ApnsResponse> {
  const http2 = await import('node:http2')
  return new Promise<ApnsResponse>((resolve) => {
    const client = http2.connect(`https://${request.host}`)
    const finish = (response: ApnsResponse) => {
      client.close()
      resolve(response)
    }
    client.on('error', (err) => finish({ status: 0, reason: err.message }))
    const stream = client.request({ ':method': 'POST', ':path': `/3/device/${request.deviceToken}`, ...request.headers })
    let status = 0
    let text = ''
    stream.setEncoding('utf8')
    stream.on('response', (headers) => { status = Number(headers[':status'] ?? 0) })
    stream.on('data', (chunk) => { text += chunk })
    stream.on('end', () => {
      let reason: string | undefined
      try { reason = (JSON.parse(text) as { reason?: string }).reason } catch { /* empty body on success */ }
      finish({ status, reason })
    })
    stream.on('error', (err) => finish({ status: 0, reason: err.message }))
    stream.setTimeout(10_000, () => { stream.close(); finish({ status: 0, reason: 'timeout' }) })
    stream.end(request.body)
  })
}

/** The token is dead: the activity ended, the app was removed, or the token was replaced. */
export function isDeadTokenResponse(response: ApnsResponse): boolean {
  return response.status === 410 || response.reason === 'BadDeviceToken' || response.reason === 'Unregistered' || response.reason === 'ExpiredToken'
}

export interface VoipPayload {
  huddleId: string
  conversationId: string
  workspaceId: string
  /** `dm` or `group_dm`, so the call screen can label it. */
  kind: string
  from: { userId: string; name: string; image: string | null }
}

export interface ApnsDeps {
  config?: ApnsConfig | null
  transport?: ApnsTransport
  now?: () => number
}

export interface VoipSendResult {
  sent: boolean
  /** The token is spent and should be cleared from the device record. */
  dead: boolean
  status: number
  reason?: string
}

/**
 * Rings an iPhone's incoming-call screen through PushKit. Apple requires the
 * app to report a call for every VoIP push, so the client shows CallKit at once.
 * Priority 10 and the `.voip` topic are both required by PushKit.
 */
export async function sendVoipPush(voipToken: string, payload: VoipPayload, deps: ApnsDeps = {}): Promise<VoipSendResult> {
  const config = deps.config === undefined ? apnsConfigFromEnv() : deps.config
  if (!config) return { sent: false, dead: false, status: 0, reason: 'not_configured' }
  const transport = deps.transport ?? http2Transport
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000)
  const response = await transport(buildApnsRequest({
    config,
    deviceToken: voipToken,
    pushType: 'voip',
    topicSuffix: '.voip',
    priority: '10',
    body: payload,
    nowSeconds,
  }))
  return {
    sent: response.status === 200,
    dead: isDeadTokenResponse(response),
    status: response.status,
    reason: response.reason,
  }
}
