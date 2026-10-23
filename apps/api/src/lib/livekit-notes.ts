// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The LiveKit side of huddle notes: dispatching the hidden `huddle-notes`
 * agent, telling it what the room is doing, and explaining why it is not
 * available. LiveKit is only ever the *fallback* — a track no device
 * transcribes — so every function here is safe to call when nothing is
 * configured, and says why instead of throwing.
 */

import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk'
import { liveKitConfig, type LiveKitConfig } from './livekit'
import { NOTES_AGENT_IDENTITY } from '../services/huddle-notes-coverage'

/** Agent name the worker registers under and dispatch targets. */
export const NOTES_AGENT_NAME = 'huddle-notes'

/** Inference STT model the worker sends audio to. */
export function notesSttModel(): string {
  return process.env.LIVEKIT_NOTES_STT_MODEL?.trim() || 'deepgram/nova-3'
}

/**
 * Whether the fallback can run at all, and why not when it can't. Huddles on a
 * self-hosted LiveKit have no Inference STT, so they run the client path only.
 */
export function notesFallbackAvailability(): { ok: true } | { ok: false; reason: string } {
  if (!liveKitConfig()) return { ok: false, reason: 'LiveKit is not configured' }
  if (process.env.LIVEKIT_NOTES_FALLBACK === 'off') return { ok: false, reason: 'the LiveKit fallback is turned off' }
  return { ok: true }
}

export function notesFallbackAvailable(): boolean {
  return notesFallbackAvailability().ok
}

function httpUrl(config: LiveKitConfig): string {
  return config.url.replace(/^ws/, 'http')
}

/** Room-level state the worker reads: is this call on, and which huddle is it? */
export interface NotesRoomMetadata {
  huddleId?: string
  notes?: boolean
}

export function parseRoomMetadata(metadata: string | null | undefined): NotesRoomMetadata {
  if (!metadata) return {}
  try {
    const parsed = JSON.parse(metadata) as NotesRoomMetadata
    return typeof parsed === 'object' && parsed ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Publish `{ notes, huddleId }` on the room so the worker notices a toggle
 * without another RPC. Best effort: a failure here only costs the worker a
 * beat, and the huddle row is still the source of truth.
 */
export async function setRoomNotesMetadata(
  roomName: string,
  state: NotesRoomMetadata,
  config: LiveKitConfig | null = liveKitConfig(),
): Promise<boolean> {
  if (!config) return false
  try {
    const rooms = new RoomServiceClient(httpUrl(config), config.apiKey, config.apiSecret)
    const existing = await rooms.listRooms([roomName])
    const current = parseRoomMetadata(existing[0]?.metadata)
    await rooms.updateRoomMetadata(roomName, JSON.stringify({ ...current, ...state }))
    return true
  } catch (err) {
    console.warn('[huddle-notes] could not update room metadata:', (err as Error).message)
    return false
  }
}

/**
 * Ask LiveKit to run one `huddle-notes` job in this room. The server hands the
 * job to exactly one worker across all pods and re-dispatches on failure, so
 * this is safe to call from any pod, on every toggle-on.
 */
export async function dispatchNotesAgent(
  roomName: string,
  huddleId: string,
  config: LiveKitConfig | null = liveKitConfig(),
): Promise<{ ok: true; dispatchId: string } | { ok: false; reason: string }> {
  const availability = notesFallbackAvailability()
  if (!availability.ok) return availability
  if (!config) return { ok: false, reason: 'LiveKit is not configured' }
  try {
    const client = new AgentDispatchClient(httpUrl(config), config.apiKey, config.apiSecret)
    const dispatch = await client.createDispatch(roomName, NOTES_AGENT_NAME, {
      metadata: JSON.stringify({ huddleId }),
    })
    return { ok: true, dispatchId: dispatch.id }
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'dispatch failed' }
  }
}

/** Identities LiveKit reports as agents in a room, so the API can hide them. */
export function isHiddenNotesAgent(identity: string): boolean {
  return identity === NOTES_AGENT_IDENTITY || identity.startsWith(`${NOTES_AGENT_IDENTITY}-`)
}
