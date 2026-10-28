// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Generate `packages/agent/src/model-catalog/media-catalog.generated.ts` from
 * the committed vendor snapshot (`docs/vendors/higgsfield/catalog.json`) plus
 * the curated overlay (`media-overlay.ts`).
 *
 * The docs are the only place that says which endpoints exist and what each one
 * accepts, so the catalog is derived from them rather than hand-written: every
 * `video` and `image` endpoint becomes part of a model, and every model carries
 * the endpoint's documented fields (enum, range, step, default) for
 * `list_media_models` to advertise and the request builder to validate.
 *
 * Deterministic: endpoints and fields are sorted, and the output has no
 * timestamps, so `check:higgsfield-docs` can re-render and diff it byte for byte.
 *
 * Usage:
 *   bun run scripts/generate-media-catalog.ts [--write]
 */

import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { ImageModelEntry, ModelOptionField, VideoModelEntry } from '../packages/agent/src/model-catalog/models'
import {
  HIGGSFIELD_IMAGE_OVERLAY,
  HIGGSFIELD_VIDEO_OVERLAY,
  type OverlayImageModel,
  type OverlayVideoModel,
} from '../packages/agent/src/model-catalog/media-overlay'

const REPO_ROOT = resolve(import.meta.dir, '..')
export const CATALOG_JSON = join(REPO_ROOT, 'docs/vendors/higgsfield/catalog.json')
export const GENERATED_PATH = join(REPO_ROOT, 'packages/agent/src/model-catalog/media-catalog.generated.ts')

export interface CatalogField {
  type: string
  required: boolean
  enum?: string[]
  minimum?: number
  maximum?: number
  multipleOf?: number
  default?: string | number | boolean
  title?: string
  items?: string
  itemFields?: Record<string, CatalogField>
  minItems?: number
  maxItems?: number
  maxLength?: number
}

export interface CatalogEndpoint {
  title: string
  kind: 'image' | 'video' | 'edit' | 'other'
  fields: Record<string, CatalogField>
  outputs: string[]
}

export type Catalog = { endpoints: Record<string, CatalogEndpoint> }

export function readCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_JSON, 'utf8')) as Catalog
}

function optionOf(name: string, field: CatalogField): ModelOptionField {
  const option: ModelOptionField = { name, type: field.type }
  if (field.required) option.required = true
  if (field.enum) option.enum = field.enum
  if (field.minimum !== undefined) option.minimum = field.minimum
  if (field.maximum !== undefined) option.maximum = field.maximum
  if (field.multipleOf !== undefined) option.multipleOf = field.multipleOf
  if (field.default !== undefined) option.default = field.default
  if (field.title) option.title = field.title
  if (field.items) option.items = field.items
  if (field.minItems !== undefined) option.minItems = field.minItems
  if (field.maxItems !== undefined) option.maxItems = field.maxItems
  if (field.maxLength !== undefined) option.maxLength = field.maxLength
  if (field.itemFields) {
    const nested: Record<string, ModelOptionField> = {}
    for (const key of Object.keys(field.itemFields).sort()) nested[key] = optionOf(key, field.itemFields[key])
    option.itemFields = nested
  }
  return option
}

function optionsOf(endpoint: CatalogEndpoint | undefined): ModelOptionField[] {
  if (!endpoint) return []
  return Object.keys(endpoint.fields)
    .sort()
    .map((name) => optionOf(name, endpoint.fields[name]))
}

function fieldNamed(endpoint: CatalogEndpoint | undefined, name: string): CatalogField | undefined {
  return endpoint?.fields[name]
}

/** Duration menu: the documented enum, or every integer the range allows. */
function durationsOf(field: CatalogField | undefined): number[] {
  if (!field) return []
  if (field.enum) {
    return [...new Set(field.enum.map(Number).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b)
  }
  if (field.type !== 'integer' && field.type !== 'number') return []
  const step = field.type === 'integer' ? 1 : (field.multipleOf ?? 1)
  const min = field.minimum ?? 1
  const max = field.maximum ?? min
  if (max < min || max - min > 120) return min === max ? [min] : []
  const values: number[] = []
  for (let value = min; value <= max + 1e-9; value += step) values.push(Number(value.toFixed(6)))
  return values
}

function uniqueInOrder(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))]
}

