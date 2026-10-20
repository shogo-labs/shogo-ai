// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-81 acceptance: the Higgsfield media catalog is generated from the vendor
 * snapshot, every documented model and every documented option is reachable
 * from `generate_image` / `generate_video`, and the request builder validates
 * against the vendor's own schema instead of a hand-kept table.
 *
 * These sweeps cover the *whole* catalog — every model, every endpoint, every
 * documented field — because the card's promise is "all models with all the
 * proper config options", not "Kling works". A single hand-picked model can
 * pass while a family silently loses its range, its default or its audio
 * switch; a sweep cannot.
 *
 *   bun test ./apps/api/src/__tests__/qa-media-catalog-acceptance.test.ts
 */

import { describe, test, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { withPrismaExports } from './helpers/prisma-mock-exports'

process.env.SHOGO_LOCAL_MODE = 'true'
delete process.env.SHOGO_API_KEY
process.env.HIGGSFIELD_API_KEY = 'hf-test-key'
process.env.HIGGSFIELD_BASE_URL = 'https://hf.test'

mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findFirst: async () => ({ id: 'proj-1', name: 'Test' }),
      findUnique: async () => ({ id: 'proj-1', workspaceId: 'ws-1' }),
    },
    usageEvent: { create: async () => ({}) },
  },
}))

const billingStub = () => ({
  SYSTEM_WORKSPACE_ID: 'system',
  hasBalance: async () => true,
  checkUsageBalance: async () => ({ ok: true }),
  usageLimitErrorPayload: (reason?: string) => ({ code: reason ?? 'usage_limit_reached', message: 'limit' }),
  hasAdvancedModelAccess: async () => true,
  consumeUsage: async () => ({ success: true, remainingIncludedUsd: 100 }),
  getSubscription: async () => null,
  getUsageWallet: async () => null,
  getUsageWindows: async () => null,
  ensureSystemWorkspace: async () => ({}),
  hasPaidSubscription: async () => true,
  canRunTechStackOnInstanceSize: async () => ({ ok: true }),
  syncFromStripe: async () => ({}),
  allocateMonthlyIncluded: async () => ({}),
})
mock.module('../services/billing.service', billingStub)
mock.module('../services/billing-runtime', billingStub)
mock.module('../lib/project-user-context', () => ({ getProjectUser: () => 'test-user' }))

const { buildHiggsfieldImageRequest, buildHiggsfieldVideoRequest, HiggsfieldError } =
  await import('../lib/higgsfield-media')
const { listMediaModels } = await import('../routes/ai-proxy')
const {
  IMAGE_MODEL_CATALOG,
  VIDEO_MODEL_CATALOG,
  HIGGSFIELD_LEGACY_MODEL_ALIASES,
  mergeModelOptions,
  endpointsOf,
  optionsForEndpoint,
  resolveMediaModelId,
} = await import('@shogo/model-catalog')

interface SnapshotField {
  type: string
  required?: boolean
  enum?: string[]
  minimum?: number
  maximum?: number
  multipleOf?: number
  default?: unknown
  title?: string
  minItems?: number
  maxItems?: number
  maxLength?: number
  items?: string
  itemFields?: Record<string, SnapshotField>
}
interface Snapshot {
  endpoints: Record<string, { title?: string; kind: string; fields: Record<string, SnapshotField> }>
}

const snapshot: Snapshot = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../../../docs/vendors/higgsfield/catalog.json'), 'utf8'),
)

const imageModels = Object.values(IMAGE_MODEL_CATALOG) as any[]
const videoModels = Object.values(VIDEO_MODEL_CATALOG) as any[]
const higgsfieldImageModels = imageModels.filter((entry) => entry.provider === 'higgsfield')
const higgsfieldVideoModels = videoModels.filter((entry) => entry.provider === 'higgsfield')

/** The endpoint `buildHiggsfieldVideoRequest` uses for a prompt-only call. */
function generationEndpoint(entry: any): string | undefined {
  return entry.textToVideoApiModel ?? entry.imageToVideoApiModel ?? entry.endpoints?.[0] ?? entry.editApiModel
}

