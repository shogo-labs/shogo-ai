// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Vision fallback for text-only models.
 *
 * SHO-41 taught the loop to *say* when it cannot show an image ("Image
 * omitted … do not describe or guess"), which is honest but leaves the agent
 * blind: the screenshot is on disk and the model cannot look at it. This
 * module buys sight instead — the image goes to a catalog-picked
 * vision-capable model, one shot, and the description is inlined as text where
 * the image block used to be.
 *
 * Constraints (card SHO-58):
 * - **No hardcoded model id.** The describing model is picked from
 *   `MODEL_CATALOG` at runtime: same provider first, current generation before
 *   legacy, economy before standard/premium.
 * - **Bounded.** At most `maxImagesPerRun` (3) distinct images are described
 *   per run, each under `maxImageBytes` (5 MB), one describe call per distinct
 *   image.
 * - **Byte-stable.** Results *and* failures are cached by the sha256 of the
 *   image payload, so every `transformContext` pass of the same turn emits the
 *   same bytes — the prompt-cache prefix must not shift.
 * - **Never worse than before.** Anything missing — no vision model, no API
 *   key, over the cap, over the size limit, a failed call — degrades to
 *   SHO-41's note verbatim plus one `MODEL_VISION_UNAVAILABLE` log line.
 * - **No recursion.** A describe call is a single `completeSimple`: no
 *   streaming, no tools, no loop.
 */

import { completeSimple, type ImageContent, type Message } from '@mariozechner/pi-ai'
import { MODEL_CATALOG, type ModelEntry, type ModelGeneration, type ModelTier } from './model-catalog'
import { resolveApiKey, resolveModel } from './pi-adapter'

export interface ImageDescription {
  /** Catalog id of the model that produced the description. */
  modelId: string
  provider: string
  text: string
  /** Decoded size of the image that was sent. */
  bytes: number
  ms: number
}

/** Why an image was not described. Logged as `reason=` and folded into the note. */
export type VisionSkipReason =
  | 'no-vision-model'
  | 'no-api-key'
  | 'cap-reached'
  | 'too-large'
  | 'unsupported-format'
  | 'describe-failed'

export type DescribeOutcome =
  | { ok: true; description: ImageDescription }
  | { ok: false; reason: VisionSkipReason }

export interface VisionModel {
  provider: string
  modelId: string
}

export interface VisionFallbackOptions {
  /** Pin the describing model (catalog id, or `provider:id`). Default: catalog pick. */
  model?: string
  /** Max images described per loop run. Default 3. */
  maxImagesPerRun?: number
  /** Skip any image whose decoded payload exceeds this. Default 5 MB. */
  maxImageBytes?: number
  /** Total budget for one describe call. Default 20_000 ms. */
  timeoutMs?: number
  /** Test seam — no network, no billing. */
  describeFn?: (image: ImageContent, ctx: DescribeContext) => Promise<string | null>
}

/** What the describe call needs to know about the turn that hit the text-only model. */
export interface DescribeContext {
  /** Provider/model of the loop that cannot take images. */
  provider: string
  modelId: string
  /** The loop's API key, reused when the vision provider is the same provider. */
  apiKey?: string
  /** Loop `extraHeaders` (e.g. `x-chat-session-id`), forwarded so billing still lands. */
  extraHeaders?: Record<string, string>
  /** Turn abort signal — the describe call is cancelled with the turn. */
  signal?: AbortSignal
}

export interface VisionDescriber {
  describe(image: ImageContent, ctx: DescribeContext): Promise<DescribeOutcome>
  /** Per-run counters, for tests and telemetry. */
  stats(): { described: number; skipped: number; failed: number }
}

const DEFAULT_MAX_IMAGES_PER_RUN = 3
const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_DESCRIPTION_CHARS = 1_500
const DESCRIBE_MAX_TOKENS = 500

const SUPPORTED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const TIER_RANK: Record<ModelTier, number> = { economy: 0, standard: 1, premium: 2 }
const GENERATION_RANK: Record<ModelGeneration, number> = { current: 0, legacy: 1 }

export const DESCRIBE_SYSTEM_PROMPT =
  'Describe what is visibly in this image: layout and regions, any text verbatim where legible, ' +
  'colours/borders, and anything that looks broken, empty, clipped or overlapping. ' +
  'Do not speculate about intent or about what is off-screen.'

export const DESCRIBE_USER_PROMPT = 'Describe this image for an agent that cannot see it. Be concrete and brief.'

/**
 * Normalize the loop's `visionFallback` option. `false` — explicitly, or via
 * the `SHOGO_VISION_FALLBACK=0` / `false` / `off` kill switch — restores exactly
 * the pre-SHO-58 note-only behaviour.
 */
export function resolveVisionFallbackOptions(options?: VisionFallbackOptions | false): VisionFallbackOptions | false {
  if (options === false) return false
  const killSwitch = process.env.SHOGO_VISION_FALLBACK
  if (killSwitch === '0' || killSwitch === 'false' || killSwitch === 'off') return false
  return options ?? {}
}

function modelTakesImages(provider: string, modelId: string): boolean {
  try {
    const model = resolveModel(provider, modelId)
    const input = (model as { input?: unknown }).input
    return Array.isArray(input) && (input as string[]).includes('image')
  } catch {
    return false
  }
}

/** Parse a `provider:id` / bare-catalog-id override into a vision model. */
function parseModelOverride(override: string, preferredProvider: string): VisionModel | null {
  const trimmed = override.trim()
  if (!trimmed) return null
  const catalogEntry = (MODEL_CATALOG as Record<string, ModelEntry>)[trimmed]
  if (catalogEntry) return { provider: catalogEntry.provider, modelId: catalogEntry.id }
  const sep = trimmed.indexOf(':')
  if (sep > 0) return { provider: trimmed.slice(0, sep), modelId: trimmed.slice(sep + 1) }
  return { provider: preferredProvider, modelId: trimmed }
}

/**
 * Every catalog chat model that advertises image input, best first:
 * same provider as the active loop → current generation → economy.
 */
export function rankVisionModels(preferredProvider: string): VisionModel[] {
  const candidates: Array<{ entry: ModelEntry; sameProvider: boolean }> = []
  for (const entry of Object.values(MODEL_CATALOG) as ModelEntry[]) {
    if ((entry.kind ?? 'chat') !== 'chat') continue
    if (!modelTakesImages(entry.provider, entry.id)) continue
    candidates.push({ entry, sameProvider: entry.provider === preferredProvider })
  }
  candidates.sort(
    (a, b) =>
      Number(b.sameProvider) - Number(a.sameProvider) ||
      GENERATION_RANK[a.entry.generation] - GENERATION_RANK[b.entry.generation] ||
      TIER_RANK[a.entry.tier] - TIER_RANK[b.entry.tier] ||
      a.entry.id.localeCompare(b.entry.id),
  )
  return candidates.map(({ entry }) => ({ provider: entry.provider, modelId: entry.id }))
}

/**
 * Pick the model that describes images for this run. Override order:
 * `opts.override` → `SHOGO_VISION_FALLBACK_MODEL` → catalog rank.
 * Returns `null` when no catalog chat entry takes image input at all (today: a
 * provider like `xai`, which has none) — the caller degrades to today's note.
 */
export function resolveVisionModel(opts: { preferredProvider: string; override?: string }): VisionModel | null {
  const override = opts.override ?? process.env.SHOGO_VISION_FALLBACK_MODEL
  if (override) {
    const parsed = parseModelOverride(override, opts.preferredProvider)
    if (parsed && modelTakesImages(parsed.provider, parsed.modelId)) return parsed
  }
  return rankVisionModels(opts.preferredProvider)[0] ?? null
}

/** Decoded byte length of a base64 payload, without decoding it. */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  let out = ''
  for (const byte of new Uint8Array(digest)) out += byte.toString(16).padStart(2, '0')
  return out
}

