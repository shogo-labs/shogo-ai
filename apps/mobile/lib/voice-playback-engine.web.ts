// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The browser's voice-note playback engine, over a single `<audio>` element.
 *
 * One element is reused for every clip — a player per message would be both
 * expensive and wrong, since only one voice note should ever be audible.
 */

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

export function createVoicePlaybackEngine(handlers: VoicePlaybackHandlers): VoicePlaybackEngine {
  let audio: HTMLAudioElement | null = null

  const ensureAudio = (): HTMLAudioElement => {
    if (audio) return audio
    const element = new Audio()
    element.preload = "metadata"
    const report = () =>
      handlers.onProgress(element.currentTime * 1000, (element.duration || 0) * 1000)
    element.addEventListener("loadedmetadata", report)
    element.addEventListener("timeupdate", report)
    element.addEventListener("ended", () => handlers.onEnded())
    element.addEventListener("error", () => handlers.onError())
    audio = element
    return element
  }

  return {
    load(url) {
      const element = ensureAudio()
      if (element.src !== url) {
        element.src = url
        element.load()
      }
    },
    play() {
      // Autoplay is only allowed from a user gesture; every caller is a tap.
      void audio?.play().catch((error: unknown) => handlers.onError(error))
    },
    pause() {
      audio?.pause()
    },
    seek(seconds) {
      const element = audio
      if (!element) return
      try {
        element.currentTime = Math.max(0, seconds)
      } catch (error) {
        handlers.onError(error)
      }
    },
    setRate(rate) {
      const element = audio
      if (!element) return
      element.playbackRate = rate
      // Keeps voices natural at 1.5x/2x instead of chipmunked (no-op elsewhere).
      ;(element as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
    },
    release() {
      if (!audio) return
      audio.pause()
      audio.removeAttribute("src")
      audio.load()
      audio = null
    },
  }
}