/**
 * Arguments that reach the endpoint above: a source-clip workflow needs a clip,
 * an image-to-video-only model needs a frame, everything else takes a prompt.
 * The sweeps use this so each assertion measures the model, not the harness.
 */
function argsFor(entry: any): Record<string, unknown> {
  if (entry.sourceVideo) {
    return {
      prompt: 'x',
      sourceVideoUrl: 'https://cdn.test/source.mp4',
      ...(entry.genjutsu === 'restyle' ? { presetId: 'preset-1' } : {}),
    }
  }
  if (!entry.textToVideoApiModel && entry.imageToVideoApiModel) {
    return { prompt: 'x', startImageUrl: 'https://cdn.test/first.png' }
  }
  return { prompt: 'x' }
}

/** Models whose `sourceVideo` edit flow takes a clip rather than generating. */
const generatingVideoModels = higgsfieldVideoModels.filter((entry) => !entry.sourceVideo)

/** Catch a builder error and return its code, or fail loudly if it threw nothing. */
function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof HiggsfieldError) return error.code
    throw error
  }
  throw new Error('expected the builder to reject this call, but it accepted it')
}

function errorMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected the builder to reject this call, but it accepted it')
}

// =========================================================================
// AC2 — every documented model, with every documented option
// =========================================================================

