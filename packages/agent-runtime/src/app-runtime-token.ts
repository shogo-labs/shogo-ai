// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-project runtime tokens for the app servers a workspace runtime starts.
 *
 * The runtime's own RUNTIME_AUTH_SECRET is the workspace token, which every
 * project in the workspace accepts. An app server runs user code, so it gets
 * its project's `rt_v1_*` token instead: the SDK uses it for the Shogo API
 * (LLM, voice) and for the runtime's tool execute/schemas routes, which accept
 * only tokens this module handed out.
 */

const FETCH_TIMEOUT_MS = 10_000

const tokensByProject = new Map<string, string>()

type TokenRequest = (path: string) => Promise<Response | null>

const requestInternalApi: TokenRequest = async (path) => {
  const { deriveApiUrl, getInternalHeaders } = await import('./internal-api')
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return null
  return fetch(`${apiUrl}${path}`, {
    headers: getInternalHeaders(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

/** The project's runtime token, fetched once from the API. Null when unavailable. */
export async function fetchAppRuntimeToken(
  projectId: string,
  request: TokenRequest = requestInternalApi,
): Promise<string | null> {
  const cached = tokensByProject.get(projectId)
  if (cached) return cached
  try {
    const res = await request(
      `/api/internal/projects/${encodeURIComponent(projectId)}/app-runtime-token`,
    )
    if (!res) return null
    if (!res.ok) {
      console.warn(`[app-runtime-token] ${projectId}: API returned ${res.status}`)
      return null
    }
    const body = (await res.json()) as { token?: unknown }
    if (typeof body.token !== 'string' || !body.token) return null
    tokensByProject.set(projectId, body.token)
    return body.token
  } catch (err: any) {
    console.warn(`[app-runtime-token] ${projectId}: ${err?.message ?? err}`)
    return null
  }
}

/** True when `token` was issued to one of this runtime's app servers. */
export function isAppRuntimeToken(token: string): boolean {
  if (!token) return false
  for (const issued of tokensByProject.values()) {
    if (issued === token) return true
  }
  return false
}

/** The runtime routes an app's SDK tools client calls. */
const APP_TOOL_PATHS = new Set(['/agent/tools/execute', '/agent/tools/schemas'])

/** `acceptsScopedToken` for the agent runtime: app tokens may call the tool routes only. */
export function acceptsAppToolToken(path: string, token: string): boolean {
  return APP_TOOL_PATHS.has(path) && isAppRuntimeToken(token)
}

/** @internal */
export function _resetAppRuntimeTokensForTests(): void {
  tokensByProject.clear()
}
