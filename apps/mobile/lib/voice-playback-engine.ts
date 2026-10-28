// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The phone's voice-note playback engine (expo-audio).
 *
 * One player object is reused for every clip — a player per message would be
 * both expensive and wrong, since only one voice note should ever be audible.
 * The web sibling is `voice-playback-engine.web.ts`.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio"

export interface VoicePlaybackHandlers {
  onProgress: (positionMs: number, durationMs: number) => void
  onEnded: () => void
  onError: (error?: unknown) => void
}

export interface VoicePlaybackEngine {
  load: (url: string) => void
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  setRate: (rate: number) => void
  release: () => void
}

/** 200ms keeps the playhead smooth without waking JS more than it must. */
const UPDATE_INTERVAL_MS = 200

export function createVoicePlaybackEngine(handlers: VoicePlaybackHandlers): VoicePlaybackEngine {
  let player: AudioPlayer | null = null
  let subscription: { remove: () => void } | null = null
  let sessionReady = false

  const ensurePlayer = (url: string): AudioPlayer => {
    if (!player) {
      player = createAudioPlayer(url, { updateInterval: UPDATE_INTERVAL_MS })
      subscription = player.addListener("playbackStatusUpdate", (status) => {
        handlers.onProgress(status.currentTime * 1000, (status.duration ?? 0) * 1000)
        if (status.didJustFinish) handlers.onEnded()
      })
      return player
    }
    player.replace(url)
    return player
  }

  // iOS plays nothing through the silent switch until the session allows it.
  const readySession = async () => {
    if (sessionReady) return
    sessionReady = true
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {})
  }

  return {
    load(url) {
      try {
        ensurePlayer(url)
      } catch (error) {
        handlers.onError(error)
      }
    },
    play() {
      const current = player
      if (!current) return
      void readySession().then(() => {
        try {
          current.play()
        } catch (error) {
          handlers.onError(error)
        }
      })
    },
    pause() {
      try {
        player?.pause()
      } catch (error) {
        handlers.onError(error)
      }
    },
    seek(seconds) {
      void player?.seekTo(Math.max(0, seconds)).catch((error: unknown) => handlers.onError(error))
    },
    setRate(rate) {
      try {
        // `high` keeps voices natural at 1.5x/2x instead of chipmunked.
        player?.setPlaybackRate(rate, "high")
      } catch (error) {
        handlers.onError(error)
      }
    },
    release() {
      try {
        subscription?.remove()
        player?.remove()
      } catch {
        // Already torn down.
      }
      subscription = null
      player = null
    },
  }
}