describe('AC2 — every documented endpoint and field reaches a model', () => {
  test('the snapshot is what the catalogs were generated from', () => {
    // Guards the fixture itself: a truncated snapshot would make every sweep
    // below pass vacuously.
    expect(Object.keys(snapshot.endpoints).length).toBeGreaterThan(80)
    expect(higgsfieldVideoModels.length).toBeGreaterThan(20)
    expect(higgsfieldImageModels.length).toBeGreaterThan(15)
  })

  test('every endpoint a model declares exists in the snapshot with the right kind', () => {
    const wrong: string[] = []
    const check = (entry: any, kind: 'video' | 'image') => {
      const allowed = kind === 'video' ? ['video', 'edit'] : ['image', 'edit']
      for (const endpoint of endpointsOf(entry)) {
        const documented = snapshot.endpoints[endpoint]
        if (!documented) {
          wrong.push(`${entry.id} → ${endpoint} is not documented`)
          continue
        }
        if (!allowed.includes(documented.kind)) {
          wrong.push(`${entry.id} → ${endpoint} is a '${documented.kind}' endpoint, not a '${kind}' one`)
        }
      }
    }
    for (const entry of higgsfieldVideoModels) check(entry, 'video')
    for (const entry of higgsfieldImageModels) check(entry, 'image')
    expect(wrong).toEqual([])
  })

  test('every documented field on every endpoint appears in that endpoint’s option list, with its constraints', () => {
    // This is the "all the proper config options" promise: a field the vendor
    // documents must be visible (so an agent can fill it in) and carry the
    // vendor's range/enum/default (so the builder can validate it) — on the
    // endpoint that documents it, not just somewhere on the model.
    const problems: string[] = []
    for (const entry of [...higgsfieldVideoModels, ...higgsfieldImageModels]) {
      for (const endpoint of endpointsOf(entry)) {
        const documented = snapshot.endpoints[endpoint]?.fields ?? {}
        const table = optionsForEndpoint(entry, endpoint) as any[]
        if (Object.keys(documented).length > 0 && table.length === 0) {
          problems.push(`${entry.id}: ${endpoint} documents ${Object.keys(documented).length} fields but lists no options`)
          continue
        }
        for (const [name, field] of Object.entries(documented)) {
          const option = table.find((candidate) => candidate.name === name)
          if (!option) {
            problems.push(`${entry.id}: documented field '${name}' (${endpoint}) is missing from that endpoint's options`)
            continue
          }
          if (field.required && !option.required) {
            problems.push(`${entry.id}.${name}: vendor marks it required, the catalog does not`)
          }
          if (field.enum && JSON.stringify([...field.enum].sort()) !== JSON.stringify([...(option.enum ?? [])].sort())) {
            problems.push(`${entry.id}.${name} (${endpoint}): enum ${JSON.stringify(option.enum)} ≠ vendor ${JSON.stringify(field.enum)}`)
          }
          if (field.minimum !== undefined && option.minimum !== field.minimum) {
            problems.push(`${entry.id}.${name} (${endpoint}): minimum ${option.minimum} ≠ vendor ${field.minimum}`)
          }
          if (field.maximum !== undefined && option.maximum !== field.maximum) {
            problems.push(`${entry.id}.${name} (${endpoint}): maximum ${option.maximum} ≠ vendor ${field.maximum}`)
          }
          if (field.multipleOf !== undefined && option.multipleOf !== field.multipleOf) {
            problems.push(`${entry.id}.${name} (${endpoint}): multipleOf ${option.multipleOf} ≠ vendor ${field.multipleOf}`)
          }
          if (field.default !== undefined && option.default !== field.default) {
            problems.push(`${entry.id}.${name} (${endpoint}): default ${String(option.default)} ≠ vendor ${String(field.default)}`)
          }
          if (field.itemFields) {
            const nested = Object.keys(option.itemFields ?? {}).sort()
            const expected = Object.keys(field.itemFields).sort()
            if (JSON.stringify(nested) !== JSON.stringify(expected)) {
              problems.push(`${entry.id}.${name} (${endpoint}): nested item fields ${JSON.stringify(nested)} ≠ vendor ${JSON.stringify(expected)}`)
            }
          }
        }
      }
    }
    expect(problems).toEqual([])
  })

  test('the merged (model-level) option view never invents a value the vendor does not document', () => {
    // `list_media_models` shows one row per field name across the model's
    // endpoints, narrowed to the values valid everywhere. It may hide a value
    // that only one endpoint takes (a documented trade-off — the single-model
    // view still names the endpoint per field), but it must never advertise
    // one that no endpoint accepts.
    const problems: string[] = []
    for (const entry of [...higgsfieldVideoModels, ...higgsfieldImageModels]) {
      const merged = mergeModelOptions(entry) as any[]
      for (const option of merged) {
        const perEndpoint = endpointsOf(entry)
          .map((endpoint) => (optionsForEndpoint(entry, endpoint) as any[]).find((field) => field.name === option.name))
          .filter(Boolean)
        if (perEndpoint.length === 0) {
          problems.push(`${entry.id}.${option.name}: listed on the model but on none of its endpoints`)
          continue
        }
        if (option.enum) {
          for (const value of option.enum) {
            const accepted = perEndpoint.some((field) => field.enum?.includes(value))
            const onEveryEndpoint = perEndpoint.every((field) => field.enum?.includes(value))
            if (!accepted) problems.push(`${entry.id}.${option.name}: advertises '${value}', which no endpoint accepts`)
            if (perEndpoint.length === endpointsOf(entry).length && !onEveryEndpoint) {
              problems.push(`${entry.id}.${option.name}: advertises '${value}' as model-wide, but not every endpoint accepts it`)
            }
          }
        }
        if (option.minimum !== undefined) {
          for (const field of perEndpoint) {
            // The model-level row narrows to the values valid on every
            // endpoint, so its minimum may only be *higher* than an
            // endpoint's own.
            if (field.minimum !== undefined && option.minimum < field.minimum) {
              problems.push(`${entry.id}.${option.name}: merged minimum ${option.minimum} is below ${field.minimum} on ${field.endpoints?.[0]}`)
            }
          }
        }
        if (option.maximum !== undefined) {
          for (const field of perEndpoint) {
            if (field.maximum !== undefined && option.maximum > field.maximum) {
              problems.push(`${entry.id}.${option.name}: merged maximum ${option.maximum} exceeds ${field.maximum} on ${field.endpoints?.[0]}`)
            }
          }
        }
      }
    }
    expect(problems).toEqual([])
  })

  test('every documented video/image endpoint is in some model — nothing silently omitted', () => {
    const wired = new Set<string>()
    for (const entry of [...higgsfieldVideoModels, ...higgsfieldImageModels]) {
      for (const endpoint of endpointsOf(entry)) wired.add(endpoint)
    }
    const documented = Object.entries(snapshot.endpoints)
      .filter(([, endpoint]) => endpoint.kind === 'video' || endpoint.kind === 'image')
      .map(([id]) => id)
      .sort()
    expect(documented.length).toBeGreaterThan(55)
    expect(documented.filter((id) => !wired.has(id))).toEqual([])
  })

  test('list_media_models lists every model, and one model’s full option list on demand', async () => {
    const all = await listMediaModels(undefined, {})
    const video = await listMediaModels(undefined, { kind: 'video' })
    const image = await listMediaModels(undefined, { kind: 'image' })

    expect(video.videos.map((model: any) => model.id).sort()).toEqual(higgsfieldVideoModels.map((entry) => entry.id).sort())
    expect(image.images.map((model: any) => model.id).sort()).toEqual(higgsfieldImageModels.map((entry) => entry.id).sort())
    expect(all.videos.length).toBe(video.videos.length)
    expect(all.images.length).toBe(image.images.length)
    expect(image.videos).toEqual([])
    expect(video.images).toEqual([])

    // Every listed model carries its endpoints, its options and a price, so an
    // agent can pick and fill in a call without guessing.
    const thin: string[] = []
    for (const model of [...(all.videos as any[]), ...(all.images as any[])]) {
      if (!model.endpoints?.length) thin.push(`${model.id}: no endpoints`)
      if (!Array.isArray(model.options) || model.options.length === 0) thin.push(`${model.id}: no options`)
      if (!model.price) thin.push(`${model.id}: no price`)
    }
    expect(thin).toEqual([])

    // A model's price is a Shogo-marked-up figure or an explicit null the
    // agent can see — never a missing field that reads as free.
    for (const model of [...(all.videos as any[]), ...(all.images as any[])]) {
      expect(model.price).toHaveProperty('usd')
      expect(model.price).toHaveProperty('source')
    }

    // The single-model view is the same data, not a narrower one.
    const one = await listMediaModels(undefined, { model: 'hf-kling-3.0-std' })
    expect(one.videos.length).toBe(1)
    expect(one.images.length).toBe(0)
    const kling = one.videos[0] as any
    expect(kling.options.map((option: any) => option.name)).toEqual(
      expect.arrayContaining(['duration', 'sound', 'cfg_scale', 'multi_prompt', 'multi_shots', 'last_image_url', 'image_url', 'aspect_ratio']),
    )
    const duration = kling.options.find((option: any) => option.name === 'duration')
    expect(duration).toMatchObject({ type: 'integer', min: 3, max: 15, default: 5 })
    const sound = kling.options.find((option: any) => option.name === 'sound')
    expect(sound).toMatchObject({ values: ['on', 'off'], default: 'on' })
    // A field only the image-to-video endpoint takes still says so.
    const lastImage = kling.options.find((option: any) => option.name === 'last_image_url')
    expect(lastImage.endpoints).toEqual(['kling-video/v3.0/std/image-to-video'])

    // A retired id resolves to the model that replaced it.
    const legacy = await listMediaModels(undefined, { model: 'kling-3-pro' })
    expect(legacy.videos.map((model: any) => model.id)).toEqual(['hf-kling-3.0-pro'])
  })
})