class GenerationError extends Error {}

function requireEndpoint(catalog: Catalog, id: string, label: string, kinds: CatalogEndpoint['kind'][]): CatalogEndpoint {
  const endpoint = catalog.endpoints[id]
  if (!endpoint) throw new GenerationError(`${label}: endpoint '${id}' is not in docs/vendors/higgsfield/catalog.json.`)
  if (!kinds.includes(endpoint.kind)) {
    throw new GenerationError(`${label}: '${id}' is documented as kind '${endpoint.kind}', expected ${kinds.join('/')}.`)
  }
  return endpoint
}

type Used = Map<string, string>

function claim(used: Used, endpoint: string, modelId: string) {
  const owner = used.get(endpoint)
  if (owner && owner !== modelId) {
    throw new GenerationError(`Endpoint '${endpoint}' is claimed by both '${owner}' and '${modelId}'.`)
  }
  used.set(endpoint, modelId)
}

function buildImageEntry(catalog: Catalog, model: OverlayImageModel, used: Used): ImageModelEntry {
  requireEndpoint(catalog, model.apiModel, model.id, ['image'])
  claim(used, model.apiModel, model.id)
  if (model.editApiModel) {
    requireEndpoint(catalog, model.editApiModel, model.id, ['image'])
    claim(used, model.editApiModel, model.id)
  }

  const endpoints = [model.apiModel, model.editApiModel].filter((id): id is string => !!id)
  const optionsByEndpoint: Record<string, ModelOptionField[]> = {}
  for (const endpoint of endpoints) optionsByEndpoint[endpoint] = optionsOf(catalog.endpoints[endpoint])

  const referenceEndpoint = model.referenceField
    ? endpoints.find((endpoint) => !!fieldNamed(catalog.endpoints[endpoint], model.referenceField!.name))
    : undefined
  if (model.referenceField && !referenceEndpoint) {
    throw new GenerationError(`${model.id}: field '${model.referenceField.name}' is not documented on ${endpoints.join(' or ')}.`)
  }
  const referenceSpec = referenceEndpoint
    ? fieldNamed(catalog.endpoints[referenceEndpoint], model.referenceField!.name)
    : undefined
  if (model.referenceField && referenceSpec && (referenceSpec.type === 'array') !== model.referenceField.multiple) {
    throw new GenerationError(
      `${model.id}: '${model.referenceField.name}' is documented as ${referenceSpec.type}, so ` +
        `multiple must be ${referenceSpec.type === 'array'}.`,
    )
  }

  let maxReferenceImages = 0
  if (model.referenceField && referenceSpec) {
    maxReferenceImages = referenceSpec.maxItems ?? (referenceSpec.type === 'array' ? 4 : 1)
  }

  if (model.quality) {
    const spec = fieldNamed(catalog.endpoints[model.apiModel], model.quality.field)
    if (!spec?.enum) throw new GenerationError(`${model.id}: quality field '${model.quality.field}' has no documented enum.`)
    for (const value of [model.quality.standard, model.quality.hd]) {
      if (!spec.enum.includes(value)) {
        throw new GenerationError(`${model.id}: '${value}' is not a documented '${model.quality.field}' value (${spec.enum.join(', ')}).`)
      }
    }
  }

  const entry: ImageModelEntry = {
    id: model.id,
    provider: 'higgsfield',
    apiModel: model.apiModel,
    displayName: model.displayName,
    capabilities: {
      textToImage: !!fieldNamed(catalog.endpoints[model.apiModel], 'prompt'),
      imageToImage: !!model.referenceField,
      maxReferenceImages,
    },
    bestFor: model.bestFor,
    endpoints,
    optionsByEndpoint,
    ...(model.editApiModel ? { editApiModel: model.editApiModel } : {}),
    ...(model.referenceField ? { referenceField: model.referenceField } : {}),
    ...(model.quality ? { quality: model.quality } : {}),
    ...(model.usdPerRequest !== undefined ? { usdPerRequest: model.usdPerRequest } : {}),
  }
  return entry
}

