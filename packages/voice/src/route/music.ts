// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in `POST /voice/music` handler — generate music via the
 * ElevenLabs Music API. Returns raw audio bytes.
 *
 * Unlike companion CRUD, music generation is project-scoped (not
 * per-end-user), so it works in BOTH BYO-EL and runtime-token proxy
 * mode. In proxy mode it forwards to the Shogo API, which holds the
 * pooled EL key.
 *
 * Body mirrors `ComposeMusicParams`: provide exactly one of `prompt`
 * or `compositionPlan`, plus optional `musicLengthMs`, `modelId`,
 * `forceInstrumental`, `outputFormat`.
 *
 * @example
 * ```ts
 * // app/api/voice/music+api.ts (Expo Router)
 * export { POST } from '@shogo-ai/sdk/voice/route/music'
 * ```
 */

import { defaultHandlers } from './index.js'

export const POST = (req: Request): Promise<Response> => defaultHandlers().music(req)
