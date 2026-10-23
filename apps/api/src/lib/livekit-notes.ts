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
import { NOTES_AGENT_IDENTITY, isNotesAgent } from '../services/huddle-notes-coverage'

/** Attribute the worker puts on its own participant; see the worker's entry. */
export const NOTES_AGENT_ATTRIBUTE = 'shogoNotesAgent'

/** Agent name the worker registers under and dispatch targets. */
export const NOTES_AGENT_NAME = 'huddle-notes'

/**
 * LiveKit's own topic for transcription text streams. Whoever transcribes a
 * speaker publishes each partial and final here, so every participant reads
 * live captions straight from the room (guests and phones included) with no
 * server hop. Must match `CAPTION_TOPIC` in the app.
 */
export const CAPTION_TOPIC = 'lk.transcription'
/** The transcript item a line belongs to, so a partial is replaced by its final. */
export const CAPTION_SEGMENT_ATTRIBUTE = 'lk.segment_id'
/** `'true'` once the recognizer settled the line. */
export const CAPTION_FINAL_ATTRIBUTE = 'lk.transcription_final'
/** Who said it — the worker's own participant identity is the agent, not the speaker. */
export const CAPTION_SPEAKER_ATTRIBUTE = 'shogo.speaker'

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

/** Dispatches this pod already made, so a burst of joins doesn't mint jobs. */
const recentDispatches = new Map<string, number>()
const DISPATCH_MEMO_MS = 60_000

/** Whether this room already has a fallback transcriber in it. */
async function notesAgentPresent(roomName: string, config: LiveKitConfig): Promise<boolean> {
  try {
    const rooms = new RoomServiceClient(httpUrl(config), config.apiKey, config.apiSecret)
    const participants = await rooms.listParticipants(roomName)
    return participants.some(
      (participant: any) =>
        participant?.attributes?.[NOTES_AGENT_ATTRIBUTE] === '1' ||
        isNotesAgent(String(participant?.identity ?? '')),
    )
  } catch {
    // Room not there yet (nobody has joined): nothing is covering it.
    return false
  }
}

/**
 * Ask LiveKit to run one `huddle-notes` job in this room. The server hands the
 * job to exactly one worker across all pods and re-dispatches on failure, so
 * this is safe to call from any pod — and from every join, not just a toggle:
 * notes are on by default, so a call that nobody toggles still needs covering.
 * A dispatch is skipped when an agent is already in the room, or when this pod
 * asked for one moments ago.
 */
export async function dispatchNotesAgent(
  roomName: string,
  huddleId: string,
  config: LiveKitConfig | null = liveKitConfig(),
): Promise<{ ok: true; dispatchId: string } | { ok: false; reason: string }> {
  const availability = notesFallbackAvailability()
  if (!availability.ok) return availability
  if (!config) return { ok: false, reason: 'LiveKit is not configured' }
  const askedAt = recentDispatches.get(roomName)
  if (askedAt && Date.now() - askedAt < DISPATCH_MEMO_MS) return { ok: true, dispatchId: 'recent' }
  if (await notesAgentPresent(roomName, config)) {
    recentDispatches.set(roomName, Date.now())
    return { ok: true, dispatchId: 'present' }
  }
  try {
    const client = new AgentDispatchClient(httpUrl(config), config.apiKey, config.apiSecret)
    const dispatch = await client.createDispatch(roomName, NOTES_AGENT_NAME, {
      metadata: JSON.stringify({ huddleId }),
    })
    recentDispatches.set(roomName, Date.now())
    return { ok: true, dispatchId: dispatch.id }
  } catch (err) {
    return { ok: false, reason: (err as Error).message || 'dispatch failed' }
  }
}

/** Identities LiveKit reports as agents in a room, so the API can hide them. */
export function isHiddenNotesAgent(identity: string): boolean {
  return isNotesAgent(identity) || identity === NOTES_AGENT_IDENTITY
}
