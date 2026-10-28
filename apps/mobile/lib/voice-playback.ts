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
type SeekTarget = { id: string; ratio: number } | { id: string; positionMs: number }
let pendingSeek: SeekTarget | null = null

const listeners = new Set<() => void>()

function update(next: Partial<VoicePlaybackSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

function getEngine(): VoicePlaybackEngine {
  if (!engine) {
    engine = createVoicePlaybackEngine({
      onProgress: (positionMs, durationMs) => {
        const knownDuration = Number.isFinite(durationMs) && durationMs > 0
          ? durationMs
          : snapshot.durationMs
        if (pendingSeek?.id === snapshot.activeId && knownDuration > 0) {
          const target = pendingSeek
          pendingSeek = null
          const nextPositionMs = seekPositionMs(target, knownDuration)
          engine?.seek(nextPositionMs / 1000)
          update({ positionMs: nextPositionMs, durationMs: knownDuration })
        } else {
          update({ positionMs, durationMs: knownDuration })
        }
      },
      onEnded: () => {
        pendingSeek = null
        update({ isPlaying: false, positionMs: 0 })
      },
      onError: () => {
        pendingSeek = null
        update({ isPlaying: false })
      },
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

function seekPositionMs(target: SeekTarget, durationMs: number): number {
  return 'ratio' in target
    ? durationMs * target.ratio
    : Math.max(0, Math.min(durationMs, target.positionMs))
}

function seekToTarget(audio: VoicePlaybackEngine, target: SeekTarget): void {
  if (!Number.isFinite(snapshot.durationMs) || snapshot.durationMs <= 0) {
    pendingSeek = target
    return
  }
  pendingSeek = null
  const positionMs = seekPositionMs(target, snapshot.durationMs)
  audio.seek(positionMs / 1000)
  update({ positionMs })
}

function startVoiceNote(note: VoiceNotePlayable, audio: VoicePlaybackEngine): void {
  pendingSeek = null
  audio.load(note.url)
  audio.setRate(speed)
  update({
    activeId: note.id,
    isPlaying: true,
    positionMs: 0,
    durationMs: note.durationMs && Number.isFinite(note.durationMs) && note.durationMs > 0
      ? note.durationMs
      : 0,
  })
  audio.play()
}

function prepareToSeek(note: VoiceNotePlayable): VoicePlaybackEngine {
  const audio = getEngine()
  if (snapshot.activeId !== note.id) startVoiceNote(note, audio)
  return audio
}

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
    startVoiceNote(note, audio)
    return
  }
  update({ isPlaying: true })
  audio.play()
}

/**
 * Jump to `ratio` (0-1) through a clip. Scrubbing a clip that is not already
 * loaded starts it there and plays on, which is what the gesture means.
 */
export function seekVoiceNote(note: VoiceNotePlayable, ratio: number): void {
  if (!Number.isFinite(ratio)) return
  const audio = prepareToSeek(note)
  seekToTarget(audio, { id: note.id, ratio: Math.max(0, Math.min(1, ratio)) })
}

/** Move the playhead by a fixed time, including before an older clip's length loads. */
export function seekVoiceNoteByMs(note: VoiceNotePlayable, deltaMs: number): void {
  if (!Number.isFinite(deltaMs)) return
  const audio = prepareToSeek(note)
  const queuedPositionMs = pendingSeek?.id === note.id && 'positionMs' in pendingSeek
    ? pendingSeek.positionMs
    : snapshot.positionMs
  seekToTarget(audio, { id: note.id, positionMs: queuedPositionMs + deltaMs })
}

export function setVoiceNoteSpeed(next: PlaybackSpeed): void {
  speed = next
  getEngine().setRate(next)
  update({ rate: next })
}

/** Stop playback, e.g. because the clip's message was deleted or unmounted. */
export function stopVoiceNote(): void {
  if (!snapshot.activeId && !snapshot.isPlaying) return
  pendingSeek = null
  getEngine().pause()
  update({ activeId: null, isPlaying: false, positionMs: 0, durationMs: 0 })
}
