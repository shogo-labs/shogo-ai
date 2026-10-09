// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Third-Party Tools Passthrough Proxy
 *
 * Generic proxy for Composio, Serper, and OpenAI embeddings, plus a
 * structured social-media lookup that keeps the EnsembleData token on
 * this server.
 * Agent pods send requests here with a JWT proxy token; this server
 * validates the token, swaps in the real API key, and forwards the
 * request verbatim to the upstream service.
 *
 * Routes:
 *   /tools/composio/*  → https://backend.composio.dev/*
 *   /tools/serper/*    → https://google.serper.dev/*
 *   /tools/openai/*    → https://api.openai.com/*
 *   POST /tools/social/:platform/:op  → EnsembleData (token stays here)
 *
 * Authentication: Reuses the AI proxy JWT tokens (see ai-proxy-token.ts).
 * The token can arrive as `x-api-key` header or `Authorization: Bearer`.
 */

import { Hono } from 'hono'
import { normalizeCapabilitySettings } from '@shogo/shared-runtime/capability-settings'
import { verifyProxyToken } from '../lib/ai-proxy-token'
import { resolveApiKey } from './api-keys'
import { getShogoCloudUrl } from '../lib/cloud-urls'
import { parseProjectSettings } from '../lib/project-settings'
import { prisma } from '../lib/prisma'
import {
  shouldSkipForwardedHeader,
  shouldSkipResponseHeader,
} from '../lib/proxy-headers'
import {
  getSocialContentProvider,
  SocialProviderError,
  type NormalizedPost,
  type SocialPlatform,
} from '../services/social-content'

// =============================================================================
// Configuration
// =============================================================================

interface ProxyTarget {
  upstream: string
  envKey: string
  authHeader: string
}

const TARGETS: Record<string, ProxyTarget> = {
  composio: {
    upstream: 'https://backend.composio.dev',
    envKey: 'COMPOSIO_API_KEY',
    authHeader: 'x-api-key',
  },
  serper: {
    upstream: 'https://google.serper.dev',
    envKey: 'SERPER_API_KEY',
    authHeader: 'X-API-KEY',
  },
  openai: {
    upstream: 'https://api.openai.com',
    envKey: 'OPENAI_API_KEY',
    authHeader: 'authorization',
  },
}

// Header skip-lists are shared with marketplace.ts and integrations.ts via
// `lib/proxy-headers.ts`. See that module's header for the rationale on
// what's stripped where (hop-by-hop vs. cookie vs. content-encoding).

// =============================================================================
// JWT extraction
// =============================================================================

function extractToken(req: Request): string | null {
  const xApiKey = req.headers.get('x-api-key')
  if (xApiKey) return xApiKey

  const auth = req.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  return null
}

// =============================================================================
// Cloud forwarding helpers
// =============================================================================

function isShogoCloudForwarding(): boolean {
  return !!process.env.SHOGO_API_KEY
}

async function forwardToCloud(
  req: Request,
  serviceName: string,
  upstreamPath: string,
): Promise<Response> {
  const cloudUrl = getShogoCloudUrl()
  const shogoKey = process.env.SHOGO_API_KEY!
  const url = `${cloudUrl}/api/tools/${serviceName}${upstreamPath}`

  const headers = new Headers()
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipForwardedHeader(lower)) return
    if (lower === 'x-api-key' || lower === 'authorization') return
    headers.set(key, value)
  })
  headers.set('Authorization', `Bearer ${shogoKey}`)

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error -- Node fetch supports duplex for streaming request bodies
    duplex: 'half',
  })

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipResponseHeader(lower)) return
    responseHeaders.set(key, value)
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

// =============================================================================
// Generic forwarding
// =============================================================================

async function forwardRequest(
  req: Request,
  target: ProxyTarget,
  serviceName: string,
  upstreamPath: string,
): Promise<Response> {
  if (isShogoCloudForwarding()) {
    return forwardToCloud(req, serviceName, upstreamPath)
  }

  const realKey = process.env[target.envKey]
  if (!realKey) {
    return Response.json(
      { error: `${target.envKey} not configured on API server` },
      { status: 503 },
    )
  }

  const url = `${target.upstream}${upstreamPath}`

  const headers = new Headers()
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipForwardedHeader(lower)) return
    if (lower === 'x-api-key' || lower === 'authorization') return
    headers.set(key, value)
  })

  if (target.authHeader === 'authorization') {
    headers.set('Authorization', `Bearer ${realKey}`)
  } else {
    headers.set(target.authHeader, realKey)
  }

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-expect-error -- Node fetch supports duplex for streaming request bodies
    duplex: 'half',
  })

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipResponseHeader(lower)) return
    responseHeaders.set(key, value)
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

// =============================================================================
// Auth middleware
// =============================================================================

