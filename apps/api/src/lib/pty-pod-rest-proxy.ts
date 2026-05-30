// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * REST half of the studio↔pod terminal bridge. Forwards the three
 * /api/projects/:projectId/terminal/sessions[...] HTTP calls to the
 * per-project runtime pod's matching /terminal/sessions[...] routes
 * (see packages/agent-runtime/src/runtime-terminal-routes.ts).
 *
 * The WS half lives in pty-pod-bridge.ts. Both are reached only when
 * `isKubernetes()` is true on the studio gateway. Desktop terminals
 * never touch either file — they go through Electron IPC.
 *
 * Failure model mirrors the `/terminal/commands` proxy in server.ts:
 *   - upstream JSON error → passed through verbatim
 *   - upstream non-JSON 5xx (Knative HTML 503 etc.) → wrapped in
 *     `{ error: { code, message } }` so the studio client can render it
 *     without parsing Knative HTML
 *   - pod resolution throws → 503 `pod_unavailable`
 *   - invalid projectId at the gateway → 400 `invalid_project_id`
 */

const HOP_BY_HOP = new Set(['transfer-encoding', 'connection'])

export interface ProxyDeps {
  /** Resolves `getProjectPodUrl(projectId)` → http(s):// origin of the pod. */
  resolvePodUrl: (projectId: string) => Promise<string>
  /** Derives the shared `x-runtime-token` for the pod's auth middleware. */
  deriveRuntimeToken: (projectId: string) => string
  /** Guard against path-traversal / weird ids before we hit the resolver. */
  isSafeProjectId: (id: string) => boolean
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Diagnostics sink. Defaults to `console`. */
  logger?: { error(...args: unknown[]): void }
}

export interface ProxyOptions {
  projectId: string
  method: 'POST' | 'GET' | 'DELETE'
  /** Suffix appended after `/terminal/sessions` (e.g. '' for list/create, `/${id}` for delete). */
  pathSuffix: string
  body: string | undefined
  contentType: string | undefined
}

export async function proxyTerminalSessionsToPod(
  deps: ProxyDeps,
  opts: ProxyOptions,
): Promise<Response> {
  const { resolvePodUrl, deriveRuntimeToken, isSafeProjectId, logger = console } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  const { projectId, method, pathSuffix, body, contentType } = opts

  if (!isSafeProjectId(projectId)) {
    return Response.json(
      { error: { code: 'invalid_project_id', message: 'Invalid project id' } },
      { status: 400 },
    )
  }
  try {
    const podUrl = await resolvePodUrl(projectId)
    const targetUrl = `${trimTrailingSlash(podUrl)}/terminal/sessions${pathSuffix}`
    const headers: Record<string, string> = { 'x-runtime-token': deriveRuntimeToken(projectId) }
    if (body !== undefined) {
      headers['content-type'] = contentType ?? 'application/json'
    }
    const response = await fetchImpl(targetUrl, { method, headers, body })

    if (!response.ok) {
      const upstreamContentType = response.headers.get('content-type') || ''
      if (upstreamContentType.includes('application/json')) {
        return new Response(response.body, {
          status: response.status,
          headers: filteredHeaders(response.headers),
        })
      }
      const errorCode = response.status === 503 ? 'service_starting'
        : response.status === 502 ? 'service_unavailable'
        : 'upstream_error'
      if (response.status !== 503) {
        logger.error(`[TerminalProxy] sessions ${method} ${pathSuffix || '/'} upstream ${response.status}`)
      }
      const errHeaders = new Headers({ 'content-type': 'application/json' })
      if (response.status === 503) errHeaders.set('Retry-After', '5')
      return new Response(
        JSON.stringify({ error: { code: errorCode, message: `Terminal service unavailable (${response.status})` } }),
        { status: response.status, headers: errHeaders },
      )
    }

    return new Response(response.body, {
      status: response.status,
      headers: filteredHeaders(response.headers),
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`[TerminalProxy] sessions ${method} ${pathSuffix || '/'} pod-unreachable:`, msg)
    return Response.json({ error: { code: 'pod_unavailable', message: msg } }, { status: 503 })
  }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s
}

function filteredHeaders(src: Headers): Headers {
  const out = new Headers()
  src.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value)
  })
  return out
}
