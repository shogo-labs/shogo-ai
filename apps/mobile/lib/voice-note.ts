// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared maths and formatting for voice notes.
 *
 * Both platform recorders and every player use these, so a clip records the
 * same waveform whichever client captured it, and the player can rebuild that
 * waveform from the stored string without a recorder being involved.
 */

/** Longest clip we record. Five minutes at 64 kbps is roughly 2.4 MB. */
export const MAX_VOICE_NOTE_MS = 5 * 60 * 1000
/** Anything shorter is a mis-tap rather than a message. */
export const MIN_VOICE_NOTE_MS = 700
/** How often the live level is sampled, and how often the meter updates. */
export const LEVEL_SAMPLE_MS = 100
/** Bars a player draws. The recorder stores more and the player resamples. */
export const WAVEFORM_BARS = 32
/** Cap on stored peaks, matching the server's limit. */
export const MAX_WAVEFORM_PEAKS = 256

/**
 * A native level meter reports dBFS: -160 is silence, 0 is clipping. Speech
 * sits around -30..-10, so map a -60..0 window onto 0-100 and clamp.
 */
export function meterToLevel(db: number): number {
  if (!Number.isFinite(db)) return 0
  const clamped = Math.max(-60, Math.min(0, db))
  return Math.round(((clamped + 60) / 60) * 100)
}

/** The web mic has no dB meter, so a level comes from RMS instead. */
export function rmsToLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  return Math.round(Math.min(1, rms * 8) * 100)
}

/**
 * Compress raw samples into `bars` levels, each the loudest sample in its
 * slice. Never upsamples: a two second clip keeps two seconds' worth of
 * detail rather than being stretched into fake bars.
 */
export function downsamplePeaks(samples: number[], bars = WAVEFORM_BARS): number[] {
  if (!samples.length) return []
  const count = Math.min(bars, samples.length)
  const out: number[] = []
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * samples.length) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples.length) / count))
    let peak = 0
    for (let j = start; j < end && j < samples.length; j += 1) peak = Math.max(peak, samples[j])
    out.push(Math.max(0, Math.min(100, Math.round(peak))))
  }
  return out
}

/** Space separated, which is how the server stores and clamps them too. */
export function peaksToString(peaks: number[]): string | null {
  const capped = peaks
    .slice(0, MAX_WAVEFORM_PEAKS)
    .map((peak) => Math.max(0, Math.min(100, Math.round(peak))))
  return capped.length ? capped.join(' ') : null
}

/**
 * The bars a player draws for a message. A clip with no stored peaks — one
 * recorded before this existed, or by a client that couldn't sample — gets a
 * deterministic wave rather than an empty box.
 */
export function waveformBars(peaks: string | null | undefined, bars = WAVEFORM_BARS): number[] {
  const parsed = (peaks ?? '')
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value))
  if (!parsed.length) {
    return Array.from({ length: bars }, (_, i) => 32 + Math.round(20 * Math.abs(Math.sin(i * 1.7))))
  }
  return downsamplePeaks(
    parsed.map((value) => Math.max(0, Math.min(100, value))),
    bars,
  )
}

/** `0:07`, and `1:02:03` only for a clip that actually runs that long. */
export function formatClipDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** Where the playhead sits, 0-1, for a clip of `durationMs`. */
export function playbackProgress(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) return 0
  return Math.max(0, Math.min(1, positionMs / durationMs))
}

/**
 * Where a tap or click landed, as a fraction of the clip. Null when the track
 * has not been measured yet or the event carries no position — the caller
 * ignores the gesture rather than seeking by a guess.
 */
export function seekRatioForTap(x: unknown, width: number): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null
  if (!Number.isFinite(width) || width <= 0) return null
  return Math.max(0, Math.min(1, x / width))
}

/** The one-line label a voice note shows outside its player. */
export function voiceNoteLabel(durationMs: number | null | undefined): string {
  return typeof durationMs === 'number' && durationMs > 0
    ? `🎤 Voice note · ${formatClipDuration(durationMs)}`
    : '🎤 Voice note'
}

/** True when an attachment should render as a voice note rather than a file. */
export function isVoiceNote(attachment: { mimeType?: string | null; name?: string | null }): boolean {
  if ((attachment.mimeType ?? '').toLowerCase().startsWith('audio/')) return true
  return /\.(m4a|mp3|aac|wav|ogg|oga|opus|webm)$/i.test(attachment.name ?? '')
}

/** The second line a conversation list shows for a message that carries no text. */
export function voiceNotePreview(
  attachments: Array<{ mimeType?: string | null; name?: string | null; durationMs?: number | null }> | null | undefined,
): string {
  const note = (attachments ?? []).find((attachment) => isVoiceNote(attachment))
  return note ? voiceNoteLabel(note.durationMs) : ''
}
