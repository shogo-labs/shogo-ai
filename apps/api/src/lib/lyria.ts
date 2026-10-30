// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Google Lyria, through the Interactions API.
 *
 * Two routes generate music and both must speak exactly the same contract: the
 * AI gateway (`POST /ai/v1/music/generations`, billed per song) and hosted
 * voice media (`POST /api/voice/music`, metered per second). Keeping the
 * request shape and the response reader here means a documented field added to
 * one is added to the other, instead of drifting into two slightly different
 * calls to the same upstream.
 *
 * Lyria is not a chat model and does not live on chat completions: Gemini
 * serves it on `POST /v1beta/interactions`, which renders the audio inline as
 * base64 blocks instead of returning a job to poll. One call, one track.
 */

/** A full song renders in a minute or two; a 30-second clip in seconds. */
export const LYRIA_TIMEOUT_MS = 240_000

export interface LyriaAudioBlock {
  mimeType: string
  data: string
}

export interface LyriaInteraction {
  id?: string
  output_text?: string
  output_audio?: { data?: string; mime_type?: string } | Array<{ data?: string; mime_type?: string }>
  steps?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string; data?: string; mime_type?: string }>
  }>
}

/** An upstream failure, carrying the status and body the callers report. */
export class LyriaError extends Error {
  readonly status: number
  readonly bodyText: string

  constructor(message: string, status: number, bodyText: string) {
    super(message)
    this.name = 'LyriaError'
    this.status = status
    this.bodyText = bodyText
  }
}

/**
 * Google's Gemini API host. `GOOGLE_BASE_URL` may point at the OpenAI
 * compatibility root (`…/v1beta/openai`, what chat routing expects) or at the
 * bare host; native endpoints such as Lyria's Interactions API need the host.
 */
export function googleApiBase(): string {
  return (process.env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com')
    .replace(/\/$/, '')
    .replace(/\/v1beta(\/openai)?$/, '')
}

/**
 * Lyria has no separate lyrics or instrumental field: both are read from the
 * prompt, lyrics as tagged sections after the style instructions.
 */
export function buildLyriaInput(prompt: string, opts: { lyrics?: string; instrumental?: boolean }): string {
  if (opts.instrumental) return `${prompt}\n\nInstrumental only, no vocals.`
  if (opts.lyrics) return `${prompt}\n\nUse exactly these lyrics:\n${opts.lyrics}`
  return prompt
}

/**
 * Pull the rendered audio (plus any lyrics / timed text) out of an Interactions
 * response. A song with interleaved lyrics returns several content blocks, so
 * this walks the steps instead of trusting the `output_audio` convenience field
 * — the docs warn that the convenience fields do not cover every part.
 */
export function readLyriaOutput(interaction: LyriaInteraction): { audio?: LyriaAudioBlock; text?: string } {
  let audio: LyriaAudioBlock | undefined
  const texts: string[] = []
  for (const step of interaction.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type === 'audio' && typeof block.data === 'string' && block.data.length > 0) {
        audio ??= { mimeType: block.mime_type || 'audio/mpeg', data: block.data }
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        texts.push(block.text.trim())
      }
    }
  }
  if (!audio && interaction.output_audio) {
    const first = Array.isArray(interaction.output_audio) ? interaction.output_audio[0] : interaction.output_audio
    if (first && typeof first.data === 'string' && first.data.length > 0) {
      audio = { mimeType: first.mime_type || 'audio/mpeg', data: first.data }
    }
  }
  const text = texts.length > 0 ? texts.join('\n\n') : interaction.output_text?.trim() || undefined
  return { audio, text }
}

export interface LyriaRequest {
  apiKey: string
  /** Upstream model id, e.g. `lyria-3.5` — never the catalog id. */
  apiModel: string
  prompt: string
  lyrics?: string
  instrumental?: boolean
  /** Documented Interactions fields, passed through untouched. */
  options?: Record<string, unknown>
  signal?: AbortSignal
}

/**
 * One music request. Throws {@link LyriaError} on an upstream rejection so each
 * caller keeps its own error envelope; a 200 with no audio is not thrown here —
 * the caller decides what a silent response means.
 */
export async function generateLyriaMusic(
  request: LyriaRequest,
): Promise<{ interaction: LyriaInteraction; audio?: LyriaAudioBlock; text?: string }> {
  const response = await fetch(`${googleApiBase()}/v1beta/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': request.apiKey },
    body: JSON.stringify({
      // Caller-supplied documented fields first, so model/input can't be
      // redirected to a different model than the one we bill for.
      ...(request.options ?? {}),
      model: request.apiModel,
      input: buildLyriaInput(request.prompt, {
        ...(request.lyrics ? { lyrics: request.lyrics } : {}),
        ...(request.instrumental ? { instrumental: true } : {}),
      }),
    }),
    signal: request.signal ?? AbortSignal.timeout(LYRIA_TIMEOUT_MS),
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new LyriaError(`Google music error (${response.status}): ${bodyText.slice(0, 500)}`, response.status, bodyText)
  }

  const interaction = (await response.json()) as LyriaInteraction
  const { audio, text } = readLyriaOutput(interaction)
  return { interaction, ...(audio ? { audio } : {}), ...(text ? { text } : {}) }
}
