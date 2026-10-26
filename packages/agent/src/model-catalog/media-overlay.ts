// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The hand-written part of the Higgsfield media catalog.
 *
 * Everything an endpoint *accepts* comes from `docs/vendors/higgsfield/catalog.json`,
 * which is derived from the vendor's own docs. This file only carries what the
 * docs do not: which endpoints belong to one model, the display name, one line
 * on when to pick it, and a display-only list price. `scripts/generate-media-catalog.ts`
 * turns this plus the snapshot into `media-catalog.generated.ts`, and
 * `bun run check:higgsfield-docs` fails when:
 *
 *   - an endpoint named here is not in the snapshot (vendor renamed or dropped it),
 *   - a snapshot `video` / `image` endpoint is in no model here (silent omission),
 *   - or a declared reference field is not documented on its endpoint.
 *
 * Prices are the vendor's per-request list price, used only to show a figure
 * before `/estimate` is consulted; billing always uses the free `/estimate`.
 */

export interface OverlayImageModel {
  id: string
  displayName: string
  bestFor: string
  /** Endpoint used for prompt-only requests. */
  apiModel: string
  /** Endpoint used when reference images are supplied, when it differs. */
  editApiModel?: string
  /** Documented field that carries reference images. */
  referenceField?: { name: string; multiple: boolean }
  /**
   * Set when the model's quality vocabulary is not the generic tier order
   * (e.g. Ideogram's `rendering_speed` DEFAULT/QUALITY).
   */
  quality?: { field: string; standard: string; hd: string }
  usdPerRequest?: number
}

export interface OverlayVideoModel {
  id: string
  displayName: string
  bestFor: string
  textToVideoApiModel?: string
  imageToVideoApiModel?: string
  /** Genjutsu-style edit workflow: submits a source clip instead of generating. */
  editApiModel?: string
  genjutsu?: 'motion_transfer' | 'object_swap' | 'restyle'
  minSourceSeconds?: number
  maxSourceSeconds?: number
  minSourcePixels?: number
  maxSourceBytes?: number
  /** Rate card for the per-source-second workflows (`/estimate` returns prose). */
  usdPerSecondByResolution?: Record<string, number>
  /** Reference images the workflow takes, when the endpoint's schema is loose. */
  maxReferenceImages?: number
  usdPerRequest?: number
}

