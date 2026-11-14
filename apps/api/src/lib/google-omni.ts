// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Google Gemini Omni, through the Interactions API.
 *
 * Omni is not a chat model and has no `:predict` shape: it is one
 * `POST /v1beta/interactions` call (the same endpoint Lyria uses) whose result
 * is a job you poll with `GET /v1beta/interactions/{id}`. Because the call is
 * long — minutes for a 1080p clip — every submit asks for `background: true`,
 * which is what makes the poll in `GET /ai/v1/videos/:id` possible at all.
 *
 * One model id serves every mode. `previous_interaction_id` turns a generation
 * into a follow-up turn on an earlier clip (edit, extend, or re-render at a
 * higher resolution — Google documents 1080p/4K only as a generation-time
 * option, so that is how a 360p draft is "upscaled"). A stored interaction is
 * kept 55 days on the paid tier, which is why Omni jobs live longer in the
 * video job store than Higgsfield's.
 *
 * Billing is by usage tokens the interaction reports, so the reader here is the
 * one the cost calculation depends on: `readOmniUsage` never invents a number.
 */

import { googleApiBase } from './lyria'

/** A 1080p clip renders in minutes; the docs allow up to 15 s of output. */
export const OMNI_TIMEOUT_MS = 600_000

/** Modes Google documents for `generation_config.video_config.task`. */
export const OMNI_TASKS = [
  'text_to_video',
  'image_to_video',
  'reference_to_video',
  'edit',
  'extend',
] as const
export type OmniTask = (typeof OMNI_TASKS)[number]

/** One content block in a model step. Video blocks carry `data` (base64) or `uri`. */
export interface OmniContentBlock {
  type?: string
  text?: string
  data?: string
  uri?: string
  mime_type?: string
}

export interface OmniInteraction {
  id?: string
  status?: string
  error?: { code?: number; message?: string; status?: string }
  steps?: Array<{ type?: string; content?: OmniContentBlock[] }>
  output_text?: string
  usage?: OmniUsage
}

/**
 * Token accounting. Google reports the output split by modality, which is the
 * only way to bill video output at its own rate instead of the cheaper text
 * rate; `output_tokens_by_modality` is therefore preferred over
 * `total_output_tokens` whenever both are present.
 */
export interface OmniUsage {
  total_input_tokens?: number
  total_output_tokens?: number
  total_thought_tokens?: number
  total_tokens?: number
  output_tokens_by_modality?: Record<string, number>
}

/** An upstream failure, carrying the status and body the callers report. */
export class OmniError extends Error {
  readonly status: number
  readonly bodyText: string

  constructor(message: string, status: number, bodyText: string) {
    super(message)
    this.name = 'OmniError'
    this.status = status
    this.bodyText = bodyText
  }
}

export interface OmniRequestInput {
  /** Upstream model id (`gemini-omni-1.2-flash`) — never the catalog id. */
  apiModel: string
  prompt: string
  /** Reference / start images as data URIs or https URLs; inlined by the builder. */
  images?: string[]
  resolution?: string
  aspectRatio?: string
  duration?: number
  task?: OmniTask
  /** Continue from an earlier interaction: upscale, edit or extend it. */
  previousInteractionId?: string
  /** Documented fields, passed through untouched. */
  options?: Record<string, unknown>
}

interface OmniImageBlock {
  type: 'image'
  data: string
  mime_type: string
}

/**
 * An image the caller passed as a data URI or an https URL, as the inline block
 * Omni expects. A URL is fetched and inlined: the API takes bytes, not links,
 * and the fetch happens server-side so the key never travels with it.
 */
export async function omniImageBlock(ref: string, signal?: AbortSignal): Promise<OmniImageBlock> {
  if (ref.startsWith('data:')) {
    const match = /^data:([^;,]+)(?:;base64)?,(.*)$/s.exec(ref)
    if (!match) throw new OmniError('Image data URI is malformed.', 400, '')
    const [, mimeType, payload] = match
    const data = ref.includes(';base64,') ? payload : Buffer.from(decodeURIComponent(payload)).toString('base64')
    return { type: 'image', data, mime_type: mimeType }
  }
  if (/^https:\/\//i.test(ref)) {
    const response = await fetch(ref, { signal })
    if (!response.ok) {
      throw new OmniError(`Could not fetch image ${ref} (${response.status}).`, response.status, '')
    }
    const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0]
    const data = Buffer.from(await response.arrayBuffer()).toString('base64')
    return { type: 'image', data, mime_type: mimeType }
  }
  throw new OmniError('Images must be data URIs or https URLs.', 400, '')
}

/**
 * The request body for one Omni call. Caller options go first so `model`,
 * `input` and `response_format` cannot be redirected to a different model or
 * resolution than the one we bill for (same rule as Lyria).
 *
 * `background` and `store` are always on together: `store:false` breaks both
 * `previous_interaction_id` and `background`, so neither is caller-controlled.
 */
