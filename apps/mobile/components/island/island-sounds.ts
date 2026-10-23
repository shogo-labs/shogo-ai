// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Island sound cues, synthesized with Web Audio so there are no audio assets
// to license or bundle.

import { islandSessionKey, type IslandMeetingState, type IslandSnapshot } from "./types"
import { scheduleTones, sharedAudioContext, type Tone } from "../../lib/notification-sound"

export type IslandSound = "needs-you" | "done" | "error" | "sent"

/** The one cue a snapshot transition deserves, loudest first. Sessions the
 * user is looking at in a focused Shogo window stay silent. */
export function islandSoundForTransition(
  previous: IslandSnapshot,
  next: IslandSnapshot,
): IslandSound | null {
  const before = new Map(
    previous.sessions.map((session) => [islandSessionKey(session.projectId, session.sessionId), session]),
  )
  let sound: IslandSound | null = null
  for (const session of next.sessions) {
    const key = islandSessionKey(session.projectId, session.sessionId)
    if (key === next.focusedSessionKey) continue
    const prior = before.get(key)
    const newRequest =
      !!session.pending && session.pending.request.id !== prior?.pending?.request.id
    const newPlan =
      !!session.pendingPlan && session.pendingPlan.toolCallId !== prior?.pendingPlan?.toolCallId
    if (newRequest || newPlan) return "needs-you"
    if (prior?.status === "running" && session.status === "done") sound = "done"
  }
  if (!sound && next.notice && next.notice !== previous.notice) return "error"
  return sound
}

export function meetingSoundForTransition(
  previous: IslandMeetingState,
  next: IslandMeetingState,
): IslandSound | null {
  if (next.prompt && next.prompt.id !== previous.prompt?.id) return "needs-you"
  if (next.error && next.error !== previous.error) return "error"
  return null
}

const SOUNDS: Record<IslandSound, Tone[]> = {
  "needs-you": [
    { frequency: 880, start: 0, duration: 0.14 },
    { frequency: 1318.5, start: 0.12, duration: 0.22 },
  ],
  done: [
    { frequency: 659.25, start: 0, duration: 0.18 },
    { frequency: 987.77, start: 0.09, duration: 0.3 },
  ],
  error: [
    { frequency: 392, start: 0, duration: 0.16, type: "triangle" },
    { frequency: 293.66, start: 0.13, duration: 0.26, type: "triangle" },
  ],
  sent: [{ frequency: 1567.98, start: 0, duration: 0.07 }],
}

export function playIslandSound(sound: IslandSound, volume: number): void {
  if (volume <= 0) return
  const ctx = sharedAudioContext()
  if (!ctx) return
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined)
  scheduleTones(ctx, SOUNDS[sound], Math.min(1, volume) * 0.18)
}
