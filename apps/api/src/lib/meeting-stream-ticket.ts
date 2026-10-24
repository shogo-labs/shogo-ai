// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Short-lived tickets for the live-transcript audio WebSocket.
 *
 * Browsers can't set headers on a WebSocket and the desktop recorder has no
 * session, so the recorder first asks an authorized HTTP route for a ticket
 * (which resolves the workspace exactly like every other meetings route) and
 * then opens the socket with it. A ticket names one recording in one
 * workspace and expires quickly.
 */

import { createHmac } from 'crypto'
import { safeTokenEqual } from './crypto-util'
import { getSigningSecret } from './runtime-token'

export interface MeetingStreamTicket {
  workspaceId: string
  userId: string | null
  recordingId: string
  exp: number
  /**
   * Set when the recording id belongs to a live huddle (`huddle:<huddleId>`).
   * The stream then writes into the huddle's shared draft with a speaker label
   * and a server-computed timeline instead of the recorder's own clock.
   */
  huddleId?: string
  /** Who is being transcribed: a display name, so the transcript reads `Ana: …`. */
  speaker?: string
  /** Who is being transcribed: a user id or guest id, so their finals never collide with anyone else's. */
  speakerId?: string
}

export const STREAM_TICKET_TTL_MS = 2 * 60 * 1000
export const STREAM_WS_PATH = '/api/meetings/live-stream'

function sign(payload: string): string {
  return createHmac('sha256', getSigningSecret()).update(`meeting-stream:${payload}`).digest('hex')
}

export function createStreamTicket(
  input: Omit<MeetingStreamTicket, 'exp'>,
  now = Date.now(),
  ttlMs = STREAM_TICKET_TTL_MS,
): string {
  const payload = Buffer.from(JSON.stringify({ ...input, exp: now + ttlMs })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyStreamTicket(ticket: string | null | undefined, now = Date.now()): MeetingStreamTicket | null {
  if (!ticket || ticket.length > 2048) return null
  const dot = ticket.indexOf('.')
  if (dot <= 0) return null
  const payload = ticket.slice(0, dot)
  if (!safeTokenEqual(ticket.slice(dot + 1), sign(payload))) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      typeof parsed?.workspaceId !== 'string' ||
      typeof parsed?.recordingId !== 'string' ||
      typeof parsed?.exp !== 'number' ||
      parsed.exp < now
    ) {
      return null
    }
    return {
      workspaceId: parsed.workspaceId,
      userId: typeof parsed.userId === 'string' ? parsed.userId : null,
      recordingId: parsed.recordingId,
      exp: parsed.exp,
      // Only present on huddle tickets; older tickets keep verifying unchanged.
      ...(typeof parsed.huddleId === 'string' && parsed.huddleId ? { huddleId: parsed.huddleId } : {}),
      ...(typeof parsed.speaker === 'string' && parsed.speaker ? { speaker: parsed.speaker.slice(0, 80) } : {}),
      ...(typeof parsed.speakerId === 'string' && parsed.speakerId ? { speakerId: parsed.speakerId.slice(0, 128) } : {}),
    }
  } catch {
    return null
  }
}
