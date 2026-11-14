// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The browser's voice-note playback engine, with one active `<audio>` element.
 *
 * Up to three more elements warm nearby notes without ever playing them.
 */

export interface VoicePlaybackHandlers {
  onProgress: (positionMs: number, durationMs: number) => void
  onPlaying?: () => void
  onWaiting?: () => void
  onEnded: () => void
  onError: (error?: unknown) => void
}

export interface VoicePlaybackEngine {
  preload: (url: string) => () => void
  load: (url: string) => void
  play: () => void
  pause: () => void
  seek: (seconds: number) => void
  setRate: (rate: number) => void
  release: () => void
}

export function createVoicePlaybackEngine(handlers: VoicePlaybackHandlers): VoicePlaybackEngine {
  let audio: HTMLAudioElement | null = null
  let activeUrl: string | null = null
  let playRequest = 0
  const preloaded = new Map<string, { element: HTMLAudioElement; leases: number }>()
  const maxPreloaded = 3

  const dispose = (element: HTMLAudioElement) => {
    element.pause()
    element.removeAttribute("src")
    element.load()
  }

  const createAudio = (): HTMLAudioElement => {
    const element = new Audio()
    element.preload = "metadata"
    const report = () =>
      audio === element && handlers.onProgress(element.currentTime * 1000, (element.duration || 0) * 1000)
    element.addEventListener("loadedmetadata", report)
    element.addEventListener("timeupdate", report)
    element.addEventListener("playing", () => audio === element && handlers.onPlaying?.())
    element.addEventListener("waiting", () => audio === element && handlers.onWaiting?.())
    element.addEventListener("ended", () => audio === element && handlers.onEnded())
    element.addEventListener("error", () => audio === element && handlers.onError())
    return element
  }

  const evictOldestPreload = () => {
    while (preloaded.size > maxPreloaded) {
      const oldest = preloaded.entries().next().value as
        | [string, { element: HTMLAudioElement; leases: number }]
        | undefined
      if (!oldest) return
      preloaded.delete(oldest[0])
      if (oldest[1].element !== audio) dispose(oldest[1].element)
    }
  }

  return {
    preload(url) {
      if (!url || activeUrl === url) return () => {}
      let entry = preloaded.get(url)
      if (entry) {
        entry.leases += 1
        // Refresh insertion order so the most recently visible note is kept.
        preloaded.delete(url)
        preloaded.set(url, entry)
      } else {
        const element = createAudio()
        entry = { element, leases: 1 }
        preloaded.set(url, entry)
        element.src = url
        element.load()
        evictOldestPreload()
      }

      let released = false
      return () => {
        if (released) return
        released = true
        const current = preloaded.get(url)
        if (!current || current !== entry) return
        current.leases = Math.max(0, current.leases - 1)
        if (current.leases === 0) {
          preloaded.delete(url)
          if (current.element !== audio) dispose(current.element)
        }
      }
    },
    load(url) {
      if (audio && activeUrl === url) return
      playRequest += 1
      const previous = audio
      audio = null
      activeUrl = null
      if (previous) dispose(previous)

      const warmed = preloaded.get(url)
      if (warmed) {
        preloaded.delete(url)
        audio = warmed.element
        activeUrl = url
        handlers.onProgress(audio.currentTime * 1000, (audio.duration || 0) * 1000)
      } else {
        const element = createAudio()
        audio = element
        activeUrl = url
        element.src = url
        element.load()
      }
    },
    play() {
      // Autoplay is only allowed from a user gesture; every caller is a tap.
      const element = audio
      if (!element) return
      const request = ++playRequest
      void element.play().catch((error: unknown) => {
        if (audio === element && playRequest === request) handlers.onError(error)
      })
    },
    pause() {
      playRequest += 1
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
      playRequest += 1
      const previous = audio
      audio = null
      activeUrl = null
      if (previous) dispose(previous)
      for (const entry of preloaded.values()) dispose(entry.element)
      preloaded.clear()
    },
  }
}
