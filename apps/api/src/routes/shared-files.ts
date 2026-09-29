// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { Hono } from 'hono'
import { pinChatToHomeRegion } from '../lib/chat-region-pin'
import { deriveProjectRuntimeToken } from '../lib/project-runtime-token'
import { resolveAgentProxyPodUrl } from '../lib/agent-proxy-resolver'
import { relayAgentProxyViaTunnel } from '../lib/tunnel-relay'
import { verifySharedFileToken } from '../lib/shared-file-token'

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

export interface SharedFileRouteDeps {
  pinChatToHomeRegion?: typeof pinChatToHomeRegion
  resolveAgentProxyPodUrl?: typeof resolveAgentProxyPodUrl
  deriveProjectRuntimeToken?: typeof deriveProjectRuntimeToken
  relayAgentProxyViaTunnel?: typeof relayAgentProxyViaTunnel
}

export function sharedFileRoutes(deps: SharedFileRouteDeps = {}): Hono {
  const app = new Hono()
  const pinHome = deps.pinChatToHomeRegion ?? pinChatToHomeRegion
  const resolveRuntime = deps.resolveAgentProxyPodUrl ?? resolveAgentProxyPodUrl
  const deriveToken = deps.deriveProjectRuntimeToken ?? deriveProjectRuntimeToken
  const relayTunnel = deps.relayAgentProxyViaTunnel ?? relayAgentProxyViaTunnel

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

    const pinned = await pinHome(c, payload.projectId)
    if (pinned) return pinned

    try {
      const resolution = await resolveRuntime(payload.projectId)
      if (!resolution.ok) {
        return c.json({ error: { code: 'runtime_unavailable', message: 'The file runtime is unavailable' } }, 503)
      }

      const runtimeToken = await deriveToken(payload.projectId, {
        workspaceId: payload.workspaceId,
      })
      const agentPath = `/agent/workspace/download/${encodeRuntimePath(payload.path)}`

      if (resolution.kind === 'tunnel') {
        const upstream = await relayTunnel({
          c,
          instanceId: resolution.instanceId,
          workspaceId: resolution.workspaceId,
          projectId: payload.projectId,
          agentPath,
          cleanPath: agentPath,
          method: 'GET',
          headers: { 'x-runtime-token': runtimeToken },
        })
        if (!upstream.ok) {
          return c.json({ error: { code: 'not_found', message: 'File not found' } }, upstream.status === 404 ? 404 : 503)
        }
        return new Response(upstream.body, {
          status: upstream.status,
          headers: downloadHeaders(payload.path, upstream.headers),
        })
      }

      const runtimeUrl = `${resolution.url.replace(/\/+$/, '')}${agentPath}`
      const upstream = await fetch(runtimeUrl, {
        method: 'GET',
        headers: { 'x-runtime-token': runtimeToken },
        signal: c.req.raw.signal,
      })
      if (!upstream.ok) {
        return c.json({ error: { code: 'not_found', message: 'File not found' } }, upstream.status === 404 ? 404 : 503)
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: downloadHeaders(payload.path, upstream.headers),
      })
    } catch (error: any) {
      console.error(`[SharedFiles] Download failed for ${payload.projectId}:`, error?.message || error)
      return c.json({ error: { code: 'runtime_unavailable', message: 'The file runtime is unavailable' } }, 503)
    }
  }

  return app
}