async function requireProxyAuth(
  req: Request,
): Promise<{ error: Response } | { projectId: string }> {
  const token = extractToken(req)
  if (!token) {
    return {
      error: Response.json({ error: 'Missing proxy token' }, { status: 401 }),
    }
  }

  const payload = await verifyProxyToken(token)
  if (payload) {
    return { projectId: payload.projectId }
  }

  if (token.startsWith('shogo_sk_')) {
    try {
      const resolved = await resolveApiKey(token)
      if (resolved) {
        return { projectId: `ws_${resolved.workspaceId}` }
      }
    } catch {}
  }

  return {
    error: Response.json({ error: 'Invalid or expired proxy token' }, { status: 401 }),
  }
}

// =============================================================================
// Local LLM embedding forwarding
// =============================================================================

async function forwardLocalEmbedding(
  req: Request,
  localBaseUrl: string,
  embeddingModel: string,
  upstreamPath: string,
): Promise<Response> {
  const url = `${localBaseUrl.replace(/\/$/, '')}${upstreamPath}`

  let body: any = null
  if (req.method === 'POST') {
    try {
      const parsed = await req.json()
      parsed.model = embeddingModel
      const dims = process.env.LOCAL_EMBEDDING_DIMENSIONS
      if (dims) parsed.dimensions = parseInt(dims, 10)
      body = JSON.stringify(parsed)
    } catch {
      body = req.body
    }
  }

  const headers = new Headers()
  req.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipForwardedHeader(lower)) return
    if (lower === 'x-api-key' || lower === 'authorization') return
    headers.set(key, value)
  })
  headers.set('Content-Type', 'application/json')

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
  })

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (shouldSkipResponseHeader(lower)) return
    responseHeaders.set(key, value)
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

// =============================================================================
// Routes
// =============================================================================

// =============================================================================
// Social media lookup (EnsembleData token stays on this server)
// =============================================================================

const SOCIAL_PLATFORMS = new Set<SocialPlatform>(['instagram', 'tiktok'])
const SOCIAL_OPS = new Set(['profile', 'posts'])
const SOCIAL_DAILY_LIMIT_DEFAULT = 200

/** In-process per-project call counter. Resets on the UTC day boundary. */
const socialQuota = new Map<string, { day: string; count: number }>()

/** Test hook. Not part of the route contract. */
export function resetSocialToolQuotaForTests(): void {
  socialQuota.clear()
}

function socialToolDailyLimit(): number {
  const raw = process.env.SOCIAL_TOOL_DAILY_LIMIT
  if (raw === undefined || raw.trim() === '') return SOCIAL_DAILY_LIMIT_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return SOCIAL_DAILY_LIMIT_DEFAULT
  return Math.floor(n)
}

/**
 * Count one call against the project's daily cap. Workspace API keys
 * (`ws_…`, used when desktop forwards to cloud) are not projects — the
 * originating API already counted the real project — so they are not
 * capped again here. `0` disables the cap.
 */
function consumeSocialToolQuota(projectId: string): { ok: true } | { ok: false; limit: number } {
  if (projectId.startsWith('ws_')) return { ok: true }
  const limit = socialToolDailyLimit()
  if (limit === 0) return { ok: true }
  const day = new Date().toISOString().slice(0, 10)
  const row = socialQuota.get(projectId)
  if (!row || row.day !== day) {
    socialQuota.set(projectId, { day, count: 1 })
    return { ok: true }
  }
  if (row.count >= limit) return { ok: false, limit }
  row.count += 1
  return { ok: true }
}

function parseSocialHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const handle = raw.trim().replace(/^@+/, '')
  if (!handle || handle.length > 64) return null
  if (!/^[A-Za-z0-9._]+$/.test(handle)) return null
  return handle
}

/** Clamp to 1..50. `undefined` defaults to 20. Non-numeric input is rejected. */
function parseSocialLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 20
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(50, Math.max(1, Math.floor(n)))
}

function serializePost(post: NormalizedPost) {
  return {
    providerPostId: post.providerPostId,
    url: post.url,
    caption: post.caption,
    postedAt: post.postedAt ? post.postedAt.toISOString() : null,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    shares: post.shares,
  }
}

function socialErrorStatus(err: SocialProviderError): number {
  switch (err.code) {
    case 'not_found':
      return 404
    case 'rate_limited':
      return 429
    case 'not_configured':
    case 'bad_credentials':
      return 503
    default:
      return 502
  }
}

/**
 * 403 when this project has the tool or the platform switched off.
 * Workspace-key callers (`ws_…`) already passed the check on the API
 * that owns the project (desktop forwards here after that), and cloud
 * does not have that project's settings.
 */
async function socialCapabilityDenied(
  projectId: string,
  platform: SocialPlatform,
): Promise<Response | null> {
  if (projectId.startsWith('ws_')) return null
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { settings: true },
  })
  if (!project) {
    return Response.json({ error: 'Project not found' }, { status: 403 })
  }
  const caps = normalizeCapabilitySettings(parseProjectSettings(project.settings))
  if (!caps.socialMediaEnabled) {
    return Response.json({ error: 'Social media tool is disabled for this project' }, { status: 403 })
  }
  const platformOn = platform === 'instagram' ? caps.socialInstagramEnabled : caps.socialTiktokEnabled
  if (!platformOn) {
    return Response.json({ error: `${platform} is disabled for this project` }, { status: 403 })
  }
  return null
}

