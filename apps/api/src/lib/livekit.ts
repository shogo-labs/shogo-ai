// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * LiveKit access for huddles: join tokens for clients and verification of
 * LiveKit's webhooks. Media never touches the API; LiveKit (Cloud or
 * self-hosted) carries it. Huddles are off unless all three env vars are set.
 */

import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver, type WebhookEvent } from 'livekit-server-sdk'

export interface LiveKitConfig {
  /** `wss://` URL clients connect to. */
  url: string
  apiKey: string
  apiSecret: string
}

const TOKEN_TTL_SECONDS = 10 * 60

export function liveKitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL?.trim()
  const apiKey = process.env.LIVEKIT_API_KEY?.trim()
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim()
  if (!url || !apiKey || !apiSecret) return null
  return { url, apiKey, apiSecret }
}

export function huddlesEnabled(): boolean {
  return liveKitConfig() !== null
}

/**
 * A short-lived token that lets one person into one room with their mic,
 * camera, and screen. The token only gates the initial connect; LiveKit keeps
 * the session alive after it expires.
 */
export async function mintJoinToken(
  config: LiveKitConfig,
  input: { roomName: string; userId: string; name: string; image?: string | null },
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: input.userId,
    name: input.name,
    metadata: JSON.stringify({ image: input.image ?? null }),
    ttl: TOKEN_TTL_SECONDS,
  })
  token.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  })
  return token.toJwt()
}

function roomService(config: LiveKitConfig): RoomServiceClient {
  return new RoomServiceClient(config.url.replace(/^ws/, 'http'), config.apiKey, config.apiSecret)
}

/**
 * Identities connected to a room right now: empty when the room doesn't exist,
 * null when LiveKit couldn't be asked (callers then keep what they have).
 */
export async function listRoomIdentities(config: LiveKitConfig, roomName: string): Promise<Set<string> | null> {
  try {
    const participants = await roomService(config).listParticipants(roomName)
    return new Set(participants.map((p) => p.identity))
  } catch (err: any) {
    if (err?.status === 404 || /does not exist|not found/i.test(String(err?.message ?? ''))) return new Set()
    console.warn(`[LiveKit] listParticipants(${roomName}) failed:`, err?.message ?? err)
    return null
  }
}

/** Close a room, disconnecting anyone still in it. A room that is already gone is fine. */
export async function deleteRoom(config: LiveKitConfig, roomName: string): Promise<void> {
  try {
    await roomService(config).deleteRoom(roomName)
  } catch (err: any) {
    if (err?.status === 404 || /does not exist|not found/i.test(String(err?.message ?? ''))) return
    console.warn(`[LiveKit] deleteRoom(${roomName}) failed:`, err?.message ?? err)
  }
}

/** Verify and parse a LiveKit webhook. Throws when the signature is wrong. */
export async function receiveWebhook(config: LiveKitConfig, body: string, authHeader: string | undefined): Promise<WebhookEvent> {
  return new WebhookReceiver(config.apiKey, config.apiSecret).receive(body, authHeader)
}
