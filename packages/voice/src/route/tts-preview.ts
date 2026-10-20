// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in `POST /voice/tts-preview` handler.
 *
 * In runtime-token proxy mode this forwards to the Shogo API's hosted
 * `POST /api/voice/tts` (pooled key, project-scoped, no per-user context), so
 * pods get real audio with zero configuration. Provide `text` in the body;
 * `voiceId` / `modelId` are optional (defaults: the project's voice,
 * `eleven_v4_turbo`). In BYO-EL mode it needs `apiKey` plus, for the
 * companion-flavoured preview line, `getUser`/`companionStore`.
 *
 * @example
 * ```ts
 * // app/api/voice/tts-preview+api.ts (Expo Router)
 * export { POST } from '@shogo-ai/sdk/voice/route/tts-preview'
 * ```
 */

import { defaultHandlers } from './index.js'

export const POST = (req: Request): Promise<Response> => defaultHandlers().tts(req)