function trimDescription(text: string): string {
  const collapsed = text.trim()
  return collapsed.length <= MAX_DESCRIPTION_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`
}

/** The API key a describe call should use, preferring the loop's own. */
function keyForVisionModel(vision: VisionModel, ctx: DescribeContext): string | undefined {
  if (vision.provider === ctx.provider) return ctx.apiKey ?? resolveApiKey(vision.provider)
  return resolveApiKey(vision.provider)
}

/**
 * One-shot describe call against a vision model. Throws on provider failure;
 * `createVisionDescriber` turns that into `describe-failed`.
 */
export async function describeImage(
  image: ImageContent,
  ctx: DescribeContext & { vision?: VisionModel; timeoutMs?: number },
): Promise<ImageDescription> {
  const vision = ctx.vision ?? resolveVisionModel({ preferredProvider: ctx.provider })
  if (!vision) throw new Error(`no vision-capable model for provider ${ctx.provider}`)

  const apiKey = keyForVisionModel(vision, ctx)
  if (!apiKey) throw new Error(`no API key for vision provider ${vision.provider}`)

  let model = resolveModel(vision.provider, vision.modelId)
  if (ctx.extraHeaders && Object.keys(ctx.extraHeaders).length > 0) {
    model = { ...model, headers: { ...(model.headers || {}), ...ctx.extraHeaders } }
  }

  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = ctx.signal
    ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs)

  const startedAt = Date.now()
  const response = await completeSimple(
    model,
    {
      systemPrompt: DESCRIBE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: DESCRIBE_USER_PROMPT }, image],
          timestamp: Date.now(),
        } as Message,
      ],
    },
    { apiKey, maxTokens: DESCRIBE_MAX_TOKENS, signal, headers: model.headers },
  )

  if (response.stopReason === 'error') throw new Error(response.errorMessage || 'describe call failed')

  const text = trimDescription(
    response.content
      .filter((block) => block.type === 'text' && typeof (block as { text?: string }).text === 'string')
      .map((block) => (block as { text: string }).text)
      .join('\n'),
  )
  if (!text) throw new Error('describe call returned no text')

  return {
    modelId: vision.modelId,
    provider: vision.provider,
    text,
    bytes: base64Bytes(image.data),
    ms: Date.now() - startedAt,
  }
}

/**
 * Run-scoped describer: sha256 cache (so repeated `transformContext` passes are
 * byte-stable), per-run cap, one log line per distinct outcome.
 */
export function createVisionDescriber(
  opts: VisionFallbackOptions & { log?: (line: string) => void },
): VisionDescriber {
  const log = opts.log ?? ((line: string) => console.warn(line))
  const maxImages = opts.maxImagesPerRun ?? DEFAULT_MAX_IMAGES_PER_RUN
  const maxBytes = opts.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cache = new Map<string, DescribeOutcome>()
  const visionByProvider = new Map<string, VisionModel | null>()
  const loggedReasons = new Set<VisionSkipReason>()
  let described = 0
  let skipped = 0
  let failed = 0

  function visionFor(provider: string): VisionModel | null {
    if (!visionByProvider.has(provider)) {
      visionByProvider.set(provider, resolveVisionModel({ preferredProvider: provider, override: opts.model }))
    }
    return visionByProvider.get(provider) ?? null
  }

  function unavailable(reason: VisionSkipReason, ctx: DescribeContext, extra = ''): DescribeOutcome {
    if (!loggedReasons.has(reason)) {
      loggedReasons.add(reason)
      log(`MODEL_VISION_UNAVAILABLE for=${ctx.modelId} reason=${reason}${extra}`)
    }
    skipped += 1
    return { ok: false, reason }
  }

  return {
    async describe(image: ImageContent, ctx: DescribeContext): Promise<DescribeOutcome> {
      if (!image?.data) return unavailable('unsupported-format', ctx)
      if (!SUPPORTED_MIME_TYPES.has(String(image.mimeType).toLowerCase())) {
        return unavailable('unsupported-format', ctx)
      }
      const bytes = base64Bytes(image.data)
      if (bytes > maxBytes) return unavailable('too-large', ctx)

      const key = await sha256Hex(image.data)
      const cached = cache.get(key)
      if (cached) {
        skipped += 1
        return cached
      }

      if (described >= maxImages) {
        const outcome = unavailable('cap-reached', ctx)
        cache.set(key, outcome)
        return outcome
      }

      const vision = visionFor(ctx.provider)
      if (!vision && !opts.describeFn) {
        const outcome = unavailable('no-vision-model', ctx)
        cache.set(key, outcome)
        return outcome
      }

      const apiKey = vision ? keyForVisionModel(vision, ctx) : undefined
      if (!opts.describeFn && !apiKey) {
        const outcome = unavailable('no-api-key', ctx, ` model=${vision?.modelId ?? 'none'}`)
        cache.set(key, outcome)
        return outcome
      }

      const label = vision?.modelId ?? 'injected'
      const startedAt = Date.now()
      try {
        const text = opts.describeFn
          ? await opts.describeFn(image, ctx)
          : (
              await describeImage(image, {
                ...ctx,
                vision: vision!,
                apiKey,
                timeoutMs,
              })
            ).text

        if (!text || !text.trim()) throw new Error('describe call returned no text')

        const description: ImageDescription = {
          modelId: label,
          provider: vision?.provider ?? ctx.provider,
          text: trimDescription(text),
          bytes,
          ms: Date.now() - startedAt,
        }
        described += 1
        log(
          `MODEL_VISION_FALLBACK model=${label} for=${ctx.modelId} ` +
            `images=1 bytes=${description.bytes} ms=${description.ms}`,
        )
        const outcome: DescribeOutcome = { ok: true, description }
        cache.set(key, outcome)
        return outcome
      } catch (err: unknown) {
        failed += 1
        loggedReasons.add('describe-failed')
        log(
          `MODEL_VISION_UNAVAILABLE for=${ctx.modelId} reason=describe-failed ` +
            `model=${label} error=${err instanceof Error ? err.message : String(err)}`,
        )
        const outcome: DescribeOutcome = { ok: false, reason: 'describe-failed' }
        cache.set(key, outcome)
        return outcome
      }
    },

    stats() {
      return { described, skipped, failed }
    },
  }
}
