// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Device checks outside a call, for the pre-join preview and the settings
 * sheet: list mics, cameras and speakers, show your camera, meter your mic.
 * Browser-only; everything resolves to "nothing" on phones, where the call
 * itself picks the devices.
 */
import type { HuddleDevice, HuddleDeviceKind } from './huddle-room'

const hasMedia = () => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.enumerateDevices === 'function'

export const previewSupported = hasMedia() && typeof document !== 'undefined'

/** Devices of one kind. Labels stay blank until the browser has been given access once. */
export async function listLocalDevices(kind: HuddleDeviceKind): Promise<HuddleDevice[]> {
  if (!hasMedia()) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    const noun = kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'
    return all
      .filter((d) => d.kind === kind && d.deviceId)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${noun} ${i + 1}` }))
  } catch {
    return []
  }
}

export function onLocalDevicesChanged(listener: () => void): () => void {
  if (!hasMedia() || !navigator.mediaDevices.addEventListener) return () => {}
  navigator.mediaDevices.addEventListener('devicechange', listener)
  return () => navigator.mediaDevices.removeEventListener('devicechange', listener)
}

export interface Preview {
  stream: MediaStream
  /** Current mic loudness, 0 to 1. */
  level: () => number
  stop: () => void
}

/**
 * Open the chosen camera and mic for a preview. Either can be refused or
 * missing; the preview carries on with whatever it got.
 */
export async function openPreview(opts: { cameraId?: string | null; micId?: string | null; video: boolean; audio: boolean }): Promise<Preview | null> {
  if (!hasMedia() || typeof navigator.mediaDevices.getUserMedia !== 'function') return null
  const constraints: MediaStreamConstraints = {
    video: opts.video ? (opts.cameraId ? { deviceId: { exact: opts.cameraId } } : true) : false,
    audio: opts.audio ? (opts.micId ? { deviceId: { exact: opts.micId } } : true) : false,
  }
  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints)
  } catch {
    // One of the two may be unavailable: try each on its own before giving up.
    const parts: MediaStream[] = []
    for (const key of ['video', 'audio'] as const) {
      if (!constraints[key]) continue
      try {
        parts.push(await navigator.mediaDevices.getUserMedia({ [key]: constraints[key] }))
      } catch {
        // Leave this one out.
      }
    }
    if (parts.length) stream = new MediaStream(parts.flatMap((p) => p.getTracks()))
  }
  if (!stream) return null

  let analyser: AnalyserNode | null = null
  let ctx: AudioContext | null = null
  if (stream.getAudioTracks().length) {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx = new Ctor()
      analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      ctx.createMediaStreamSource(stream).connect(analyser)
    } catch {
      analyser = null
    }
  }
  const buffer = analyser ? new Uint8Array(analyser.fftSize) : null
  const open = stream
  return {
    stream: open,
    level: () => {
      if (!analyser || !buffer) return 0
      analyser.getByteTimeDomainData(buffer)
      let peak = 0
      for (const v of buffer) peak = Math.max(peak, Math.abs(v - 128))
      return Math.min(1, peak / 64)
    },
    stop: () => {
      for (const t of open.getTracks()) t.stop()
      void ctx?.close().catch(() => {})
    },
  }
}

/** A short beep through the chosen speaker, so you can tell it works. */
export async function playTestTone(speakerId?: string | null): Promise<void> {
  if (typeof window === 'undefined') return
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return
  const ctx = new Ctor()
  const sink = (ctx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId
  if (speakerId && sink) await sink.call(ctx, speakerId).catch(() => {})
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.08
  osc.frequency.value = 660
  osc.connect(gain).connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.4)
  osc.onended = () => void ctx.close().catch(() => {})
}

/** Shrink a picked image to a 1280-wide JPEG data URL, small enough to remember on this device and load without network. */
export async function imageToBackgroundDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / bitmap.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', 0.85)
}
