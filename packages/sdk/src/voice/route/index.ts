// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/voice/route
 *
 * Drop-in route handlers for any Web-Standard router that dispatches
 * by HTTP method export (Expo Router `+api.ts`, Next.js App Router
 * `route.ts`, Cloudflare Workers, Bun.serve, Deno, Hono, etc.).
 *
 * The per-resource sub-modules (`./signed-url`, `./tts-preview`,
 * `./agent`, `./audio-tags`) re-export pre-instantiated `GET`/`POST`/
 * `PATCH`/`DELETE` handlers that delegate to {@link createVoiceHandlers}
 * with zero configuration — pod apps just point a route file at them:
 *
 * @example Expo Router (zero-config, runtime-token proxy mode)
 * ```ts
 * // app/api/voice/signed-url+api.ts
 * export { GET } from '@shogo-ai/sdk/voice/route/signed-url'
 *
 * // app/api/voice/audio-tags+api.ts
 * export { GET } from '@shogo-ai/sdk/voice/route/audio-tags'
 *
 * // app/api/voice/tts-preview+api.ts
 * export { POST } from '@shogo-ai/sdk/voice/route/tts-preview'
 *
 * // app/api/voice/agent+api.ts
 * export { POST, PATCH, DELETE } from '@shogo-ai/sdk/voice/route/agent'
 * ```
 *
 * In a Shogo-managed pod, `RUNTIME_AUTH_SECRET` and `PROJECT_ID` are
 * injected automatically; `createVoiceHandlers({})` detects them and
 * proxies to the Shogo API. No keys, no `getUser`, no companion store
 * are required for the proxy path.
 *
 * @example Next.js App Router (BYO ElevenLabs)
 * ```ts
 * // app/api/voice/route.ts — when you own the EL key + user/companion stores
 * import { createVoiceRoute } from '@shogo-ai/sdk/voice/route'
 *
 * const voice = createVoiceRoute({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 *   getUser: async (req) => authenticate(req),
 *   companionStore: new PrismaCompanionStore(prisma),
 * })
 *
 * export const { GET } = voice.signedUrl
 * ```
 */

import {
  createVoiceHandlers,
  type VoiceHandlers,
  type VoiceHandlersConfig,
} from '../server.js'

/**
 * Lazily build a {@link VoiceHandlers} instance per request using
 * environment-driven config. Used by the per-resource modules so that
 * `process.env` reads happen at request time (some runtimes populate
 * env after module evaluation) and so tests can mutate env between
 * cases without poisoning a cached handler.
 *
 * Instantiation cost is negligible — proxy mode just snapshots a few
 * env vars; BYO mode constructs a single `ElevenLabsClient`.
 *
 * @internal Public for tests; not part of the stable surface.
 */
export function defaultHandlers(): VoiceHandlers {
  return createVoiceHandlers({})
}

/**
 * Per-resource route exports keyed by HTTP method.
 *
 * Maps directly onto the file convention used by Expo Router /
 * Next.js App Router / etc.: each property is an object whose keys
 * are method names and whose values are `(req: Request) =>
 * Promise<Response>` handlers.
 */
export interface VoiceRoute {
  /** `GET /voice/signed-url` */
  signedUrl: { GET: (req: Request) => Promise<Response> }
  /** `POST /voice/tts-preview` */
  ttsPreview: { POST: (req: Request) => Promise<Response> }
  /** `POST | PATCH | DELETE /voice/agent` */
  agent: {
    POST: (req: Request) => Promise<Response>
    PATCH: (req: Request) => Promise<Response>
    DELETE: (req: Request) => Promise<Response>
  }
  /** `GET /voice/audio-tags` */
  audioTags: { GET: (req: Request) => Promise<Response> }
}

/**
 * Build per-resource route handlers from an explicit
 * {@link VoiceHandlersConfig}. Use this when you need to pass
 * `apiKey` / `getUser` / `companionStore` (BYO ElevenLabs mode) or
 * an explicit `proxy` override — the zero-config per-resource
 * modules cover the pod auto-detect case.
 *
 * @example
 * ```ts
 * const voice = createVoiceRoute({
 *   apiKey: process.env.ELEVENLABS_API_KEY!,
 *   getUser: async (req) => authenticate(req),
 *   companionStore: new PrismaCompanionStore(prisma),
 * })
 *
 * // Re-export under whatever route file the framework expects:
 * export const { GET } = voice.signedUrl
 * export const { POST, PATCH, DELETE } = voice.agent
 * ```
 */
export function createVoiceRoute(config: VoiceHandlersConfig): VoiceRoute {
  const v = createVoiceHandlers(config)
  return {
    signedUrl: { GET: (req: Request) => v.signedUrl(req) },
    ttsPreview: { POST: (req: Request) => v.tts(req) },
    agent: {
      POST: (req: Request) => v.agent.create(req),
      PATCH: (req: Request) => v.agent.patch(req),
      DELETE: (req: Request) => v.agent.delete(req),
    },
    audioTags: { GET: (req: Request) => v.audioTags(req) },
  }
}
