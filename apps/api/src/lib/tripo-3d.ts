// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tripo3D V3 client and operation registry for the AI proxy's 3D routes.
 *
 * Every Tripo call is asynchronous: submit an op, get a task id, poll until
 * the task reports `success`. Model files (`output.model_url`) live on signed
 * storage that expires after ~5 minutes, so they are returned to the caller
 * as-is and never cached in the proxy.
 *
 * V3, not V2: `platform.tripo3d.ai/docs` still documents `/v2/openapi/task`
 * and Tripo retires V2 on 2026-10-31. `developers.tripo3d.ai/en/docs/*` is
 * the authoritative surface.
 *
 * `TRIPO_OPS` is the single source of truth for what each operation accepts,
 * where it submits, and what it costs. The route validates against it, so a
 * new Tripo op is one entry here plus nothing else.
 */

/** Tripo V3 API base. `/v3/tasks/:id` is a path param, not a query param. */
export const TRIPO_API_BASE = 'https://openapi.tripo3d.ai/v3'

/** 1 credit = $1.00 / 100 (developers.tripo3d.ai pricing). */
export const TRIPO_CREDITS_PER_USD = 100

export interface TripoModel {
  id: string
  name: string
  /** Version-pinned value the API's `model` parameter actually accepts. */
  apiModel: string
  /** H = high-fidelity series (v3.x), P = low-poly game-asset series (p1). */
  series: 'H' | 'P'
  textToModel: boolean
  imageToModel: boolean
}

/**
 * Model ids the proxy will run. The public docs list these as "model IDs"
 * (`tripo-v3.1`, `tripo-p1`), but the API's `model` parameter rejects them —
 * it wants the version string (verified live 2026-10-18: `invalid model
 * 'tripo-v3.1', allowed values: P1-20260311, P2-20260801, v2.5-20250123,
 * v3.0-20250812, v3.1-20260211`). Shogo's ids stay readable; `apiModel` is
 * what goes on the wire.
 */
export const TRIPO_MODELS: Record<string, TripoModel> = {
  'tripo-v3.1': { id: 'tripo-v3.1', name: 'Tripo v3.1', apiModel: 'v3.1-20260211', series: 'H', textToModel: true, imageToModel: true },
  'tripo-v3.0': { id: 'tripo-v3.0', name: 'Tripo v3.0', apiModel: 'v3.0-20250812', series: 'H', textToModel: true, imageToModel: true },
  'tripo-v2.5': { id: 'tripo-v2.5', name: 'Tripo v2.5', apiModel: 'v2.5-20250123', series: 'H', textToModel: true, imageToModel: true },
  'tripo-p1': { id: 'tripo-p1', name: 'Tripo P1', apiModel: 'P1-20260311', series: 'P', textToModel: true, imageToModel: true },
}

export const DEFAULT_TRIPO_MODEL = 'tripo-v3.1'

export function getTripoModel(modelId: string): TripoModel | undefined {
  return TRIPO_MODELS[modelId]
}

/** A model id starting `tripo-p` is the low-poly P-series; everything else is H. */
export function tripoSeries(model: string | undefined): 'H' | 'P' {
  return (model ?? '').startsWith('tripo-p') ? 'P' : 'H'
}

// ---------------------------------------------------------------------------
// Operation registry
// ---------------------------------------------------------------------------

export type TripoOp =
  | 'text_to_model'
  | 'image_to_model'
  | 'multiview_to_model'
  | 'texture'
  | 'convert'
  | 'retopology'
  | 'segment'
  | 'complete'
  | 'rig_check'
  | 'rig'
  | 'retarget'
  | 'import'

