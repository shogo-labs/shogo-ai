// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Third-Party Tools Passthrough Proxy
 *
 * Generic proxy for Composio, Serper, and OpenAI embeddings.
 * Agent pods send requests here with a JWT proxy token; this server
 * validates the token, swaps in the real API key, and forwards the
 * request verbatim to the upstream service.
 *
 * Routes:
 *   /tools/composio/*  → https://backend.composio.dev/*
 *   /tools/serper/*    → https://google.serper.dev/*
 *   /tools/openai/*    → https://api.openai.com/*
 *
 * Authentication: Reuses the AI proxy JWT tokens (see ai-proxy-token.ts).
 * The token can arrive as `x-api-key` header or `Authorization: Bearer`.
 */

import { Hono } from 'hono'
import { verifyProxyToken } from '../lib/ai-proxy-token'

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

const FORWARDED_SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
])

const RESPONSE_SKIP_HEADERS = new Set([
  ...FORWARDED_SKIP_HEADERS,
  'content-encoding',
  'content-length',
])

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
// Generic forwarding
// =============================================================================

async function forwardRequest(
  req: Request,
  target: ProxyTarget,
  upstreamPath: string,
): Promise<Response> {
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
    if (FORWARDED_SKIP_HEADERS.has(lower)) return
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
    if (RESPONSE_SKIP_HEADERS.has(lower)) return
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
  if (!payload) {
    return {
      error: Response.json({ error: 'Invalid or expired proxy token' }, { status: 401 }),
    }
  }

  return { projectId: payload.projectId }
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
    if (FORWARDED_SKIP_HEADERS.has(lower)) return
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
    if (RESPONSE_SKIP_HEADERS.has(lower)) return
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
    return forwardRequest(c.req.raw, TARGETS.composio, upstreamPath + qs)
  })

  // ---- Serper passthrough ----
  router.all('/tools/serper/*', async (c) => {
    const auth = await requireProxyAuth(c.req.raw)
    if ('error' in auth) return auth.error

    const upstreamPath = extractUpstreamPath(c.req.path, 'serper')
    const qs = new URL(c.req.url).search
    return forwardRequest(c.req.raw, TARGETS.serper, upstreamPath + qs)
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

    return forwardRequest(c.req.raw, TARGETS.openai, upstreamPath + qs)
  })

  return router
}
