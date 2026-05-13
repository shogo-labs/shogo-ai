// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in `POST /voice/tts-preview` handler.
 *
 * Note: in runtime-token proxy mode this returns 501 — TTS preview
 * requires a per-user companion context that pod apps don't own.
 * Use `createVoiceRoute({ apiKey, getUser, companionStore })` from
 * `@shogo-ai/sdk/voice/route` for BYO-EL deployments.
 *
 * @example
 * ```ts
 * // app/api/voice/tts-preview+api.ts (Expo Router)
 * export { POST } from '@shogo-ai/sdk/voice/route/tts-preview'
 * ```
 */

import { defaultHandlers } from './index.js'

export const POST = (req: Request): Promise<Response> => defaultHandlers().tts(req)