export const TRIPO_OPS: Record<TripoOp, {
  /** Path under `/v3`. */
  path: string
  /** What the caller must supply. `model` = an existing task/file/URL. */
  input: 'prompt' | 'image' | 'images' | 'model'
  /** Op parameters forwarded to Tripo. Anything else in the body is a 400. */
  fields: string[]
  /** What a successful task yields. */
  produces: 'model' | 'parts'
  estimateCredits(body: Record<string, unknown>): number
}> = {
  text_to_model: {
    path: '/generation/text-to-model',
    input: 'prompt',
    produces: 'model',
    fields: [
      'negative_prompt', 'model_seed', 'image_seed', 'face_limit', 'texture', 'pbr', 'texture_seed',
      'texture_quality', 'texture_version', 'delight', 'geometry_quality', 'auto_size', 'quad',
      'smart_low_poly', 'generate_parts', 'compress', 'export_orientation', 'export_uv',
    ],
    // H-series 10 / +10 textured; P-series 30 / 40. `model` is read by the route.
    estimateCredits: (body) => estimateGenerationCredits(body, 'text'),
  },
  image_to_model: {
    path: '/generation/image-to-model',
    input: 'image',
    produces: 'model',
    fields: [
      'enable_image_autofix', 'texture_alignment', 'orientation', 'face_limit', 'texture', 'pbr',
      'texture_seed', 'texture_quality', 'texture_version', 'delight', 'geometry_quality', 'auto_size',
      'quad', 'smart_low_poly', 'generate_parts', 'compress', 'export_orientation', 'export_uv', 'model_seed',
    ],
    estimateCredits: (body) => estimateGenerationCredits(body, 'image'),
  },
  multiview_to_model: {
    path: '/generation/multiview-to-model',
    input: 'images',
    produces: 'model',
    fields: [
      'texture_alignment', 'orientation', 'face_limit', 'texture', 'pbr', 'texture_seed',
      'texture_quality', 'texture_version', 'delight', 'geometry_quality', 'auto_size', 'quad',
      'smart_low_poly', 'compress', 'export_orientation', 'export_uv',
    ],
    estimateCredits: (body) => estimateGenerationCredits(body, 'multiview'),
  },
  texture: {
    path: '/models/texture',
    input: 'model',
    produces: 'model',
    fields: ['texture_prompt', 'pbr', 'texture_seed', 'texture_alignment', 'texture_quality', 'part_names', 'compress', 'bake', 'delight'],
    estimateCredits: (body) => textureTierCredits(String(body.texture_quality || 'standard')),
  },
  convert: {
    path: '/models/convert',
    input: 'model',
    produces: 'model',
    fields: [
      'format', 'quad', 'force_symmetry', 'face_limit', 'flatten_bottom', 'flatten_bottom_threshold',
      'texture_size', 'texture_format', 'bake', 'pack_uv', 'export_vertex_colors', 'pivot_to_center_bottom',
      'scale_factor', 'with_animation', 'animate_in_place', 'part_names', 'export_orientation', 'fbx_preset',
    ],
    estimateCredits: () => TRIPO_FIXED_CREDITS.convert,
  },
  retopology: {
    path: '/mesh/decimate',
    input: 'model',
    produces: 'model',
    fields: ['model', 'face_limit', 'quad', 'smart_uv', 'bake', 'part_names'],
    // v3.0 35 (40 with quad), v2.0 30, v1.0 10.
    estimateCredits: (body) => {
      const version = String(body.model || 'v2.0')
      const base = version.startsWith('v3') ? 35 : version.startsWith('v1') ? 10 : 30
      return base + (body.quad === true ? 5 : 0)
    },
  },
  segment: {
    path: '/mesh/segment',
    input: 'model',
    produces: 'parts',
    fields: ['model', 'segmentation_granularity', 'split_by_connectivity', 'ref_image'],
    estimateCredits: () => TRIPO_FIXED_CREDITS.segment,
  },
  complete: {
    path: '/mesh/complete',
    input: 'model',
    produces: 'model',
    fields: ['model', 'part_names', 'completion_mode'],
    estimateCredits: () => TRIPO_FIXED_CREDITS.complete,
  },
  rig_check: {
    path: '/animations/rig-check',
    input: 'model',
    produces: 'parts',
    fields: [],
    // Free: no wallet row is ever written for a zero-credit task.
    estimateCredits: () => 0,
  },
  rig: {
    path: '/animations/rig',
    input: 'model',
    produces: 'model',
    fields: ['model', 'rig_type', 'spec', 'out_format'],
    estimateCredits: () => TRIPO_FIXED_CREDITS.rig,
  },
  retarget: {
    path: '/animations/retarget',
    input: 'model',
    produces: 'model',
    fields: ['animation', 'animations', 'out_format', 'export_with_geometry', 'animate_in_place'],
    estimateCredits: (body) => {
      const animations = Array.isArray(body.animations) ? body.animations.length : body.animation ? 1 : 0
      // A retarget task always applies at least one animation; floor the
      // estimate at one so the listing and the queued response are not "$0".
      return Math.max(animations, 1) * TRIPO_FIXED_CREDITS.retargetPerAnimation
    },
  },
  import: {
    path: '/models/import',
    input: 'model',
    produces: 'model',
    fields: [],
    // Ingestion itself is free; the downstream op is what costs.
    estimateCredits: () => 0,
  },
}

