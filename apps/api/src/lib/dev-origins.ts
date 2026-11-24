// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Origins the API accepts outside its configured allow-list (CORS + CSRF).
 *
 * `Origin: null` is what a sandboxed iframe or a `data:` page on ANY site sends,
 * so accepting it with credentials lets every website make credentialed calls
 * (SEC-3). The desktop's Electron custom scheme is the only legitimate sender,
 * so `null` is accepted only on a local API, never on a deployed one. Staging
 * runs NODE_ENV=staging, which the old `!== 'production'` test treated as dev.
 */

import { isLocalDevelopmentEnv } from './native-oauth-trust'

export function isDevOriginAllowed(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const localMode = env.SHOGO_LOCAL_MODE === 'true'
  if (origin === 'null') return localMode || isLocalDevelopmentEnv(env.NODE_ENV)
  const nonProduction = env.NODE_ENV !== 'production' || localMode
  if (!nonProduction) return false
  return (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('shogo://') ||
    /^http:\/\/192\.168\.\d+\.\d+/.test(origin)
  )
}
