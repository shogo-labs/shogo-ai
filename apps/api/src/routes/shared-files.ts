// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { pinChatToHomeRegion, pinWorkspaceToHomeRegion } from '../lib/chat-region-pin'
import { deriveProjectRuntimeToken } from '../lib/project-runtime-token'
import { deriveWorkspaceRuntimeToken } from '../lib/workspace-runtime-token'
import { resolveWorkspaceRuntimeUrl as resolveWorkspaceRuntime } from '../lib/resolve-workspace-runtime-url'
import { resolveAgentProxyPodUrl } from '../lib/agent-proxy-resolver'
import { relayAgentProxyViaTunnel } from '../lib/tunnel-relay'
import { verifySharedFileToken } from '../lib/shared-file-token'
import { importCloudModule } from '../lib/cloud-import'
import { isMetalEnabled } from '../lib/metal-eligibility'

// Kept short: a long in-request retry holds an API slot per download, and a
// pileup of those under cold starts is what OOM-killed API pods before (see
// project-chat.ts). The caller can retry a 503 itself.
const RUNTIME_RETRY_DELAYS_MS = [500, 1500, 3000]

/**
 * Runtime answers worth one more try against a freshly resolved URL. A 401/403
 * means the runtime at that URL is not (yet) bound to this workspace — a
 * warm-pool assign race or a stale cached URL — since the API just derived
 * the token itself.
 */
function isTransientRuntimeStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

async function invalidateMetalRuntimeUrl(projectId: string): Promise<void> {
  if (!isMetalEnabled()) return
  const { getMetalWarmPoolController, workspaceRuntimeKey } =
    await importCloudModule<typeof import('../lib/metal-warm-pool-controller')>('../lib/metal-warm-pool-controller')
  getMetalWarmPoolController().invalidateUrlCache(workspaceRuntimeKey('', projectId))
}

async function invalidateMetalWorkspaceRuntimeUrl(workspaceId: string): Promise<void> {
  if (!isMetalEnabled()) return
  const { getMetalWarmPoolController, workspaceRuntimeKey } =
    await importCloudModule<typeof import('../lib/metal-warm-pool-controller')>('../lib/metal-warm-pool-controller')
  getMetalWarmPoolController().invalidateUrlCache(workspaceRuntimeKey(workspaceId))
}

async function defaultResolveWorkspaceRuntimeUrl(workspaceId: string): Promise<string> {
  const resolved = await resolveWorkspaceRuntime(workspaceId, { attachedProjectIds: [], logTag: 'SharedFiles' })
  return resolved.url
}

const DOWNLOAD_LIMIT = 120
const DOWNLOAD_WINDOW_MS = 60_000
const downloadRateLimit = new Map<string, { count: number; resetAt: number }>()

function clientKey(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
}

function allowedByRateLimit(key: string): boolean {
  const now = Date.now()
  const current = downloadRateLimit.get(key)
  if (!current || current.resetAt <= now) {
    downloadRateLimit.set(key, { count: 1, resetAt: now + DOWNLOAD_WINDOW_MS })
    return true
  }
  current.count++
  return current.count <= DOWNLOAD_LIMIT
}