/** Flat per-task credit prices from the published table. */
export const TRIPO_FIXED_CREDITS = {
  // Measured live 2026-10-18: FBX charged 10, USDZ on a small imported GLB
  // charged 5 — convert is priced by output format/size, so the flat figure
  // here is an upper bound for the pre-flight estimate. Billing always uses the
  // number Tripo reports for the finished task.
  convert: 10,
  segment: 40,
  // Measured live: 50, and it took 306s (the slowest op in the matrix).
  complete: 50,
  rig: 25,
  retargetPerAnimation: 10,
  import: 0,
} as const

const TRIPO_BASE_CREDITS = {
  H: { text: 10, image: 20, multiview: 20 },
  P: { text: 30, image: 40, multiview: 40 },
} as const

const TRIPO_TEXTURE_CREDITS: Record<string, number> = {
  none: 0,
  fast: 10,
  standard: 10,
  detailed: 20,
  extreme: 30,
}

/** A standalone `/models/texture` task prices the output tier directly. */
function textureTierCredits(quality: string): number {
  return TRIPO_TEXTURE_CREDITS[quality] ?? TRIPO_TEXTURE_CREDITS.standard
}

/**
 * Generation credits: series base, plus the texture surcharge. `pbr: true`
 * forces texturing upstream, so it counts as textured too.
 */
function estimateGenerationCredits(
  body: Record<string, unknown>,
  mode: 'text' | 'image' | 'multiview',
): number {
  const series = tripoSeries(typeof body.model === 'string' ? body.model : undefined)
  const texture = body.pbr === true || body.texture !== false
  const quality = String(body.texture_quality || 'standard')
  const surcharge = texture ? (TRIPO_TEXTURE_CREDITS[quality] ?? TRIPO_TEXTURE_CREDITS.standard) : 0
  return TRIPO_BASE_CREDITS[series][mode] + surcharge
}

/** Credits for one op body, from the registry. */
export function estimateTripoCredits(op: TripoOp, body: Record<string, unknown> = {}): number {
  const spec = TRIPO_OPS[op]
  if (!spec) return 0
  return spec.estimateCredits(body)
}

/** Multiview is documented as exactly four views: front, left, back, right. */
export const TRIPO_MULTIVIEW_ORDER = ['front', 'left', 'back', 'right'] as const

/** Export formats `/models/convert` accepts. */
export const TRIPO_CONVERT_FORMATS = ['GLTF', 'FBX', 'USDZ', 'OBJ', 'STL', '3MF'] as const

/** Retarget accepts at most five animations per task. */
export const TRIPO_MAX_ANIMATIONS = 5

/**
 * Rig model versions. These are NOT the generation model ids above: the
 * animations endpoints reject generation versions (verified live 2026-10-18 —
 * omitting `model` falls back to `v2.5-20250123`, which the API now refuses).
 */
export const TRIPO_RIG_MODELS = ['v1.0-20240301', 'v2.5-20260210', 'v3.0-20260909'] as const
export const DEFAULT_TRIPO_RIG_MODEL = 'v2.5-20260210'

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

interface TripoEnvelope<T> {
  code: number
  message?: string
  suggestion?: string
  data?: T
}

function tripoHeaders(apiKey: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (contentType) headers['Content-Type'] = contentType
  return headers
}

/** A Tripo API failure, carrying the upstream HTTP status for the route's mapping. */
export class TripoApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'TripoApiError'
    this.status = status
  }
}

/** `{ message, suggestion }` from a non-zero envelope or an HTTP error body. */
function tripoErrorMessage(status: number, body: unknown): string {
  const envelope = (body ?? {}) as TripoEnvelope<unknown>
  const parts = [envelope.message, envelope.suggestion].filter((p): p is string => !!p)
  if (parts.length > 0) return parts.join(' — ')
  return `Tripo request failed (${status})`
}