function buildVideoEntry(catalog: Catalog, model: OverlayVideoModel, used: Used): VideoModelEntry {
  const generationEndpoints: string[] = []
  if (model.textToVideoApiModel) {
    requireEndpoint(catalog, model.textToVideoApiModel, model.id, ['video'])
    claim(used, model.textToVideoApiModel, model.id)
    generationEndpoints.push(model.textToVideoApiModel)
  }
  if (model.imageToVideoApiModel) {
    requireEndpoint(catalog, model.imageToVideoApiModel, model.id, ['video'])
    claim(used, model.imageToVideoApiModel, model.id)
    generationEndpoints.push(model.imageToVideoApiModel)
  }
  if (model.editApiModel) {
    requireEndpoint(catalog, model.editApiModel, model.id, ['edit'])
    claim(used, model.editApiModel, model.id)
  }
  if (generationEndpoints.length === 0 && !model.editApiModel) {
    throw new GenerationError(`${model.id}: no endpoint.`)
  }

  const endpoints = uniqueInOrder([...generationEndpoints, model.editApiModel])
  const optionsByEndpoint: Record<string, ModelOptionField[]> = {}
  for (const endpoint of endpoints) optionsByEndpoint[endpoint] = optionsOf(catalog.endpoints[endpoint])

  const primary = catalog.endpoints[generationEndpoints[0] ?? model.editApiModel!]
  const durationField = fieldNamed(primary, 'duration') ?? fieldNamed(catalog.endpoints[generationEndpoints[1] ?? ''], 'duration')
  const sourceVideo = !!model.editApiModel
  // One menu for the model, not one per endpoint: keep only the values every
  // endpoint accepts, so a duration an agent reads here works whether or not it
  // also passes a start image.
  const perEndpointDurations = generationEndpoints.map((endpoint) =>
    durationsOf(fieldNamed(catalog.endpoints[endpoint], 'duration')),
  )
  const durations = sourceVideo
    ? []
    : perEndpointDurations.reduce<number[] | null>(
        (shared, values) => (shared === null ? values : shared.filter((value) => values.includes(value))),
        null,
      ) ?? []

  const resolutionEnums = endpoints.map((endpoint) => fieldNamed(catalog.endpoints[endpoint], 'resolution')?.enum)
  const resolutions = uniqueInOrder(resolutionEnums.flat() ?? [])
  const audio = endpoints.some((endpoint) => {
    const spec = catalog.endpoints[endpoint].fields
    return !!spec.sound || !!spec.generate_audio
  })

  const entry: VideoModelEntry = {
    id: model.id,
    provider: 'higgsfield',
    displayName: model.displayName,
    // A source-video workflow submits to its one edit endpoint, which is what
    // `textToVideoApiModel` names for those models.
    ...(model.textToVideoApiModel
      ? { textToVideoApiModel: model.textToVideoApiModel }
      : model.editApiModel
        ? { textToVideoApiModel: model.editApiModel }
        : {}),
    ...(model.imageToVideoApiModel ? { imageToVideoApiModel: model.imageToVideoApiModel } : {}),
    durations,
    defaultDuration: (() => {
      const documented = typeof durationField?.default === 'number' ? durationField.default : undefined
      if (documented !== undefined && durations.includes(documented)) return documented
      return durations[0] ?? 4
    })(),
    aspectRatios: fieldNamed(primary, 'aspect_ratio')?.enum ?? [],
    maxReferenceImages: model.maxReferenceImages ?? 0,
    bestFor: model.bestFor,
    endpoints,
    optionsByEndpoint,
    audio,
    ...(resolutions.length > 0
      ? { resolutions, defaultResolution: (fieldNamed(primary, 'resolution')?.default as string | undefined) ?? resolutions[0] }
      : {}),
    ...(sourceVideo
      ? {
          sourceVideo: true,
          ...(model.genjutsu ? { genjutsu: model.genjutsu } : {}),
          ...(model.minSourceSeconds !== undefined ? { minSourceSeconds: model.minSourceSeconds } : {}),
          ...(model.maxSourceSeconds !== undefined ? { maxSourceSeconds: model.maxSourceSeconds } : {}),
          ...(model.minSourcePixels !== undefined ? { minSourcePixels: model.minSourcePixels } : {}),
          ...(model.maxSourceBytes !== undefined ? { maxSourceBytes: model.maxSourceBytes } : {}),
          ...(model.usdPerSecondByResolution ? { usdPerSecondByResolution: model.usdPerSecondByResolution } : {}),
        }
      : {}),
    ...(model.usdPerRequest !== undefined ? { usdPerRequest: model.usdPerRequest } : {}),
  }
  return entry
}