export function buildOmniRequest(
  input: OmniRequestInput,
  images: OmniImageBlock[] = [],
): Record<string, unknown> {
  const { apiModel, prompt, resolution, aspectRatio, duration, task, previousInteractionId, options } = input
  const responseFormat: Record<string, unknown> = { type: 'video' }
  if (aspectRatio) responseFormat.aspect_ratio = aspectRatio
  if (resolution) responseFormat.resolution = resolution
  if (duration !== undefined) responseFormat.duration = `${duration}s`

  return {
    ...(options ?? {}),
    model: apiModel,
    input: images.length > 0
      ? [{ type: 'text', text: prompt } as const, ...images]
      : prompt,
    response_format: responseFormat,
    ...(task ? { generation_config: { video_config: { task } } } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    background: true,
    store: true,
  }
}

/** Largest image count Google accepts on one request. */
export const OMNI_MAX_IMAGES = 6

/**
 * What an upscale turn says. Google has no upscale endpoint — 1080p/4K are
 * generation-time options — so asking for the higher resolution again on the
 * parent interaction is the only way to get one, and this instruction is what
 * asks it to re-render rather than re-imagine the clip.
 */
export const OMNI_UPSCALE_INSTRUCTION =
  'Re-render this exact video at the requested resolution; keep every frame, motion, timing and the audio unchanged.'

/** Longest clip a chain of turns may reach (`extend` adds 3–10 s per turn). */
export const OMNI_MAX_TOTAL_SECONDS = 30

function omniUrl(path: string): string {
  return `${googleApiBase()}/v1beta/interactions${path}`
}

/** Google returns the interaction bare or wrapped in a one-element list. */
function unwrapInteraction(payload: unknown): OmniInteraction {
  const value = Array.isArray(payload) ? payload[0] : payload
  if (!value || typeof value !== 'object') {
    throw new OmniError('Google returned no interaction.', 502, '')
  }
  return value as OmniInteraction
}

export function mapOmniStatus(status: string | undefined): 'queued' | 'in_progress' | 'completed' | 'failed' {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed'
    case 'queued':
    case 'pending':
      return 'queued'
    default:
      return 'in_progress'
  }
}

/** Submit one Omni interaction. Throws {@link OmniError} on an upstream rejection. */
export async function submitOmni(
  apiKey: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<OmniInteraction> {
  const response = await fetch(omniUrl(''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(OMNI_TIMEOUT_MS),
  })
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new OmniError(
      `Google video error (${response.status}): ${bodyText.slice(0, 500)}`,
      response.status,
      bodyText,
    )
  }
  return unwrapInteraction(await response.json())
}

/** Poll one interaction. `GET` always returns the video inline as base64. */
export async function getOmniInteraction(
  apiKey: string,
  id: string,
  signal?: AbortSignal,
): Promise<OmniInteraction> {
  const response = await fetch(omniUrl(`/${encodeURIComponent(id)}`), {
    headers: { 'x-goog-api-key': apiKey },
    signal: signal ?? AbortSignal.timeout(OMNI_TIMEOUT_MS),
  })
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new OmniError(
      `Google video status error (${response.status}): ${bodyText.slice(0, 500)}`,
      response.status,
      bodyText,
    )
  }
  return unwrapInteraction(await response.json())
}

/**
 * Walk the steps rather than trusting a convenience field: a turn can carry
 * text alongside the video, and the docs warn the flattened fields do not cover
 * every part.
 */
export function readOmniVideo(
  interaction: OmniInteraction,
): { data?: string; uri?: string; mimeType: string } | undefined {
  for (const step of interaction.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type !== 'video') continue
      if (typeof block.data === 'string' && block.data.length > 0) {
        return { data: block.data, mimeType: block.mime_type || 'video/mp4' }
      }
      if (typeof block.uri === 'string' && block.uri.length > 0) {
        return { uri: block.uri, mimeType: block.mime_type || 'video/mp4' }
      }
    }
  }
  return undefined
}

/** Any text the turn produced (a safety refusal, a note), for the failed path. */
export function readOmniText(interaction: OmniInteraction): string | undefined {
  const parts: string[] = []
  for (const step of interaction.steps ?? []) {
    for (const block of step.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
  }
  if (parts.length > 0) return parts.join('\n\n')
  return interaction.output_text?.trim() || undefined
}

/**
 * Tokens the turn is billed for. `undefined` when Google reported no usage
 * block at all — the caller falls back to the rate card rather than billing
 * zero.
 */
export function readOmniUsage(interaction: OmniInteraction): OmniUsage | undefined {
  const usage = interaction.usage
  if (!usage || typeof usage !== 'object') return undefined
  const fields: Array<keyof OmniUsage> = [
    'total_input_tokens',
    'total_output_tokens',
    'total_thought_tokens',
    'total_tokens',
    'output_tokens_by_modality',
  ]
  const present = fields.some((field) => usage[field] !== undefined)
  return present ? usage : undefined
}