function extractUpstreamPath(fullPath: string, servicePrefix: string): string {
  const idx = fullPath.indexOf(`/tools/${servicePrefix}`)
  if (idx === -1) return '/'
  return fullPath.slice(idx + `/tools/${servicePrefix}`.length) || '/'
}

export function toolsProxyRoutes() {
  const router = new Hono()

  // ---- Composio passthrough (all methods) ----
  router.all('/tools/composio/*', async (c) => {
    const auth = await requireProxyAuth(c.req.raw)
    if ('error' in auth) return auth.error

    const upstreamPath = extractUpstreamPath(c.req.path, 'composio')
    const qs = new URL(c.req.url).search
    return forwardRequest(c.req.raw, TARGETS.composio, 'composio', upstreamPath + qs)
  })

  // ---- Serper passthrough ----
  router.all('/tools/serper/*', async (c) => {
    const auth = await requireProxyAuth(c.req.raw)
    if ('error' in auth) return auth.error

    const upstreamPath = extractUpstreamPath(c.req.path, 'serper')
    const qs = new URL(c.req.url).search
    return forwardRequest(c.req.raw, TARGETS.serper, 'serper', upstreamPath + qs)
  })

  // ---- OpenAI passthrough (embeddings, etc.) ----
  // When LOCAL_LLM_BASE_URL is configured and the request is for embeddings,
  // route to the local LLM server instead of OpenAI.
  router.all('/tools/openai/*', async (c) => {
    const auth = await requireProxyAuth(c.req.raw)
    if ('error' in auth) return auth.error

    const upstreamPath = extractUpstreamPath(c.req.path, 'openai')
    const qs = new URL(c.req.url).search
    const localBaseUrl = process.env.LOCAL_LLM_BASE_URL
    const localEmbeddingModel = process.env.LOCAL_EMBEDDING_MODEL

    if (localBaseUrl && localEmbeddingModel && upstreamPath.startsWith('/v1/embeddings')) {
      return forwardLocalEmbedding(c.req.raw, localBaseUrl, localEmbeddingModel, upstreamPath + qs)
    }

    return forwardRequest(c.req.raw, TARGETS.openai, 'openai', upstreamPath + qs)
  })

  // ---- Social media lookup (Instagram / TikTok via EnsembleData) ----
  // Structured on purpose: a raw passthrough would put the token in the
  // query string and expose every EnsembleData endpoint.
  router.post('/tools/social/:platform/:op', async (c) => {
    const auth = await requireProxyAuth(c.req.raw)
    if ('error' in auth) return auth.error

    const platform = c.req.param('platform')
    const op = c.req.param('op')
    if (!SOCIAL_PLATFORMS.has(platform as SocialPlatform) || !SOCIAL_OPS.has(op)) {
      return c.json({ error: 'Unknown platform or operation' }, 400)
    }
    const socialPlatform = platform as SocialPlatform

    let body: Record<string, unknown> | null = null
    try {
      const parsed = await c.req.json()
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      body = null
    }
    if (!body) return c.json({ error: 'Request body must be a JSON object' }, 400)

    const handle = parseSocialHandle(body.handle)
    if (!handle) return c.json({ error: 'handle is required' }, 400)
    const limit = parseSocialLimit(body.limit)
    if (limit === null) return c.json({ error: 'limit must be a number' }, 400)

    const denied = await socialCapabilityDenied(auth.projectId, socialPlatform)
    if (denied) return denied

    const quota = consumeSocialToolQuota(auth.projectId)
    if (!quota.ok) {
      return c.json({ error: 'Social media daily limit reached', limit: quota.limit }, 429)
    }

    if (isShogoCloudForwarding()) {
      const headers = new Headers(c.req.raw.headers)
      headers.delete('content-length')
      headers.set('content-type', 'application/json')
      const forwarded = new Request(c.req.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ handle, limit }),
      })
      return forwardToCloud(forwarded, 'social', `/${socialPlatform}/${op}`)
    }

    try {
      const provider = await getSocialContentProvider()
      if (op === 'profile') {
        const profile = await provider.getProfile(socialPlatform, handle)
        return c.json({ platform: socialPlatform, handle, ...profile })
      }
      const posts = await provider.listRecentPosts(socialPlatform, handle, limit)
      return c.json({
        platform: socialPlatform,
        handle,
        posts: posts.map(serializePost),
      })
    } catch (err) {
      if (err instanceof SocialProviderError) {
        return c.json({ error: err.message, code: err.code }, socialErrorStatus(err))
      }
      const message = err instanceof Error ? err.message : 'Social lookup failed'
      return c.json({ error: message }, 502)
    }
  })

  return router
}