// =========================================================================
// AC1 / AC3 — the builder validates against the vendor's own schema
// =========================================================================

describe('AC1 — Kling 3.0 Standard, 3 s, with sound', () => {
  const kling = (VIDEO_MODEL_CATALOG as any)['hf-kling-3.0-std']

  test('image-to-video builds the documented body', () => {
    const built = buildHiggsfieldVideoRequest(kling, {
      prompt: 'a fox runs through snow',
      startImageUrl: 'https://cdn.test/first.png',
      duration: 3,
      audio: true,
    })
    expect(built.endpoint).toBe('kling-video/v3.0/std/image-to-video')
    expect(built.input).toEqual({
      prompt: 'a fox runs through snow',
      duration: 3,
      image_url: 'https://cdn.test/first.png',
      sound: 'on',
    })
  })

  test('text-to-video builds the documented body, and audio:false is sent not dropped', () => {
    const built = buildHiggsfieldVideoRequest(kling, {
      prompt: 'a fox runs through snow',
      duration: 3,
      audio: false,
      aspectRatio: '9:16',
    })
    expect(built.endpoint).toBe('kling-video/v3.0/std/text-to-video')
    expect(built.input).toEqual({ prompt: 'a fox runs through snow', duration: 3, aspect_ratio: '9:16', sound: 'off' })
  })

  test('options passes cfg_scale and multi_prompt through with per-shot validation', () => {
    const built = buildHiggsfieldVideoRequest(kling, {
      prompt: 'ignored when multi_prompt is set',
      duration: 8,
      options: {
        cfg_scale: 0.7,
        multi_shots: true,
        multi_prompt: [{ prompt: 'a fox runs', duration: 4 }, { prompt: 'it stops', duration: 4 }],
      },
    })
    expect(built.input.cfg_scale).toBe(0.7)
    expect(built.input.multi_shots).toBe(true)
    expect(built.input.multi_prompt).toEqual([
      { prompt: 'a fox runs', duration: 4 },
      { prompt: 'it stops', duration: 4 },
    ])
    // Nested constraints are the vendor's: multi_prompt[].duration is 1–15.
    expect(errorCode(() => buildHiggsfieldVideoRequest(kling, {
      prompt: 'x',
      options: { multi_prompt: [{ prompt: 'a', duration: 16 }] },
    }))).toBe('invalid_option')
    expect(errorMessage(() => buildHiggsfieldVideoRequest(kling, {
      prompt: 'x',
      options: { multi_prompt: [{ prompt: 'a', duration: 16 }] },
    }))).toContain('1–15')
  })

  test('an undeclared field is rejected and the error names the fields that exist', () => {
    const message = errorMessage(() => buildHiggsfieldVideoRequest(kling, { prompt: 'x', options: { vibe: 'warm' } }))
    expect(message).toContain("'vibe'")
    expect(message).toContain('cfg_scale')
  })
})

