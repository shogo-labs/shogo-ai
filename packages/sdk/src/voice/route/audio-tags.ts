// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in `GET /voice/audio-tags` handler.
 *
 * Returns the static catalog of supported audio tags + expressivity
 * options + voice-settings defaults. Safe in any mode (no auth, no
 * network).
 *
 * @example
 * ```ts
 * // app/api/voice/audio-tags+api.ts (Expo Router)
 * export { GET } from '@shogo-ai/sdk/voice/route/audio-tags'
 * ```
 */

import { defaultHandlers } from './index.js'

export const GET = (req: Request): Promise<Response> => defaultHandlers().audioTags(req)