/**
 * Documented `edit` endpoints we deliberately do not expose, with the reason.
 *
 * They are per-token/per-second priced and `/estimate` answers with a prose rate
 * card instead of an amount, so there is no figure to bill before running the
 * job — and the proxy refuses to run work it cannot price. Naming them here
 * (rather than ignoring the `edit` kind) keeps the rule "a documented endpoint is
 * either wired or explained": a new one appearing in the snapshot still fails.
 */
export const UNWIRED_EDIT_ENDPOINTS: Readonly<Record<string, string>> = {
  'bytedance/seedance-2.5/video-edit': 'token rate card only; /estimate returns no per-request price',
  'bytedance/seedance-2.5/video-extend': 'token rate card only; /estimate returns no per-request price',
  'kling-video/motion-control/pro': 'no usable /estimate (upstream 500); pricing unverified',
  'kling-video/motion-control/std': 'no usable /estimate (upstream 500); pricing unverified',
  'kling-video/v3/motion-control/pro': 'no usable /estimate (upstream 500); pricing unverified',
  'kling-video/v3/motion-control/std': 'no usable /estimate (upstream 500); pricing unverified',
}

export interface GeneratedCatalog {
  images: Record<string, ImageModelEntry>
  videos: Record<string, VideoModelEntry>
}

