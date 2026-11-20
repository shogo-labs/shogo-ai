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
import { isShogoCloudAuthed } from '../lib/cloud-forwarding'
import { parseProjectSettings } from '../lib/project-settings'
import { prisma } from '../lib/prisma'
import {
  shouldSkipForwardedHeader,
  shouldSkipResponseHeader,
} from '../lib/proxy-headers'
import {
  calculateSocialLookupCost,
  socialLookupUnits,
  type SocialLookupOp,
} from '../lib/usage-cost'
import * as billingService from '../services/billing.service'
import {
  getSocialContentProvider,
  SocialProviderError,
  type NormalizedPost,
  type NormalizedSearchResult,
  type SocialPlatform,
  type UnitMeter,
} from '../services/social-content'
import { outlierScore } from '../services/social-content/outlier'
import { parseWorkspaceSettings } from '../lib/workspace-settings'

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
//
// Tool and integration calls always relay through Shogo Cloud on a cloud-authed
// desktop, whatever `AI_MODE` says: the relay is the only place a Composio,
// Serper or social-provider key exists, so a BYOK install that skipped it would
// answer 503 rather than fall back to anything local.

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
  if (isShogoCloudAuthed()) {
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
): Promise<{ error: Response } | { projectId: string; workspaceId: string; userId?: string }> {
  const token = extractToken(req)
  if (!token) {
    return {
      error: Response.json({ error: 'Missing proxy token' }, { status: 401 }),
    }
  }

  const payload = await verifyProxyToken(token)
  if (payload) {
    return {
      projectId: payload.projectId,
      workspaceId: payload.workspaceId,
      userId: payload.userId,
    }
  }

  if (token.startsWith('shogo_sk_')) {
    try {
      const resolved = await resolveApiKey(token)
      if (resolved) {
        return {
          projectId: `ws_${resolved.workspaceId}`,
          workspaceId: resolved.workspaceId,
          userId: resolved.userId,
        }
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
const SOCIAL_OPS = new Set(['profile', 'posts', 'search'])

// In-process TTL cache for creator baselines (platform:handle → baseline + timestamp)
const BASELINE_CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6 hours
const BASELINE_CACHE_MAX_ENTRIES = 2_000
const baselineCache = new Map<string, { medianViews: number | null; sample: number; at: number }>()

/**
 * Charge a successful lookup to the workspace. Fire-and-forget, like
 * transcription billing: the response is not held on the wallet write.
 * Provider errors are not charged. Workspace API keys (`ws_…`) have no
 * project row, so the event is attributed to the workspace only.
 */
function recordSocialUsage(args: {
  workspaceId: string
  projectId: string
  userId?: string
  platform: SocialPlatform
  op: SocialLookupOp
  limit: number
  /** Real units from EnsembleData units_charged headers. Falls back to estimate when 0. */
  actualUnits?: number
  actionExtra?: Record<string, unknown>
}): void {
  const estimatedUnits = socialLookupUnits(args.platform, args.op, args.limit)
  let units = estimatedUnits
  if (args.actualUnits && args.actualUnits > 0) {
    units = args.actualUnits
  } else if (args.actualUnits === 0) {
    console.warn(`[Tools Proxy] units_charged header missing for social ${args.platform} ${args.op} — using estimate`)
  }
  const { rawUsd, billedUsd } = calculateSocialLookupCost(units)
  if (billedUsd === 0) return

  // Sentinel projectIds ('workspace', 'api-key', 'system') have no Project FK.
  const billingProjectId = isNonProjectSentinel(args.projectId) ? null : args.projectId

  void billingService.consumeUsage({
    workspaceId: args.workspaceId,
    projectId: billingProjectId,
    memberId: args.userId || 'system',
    actionType: 'social_media_lookup',
    rawUsd,
    billedUsd,
    actionMetadata: {
      platform: args.platform,
      op: args.op,
      limit: args.limit,
      units,
      ...(args.actionExtra ?? {}),
    },
  }).then((result) => {
    if (result.success) {
      console.log(`[Tools Proxy] Charged $${billedUsd.toFixed(4)} (social ${args.platform} ${args.op}, ${units} units) — remaining included: $${result.remainingIncludedUsd?.toFixed(4)}`)
    } else {
      console.warn(`[Tools Proxy] Could not charge social lookup: ${result.error}`)
    }
  }).catch((err) => {
    console.error('[Tools Proxy] Failed to charge social lookup:', err)
  })
}

function isNonProjectSentinel(projectId: string): boolean {
  return projectId === 'workspace' || projectId === 'api-key' || projectId === 'system' || projectId.startsWith('ws_')
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

/** Parse a search query. Strips leading #→ hashtag kind, returns null when invalid. */
function parseSocialQuery(raw: unknown): { query: string; kind: 'keyword' | 'hashtag' } | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 100) return null
  if (trimmed.startsWith('#')) return { query: trimmed.slice(1).trim(), kind: 'hashtag' }
  return { query: trimmed, kind: 'keyword' }
}

/** Parse period string to days. Defaults to 30. */
function parseSocialPeriod(raw: unknown): number {
  const map: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, '180d': 180, all: 0 }
  if (typeof raw === 'string' && raw in map) return map[raw]
  return 30
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

function serializeSearchResult(r: NormalizedSearchResult & {
  outlierScore: number | null
  creatorMedianViews: number | null
  viewsPerFollower: number | null
  scored: boolean
}) {
  return {
    url: r.url,
    creator_handle: r.creator.handle,
    followers: r.creator.followers,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    shares: r.shares,
    posted_at: r.postedAt ? r.postedAt.toISOString() : null,
    caption: r.caption,
    duration_sec: r.durationSec,
    outlier_score: r.outlierScore,
    creator_median_views: r.creatorMedianViews,
    views_per_follower: r.viewsPerFollower,
  }
}

function socialErrorStatus(err: SocialProviderError): 400 | 404 | 429 | 502 | 503 {
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
 * 403 when this project / workspace has the tool or the platform switched off.
 *
 * Handles three cases:
 * 1. `ws_…` keys — desktop has already checked; pass through.
 * 2. Sentinel projectIds ('workspace', 'api-key', 'system') — the token belongs to a
 *    workspace runtime with no attached project. Read capabilities from Workspace.settings.
 * 3. Normal project id but the project row was deleted (stale token) — same workspace fallback.
 */
async function socialCapabilityDenied(
  projectId: string,
  workspaceId: string,
  platform: SocialPlatform,
): Promise<Response | null> {
  if (projectId.startsWith('ws_')) return null

  let settings: unknown = null

  if (!isNonProjectSentinel(projectId)) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { settings: true },
    })
    if (project) {
      settings = project.settings
    }
    // project missing (deleted / stale token) → fall through to workspace check
  }

  if (settings === null) {
    // Sentinel or missing project: fall back to workspace settings
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { settings: true, name: true },
    })
    if (!workspace) {
      return Response.json({ error: 'Workspace not found' }, { status: 403 })
    }
    const caps = normalizeCapabilitySettings(parseWorkspaceSettings(workspace.settings))
    if (!caps.socialMediaEnabled) {
      return Response.json({ error: `Social media tool is disabled for workspace "${workspace.name}"` }, { status: 403 })
    }
    const platformOn = platform === 'instagram' ? caps.socialInstagramEnabled : caps.socialTiktokEnabled
    if (!platformOn) {
      return Response.json({ error: `${platform} is disabled for workspace "${workspace.name}"` }, { status: 403 })
    }
    return null
  }

  const caps = normalizeCapabilitySettings(parseProjectSettings(settings))
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

    // For search, handle is optional; query is required instead.
    const limit = parseSocialLimit(body.limit)
    if (limit === null) return c.json({ error: 'limit must be a number' }, 400)

    // --- search action (no handle required) --------------------------------
    if (op === 'search') {
      const parsed = parseSocialQuery(body.query)
      if (!parsed) return c.json({ error: 'query is required (1–100 chars)' }, 400)

      // Instagram is hashtag-only; compact keyword → hashtag
      let { query, kind } = parsed
      let queryUsedCompacted = false
      if (socialPlatform === 'instagram' && kind === 'keyword') {
        query = query.replace(/\s+/g, '')
        kind = 'hashtag'
        queryUsedCompacted = true
      }

      const periodDays = parseSocialPeriod(body.period)
      const scoreEnabled = body.score === true

      const denied = await socialCapabilityDenied(auth.projectId, auth.workspaceId, socialPlatform)
      if (denied) return denied

      if (isShogoCloudAuthed()) {
        const headers = new Headers(c.req.raw.headers)
        headers.delete('content-length')
        headers.set('content-type', 'application/json')
        const forwarded = new Request(c.req.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: (kind === 'hashtag' ? '#' : '') + query, period: body.period, limit, score: scoreEnabled }),
        })
        return forwardToCloud(forwarded, 'social', `/${socialPlatform}/search`)
      }

      if (process.env.SHOGO_LOCAL_MODE !== 'true') {
        const balanceCheck = await billingService.checkUsageBalance(auth.workspaceId, 0.001, auth.userId)
        if (!balanceCheck.ok) {
          const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
          return c.json({ error: { message, type: 'billing_error', code } }, 402)
        }
      }

      try {
        const provider = await getSocialContentProvider()
        const searchMeter: UnitMeter = { units: 0 }
        const { results, queryUsed } = await provider.searchPosts(socialPlatform, {
          query,
          kind,
          periodDays,
          limit,
          meter: searchMeter,
        })

        // --- outlier scoring (top 10 unique creators by views) ---
        let scored: Array<NormalizedSearchResult & { outlierScore: number | null; creatorMedianViews: number | null; viewsPerFollower: number | null; scored: boolean }> = []
        let scoredCreatorCount = 0
        let cacheHits = 0

        if (scoreEnabled) {
          // Pick top 10 unique creators by views to baseline
          const creatorOrder: string[] = []
          const creatorViewMap = new Map<string, number>()
          for (const r of results) {
            const key = `${socialPlatform}:${r.creator.handle}`
            if (!creatorViewMap.has(key)) {
              creatorViewMap.set(key, 0)
              creatorOrder.push(key)
            }
            creatorViewMap.set(key, Math.max(creatorViewMap.get(key)!, r.views))
          }
          const topCreatorKeys = creatorOrder
            .sort((a, b) => (creatorViewMap.get(b) ?? 0) - (creatorViewMap.get(a) ?? 0))
            .slice(0, 10)
          const topCreatorSet = new Set(topCreatorKeys)

          // Build baselines (with TTL cache)
          const baselineMeter: UnitMeter = { units: 0 }
          const baselineMap = new Map<string, { medianViews: number | null; sample: number }>()
          for (const key of topCreatorSet) {
            const cached = baselineCache.get(key)
            if (cached && Date.now() - cached.at < BASELINE_CACHE_TTL_MS) {
              baselineMap.set(key, { medianViews: cached.medianViews, sample: cached.sample })
              cacheHits++
              continue
            }
            const [, handle] = key.split(':')
            // Find the userId from results for this creator (skips detailed-info on IG)
            const matchingResult = results.find((r) => r.creator.handle === handle)
            const userId = matchingResult?.creator.userId ?? null
            try {
              const baseline = await provider.creatorBaseline(socialPlatform, { handle, userId, meter: baselineMeter })
              baselineMap.set(key, baseline)
              // Update cache
              if (baselineCache.size >= BASELINE_CACHE_MAX_ENTRIES) {
                // Evict the oldest entry
                const oldest = baselineCache.keys().next().value
                if (oldest) baselineCache.delete(oldest)
              }
              baselineCache.set(key, { ...baseline, at: Date.now() })
            } catch {
              baselineMap.set(key, { medianViews: null, sample: 0 })
            }
          }
          scoredCreatorCount = topCreatorSet.size - cacheHits

          scored = results.map((r) => {
            const key = `${socialPlatform}:${r.creator.handle}`
            const isTopCreator = topCreatorSet.has(key)
            const baseline = isTopCreator ? baselineMap.get(key) : null
            const medianViews = baseline?.medianViews ?? null
            // Exclude the result post from its own baseline when it appears in the sample
            const oScore = outlierScore(r.views, medianViews)
            const vpf = r.creator.followers && r.creator.followers > 0
              ? Math.round((r.views / r.creator.followers) * 1000) / 1000
              : null
            return {
              ...r,
              outlierScore: oScore,
              creatorMedianViews: medianViews,
              viewsPerFollower: vpf,
              scored: isTopCreator,
            }
          })

          // Sort: outlier_score desc (nulls last), then views desc
          scored.sort((a, b) => {
            if (a.outlierScore !== null && b.outlierScore !== null) return b.outlierScore - a.outlierScore
            if (a.outlierScore !== null) return -1
            if (b.outlierScore !== null) return 1
            return b.views - a.views
          })

          recordSocialUsage({
            workspaceId: auth.workspaceId,
            projectId: auth.projectId,
            userId: auth.userId,
            platform: socialPlatform,
            op: 'search',
            limit,
            actualUnits: searchMeter.units + baselineMeter.units || undefined,
            actionExtra: { query: queryUsed, score: true, scoredCreators: scoredCreatorCount, cacheHits },
          })
        } else {
          scored = results.map((r) => ({
            ...r,
            outlierScore: null,
            creatorMedianViews: null,
            viewsPerFollower: r.creator.followers && r.creator.followers > 0
              ? Math.round((r.views / r.creator.followers) * 1000) / 1000
              : null,
            scored: false,
          }))
          recordSocialUsage({
            workspaceId: auth.workspaceId,
            projectId: auth.projectId,
            userId: auth.userId,
            platform: socialPlatform,
            op: 'search',
            limit,
            actualUnits: searchMeter.units || undefined,
            actionExtra: { query: queryUsed, score: false },
          })
        }

        return c.json({
          platform: socialPlatform,
          query: (kind === 'hashtag' ? '#' : '') + query,
          query_used: queryUsed,
          period: periodDays === 0 ? 'all' : `${periodDays}d`,
          scored_creators: scoredCreatorCount,
          units: searchMeter.units + (scoreEnabled ? 0 : 0),
          results: scored.map(serializeSearchResult),
        })
      } catch (err) {
        if (err instanceof SocialProviderError) {
          return c.json({ error: err.message, code: err.code }, socialErrorStatus(err))
        }
        const message = err instanceof Error ? err.message : 'Social search failed'
        return c.json({ error: message }, 502)
      }
    }

    // --- profile / posts actions -------------------------------------------
    const handle = parseSocialHandle(body.handle)
    if (!handle) return c.json({ error: 'handle is required' }, 400)

    const denied = await socialCapabilityDenied(auth.projectId, auth.workspaceId, socialPlatform)
    if (denied) return denied

    // Desktop forwards to cloud, which is the server that calls EnsembleData
    // and the one that charges. Do not bill (or balance-check) twice.
    if (isShogoCloudAuthed()) {
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

    if (process.env.SHOGO_LOCAL_MODE !== 'true') {
      const balanceCheck = await billingService.checkUsageBalance(auth.workspaceId, 0.001, auth.userId)
      if (!balanceCheck.ok) {
        const { code, message } = billingService.usageLimitErrorPayload(balanceCheck.reason)
        return c.json(
          {
            error: {
              message,
              type: 'billing_error',
              code,
            },
          },
          402,
        )
      }
    }

    const socialOp: SocialLookupOp = op === 'profile' ? 'profile' : 'posts'

    try {
      const provider = await getSocialContentProvider()
      const meter: UnitMeter = { units: 0 }
      const payload = socialOp === 'profile'
        ? { platform: socialPlatform, handle, ...(await provider.getProfile(socialPlatform, handle, meter)) }
        : {
            platform: socialPlatform,
            handle,
            posts: (await provider.listRecentPosts(socialPlatform, handle, limit, meter)).map(serializePost),
          }
      recordSocialUsage({
        workspaceId: auth.workspaceId,
        projectId: auth.projectId,
        userId: auth.userId,
        platform: socialPlatform,
        op: socialOp,
        limit,
        actualUnits: meter.units || undefined,
      })
      return c.json(payload)
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
