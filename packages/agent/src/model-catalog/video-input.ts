// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The video frame-rate carrier on a content block's MIME string.
 *
 * A model that can be told how densely to sample a clip only accepts that
 * setting on its own wire shape (`videoMetadata` on Google's native
 * `generateContent`). Everything that carries video in this codebase carries
 * it as one `ImageContent` block, and pi-ai serialises that block to
 * `data:${mimeType};base64,${data}` — so a per-block setting has exactly one
 * place it can travel: MIME parameters.
 *
 *   data:video/mp4;fps=10;start=20;end=33;base64,AAAA…
 *
 * The reader (`read_file`) writes those parameters; the AI proxy either turns
 * them into `videoMetadata` (native Gemini) or strips them (every other route,
 * where a `;fps=10` suffix would be an unknown-media-type 400). Both sides
 * therefore share this one parser, so the two can never disagree about the
 * format.
 */

/** Google accepts `videoMetadata.fps` in the open-closed interval (0, 24]. */
export const MAX_VIDEO_FPS = 24

/** Frame settings a caller asked for, in seconds of the source clip. */
export interface VideoFrameSettings {
  fps?: number
  start?: number
  end?: number
}

export interface ParsedVideoMime {
  /** The bare media type, parameters removed: `video/mp4`. */
  mimeType: string
  fps?: number
  start?: number
  end?: number
}

function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Split a MIME string into its media type and any frame settings it carries.
 * Anything malformed is dropped rather than guessed at: no `fps` means "use
 * the provider default", which is always a truthful request.
 */
export function parseVideoMimeType(mimeType: string): ParsedVideoMime {
  const [base, ...params] = mimeType.split(';').map((part) => part.trim())
  const parsed: ParsedVideoMime = { mimeType: base || 'video/mp4' }
  for (const param of params) {
    const eq = param.indexOf('=')
    if (eq === -1) continue
    const key = param.slice(0, eq).trim().toLowerCase()
    const value = numberParam(param.slice(eq + 1).trim())
    if (value === undefined) continue
    if (key === 'fps') {
      const fps = clampVideoFps(value)
      if (fps !== undefined) parsed.fps = fps
    } else if (key === 'start' && value >= 0) {
      parsed.start = value
    } else if (key === 'end' && value >= 0) {
      parsed.end = value
    }
  }
  return parsed
}

/** Drop every parameter, keeping just the media type. */
export function stripVideoMimeParams(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim()
  return base || 'video/mp4'
}

/**
 * Clamp a requested rate into the range a provider documents. `undefined`
 * (rather than 0) for a value that cannot describe a sampling rate, so callers
 * send no setting instead of an invalid one.
 */
export function clampVideoFps(fps: number | undefined): number | undefined {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return undefined
  return Math.min(fps, MAX_VIDEO_FPS)
}

/**
 * Build the MIME string a block travels with. Returns the bare media type when
 * nothing was asked for, so a plain video read is byte-identical to what it
 * was before this existed.
 */
export function buildVideoMimeType(mimeType: string, settings: VideoFrameSettings = {}): string {
  const base = stripVideoMimeParams(mimeType)
  const parts = [base]
  const fps = clampVideoFps(settings.fps)
  if (fps !== undefined) parts.push(`fps=${fps}`)
  if (typeof settings.start === 'number' && Number.isFinite(settings.start) && settings.start > 0) {
    parts.push(`start=${settings.start}`)
  }
  if (typeof settings.end === 'number' && Number.isFinite(settings.end) && settings.end > 0) {
    parts.push(`end=${settings.end}`)
  }
  return parts.join(';')
}

/**
 * Google's `videoMetadata`, from the parameters on a block's MIME string.
 * `undefined` when the caller set nothing — sending no `videoMetadata` keeps
 * Google's own 1 fps default, which is what "no setting" has always meant.
 */
export function toGeminiVideoMetadata(mimeType: string): Record<string, unknown> | undefined {
  const { fps, start, end } = parseVideoMimeType(mimeType)
  if (fps === undefined && start === undefined && end === undefined) return undefined
  const metadata: Record<string, unknown> = {}
  if (fps !== undefined) metadata.fps = fps
  if (start !== undefined) metadata.startOffset = `${start}s`
  if (end !== undefined) metadata.endOffset = `${end}s`
  return metadata
}