function safeFilename(path: string): string {
  const basename = path.split('/').pop() || 'download'
  const sanitized = basename
    .replace(/[\u0000-\u001f\u007f"\\]/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 255)
  return sanitized || 'download'
}

function extension(path: string): string {
  const basename = path.split('/').pop() || ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ''
}

function downloadHeaders(path: string, upstream?: Headers): Headers {
  const headers = new Headers()
  const contentType = upstream?.get('content-type') || 'application/octet-stream'
  const risky = new Set(['exe', 'msi', 'dmg', 'pkg', 'apk', 'ipa', 'appimage', 'deb', 'rpm', 'html', 'htm', 'svg'])
  headers.set('Content-Type', risky.has(extension(path)) ? 'application/octet-stream' : contentType)
  const filename = safeFilename(path)
  const asciiFilename = filename.replace(/[^\x20-\x7e]/g, '_')
  const disposition = `attachment; filename="${asciiFilename}"`
  headers.set(
    'Content-Disposition',
    asciiFilename === filename
      ? disposition
      : `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
  )
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'private, no-store')
  for (const name of ['content-length', 'cross-origin-resource-policy', 'etag', 'last-modified']) {
    const value = upstream?.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

function encodeRuntimePath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

export interface SharedFileDownloadShape {
  path: string
  /**
   * `project` asks the runtime for its own project root. Without it the
   * runtime reads the merged workspace root, where a project is mounted at
   * `<projectId>/…`.
   */
  scope?: 'project'
}

/**
 * The roots a signed path can be read from, in the order worth trying.
 *
 * A project link signs `path` relative to the *project* root (SHO-67), but a
 * workspace runtime mounts that project at `<workspaceDir>/<projectId>` inside
 * the merged root that an unscoped read walks — so the merged-root read needs
 * the prefix back. `?scope=project` is the same file when the runtime's own
 * project is this one. The path as signed covers links minted before SHO-67
 * (workspace-relative, sometimes already carrying `<projectId>/`).
 *
 * The mint cannot check this: the API signs what the runtime reported and has
 * only the pod's word for where the file is (the local app resolves it, the
 * cloud app cannot reach the filesystem), so the read side has to know every
 * shape a link can legitimately mean.
 */
export function sharedFileDownloadShapes(
  signedPath: string,
  projectId?: string,
): SharedFileDownloadShape[] {
  if (!projectId) return [{ path: signedPath }]

  if (signedPath.startsWith(`${projectId}/`)) {
    const stripped = signedPath.slice(projectId.length + 1)
    const shapes: SharedFileDownloadShape[] = [{ path: signedPath }]
    if (stripped) shapes.push({ path: stripped }, { path: stripped, scope: 'project' })
    return shapes
  }

  return [
    { path: `${projectId}/${signedPath}` },
    { path: signedPath, scope: 'project' },
    { path: signedPath },
  ]
}

export interface SharedFileRouteDeps {
  pinChatToHomeRegion?: typeof pinChatToHomeRegion
  pinWorkspaceToHomeRegion?: typeof pinWorkspaceToHomeRegion
  resolveAgentProxyPodUrl?: typeof resolveAgentProxyPodUrl
  resolveWorkspaceRuntimeUrl?: (workspaceId: string) => Promise<string>
  deriveProjectRuntimeToken?: typeof deriveProjectRuntimeToken
  deriveWorkspaceRuntimeToken?: typeof deriveWorkspaceRuntimeToken
  relayAgentProxyViaTunnel?: typeof relayAgentProxyViaTunnel
  invalidateRuntimeUrl?: (projectId: string) => Promise<void>
  invalidateWorkspaceRuntimeUrl?: (workspaceId: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

function runtimeUnavailable(c: any): Response {
  c.header('Retry-After', '5')
  return c.json({ error: { code: 'runtime_unavailable', message: 'The file runtime is unavailable, please retry' } }, 503)
}

export function sharedFileRoutes(deps: SharedFileRouteDeps = {}): Hono {
  const app = new Hono()
  const pinHome = deps.pinChatToHomeRegion ?? pinChatToHomeRegion
  const pinWorkspaceHome = deps.pinWorkspaceToHomeRegion ?? pinWorkspaceToHomeRegion
  const resolveRuntime = deps.resolveAgentProxyPodUrl ?? resolveAgentProxyPodUrl
  const resolveWorkspaceRuntimeUrl = deps.resolveWorkspaceRuntimeUrl ?? defaultResolveWorkspaceRuntimeUrl
  const deriveToken = deps.deriveProjectRuntimeToken ?? deriveProjectRuntimeToken
  const deriveWorkspaceToken = deps.deriveWorkspaceRuntimeToken ?? deriveWorkspaceRuntimeToken
  const relayTunnel = deps.relayAgentProxyViaTunnel ?? relayAgentProxyViaTunnel
  const invalidateRuntimeUrl = deps.invalidateRuntimeUrl ?? invalidateMetalRuntimeUrl
  const invalidateWorkspaceRuntimeUrl = deps.invalidateWorkspaceRuntimeUrl ?? invalidateMetalWorkspaceRuntimeUrl
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  // Minted links use `/api/f/`: on the public studio origin only `/api/*`
  // reaches the API, while bare `/f/` falls through to the web app. `/f/` stays
  // for links already handed out against the API host.
  app.get('/api/f/:token', (c) => handleDownload(c))
  app.get('/f/:token', (c) => handleDownload(c))

  async function handleDownload(c: any): Promise<Response> {
    if (!allowedByRateLimit(clientKey(c))) {
      return c.json({ error: { code: 'rate_limited', message: 'Too many download attempts' } }, 429)
    }

    const payload = verifySharedFileToken(c.req.param('token'))
    if (!payload) {
      return c.json({ error: { code: 'not_found', message: 'This download link is invalid or expired' } }, 404)
    }

    const { projectId, workspaceId } = payload
    const pinned = projectId ? await pinHome(c, projectId) : await pinWorkspaceHome(c, workspaceId)
    if (pinned) return pinned

    // A project link's `path` is relative to the project root, so the merged
    // root this route reads needs `<projectId>/` back in front of it — see
    // `sharedFileDownloadShapes`. Trying every shape it can mean is what keeps
    // a link a Free user just received from 404ing.
    const shapes = sharedFileDownloadShapes(payload.path, projectId)

    let lastFailure = ''
    let fileNotFound = false
    let runtimeDown = false

    for (const shape of shapes) {
      const agentPath = `/agent/workspace/download/${encodeRuntimePath(shape.path)}`
      const agentUrlPath = shape.scope ? `${agentPath}?scope=${shape.scope}` : agentPath
      const fetchRuntime = (url: string, runtimeToken: string) =>
        fetch(`${url.replace(/\/+$/, '')}${agentUrlPath}`, {
          method: 'GET',
          headers: { 'x-runtime-token': runtimeToken },
          signal: c.req.raw.signal,
        })

      let runtimeLabel = ''
      let retryable = true
      for (let attempt = 0; attempt <= RUNTIME_RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          await (projectId ? invalidateRuntimeUrl(projectId) : invalidateWorkspaceRuntimeUrl(workspaceId)).catch(() => {})
          await sleep(RUNTIME_RETRY_DELAYS_MS[attempt - 1])
          if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 })
        }
        try {
          let upstream: Response
          if (!projectId) {
            const url = await resolveWorkspaceRuntimeUrl(workspaceId)
            runtimeLabel = url
            upstream = await fetchRuntime(url, deriveWorkspaceToken(workspaceId))
          } else {
            const resolution = await resolveRuntime(projectId)
            if (!resolution.ok) {
              lastFailure = `resolve ${resolution.status} ${resolution.body.error.code}`
              continue
            }

            runtimeLabel = resolution.kind === 'tunnel' ? `tunnel ${resolution.instanceId}` : resolution.url
            const runtimeToken = await deriveToken(projectId, { workspaceId })
            upstream = resolution.kind === 'tunnel'
              ? await relayTunnel({
                  c,
                  instanceId: resolution.instanceId,
                  workspaceId: resolution.workspaceId,
                  projectId,
                  agentPath: agentUrlPath,
                  cleanPath: agentPath,
                  method: 'GET',
                  headers: { 'x-runtime-token': runtimeToken },
                })
              : await fetchRuntime(resolution.url, runtimeToken)
          }

          if (upstream.ok) {
            return new Response(upstream.body, {
              status: upstream.status,
              headers: downloadHeaders(shape.path, upstream.headers),
            })
          }
          await upstream.body?.cancel().catch(() => {})
          if (!isTransientRuntimeStatus(upstream.status)) {
            // This root has no such file — say which one, so a reported 404
            // never has to be diagnosed by guessing again.
            console.warn(
              `[SharedFiles] No file for ${projectId ? `project ${projectId}` : `workspace ${workspaceId}`} ` +
                `at ${shape.path}${shape.scope ? ` (scope=${shape.scope})` : ''} — ` +
                `${runtimeLabel || 'runtime'} answered ${upstream.status}`,
            )
            retryable = false
            fileNotFound = true
            break
          }
          lastFailure = `runtime ${upstream.status}`
        } catch (error: any) {
          if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 })
          lastFailure = error?.message || String(error)
        }
      }
      if (retryable) {
        runtimeDown = true
        break
      }
    }

    if (!runtimeDown && fileNotFound) {
      return c.json({ error: { code: 'not_found', message: 'File not found' } }, 404)
    }

    console.error(`[SharedFiles] Download failed for ${projectId ?? `workspace ${workspaceId}`}: ${lastFailure}`)
    return runtimeUnavailable(c)
  }

  return app
}
