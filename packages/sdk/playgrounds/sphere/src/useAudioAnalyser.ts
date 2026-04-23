import { useEffect, useMemo, useRef, useState } from 'react'

export interface UseAudioAnalyserResult {
  playing: boolean
  ready: boolean
  toggle: () => void
  play: () => void
  pause: () => void
  /**
   * Mirrors the `getFrequencyData` contract consumed by `OrganicSphere`.
   * Returns a `Uint8Array` of length `fftSize` (2048 by default) or
   * `null` before the first user-gesture-triggered playback (`AudioContext`
   * construction requires a gesture in most browsers).
   */
  getFrequencyData: () => Uint8Array | null
}

/**
 * Wraps an HTMLAudioElement behind a WebAudio `AnalyserNode` so the
 * playground can drive `OrganicSphere` with the same frequency data it
 * would get from ElevenLabs in production.
 *
 * - Loops the provided audio URL.
 * - Lazily constructs the `AudioContext` on first play (browser policy).
 * - Reuses a single `Uint8Array` buffer for zero-allocation per-frame
 *   frequency reads.
 */
export function useAudioAnalyser(
  src: string,
  { fftSize = 2048 }: { fftSize?: number } = {},
): UseAudioAnalyserResult {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const bufferRef = useRef<Uint8Array | null>(null)

  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)

  // One-time audio element setup.
  useEffect(() => {
    const audio = new Audio(src)
    audio.loop = true
    audio.crossOrigin = 'anonymous'
    audio.preload = 'auto'
    audioRef.current = audio

    const onReady = () => setReady(true)
    const onEnded = () => setPlaying(false)
    const onPause = () => setPlaying(false)
    const onPlay = () => setPlaying(true)

    audio.addEventListener('canplaythrough', onReady)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('play', onPlay)

    return () => {
      audio.removeEventListener('canplaythrough', onReady)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('play', onPlay)
      audio.pause()
      audio.src = ''
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = null
      analyserRef.current = null
      bufferRef.current = null
      audioRef.current = null
    }
  }, [src])

  const ensureGraph = () => {
    if (analyserRef.current) return
    const audio = audioRef.current
    if (!audio) return
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC()
    const source = ctx.createMediaElementSource(audio)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = fftSize
    analyser.smoothingTimeConstant = 0.7
    source.connect(analyser)
    analyser.connect(ctx.destination)
    ctxRef.current = ctx
    analyserRef.current = analyser
    bufferRef.current = new Uint8Array(analyser.frequencyBinCount)
  }

  const play = () => {
    ensureGraph()
    void ctxRef.current?.resume()
    void audioRef.current?.play().catch(() => {})
  }

  const pause = () => {
    audioRef.current?.pause()
  }

  const toggle = () => {
    if (audioRef.current?.paused) play()
    else pause()
  }

  const getFrequencyData = useMemo(() => {
    return () => {
      const analyser = analyserRef.current
      const buf = bufferRef.current
      if (!analyser || !buf) return null
      analyser.getByteFrequencyData(buf)
      return buf
    }
  }, [])

  return { playing, ready, play, pause, toggle, getFrequencyData }
}
