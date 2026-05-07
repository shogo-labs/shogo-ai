// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in `GET /voice/signed-url` handler.
 *
 * @example
 * ```ts
 * // app/api/voice/signed-url+api.ts (Expo Router)
 * export { GET } from '@shogo-ai/sdk/voice/route/signed-url'
 * ```
 */

import { defaultHandlers } from './index.js'

export const GET = (req: Request): Promise<Response> => defaultHandlers().signedUrl(req)
