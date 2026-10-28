// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Lyria music generation through the Shogo AI proxy
 * (`POST /api/ai/v1/music/generations`). Same credentials as `client.llm`:
 * the pod's `RUNTIME_AUTH_SECRET`, or a `shogo_sk_*` key outside a pod. The
 * proxy holds the Google key and bills the workspace per song.
 */

import { DEFAULT_SHOGO_CLOUD_URL } from './index.js'

export interface GenerateMusicRequest {
  /** Style, mood, instruments, tempo and structure. Ask for a length here. */
  prompt: string
  /** `lyria-3-clip` (default, 30-second clip) or `lyria-3.5` (full song). */
  model?: 'lyria-3-clip' | 'lyria-3.5' | (string & {})
  /** Custom lyrics, tagged [Verse] / [Chorus] / [Bridge]. */
  lyrics?: string
  /** No vocals. Cannot be combined with `lyrics`. */
  instrumental?: boolean
}

export interface GenerateMusicResult {
  /** Catalog id that was billed. */
  model: string
  mimeType: string
  /** Base64-encoded audio (MP3 by default). */
  base64: string
  /** Decoded audio bytes. */
  bytes: Uint8Array
  /** Lyrics / song structure the model returned, when any. */
  lyrics?: string
  /** What the workspace was charged, in USD. */
  billedUsd?: number
}

export interface CreateShogoMusicOptions {
  apiKey?: string
  runtimeToken?: string
  /** Shogo base URL without `/api/ai/v1`. Defaults to Shogo Cloud. */
  baseUrl?: string
  fetch?: typeof fetch
}

export type ShogoMusicGenerator = (request: GenerateMusicRequest, init?: { signal?: AbortSignal }) => Promise<GenerateMusicResult>

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function createShogoMusicGenerator(opts: CreateShogoMusicOptions): ShogoMusicGenerator {
  const token = opts.apiKey ?? opts.runtimeToken
  if (!token || (opts.apiKey && opts.runtimeToken)) {
    throw new Error('createShogoMusicGenerator: pass exactly one of `apiKey` or `runtimeToken`.')
  }
  const root = (opts.baseUrl ?? DEFAULT_SHOGO_CLOUD_URL).replace(/\/$/, '')
  const doFetch = opts.fetch ?? fetch

  return async (request, init) => {
    const response = await doFetch(`${root}/api/ai/v1/music/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: init?.signal,
    })
    const body = (await response.json().catch(() => null)) as any
    if (!response.ok) {
      const message = body?.error?.message ?? `Music generation failed (HTTP ${response.status})`
      const error = new Error(message) as Error & { status?: number; code?: string }
      error.status = response.status
      error.code = body?.error?.code
      throw error
    }
    const base64 = body?.audio?.b64_json
    if (typeof base64 !== 'string' || !base64) throw new Error('Music generation returned no audio.')
    return {
      model: body.model,
      mimeType: body.audio.mime_type ?? 'audio/mpeg',
      base64,
      bytes: decodeBase64(base64),
      ...(body.text ? { lyrics: body.text } : {}),
      ...(typeof body.usd?.billed === 'number' ? { billedUsd: body.usd.billed } : {}),
    }
  }
}