describe('AC3 — every documented option is enforced, for every model', () => {
  test('an out-of-range duration is rejected with the range in the message, for every video model', () => {
    const problems: string[] = []
    for (const entry of generatingVideoModels) {
      const endpoint = generationEndpoint(entry)
      const duration = snapshot.endpoints[endpoint!]?.fields?.duration
      if (!duration || duration.minimum === undefined || duration.maximum === undefined) continue
      const range = `${duration.minimum}–${duration.maximum}`
      for (const bad of [duration.minimum - 1, duration.maximum + 1]) {
        const code = errorCode(() => buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), duration: bad }))
        if (code !== 'invalid_duration') problems.push(`${entry.id}: duration ${bad} failed with '${code}'`)
        const message = errorMessage(() => buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), duration: bad }))
        if (!message.includes(range) || !message.includes(entry.id)) {
          problems.push(`${entry.id}: duration ${bad} message did not name ${range} and the model — ${message}`)
        }
      }
      // The documented boundaries themselves must be accepted.
      for (const good of [duration.minimum, duration.maximum]) {
        const built = buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), duration: good })
        if (built.input.duration !== good) problems.push(`${entry.id}: duration ${good} was not sent`)
      }
    }
    expect(problems).toEqual([])
    expect(generatingVideoModels.length).toBeGreaterThan(15)
  })

  test('an out-of-range or unknown enum value is rejected with the allowed values, for every model', () => {
    const problems: string[] = []
    for (const entry of generatingVideoModels) {
      const endpoint = generationEndpoint(entry)
      const fields = snapshot.endpoints[endpoint!]?.fields ?? {}
      const aspect = fields.aspect_ratio
      if (aspect?.enum) {
        const message = errorMessage(() => buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), aspectRatio: '7:3' }))
        for (const value of aspect.enum) {
          if (!message.includes(value)) problems.push(`${entry.id}: aspect_ratio error omits '${value}' — ${message}`)
        }
      }
      // A field with a range rejects a value outside it, naming the field.
      const ranged = Object.entries(fields).find(
        ([, field]) => (field.type === 'number' || field.type === 'integer') && field.minimum !== undefined && field.maximum !== undefined,
      )
      if (ranged) {
        const [name, field] = ranged
        const message = errorMessage(() => buildHiggsfieldVideoRequest(entry, {
          ...argsFor(entry),
          options: { [name]: (field.maximum as number) + 100 },
        }))
        if (!message.includes(name)) problems.push(`${entry.id}: ${name} out-of-range error does not name the field — ${message}`)
      }
      // An enum value nobody documents is rejected, never forwarded to a 422.
      const enumField = Object.entries(fields).find(
        ([name, field]) => field.enum && name !== 'aspect_ratio' && name !== 'sound',
      )
      if (enumField) {
        const [name, field] = enumField
        const code = errorCode(() => buildHiggsfieldVideoRequest(entry, {
          ...argsFor(entry),
          options: { [name]: '__not_a_documented_value__' },
        }))
        if (code !== 'invalid_option') problems.push(`${entry.id}: ${name} accepted an undocumented value ('${code}')`)
      }
    }
    expect(problems).toEqual([])
  })

  test('audio:true on a silent model is audio_not_supported — every audio-capable model honours the flag', () => {
    const problems: string[] = []
    for (const entry of generatingVideoModels) {
      const endpoint = generationEndpoint(entry)
      const fields = snapshot.endpoints[endpoint!]?.fields ?? {}
      const sound = fields.sound
      const generateAudio = fields.generate_audio

      if (sound?.enum) {
        const on = buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), audio: true })
        const off = buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), audio: false })
        const expectedOn = sound.enum.includes('on') ? 'on' : sound.enum[0]
        const expectedOff = sound.enum.includes('off') ? 'off' : sound.enum[sound.enum.length - 1]
        if (on.input.sound !== expectedOn) problems.push(`${entry.id}: audio:true sent sound=${JSON.stringify(on.input.sound)}`)
        if (off.input.sound !== expectedOff) problems.push(`${entry.id}: audio:false sent sound=${JSON.stringify(off.input.sound)}`)
      } else if (generateAudio) {
        const on = buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), audio: true })
        const off = buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), audio: false })
        if (on.input.generate_audio !== true) problems.push(`${entry.id}: audio:true sent ${JSON.stringify(on.input.generate_audio)}`)
        if (off.input.generate_audio !== false) problems.push(`${entry.id}: audio:false sent ${JSON.stringify(off.input.generate_audio)}`)
      } else {
        const code = errorCode(() => buildHiggsfieldVideoRequest(entry, { ...argsFor(entry), audio: true }))
        if (code !== 'audio_not_supported') problems.push(`${entry.id}: audio:true on a silent model gave '${code}'`)
      }
    }
    expect(problems).toEqual([])
    // The sweep has to have seen both kinds, or it proves nothing.
    const withAudio = generatingVideoModels.filter((entry) => {
      const fields = snapshot.endpoints[generationEndpoint(entry)!]?.fields ?? {}
      return !!(fields.sound || fields.generate_audio)
    })
    expect(withAudio.length).toBeGreaterThan(10)
    expect(generatingVideoModels.length - withAudio.length).toBeGreaterThan(0)
  })

  test('image-only models refuse text-to-video, and text-only models refuse a start image', () => {
    const imageOnly = generatingVideoModels.filter((entry) => !entry.textToVideoApiModel && entry.imageToVideoApiModel)
    const textOnly = generatingVideoModels.filter((entry) => entry.textToVideoApiModel && !entry.imageToVideoApiModel)
    expect(imageOnly.length).toBeGreaterThan(0)
    for (const entry of imageOnly) {
      expect(errorCode(() => buildHiggsfieldVideoRequest(entry, { prompt: 'x' }))).toBe('text_to_video_unsupported')
    }
    for (const entry of textOnly) {
      expect(errorCode(() => buildHiggsfieldVideoRequest(entry, { prompt: 'x', startImageUrl: 'https://cdn.test/a.png' })))
        .toBe('image_to_video_unsupported')
    }
  })

  test('every image model builds a request for a plain prompt', () => {
    // A model that cannot build a request at all would be listed but unusable.
    const problems: string[] = []
    for (const entry of higgsfieldImageModels) {
      try {
        const built = buildHiggsfieldImageRequest(entry, { prompt: 'a product photo', size: '1024x1024', quality: 'standard' })
        if (!built.endpoint || !snapshot.endpoints[built.endpoint]) problems.push(`${entry.id}: built an undocumented endpoint ${built.endpoint}`)
        if (typeof built.input.prompt !== 'string') problems.push(`${entry.id}: no prompt in the built body`)
        if (built.input.batch_size !== undefined && built.input.batch_size !== 1) problems.push(`${entry.id}: batch_size is not pinned to 1`)
      } catch (error) {
        problems.push(`${entry.id}: ${(error as Error).message}`)
      }
    }
    expect(problems).toEqual([])
  })
})

