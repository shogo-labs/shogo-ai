// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MP4 box reading with no dependencies.
 *
 * Kept deliberately leaf-shaped (node `Buffer` only) because three unrelated
 * callers need it: the media tools (billing an edit by source duration),
 * `read_file` (how densely a clip can be sampled) and chat attachments (the
 * frame count shown on an `[Attached Video]` line). Anything with a subprocess
 * behind it — ffprobe — lives in `video-retime.ts` instead.
 */

/** Walk a byte range looking for one box by type. */
export function findBox(buffer: Buffer, type: string, from: number, to: number): { payload: number; end: number } | null {
  let offset = from
  while (offset + 8 <= to) {
    const size = buffer.readUInt32BE(offset)
    if (size < 8) return null
    const kind = buffer.toString('ascii', offset + 4, offset + 8)
    const end = Math.min(offset + size, to)
    if (kind === type) return { payload: offset + 8, end }
    offset = end
  }
  return null
}

/** Every box of a type inside a byte range (moov carries one `trak` per track). */
export function findAllBoxes(buffer: Buffer, type: string, from: number, to: number): Array<{ payload: number; end: number }> {
  const found: Array<{ payload: number; end: number }> = []
  let offset = from
  while (offset + 8 <= to) {
    const size = buffer.readUInt32BE(offset)
    if (size < 8) break
    const kind = buffer.toString('ascii', offset + 4, offset + 8)
    const end = Math.min(offset + size, to)
    if (kind === type) found.push({ payload: offset + 8, end })
    offset = end
  }
  return found
}

/**
 * Duration of an MP4, read from its `mvhd` box — the only reliable way to know
 * how many source seconds a Genjutsu edit will be billed for without shelling
 * out to ffprobe. Returns null when the box can't be read (fragmented or
 * non-standard files), and the caller then refuses the edit.
 */
export function readMp4DurationSeconds(buffer: Buffer): number | null {
  const moov = findBox(buffer, 'moov', 0, buffer.length)
  if (!moov) return null
  const mvhd = findBox(buffer, 'mvhd', moov.payload, moov.end)
  if (!mvhd) return null

  const version = buffer[mvhd.payload]
  const timescale = version === 1
    ? buffer.readUInt32BE(mvhd.payload + 20)
    : buffer.readUInt32BE(mvhd.payload + 12)
  const duration = version === 1
    ? Number(buffer.readBigUInt64BE(mvhd.payload + 24))
    : buffer.readUInt32BE(mvhd.payload + 16)
  if (!timescale || !duration) return null
  const seconds = duration / timescale
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null
}

/**
 * Frame count of the *video* track, from `stsz` (the sample-size table).
 *
 * One `stsz` counts one track's samples, and an MP4 with audio carries a
 * second one whose count is audio packets — so the track is picked by its
 * `hdlr` handler type rather than by position.
 */
export function readMp4VideoFrameCount(buffer: Buffer): number | null {
  const moov = findBox(buffer, 'moov', 0, buffer.length)
  if (!moov) return null
  for (const trak of findAllBoxes(buffer, 'trak', moov.payload, moov.end)) {
    const mdia = findBox(buffer, 'mdia', trak.payload, trak.end)
    if (!mdia) continue
    const hdlr = findBox(buffer, 'hdlr', mdia.payload, mdia.end)
    if (!hdlr) continue
    // version(1) + flags(3) + pre_defined(4), then the 4-character handler type.
    if (buffer.toString('ascii', hdlr.payload + 8, hdlr.payload + 12) !== 'vide') continue
    const minf = findBox(buffer, 'minf', mdia.payload, mdia.end)
    if (!minf) continue
    const stbl = findBox(buffer, 'stbl', minf.payload, minf.end)
    if (!stbl) continue
    const stsz = findBox(buffer, 'stsz', stbl.payload, stbl.end)
    if (!stsz) continue
    // version(1) + flags(3) + sample_size(4) + sample_count(4)
    const count = buffer.readUInt32BE(stsz.payload + 8)
    if (count > 0) return count
  }
  return null
}

export interface VideoProbe {
  durationSeconds: number
  /** Frames in the video track, when the container says. */
  sourceFrames: number | null
  /** Frames per second of the source, when both numbers are known. */
  sourceFps: number | null
}

/**
 * Duration and frame rate from the container itself: no ffprobe, no subprocess.
 *
 * Returns null rather than a guess when the boxes cannot be read (fragmented
 * MP4, WebM/MOV variants we do not parse) — the caller then tries ffprobe, and
 * if that is missing too it reports what it knows instead of inventing a rate.
 */
export function readMp4Probe(buffer: Buffer): VideoProbe | null {
  if (buffer.length < 8) return null
  const durationSeconds = readMp4DurationSeconds(buffer)
  if (durationSeconds === null) return null
  const sourceFrames = readMp4VideoFrameCount(buffer)
  return {
    durationSeconds,
    sourceFrames,
    sourceFps: sourceFrames ? sourceFrames / durationSeconds : null,
  }
}