export const HIGGSFIELD_IMAGE_OVERLAY: readonly OverlayImageModel[] = [
  {
    id: 'hf-soul-v2', displayName: 'SOUL V2', apiModel: 'higgsfield-ai/soul/v2/standard',
    bestFor: 'General-purpose default: fast, cheap editorial and product images',
    usdPerRequest: 0.004,
  },
  {
    id: 'hf-soul-standard', displayName: 'SOUL Standard', apiModel: 'higgsfield-ai/soul/standard',
    bestFor: "SOUL's classic editorial look with one style reference",
    referenceField: { name: 'image_reference_url', multiple: false },
    usdPerRequest: 0.094,
  },
  {
    id: 'hf-soul-cinema', displayName: 'SOUL Cinema', apiModel: 'higgsfield-ai/soul/cinema',
    bestFor: 'Cinematic film-still portraits',
    usdPerRequest: 0.004,
  },
  {
    id: 'hf-ideogram-4', displayName: 'Ideogram 4.0', apiModel: 'ideogram/v4.0',
    bestFor: 'Posters, logos and anything with legible text (one style reference)',
    referenceField: { name: 'image_url', multiple: false },
    quality: { field: 'rendering_speed', standard: 'DEFAULT', hd: 'QUALITY' },
    usdPerRequest: 0.060,
  },
  {
    id: 'hf-qwen-image-3', displayName: 'Qwen Image 3', apiModel: 'alibaba/qwen-image-3/text-to-image',
    editApiModel: 'alibaba/qwen-image-3/edit',
    bestFor: 'Legible in-image text and multi-reference edits at 2K (references go to a separate edit endpoint)',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.040,
  },
  {
    id: 'hf-recraft-v4.1', displayName: 'Recraft v4.1', apiModel: 'recraft/v4.1/text-to-image',
    bestFor: 'Vector and brand illustration', usdPerRequest: 0.035,
  },
  {
    id: 'hf-recraft-v4.1-pro', displayName: 'Recraft v4.1 Pro', apiModel: 'recraft/v4.1/pro/text-to-image',
    bestFor: 'Vector and brand illustration at 2K', usdPerRequest: 0.210,
  },
  {
    id: 'hf-recraft-v4.1-utility', displayName: 'Recraft v4.1 Utility', apiModel: 'recraft/v4.1/utility/text-to-image',
    bestFor: 'Flat icons, UI and utility art', usdPerRequest: 0.035,
  },
  {
    id: 'hf-recraft-v4.1-utility-pro', displayName: 'Recraft v4.1 Utility Pro', apiModel: 'recraft/v4.1/utility/pro/text-to-image',
    bestFor: 'Utility art at 2K', usdPerRequest: 0.210,
  },
  {
    id: 'hf-z-image-turbo', displayName: 'Z-Image Turbo', apiModel: 'z-image/turbo',
    bestFor: 'Fastest, cheapest drafts', usdPerRequest: 0.015,
  },
  {
    id: 'hf-marketing-studio', displayName: 'Marketing Studio Image', apiModel: 'marketing-studio/image',
    bestFor: 'Marketing and ad creative (2.0 Alpha)',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.054,
  },
  {
    id: 'hf-marketing-studio-flare', displayName: 'Marketing Studio Flare', apiModel: 'marketing-studio/image/flare',
    bestFor: 'Ad creative where edit precision matters (2.5 Flare, up to 4K)',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.084,
  },
  {
    id: 'hf-marketing-studio-sunburst', displayName: 'Marketing Studio Sunburst', apiModel: 'marketing-studio/image/sunburst',
    bestFor: 'Ad creative on GPT Image 2.5 Sunburst',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.084,
  },
  {
    id: 'hf-grok-image-2', displayName: 'Grok Imagine Image 2', apiModel: 'xai/grok-imagine-image-2.0',
    bestFor: 'Generate and edit in one endpoint',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.060,
  },
  {
    id: 'hf-ads-studio', displayName: 'Ads Studio', apiModel: 'higgsfield/ads-studio/v1.0',
    bestFor: 'Ad variants by audience and niche',
    referenceField: { name: 'image_urls', multiple: true },
    usdPerRequest: 0.084,
  },
  {
    id: 'hf-cinema-studio-4', displayName: 'Cinema Studio 4.0', apiModel: 'higgsfield/cinema-studio/4.0',
    bestFor: 'Directed film stills: camera, lens, era, colour palette, 4–30 s of reference audio',
    referenceField: { name: 'image_urls', multiple: true },
  },
  {
    id: 'hf-kling-o3-image', displayName: 'Kling O3 Image', apiModel: 'kling-video/o3/image-reference',
    bestFor: 'Kling motion-aware image reference with first/last frame control',
    referenceField: { name: 'image_urls', multiple: true },
  },
  {
    id: 'hf-kling-omni-image', displayName: 'Kling Omni Image', apiModel: 'kling-video/omni/image-reference',
    bestFor: 'Kling Omni image reference at std or pro',
    referenceField: { name: 'image_urls', multiple: true },
  },
]