// =========================================================================
// AC5 — fal is retired; old ids still resolve and name the model that ran
// =========================================================================

describe('AC5 — fal is gone, legacy ids still resolve', () => {
  test('no catalog entry has a fal provider or a fal endpoint', () => {
    for (const entry of [...imageModels, ...videoModels]) {
      expect(entry.provider).not.toBe('fal')
      const endpoints = [...endpointsOf(entry), entry.apiModel, entry.textToVideoApiModel, entry.imageToVideoApiModel]
        .filter((value): value is string => typeof value === 'string')
      for (const endpoint of endpoints) {
        expect(endpoint).not.toContain('fal')
      }
    }
  })

  test('every legacy alias points at a model that exists, and no alias shadows a live id', () => {
    const live = new Set([...imageModels, ...videoModels].map((entry) => entry.id))
    const problems: string[] = []
    for (const [legacy, target] of Object.entries(HIGGSFIELD_LEGACY_MODEL_ALIASES)) {
      if (!live.has(target)) problems.push(`${legacy} → ${target} does not exist in either catalog`)
      if (live.has(legacy)) problems.push(`${legacy} is both an alias and a live model id`)
      if (resolveMediaModelId(legacy) !== target) problems.push(`${legacy} does not resolve through resolveMediaModelId`)
    }
    expect(problems).toEqual([])
    // The ids the card names must all be covered.
    for (const id of ['kling-3-pro', 'veo-3.1-fast', 'nano-banana-pro', 'seedream-5-pro', 'flux-pro-ultra']) {
      expect(HIGGSFIELD_LEGACY_MODEL_ALIASES[id]).toBeDefined()
    }
  })

  test('a legacy video id builds a request on the model that replaced it', () => {
    const resolved = resolveMediaModelId('kling-3-pro')
    expect(resolved).toBe('hf-kling-3.0-pro')
    const built = buildHiggsfieldVideoRequest((VIDEO_MODEL_CATALOG as any)[resolved], { prompt: 'x', duration: 5 })
    expect(built.endpoint).toBe('kling-video/v3.0/pro/text-to-video')
    // A non-audio-only legacy id maps to a model that still has audio, so
    // "veo-3.1-fast with sound" keeps working.
    expect((VIDEO_MODEL_CATALOG as any)[resolveMediaModelId('veo-3.1-fast')].audio).toBe(true)
  })

  test('a live id resolves to itself', () => {
    for (const entry of [...imageModels, ...videoModels]) {
      expect(resolveMediaModelId(entry.id)).toBe(entry.id)
    }
  })
})