/** Build both catalogs and assert the snapshot is fully accounted for. */
export function buildCatalog(catalog: Catalog = readCatalog()): GeneratedCatalog {
  const used: Used = new Map()
  const images: Record<string, ImageModelEntry> = {}
  const videos: Record<string, VideoModelEntry> = {}

  for (const model of HIGGSFIELD_IMAGE_OVERLAY) {
    if (images[model.id]) throw new GenerationError(`Duplicate image model id '${model.id}'.`)
    images[model.id] = buildImageEntry(catalog, model, used)
  }
  for (const model of HIGGSFIELD_VIDEO_OVERLAY) {
    if (videos[model.id]) throw new GenerationError(`Duplicate video model id '${model.id}'.`)
    videos[model.id] = buildVideoEntry(catalog, model, used)
  }

  for (const endpoint of Object.keys(UNWIRED_EDIT_ENDPOINTS)) {
    if (!catalog.endpoints[endpoint]) {
      throw new GenerationError(`UNWIRED_EDIT_ENDPOINTS names '${endpoint}', which the docs no longer document.`)
    }
    if (used.has(endpoint)) {
      throw new GenerationError(`'${endpoint}' is both wired and listed as unwired.`)
    }
  }

  const missing = Object.keys(catalog.endpoints)
    .filter((id) => ['video', 'image'].includes(catalog.endpoints[id].kind))
    .filter((id) => !used.has(id))
    .sort()
  if (missing.length > 0) {
    throw new GenerationError(
      `These documented endpoints are in no catalog model (add them to media-overlay.ts):\n  ${missing.join('\n  ')}`,
    )
  }
  const unexplained = Object.keys(catalog.endpoints)
    .filter((id) => catalog.endpoints[id].kind === 'edit')
    .filter((id) => !used.has(id) && !UNWIRED_EDIT_ENDPOINTS[id])
    .sort()
  if (unexplained.length > 0) {
    throw new GenerationError(
      `These documented edit endpoints are neither wired nor explained in UNWIRED_EDIT_ENDPOINTS:\n  ${unexplained.join('\n  ')}`,
    )
  }

  return { images, videos }
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function ts(value: unknown): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(ts).join(', ')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return `{ ${entries.map(([key, nested]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)}: ${ts(nested)}`).join(', ')} }`
  }
  return 'undefined'
}

function renderOption(option: ModelOptionField): string {
  const parts: string[] = [`name: ${ts(option.name)}`, `type: ${ts(option.type)}`]
  if (option.required) parts.push('required: true')
  if (option.enum) parts.push(`enum: ${ts(option.enum)}`)
  if (option.minimum !== undefined) parts.push(`minimum: ${option.minimum}`)
  if (option.maximum !== undefined) parts.push(`maximum: ${option.maximum}`)
  if (option.multipleOf !== undefined) parts.push(`multipleOf: ${option.multipleOf}`)
  if (option.default !== undefined) parts.push(`default: ${ts(option.default)}`)
  if (option.title) parts.push(`title: ${ts(option.title)}`)
  if (option.items) parts.push(`items: ${ts(option.items)}`)
  if (option.minItems !== undefined) parts.push(`minItems: ${option.minItems}`)
  if (option.maxItems !== undefined) parts.push(`maxItems: ${option.maxItems}`)
  if (option.maxLength !== undefined) parts.push(`maxLength: ${option.maxLength}`)
  if (option.itemFields) {
    const nested = Object.entries(option.itemFields)
      .map(([key, field]) => `${key}: ${renderOption(field)}`)
      .join(', ')
    parts.push(`itemFields: { ${nested} }`)
  }
  return `{ ${parts.join(', ')} }`
}

function renderOptionsByEndpoint(options: Readonly<Record<string, readonly ModelOptionField[]>>): string {
  const lines: string[] = ['{']
  for (const endpoint of Object.keys(options)) {
    lines.push(`      ${ts(endpoint)}: [`)
    for (const option of options[endpoint]) lines.push(`        ${renderOption(option)},`)
    lines.push('      ],')
  }
  lines.push('    }')
  return lines.join('\n')
}

function renderImageEntry(entry: ImageModelEntry): string {
  const lines: string[] = ['{']
  const scalars: string[] = [
    `id: ${ts(entry.id)}`,
    `provider: 'higgsfield'`,
    `apiModel: ${ts(entry.apiModel)}`,
    `displayName: ${ts(entry.displayName)}`,
  ]
  if (entry.editApiModel) scalars.push(`editApiModel: ${ts(entry.editApiModel)}`)
  scalars.push(
    `capabilities: { textToImage: ${entry.capabilities.textToImage}, imageToImage: ${entry.capabilities.imageToImage}, maxReferenceImages: ${entry.capabilities.maxReferenceImages} }`,
  )
  if (entry.bestFor) scalars.push(`bestFor: ${ts(entry.bestFor)}`)
  if (entry.usdPerRequest !== undefined) scalars.push(`usdPerRequest: ${entry.usdPerRequest}`)
  scalars.push(`endpoints: ${ts(entry.endpoints ?? [])}`)
  if (entry.referenceField) scalars.push(`referenceField: ${ts(entry.referenceField)}`)
  if (entry.quality) scalars.push(`quality: ${ts(entry.quality)}`)
  for (const line of scalars) lines.push(`    ${line},`)
  lines.push(`    optionsByEndpoint: ${renderOptionsByEndpoint(entry.optionsByEndpoint ?? {})},`)
  lines.push('  }')
  return lines.join('\n')
}

function renderVideoEntry(entry: VideoModelEntry): string {
  const lines: string[] = ['{']
  const scalars: string[] = [`id: ${ts(entry.id)}`, `provider: 'higgsfield'`, `displayName: ${ts(entry.displayName)}`]
  if (entry.textToVideoApiModel) scalars.push(`textToVideoApiModel: ${ts(entry.textToVideoApiModel)}`)
  if (entry.imageToVideoApiModel) scalars.push(`imageToVideoApiModel: ${ts(entry.imageToVideoApiModel)}`)
  scalars.push(`durations: ${ts(entry.durations)}`)
  scalars.push(`defaultDuration: ${entry.defaultDuration}`)
  scalars.push(`aspectRatios: ${ts(entry.aspectRatios)}`)
  if (entry.resolutions) scalars.push(`resolutions: ${ts(entry.resolutions)}`)
  if (entry.defaultResolution) scalars.push(`defaultResolution: ${ts(entry.defaultResolution)}`)
  scalars.push(`maxReferenceImages: ${entry.maxReferenceImages}`)
  scalars.push(`audio: ${!!entry.audio}`)
  if (entry.bestFor) scalars.push(`bestFor: ${ts(entry.bestFor)}`)
  if (entry.usdPerRequest !== undefined) scalars.push(`usdPerRequest: ${entry.usdPerRequest}`)
  scalars.push(`endpoints: ${ts(entry.endpoints ?? [])}`)
  if (entry.sourceVideo) scalars.push(`sourceVideo: true`)
  if (entry.genjutsu) scalars.push(`genjutsu: ${ts(entry.genjutsu)}`)
  if (entry.minSourceSeconds !== undefined) scalars.push(`minSourceSeconds: ${entry.minSourceSeconds}`)
  if (entry.maxSourceSeconds !== undefined) scalars.push(`maxSourceSeconds: ${entry.maxSourceSeconds}`)
  if (entry.minSourcePixels !== undefined) scalars.push(`minSourcePixels: ${entry.minSourcePixels}`)
  if (entry.maxSourceBytes !== undefined) scalars.push(`maxSourceBytes: ${entry.maxSourceBytes}`)
  if (entry.usdPerSecondByResolution) scalars.push(`usdPerSecondByResolution: ${ts(entry.usdPerSecondByResolution)}`)
  for (const line of scalars) lines.push(`    ${line},`)
  lines.push(`    optionsByEndpoint: ${renderOptionsByEndpoint(entry.optionsByEndpoint ?? {})},`)
  lines.push('  }')
  return lines.join('\n')
}

export function renderGenerated(generated: GeneratedCatalog): string {
  const imageIds = Object.keys(generated.images)
  const videoIds = Object.keys(generated.videos)
  const parts: string[] = [
    '// SPDX-License-Identifier: MIT',
    '// Copyright (C) 2026 Shogo Technologies, Inc.',
    '/**',
    ' * GENERATED — do not edit.',
    ' *',
    ' * `bun run scripts/generate-media-catalog.ts --write` renders this from',
    ' * `docs/vendors/higgsfield/catalog.json` (the vendor snapshot) and',
    ' * `media-overlay.ts` (names, bestFor, prices). `bun run check:higgsfield-docs`',
    ' * fails when the two disagree with this file.',
    ' */',
    '',
    "import type { ImageModelEntry, VideoModelEntry } from './models'",
    '',
    `export const HIGGSFIELD_IMAGE_MODELS = {`,
  ]
  for (const id of imageIds) parts.push(`  ${ts(id)}: ${renderImageEntry(generated.images[id])},`)
  parts.push('} as const satisfies Record<string, ImageModelEntry>', '')
  parts.push('export const HIGGSFIELD_VIDEO_MODELS = {')
  for (const id of videoIds) parts.push(`  ${ts(id)}: ${renderVideoEntry(generated.videos[id])},`)
  parts.push('} as const satisfies Record<string, VideoModelEntry>', '')
  return parts.join('\n')
}

export function renderMediaCatalog(): string {
  return renderGenerated(buildCatalog())
}

if (import.meta.main) {
  const write = process.argv.includes('--write')
  try {
    const rendered = renderMediaCatalog()
    if (write) {
      writeFileSync(GENERATED_PATH, rendered)
      const generated = buildCatalog()
      console.log(
        `Wrote ${GENERATED_PATH} (${Object.keys(generated.images).length} image, ${Object.keys(generated.videos).length} video models)`,
      )
    } else {
      console.log(rendered)
    }
  } catch (error) {
    if (error instanceof GenerationError) {
      console.error(`❌ ${error.message}`)
      process.exit(1)
    }
    throw error
  }
}