export const HIGGSFIELD_VIDEO_OVERLAY: readonly OverlayVideoModel[] = [
  {
    id: 'hf-hailuo-2.3', displayName: 'Hailuo 2.3 Standard',
    textToVideoApiModel: 'minimax/hailuo-2.3/standard/text-to-video',
    imageToVideoApiModel: 'minimax/hailuo-2.3/standard/image-to-video',
    bestFor: 'The default: cheapest clips for drafts, storyboards and b-roll (fixed 768p)',
    usdPerRequest: 0.07,
  },
  {
    id: 'hf-kling-2.5-pro', displayName: 'Kling 2.5 Turbo Pro',
    textToVideoApiModel: 'kling-video/v2.5-turbo/pro/text-to-video',
    imageToVideoApiModel: 'kling-video/v2.5-turbo/pro/image-to-video',
    bestFor: 'Fluid motion and strong image-to-video when a shot needs more polish than Hailuo',
    usdPerRequest: 0.35,
  },
  {
    id: 'hf-kling-2.5-std', displayName: 'Kling 2.5 Turbo Standard',
    imageToVideoApiModel: 'kling-video/v2.5-turbo/standard/image-to-video',
    bestFor: 'Cheaper Kling 2.5 motion, image-to-video only',
  },
  {
    id: 'hf-wan-2.6', displayName: 'Wan 2.6',
    textToVideoApiModel: 'wan/v2.6/text-to-video',
    imageToVideoApiModel: 'wan/v2.6/image-to-video',
    bestFor: 'Stylized and animated looks up to 15 s, with an explicit resolution tier',
    usdPerRequest: 0.4,
  },
  {
    id: 'hf-wan-2.7', displayName: 'Wan 2.7',
    textToVideoApiModel: 'wan/v2.7/text-to-video',
    imageToVideoApiModel: 'wan/v2.7/image-to-video',
    bestFor: 'Wan 2.7 shots with an audio bed or first/last frames',
  },
  {
    id: 'hf-wan-3.0', displayName: 'Wan 3.0',
    textToVideoApiModel: 'alibaba/wan-3.0/text-to-video',
    imageToVideoApiModel: 'alibaba/wan-3.0/image-to-video',
    bestFor: 'Wan 3.0 with native audio and up to 30 s',
  },
  {
    id: 'hf-wan-3.0-prime', displayName: 'Wan 3.0 Prime',
    textToVideoApiModel: 'alibaba/wan-3.0-prime/text-to-video',
    imageToVideoApiModel: 'alibaba/wan-3.0-prime/image-to-video',
    bestFor: "Wan's best motion and prompt following, with native audio",
  },
  {
    id: 'hf-happy-horse', displayName: 'Happy Horse 1.0',
    textToVideoApiModel: 'alibaba/happy-horse/text-to-video',
    imageToVideoApiModel: 'alibaba/happy-horse/image-to-video',
    bestFor: 'Cheap Alibaba text/image-to-video at 720p or 1080p',
  },
  {
    id: 'hf-happy-horse-1.1', displayName: 'HappyHorse 1.1',
    textToVideoApiModel: 'alibaba/happy-horse/v1.1/text-to-video',
    imageToVideoApiModel: 'alibaba/happy-horse/v1.1/image-to-video',
    bestFor: 'HappyHorse 1.1, 1080p by default',
  },
  {
    id: 'hf-seedance-2.0', displayName: 'Seedance 2.0',
    textToVideoApiModel: 'bytedance/seedance-2.0/text-to-video',
    imageToVideoApiModel: 'bytedance/seedance-2.0/image-to-video',
    bestFor: 'ByteDance shots with native audio, 480p to 4K',
  },
  {
    id: 'hf-seedance-2.5', displayName: 'Seedance 2.5',
    textToVideoApiModel: 'bytedance/seedance-2.5/text-to-video',
    imageToVideoApiModel: 'bytedance/seedance-2.5/image-to-video',
    bestFor: 'Seedance 2.5: up to 30 s, first/last frames, native audio',
  },
  {
    id: 'hf-kling-2.6-pro', displayName: 'Kling 2.6 Pro',
    textToVideoApiModel: 'kling-video/v2.6/pro/text-to-video',
    imageToVideoApiModel: 'kling-video/v2.6/pro/image-to-video',
    bestFor: 'Kling 2.6 Pro with native sound on',
  },
  {
    id: 'hf-kling-3.0-turbo', displayName: 'Kling 3.0 Turbo',
    textToVideoApiModel: 'kling-video/v3.0-turbo/text-to-video',
    imageToVideoApiModel: 'kling-video/v3.0-turbo/image-to-video',
    bestFor: 'Kling 3.0 Turbo: fast 3–15 s clips',
  },
  {
    id: 'hf-kling-3.0-std', displayName: 'Kling 3.0 Standard',
    textToVideoApiModel: 'kling-video/v3.0/std/text-to-video',
    imageToVideoApiModel: 'kling-video/v3.0/std/image-to-video',
    bestFor: 'Kling 3.0 Standard: 3–15 s, native sound, multi-shot, best price/quality for talking shots',
  },
  {
    id: 'hf-kling-3.0-pro', displayName: 'Kling 3.0 Pro',
    textToVideoApiModel: 'kling-video/v3.0/pro/text-to-video',
    imageToVideoApiModel: 'kling-video/v3.0/pro/image-to-video',
    bestFor: 'Kling 3.0 Pro: multi-shot, last-frame control and native sound at the top tier',
  },
  {
    id: 'hf-kling-3.0-4k', displayName: 'Kling 3.0 4K',
    textToVideoApiModel: 'kling-video/v3.0/4k/text-to-video',
    imageToVideoApiModel: 'kling-video/v3.0/4k/image-to-video',
    bestFor: 'Kling 3.0 rendered at 4K',
  },
  {
    id: 'hf-ltx-2.5-fast', displayName: 'LTX-2.5 Fast',
    textToVideoApiModel: 'lightricks/ltx-2.5/text-to-video/fast',
    imageToVideoApiModel: 'lightricks/ltx-2.5/image-to-video/fast',
    bestFor: 'Cheap Higgsfield text-to-video that takes an aspect_ratio and generates audio',
    usdPerRequest: 0.2,
  },
  {
    id: 'hf-ltx-2.5-pro', displayName: 'LTX-2.5 Pro',
    textToVideoApiModel: 'lightricks/ltx-2.5/text-to-video/pro',
    imageToVideoApiModel: 'lightricks/ltx-2.5/image-to-video/pro',
    bestFor: 'LTX-2.5 at higher fidelity, with camera-movement control',
  },
  {
    id: 'hf-minimax-h3', displayName: 'MiniMax H3',
    textToVideoApiModel: 'minimax/h3/text-to-video',
    imageToVideoApiModel: 'minimax/h3/image-to-video',
    bestFor: 'MiniMax H3 at 2K, 5–15 s',
  },
  {
    id: 'hf-pixverse-v6', displayName: 'PixVerse V6',
    textToVideoApiModel: 'pixverse/v6/text-to-video',
    imageToVideoApiModel: 'pixverse/v6/image-to-video',
    bestFor: 'PixVerse V6 with native audio, 360p to 1080p',
  },
  // Genjutsu — video editing. The source clip is a public URL the proxy uploads
  // to; duration follows the source (4 s minimum, trimmed to 30 s). These
  // endpoints quote a prose rate card instead of a `usd` figure, so billing
  // uses `usdPerSecondByResolution` × source seconds and refuses a job whose
  // source duration it was not told.
  {
    id: 'hf-genjutsu-motion-transfer', displayName: 'Genjutsu Motion Transfer',
    editApiModel: 'higgsfield/genjutsu/motion-transfer/v1.0', genjutsu: 'motion_transfer',
    bestFor: 'Drive a photo or character image with the motion of an existing clip',
    minSourceSeconds: 4, maxSourceSeconds: 30, maxReferenceImages: 8,
    usdPerSecondByResolution: { '480p': 0.318, '720p': 0.681, '1080p': 1.632 },
  },
  {
    id: 'hf-genjutsu-object-swap', displayName: 'Genjutsu Object Swap',
    editApiModel: 'higgsfield/genjutsu/object-swap/v1.0', genjutsu: 'object_swap',
    bestFor: 'Replace an object in a clip with a product or prop from a reference image',
    minSourceSeconds: 4, maxSourceSeconds: 30, minSourcePixels: 409_600, maxReferenceImages: 8,
    usdPerSecondByResolution: { '480p': 0.318, '720p': 0.681, '1080p': 1.632 },
  },
  {
    id: 'hf-genjutsu-restyle', displayName: 'Genjutsu Restyle',
    editApiModel: 'higgsfield/genjutsu/restyle/v1.0', genjutsu: 'restyle',
    bestFor: 'Restyle a clip into another look while keeping its motion and audio (needs a preset_id)',
    minSourceSeconds: 4, maxSourceSeconds: 30, maxSourceBytes: 200 * 1024 * 1024, maxReferenceImages: 5,
    usdPerSecondByResolution: { '480p': 0.318, '720p': 0.681, '1080p': 1.632 },
  },
]

/**
 * Ids from the retired fal catalog. They still resolve — a saved prompt or a
 * pinned model id keeps working — and every response reports the Higgsfield
 * model that actually ran.
 */
export const HIGGSFIELD_LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'kling-3-pro': 'hf-kling-3.0-pro',
  'kling-2.5-turbo-pro': 'hf-kling-2.5-pro',
  'veo-3.1-fast': 'hf-kling-3.0-std',
  'minimax-h3-max': 'hf-minimax-h3',
  'nano-banana-pro': 'hf-qwen-image-3',
  'nano-banana-2': 'hf-qwen-image-3',
  'seedream-5-pro': 'hf-qwen-image-3',
  'flux-pro-ultra': 'hf-marketing-studio-flare',
  'ideogram-3': 'hf-ideogram-4',
  'recraft-3': 'hf-recraft-v4.1',
}