async function tripoRequest<T>(
  apiKey: string,
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${TRIPO_API_BASE}${path}`, {
    ...init,
    headers: { ...tripoHeaders(apiKey), ...(init.headers as Record<string, string> | undefined) },
    signal,
  })
  const body = await response.json().catch(() => null) as TripoEnvelope<T> | null
  if (!response.ok || !body || body.code !== 0) {
    throw new TripoApiError(tripoErrorMessage(response.status, body), response.status)
  }
  return (body.data ?? {}) as T
}

/** Submit a task to any `/v3` path and return its id. */
export async function tripoCreateTask(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const data = await tripoRequest<{ task_id?: string }>(apiKey, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, signal)
  if (!data.task_id) throw new Error('Tripo returned no task id')
  return data.task_id
}

export type TripoTaskStatus = 'queued' | 'running' | 'success' | 'failed'

export interface TripoTask {
  status: TripoTaskStatus
  progress?: number
  output?: { model_url?: string; model_urls?: string[]; part_names?: string[]; [key: string]: unknown }
  creditsConsumed?: number
  errorCode?: number
  errorMessage?: string
  /** rig-check only. */
  riggable?: boolean
  rigType?: string
}

/**
 * Poll one task. Tripo reports `cancelled` too; it surfaces as `failed` so a
 * caller never has to special-case it (and it is never billed).
 */
export async function tripoGetTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TripoTask> {
  const data = await tripoRequest<{
    status?: string
    progress?: number
    output?: TripoTask['output']
    credits_consumed?: number
    error_code?: number
    error_message?: string
    riggable?: boolean
    rig_type?: string
  }>(apiKey, `/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' }, signal)

  const raw = data.status ?? 'queued'
  const status: TripoTaskStatus =
    raw === 'success' || raw === 'failed' ? raw : raw === 'cancelled' ? 'failed' : raw === 'running' ? 'running' : 'queued'

  return {
    status,
    progress: typeof data.progress === 'number' ? data.progress : undefined,
    output: data.output,
    creditsConsumed: typeof data.credits_consumed === 'number' ? data.credits_consumed : undefined,
    errorCode: data.error_code,
    ...(status === 'failed' && raw === 'cancelled' ? { errorMessage: 'Task was cancelled' } : {}),
    ...(data.error_message ? { errorMessage: data.error_message } : {}),
    ...(typeof data.riggable === 'boolean' ? { riggable: data.riggable } : {}),
    ...(typeof data.rig_type === 'string' ? { rigType: data.rig_type } : {}),
  }
}

/**
 * Upload a file and return its `file_token`. Multipart field name is `file`;
 * images are JPEG/PNG/WebP (20 MB), models GLB/GLTF/FBX/OBJ/STL (150 MB).
 */
export async function tripoUploadFile(
  apiKey: string,
  bytes: Uint8Array,
  contentType: string,
  filename?: string,
  signal?: AbortSignal,
): Promise<string> {
  const extension = contentType === 'image/jpeg'
    ? 'jpg'
    : contentType === 'image/webp'
      ? 'webp'
      : contentType === 'image/png'
        ? 'png'
        : 'glb'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), filename || `input.${extension}`)

  const response = await fetch(`${TRIPO_API_BASE}/files`, {
    method: 'POST',
    headers: tripoHeaders(apiKey),
    body: form,
    signal,
  })
  const body = await response.json().catch(() => null) as TripoEnvelope<{ file_token?: string }> | null
  if (!response.ok || !body || body.code !== 0) {
    throw new TripoApiError(tripoErrorMessage(response.status, body), response.status)
  }
  const token = body.data?.file_token
  if (!token) throw new Error('Tripo returned no file token')
  return token
}

/** Decode a `data:` URI into bytes plus its content type. */
export function parseDataUri(dataUri: string): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri)
  if (!match) throw new Error('Malformed data URI')
  const contentType = match[1] || 'application/octet-stream'
  const bytes = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]))
  return { bytes: new Uint8Array(bytes), contentType }
}

export function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/i.test(value)
}

export function isFileToken(value: string): boolean {
  return /^file_[A-Za-z0-9]+$/.test(value)
}

export function isTaskId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
