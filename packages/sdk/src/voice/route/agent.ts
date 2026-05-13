// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Drop-in companion CRUD handlers (`POST` / `PATCH` / `DELETE`) on
 * the `/voice/agent` resource.
 *
 * Note: in runtime-token proxy mode all three return 501 — companion
 * CRUD requires a per-user context that pod apps don't own. Use
 * `createVoiceRoute({ apiKey, getUser, companionStore })` from
 * `@shogo-ai/sdk/voice/route` for BYO-EL deployments.
 *
 * @example
 * ```ts
 * // app/api/voice/agent+api.ts (Expo Router)
 * export { POST, PATCH, DELETE } from '@shogo-ai/sdk/voice/route/agent'
 * ```
 */

import { defaultHandlers } from './index.js'

export const POST = (req: Request): Promise<Response> => defaultHandlers().agent.create(req)
export const PATCH = (req: Request): Promise<Response> => defaultHandlers().agent.patch(req)
export const DELETE = (req: Request): Promise<Response> => defaultHandlers().agent.delete(req)
