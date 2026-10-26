// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One voice note plays at a time, for the whole app.
 *
 * This is a module-level store rather than a React context because the players
 * live inside a virtualized message list, in several surfaces (channels, DMs,
 * threads, search results), and mounting a provider around each of them just
 * to share one audio element would be worse. Starting a clip stops whatever
 * was playing, which is the behaviour every messaging app has.
 */

import { useSyncExternalStore } from "react"
import { createVoicePlaybackEngine, type VoicePlaybackEngine } from "./voice-playback-engine"

/** Offered in the player's speed menu. */
export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

export interface VoiceNotePlayable {
  id: string
  url: string
  durationMs?: number | null
}

export interface VoicePlaybackSnapshot {
  /** Attachment currently loaded into the engine, if any. */
  activeId: string | null
  isPlaying: boolean
  positionMs: number
  durationMs: number
  rate: PlaybackSpeed
}

const INITIAL: VoicePlaybackSnapshot = {
  activeId: null,
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  rate: 1,
}

let snapshot: VoicePlaybackSnapshot = INITIAL
// Sticky for the session: someone who wants 2x wants it on the next clip too.
let speed: PlaybackSpeed = 1
let engine: VoicePlaybackEngine | null = null

const listeners = new Set<() => void>()

function update(next: Partial<VoicePlaybackSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

function getEngine(): VoicePlaybackEngine {
  if (!engine) {
    engine = createVoicePlaybackEngine({
      onProgress: (positionMs, durationMs) =>
        update({ positionMs, durationMs: durationMs > 0 ? durationMs : snapshot.durationMs }),
      onEnded: () => update({ isPlaying: false, positionMs: 0 }),
      onError: () => update({ isPlaying: false }),
    })
  }
  return engine
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): VoicePlaybackSnapshot => snapshot

/** The current playback state; also what `useVoicePlayback` subscribes to. */
export function readVoicePlayback(): VoicePlaybackSnapshot {
  return snapshot
}

export function useVoicePlayback(): VoicePlaybackSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Play this clip, or pause it if it is already the one playing. */
export function toggleVoiceNote(note: VoiceNotePlayable): void {
  const audio = getEngine()
  if (snapshot.activeId === note.id && snapshot.isPlaying) {
    audio.pause()
    update({ isPlaying: false })
    return
  }
  if (snapshot.activeId !== note.id) {
    audio.load(note.url)
    audio.setRate(speed)
    update({
      activeId: note.id,
      isPlaying: true,
      positionMs: 0,
      durationMs: note.durationMs && note.durationMs > 0 ? note.durationMs : 0,
    })
  } else {
    update({ isPlaying: true })
  }
  audio.play()
}

/**
 * Jump to `ratio` (0-1) through a clip. Scrubbing a clip that is not already
 * loaded starts it there and plays on, which is what the gesture means.
 */
export function seekVoiceNote(note: VoiceNotePlayable, ratio: number): void {
  const clamped = Math.max(0, Math.min(1, ratio))
  const audio = getEngine()
  if (snapshot.activeId !== note.id) {
    audio.load(note.url)
    audio.setRate(speed)
    update({
      activeId: note.id,
      isPlaying: true,
      positionMs: 0,
      durationMs: note.durationMs && note.durationMs > 0 ? note.durationMs : 0,
    })
    audio.play()
  }
  const durationMs = snapshot.durationMs
  if (!durationMs || durationMs <= 0) return
  const seconds = (durationMs / 1000) * clamped
  audio.seek(seconds)
  update({ positionMs: seconds * 1000 })
}

export function setVoiceNoteSpeed(next: PlaybackSpeed): void {
  speed = next
  getEngine().setRate(next)
  update({ rate: next })
}

/** Stop playback, e.g. because the clip's message was deleted or unmounted. */
export function stopVoiceNote(): void {
  if (!snapshot.activeId && !snapshot.isPlaying) return
  getEngine().pause()
  update({ activeId: null, isPlaying: false, positionMs: 0, durationMs: 0 })
}
