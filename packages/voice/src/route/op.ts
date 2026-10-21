// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in handler for every voice op in the registry.
 *
 * One route file mounts every op — `/api/voice/op/<opId>` — because the id
 * comes from the URL (or `?op=`). Nothing here lists the ops: adding a row to
 * `VOICE_OPS` makes it reachable, in BYO mode and in runtime-token proxy mode.
 *
 * @example Expo Router — mount once, serve every op (present and future)
 * ```ts
 * // app/api/voice/op/[opId]+api.ts
 * export { GET, POST } from '@shogo-ai/sdk/voice/route/op'
 * ```
 *
 * @example Next.js App Router
 * ```ts
 * // app/api/voice/op/[opId]/route.ts
 * export { GET, POST } from '@shogo-ai/sdk/voice/route/op'
 * ```
 *
 * @example Hono / Bun / Deno (no dynamic file convention)
 * ```ts
 * import { defaultHandlers } from '@shogo-ai/sdk/voice/route'
 * app.all('/voice/op/:opId', (c) => defaultHandlers().op(c.req.raw, c.req.param('opId')))
 * ```
 *
 * `voiceOpRoutes` is the same handlers keyed by op id, for the frameworks
 * that want one route file per op:
 * ```ts
 * import { voiceOpRoutes } from '@shogo-ai/sdk/voice/route/op'
 * export const { POST } = voiceOpRoutes['speech-to-speech']
 * ```
 */

import { VOICE_OPS } from '../ops.js'
import { defaultHandlers } from './index.js'

/** `GET` — for the listing ops (`voices`, `models`). */
export const GET = (req: Request): Promise<Response> => defaultHandlers().op(req)

/** `POST` — for every media op (`speech-to-speech`, `sound-generation`, …). */
export const POST = (req: Request): Promise<Response> => defaultHandlers().op(req)

/** Per-op handlers keyed by registry id, built from {@link VOICE_OPS}. */
export const voiceOpRoutes: Readonly<
  Record<string, { GET: (req: Request) => Promise<Response>; POST: (req: Request) => Promise<Response> }>
> = Object.fromEntries(
  VOICE_OPS.map((op) => [
    op.id,
    {
      GET: (req: Request) => defaultHandlers().op(req, op.id),
      POST: (req: Request) => defaultHandlers().op(req, op.id),
    },
  ]),
)
