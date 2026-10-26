// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Social management API (Zernio): the workspace's connected accounts, its
 * publish fan-out and the calendar the composer schedules into.
 *
 * Mounted twice, like every other workspace surface:
 *   `socialRoutes()`      people, session auth, `/api/workspaces/:id/social/...`
 *   `agentSocialRoutes()` the runtime token, same bodies under `/api/internal`
 *
 * `socialRelayRoutes()` is the cloud half of the desktop relay: a desktop
 * forwards every social operation here and this is the only place the master
 * Zernio key is used.
 */

import { Hono } from 'hono'
import { prisma } from '../lib/prisma'
import { getWorkspaceRole } from '../services/conversation.service'
import { relayOperation } from '../services/social/relay.service'
import { connectReturnPage } from '../services/social/connect-page'
import {
  ackRelayedEvents,
  failRelayedEvents,
  listDeadLettered,
  listRelayedEvents,
  pruneRelayedEvents,
  requeueRelayedEvents,
} from '../services/social/relay-events.service'
import {
  backfillInbox,
  getComment,
  getConversation,
  listComments,
  listConversations,
  markCommentRead,
  markConversationRead,
  replyToComment,
  replyToConversation,
} from '../services/social/inbox.service'
import { LOCAL_SCOPE_HEADER } from '../services/social/client'
import { socialAnalytics } from '../services/social/analytics.service'
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  setAutomationStatus,
} from '../services/social/automations.service'
import { isScopeId, localScopeFor } from '../services/social/local-scope'
import {
  ZERNIO_EVENT_ID_HEADER,
  ZERNIO_SIGNATURE_HEADER,
  applySocialEvent,
  handleZernioWebhook,
} from '../services/social/webhooks'
import {
  SocialError,
  calendar,
  completeConnect,
  connectUrl,
  createPost,
  deletePost,
  disconnectAccount,
  ensureProfile,
  getPost,
  getProfile,
  listAccounts,
  listPosts,
  presignMedia,
  socialMode,
  syncAccounts,
  updatePost,
  workspaceName,
} from '../services/social'

const db = prisma as any

export interface SocialRoutesConfig {
  resolveUserId: (c: any) => Promise<string | null>
}

export interface AgentSocialAuthContext {
  workspaceId: string
  projectId?: string
}

export interface AgentSocialRoutesConfig {
  authorize: (c: any) => Promise<AgentSocialAuthContext | Response>
}

function errorResponse(c: any, err: unknown) {
  if (err instanceof SocialError) {
    return c.json(err.toJSON(), err.status as any)
  }
  throw err
}

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

function parseDateParam(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new SocialError(400, 'invalid_range', `Invalid date: ${raw}`)
  }
  return date
}

function requireString(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new SocialError(400, 'invalid_body', `${field} is required`)
  return value
}

/**
 * The thread window a caller asked for. `before` pages backwards through a
 * long thread; without it the first page is the recent end, because a chat view
 * has to show the message being answered.
 */
function conversationWindow(c: any): { messageLimit?: number; before?: string | null } {
  const limitRaw = Number(c.req.query('limit'))
  return {
    messageLimit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    before: c.req.query('before') || null,
  }
}

/**
 * Default landing place for the OAuth redirect when the caller does not name
 * one (the agent tool never has a mobile deep link to hand).
 *
 * It has to be a page that exists and is reachable from the browser that just
 * did the sign-in: this API's own return page, addressed by the origin the
 * request arrived on. On the desktop that is the local API on localhost, which
 * is fine because the browser runs on the same machine. `SOCIAL_CONNECT_REDIRECT_URL`
 * still wins where a deployment wants a different landing place.
 */
function defaultRedirectUrl(c: any): string {
  const override = process.env.SOCIAL_CONNECT_REDIRECT_URL
  if (override) return override
  return `${new URL(c.req.url).origin}/api/social/connect/return`
}

/**
 * The analytics window. Defaults to the last 30 days, and refuses a range that
 * does not make sense *before* the query runs: `to <= from` is a client bug, and
 * a range wider than a year is a mistyped date that would walk a busy
 * workspace's whole history.
 */
function analyticsRange(c: any): { from: Date; to: Date } {
  const now = new Date()
  const from = parseDateParam(c.req.query('from'), new Date(now.getTime() - 30 * 86_400_000))
  const to = parseDateParam(c.req.query('to'), now)
  if (to.getTime() <= from.getTime()) {
    throw new SocialError(400, 'invalid_range', '`to` must be after `from`')
  }
  if (to.getTime() - from.getTime() > 366 * 86_400_000) {
    throw new SocialError(400, 'invalid_range', 'A range of a year or less')
  }
  return { from, to }
}

export function socialRoutes(config: SocialRoutesConfig): Hono {
  const router = new Hono()

  async function requireMember(c: any, workspaceId: string): Promise<string | Response> {
    const userId = await config.resolveUserId(c)
    if (!userId) return c.json({ error: { code: 'unauthorized', message: 'Sign in first' } }, 401)
    const role = await getWorkspaceRole(workspaceId, userId)
    if (!role) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    if (role === 'viewer' && c.req.method !== 'GET') {
      return c.json({ error: { code: 'forbidden', message: 'Viewers cannot change connected accounts' } }, 403)
    }
    return userId
  }

  /**
   * Where the browser lands after a platform's sign-in. Unauthenticated by
   * necessity — the caller is a fresh browser tab coming back from Instagram or
   * TikTok — and read-only: it says what happened and writes nothing.
   */
  router.get('/social/connect/return', (c) => {
    const result = connectReturnPage(new URL(c.req.url).searchParams)
    return c.html(result.html, result.status as any)
  })

  router.get('/workspaces/:workspaceId/social/status', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    // A desktop stores this workspace's profile under its own local scope.
    const [profile, accounts] = await Promise.all([
      getProfile(workspaceId, await localScopeFor(workspaceId)),
      listAccounts(workspaceId),
    ])
    let mode: string = 'unavailable'
    let error: string | null = null
    try {
      mode = socialMode()
    } catch (err) {
      error = err instanceof SocialError ? err.message : 'Social is not configured'
    }
    return c.json({
      mode,
      configured: !!error ? false : true,
      error,
      connected: !!profile,
      accounts: accounts.filter((account: any) => account.isActive).length,
    })
  })

  router.get('/workspaces/:workspaceId/social/accounts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json({ accounts: await listAccounts(workspaceId) })
  })

  router.post('/workspaces/:workspaceId/social/accounts/sync', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ accounts: await syncAccounts(workspaceId, await workspaceName(workspaceId)) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/connect', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const result = await connectUrl({
        workspaceId,
        workspaceName: await workspaceName(workspaceId),
        platform: body.platform,
        redirectUrl: typeof body.redirectUrl === 'string' && body.redirectUrl.trim()
          ? body.redirectUrl.trim()
          : defaultRedirectUrl(c),
        forceReauth: body.forceReauth,
        expectedUsername: body.expectedUsername,
        reconnectAccountId: body.reconnectAccountId,
      })
      return c.json(result)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  /**
   * Mint an upload slot for media a post will reference. The caller PUTs the
   * bytes to `uploadUrl` itself and posts `publicUrl`, so a large video never
   * travels through this API.
   */
  router.post('/workspaces/:workspaceId/social/media/presign', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const upload = await presignMedia(workspaceId, {
        filename: body.filename,
        contentType: body.contentType,
        size: body.size,
      })
      return c.json(upload)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/connect/complete', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const account = await completeConnect({
        workspaceId,
        workspaceName: await workspaceName(workspaceId),
        platform: body.platform,
        accountId: requireString(body.accountId, 'accountId'),
        username: requireString(body.username, 'username'),
        displayName: typeof body.displayName === 'string' ? body.displayName : null,
      })
      return c.json({ account })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/accounts/:accountId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ account: await disconnectAccount(workspaceId, c.req.param('accountId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const limit = Number(c.req.query('limit') ?? 50)
    return c.json({
      posts: await listPosts(workspaceId, {
        status: c.req.query('status') ?? null,
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/posts', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const post = await createPost(workspaceId, await workspaceName(workspaceId), {
        content: body.content,
        accountIds: body.accountIds,
        variants: body.variants && typeof body.variants === 'object' ? body.variants : undefined,
        mediaUrls: body.mediaUrls,
        scheduledFor: body.scheduledFor,
        publishNow: body.publishNow === true,
        draft: body.draft === true,
        tags: body.tags,
        tiktok: body.tiktok,
        createdByUserId: userId,
      })
      return c.json({ post }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ post: await getPost(workspaceId, c.req.param('postId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const post = await updatePost(workspaceId, c.req.param('postId'), {
        content: body.content,
        scheduledFor: body.scheduledFor,
        tags: body.tags,
      })
      return c.json({ post })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/posts/:postId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json(await deletePost(workspaceId, c.req.param('postId')))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/calendar', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      const now = new Date()
      const from = parseDateParam(c.req.query('from'), new Date(now.getTime() - 7 * 86_400_000))
      const to = parseDateParam(c.req.query('to'), new Date(now.getTime() + 30 * 86_400_000))
      return c.json({ from: from.toISOString(), to: to.toISOString(), posts: await calendar(workspaceId, from, to) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/analytics', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json(await socialAnalytics(workspaceId, analyticsRange(c)))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/profile', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const profile = await getProfile(workspaceId, await localScopeFor(workspaceId))
    return c.json({ profile: profile ? { externalId: profile.externalId, name: profile.name } : null })
  })

  router.post('/workspaces/:workspaceId/social/profile', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      const profile = await ensureProfile(workspaceId, await workspaceName(workspaceId))
      return c.json({ profile: { externalId: profile.externalId, name: profile.name } })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // ── inbox: DMs ──────────────────────────────────────────────────────────
  router.get('/workspaces/:workspaceId/social/inbox', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const conversations = await listConversations(workspaceId, {
      status: c.req.query('status') ?? null,
      platform: c.req.query('platform') ?? null,
      unreadOnly: c.req.query('unread') === 'true' || c.req.query('unread') === '1',
      limit: Number(c.req.query('limit') ?? 50),
    })
    const unread = conversations.reduce((total: number, row: any) => total + (row.unreadCount ?? 0), 0)
    return c.json({ conversations, unread })
  })

  router.get('/workspaces/:workspaceId/social/inbox/conversations/:conversationId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json(
        await getConversation(workspaceId, c.req.param('conversationId'), conversationWindow(c)),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/inbox/conversations/:conversationId/messages', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const reply = await replyToConversation(workspaceId, c.req.param('conversationId'), {
        text: body.text,
        idempotencyKey: body.idempotencyKey ?? c.req.header('idempotency-key') ?? null,
      })
      return c.json({ reply }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/inbox/conversations/:conversationId/read', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ conversation: await markConversationRead(workspaceId, c.req.param('conversationId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/inbox/sync', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      const limit = Number(c.req.query('limit') ?? 50)
      return c.json({ backfill: await backfillInbox(workspaceId, { limit: Number.isFinite(limit) ? limit : 50 }) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // ── inbox: comments ─────────────────────────────────────────────────────
  router.get('/workspaces/:workspaceId/social/comments', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json({
      comments: await listComments(workspaceId, {
        platform: c.req.query('platform') ?? null,
        status: c.req.query('status') ?? null,
        includeOwn: c.req.query('includeOwn') === 'true',
        limit: Number(c.req.query('limit') ?? 50),
      }),
    })
  })

  router.get('/workspaces/:workspaceId/social/comments/:commentId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ comment: await getComment(workspaceId, c.req.param('commentId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/comments/:commentId/reply', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      const reply = await replyToComment(workspaceId, c.req.param('commentId'), {
        text: body.text,
        idempotencyKey: body.idempotencyKey ?? c.req.header('idempotency-key') ?? null,
      })
      return c.json({ reply }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/comments/:commentId/read', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ comment: await markCommentRead(workspaceId, c.req.param('commentId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // ── automations: comment→DM and DM sequences ────────────────────────────
  router.get('/workspaces/:workspaceId/social/automations', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    return c.json({
      automations: await listAutomations(workspaceId, {
        status: c.req.query('status') ?? null,
        kind: c.req.query('kind') ?? null,
        limit: Number(c.req.query('limit') ?? 50),
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/automations', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      return c.json({ automation: await createAutomation(workspaceId, body) }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/automations/:automationId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      return c.json({ automation: await getAutomation(workspaceId, c.req.param('automationId')) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/workspaces/:workspaceId/social/automations/:automationId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    const body = await readJson(c)
    try {
      return c.json({
        automation: await setAutomationStatus(workspaceId, c.req.param('automationId'), body.status),
      })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/automations/:automationId', async (c) => {
    const workspaceId = c.req.param('workspaceId')
    const userId = await requireMember(c, workspaceId)
    if (userId instanceof Response) return userId
    try {
      await deleteAutomation(workspaceId, c.req.param('automationId'))
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

/**
 * The agent surface for social management. Deliberately a mirror of the user
 * routes (same bodies, same services) rather than a second implementation:
 * `social_media` calls these, so a tool action cannot drift from the UI.
 */
export function agentSocialRoutes(config: AgentSocialRoutesConfig): Hono {
  const router = new Hono()

  async function authorize(c: any): Promise<AgentSocialAuthContext | Response> {
    return config.authorize(c)
  }

  router.get('/workspaces/:workspaceId/social/accounts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({ accounts: await listAccounts(auth.workspaceId) })
  })

  /**
   * Reconcile with the provider. The agent runs this before listing accounts
   * because a connect that finished in a browser writes nothing locally until
   * something syncs — without it a just-connected account looks absent.
   */
  router.post('/workspaces/:workspaceId/social/accounts/sync', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    try {
      return c.json({ accounts: await syncAccounts(auth.workspaceId, await workspaceName(auth.workspaceId)) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/connect', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(
        await connectUrl({
          workspaceId: auth.workspaceId,
          workspaceName: await workspaceName(auth.workspaceId),
          platform: body.platform,
          redirectUrl: typeof body.redirectUrl === 'string' && body.redirectUrl.trim()
            ? body.redirectUrl.trim()
            : defaultRedirectUrl(c),
          forceReauth: body.forceReauth,
          expectedUsername: body.expectedUsername,
          reconnectAccountId: body.reconnectAccountId,
        }),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // Media a post names has to be a public URL, so a workspace file goes through
  // the provider's presign flow first. The runtime PUTs the bytes; only the slot
  // is minted here.
  router.post('/workspaces/:workspaceId/social/media/presign', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(
        await presignMedia(auth.workspaceId, {
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
        }),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/posts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({
      posts: await listPosts(auth.workspaceId, {
        status: c.req.query('status') ?? null,
        limit: Number(c.req.query('limit') ?? 20),
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/posts', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      const post = await createPost(auth.workspaceId, await workspaceName(auth.workspaceId), {
        content: body.content,
        accountIds: body.accountIds,
        variants: body.variants && typeof body.variants === 'object' ? body.variants : undefined,
        mediaUrls: body.mediaUrls,
        scheduledFor: body.scheduledFor,
        publishNow: body.publishNow === true,
        draft: body.draft === true,
        tags: body.tags,
        tiktok: body.tiktok,
      })
      return c.json({ post }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/calendar', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    try {
      const now = new Date()
      const from = parseDateParam(c.req.query('from'), new Date(now.getTime() - 7 * 86_400_000))
      const to = parseDateParam(c.req.query('to'), new Date(now.getTime() + 30 * 86_400_000))
      return c.json({ from: from.toISOString(), to: to.toISOString(), posts: await calendar(auth.workspaceId, from, to) })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/analytics', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    try {
      return c.json(await socialAnalytics(auth.workspaceId, analyticsRange(c)))
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  // The agent triages the same inbox a person does: list, read a thread, reply,
  // and answer a comment. Same services, so a tool call cannot drift from the UI.
  router.get('/workspaces/:workspaceId/social/inbox', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const conversations = await listConversations(auth.workspaceId, {
      status: c.req.query('status') ?? null,
      platform: c.req.query('platform') ?? null,
      unreadOnly: c.req.query('unread') === 'true' || c.req.query('unread') === '1',
      limit: Number(c.req.query('limit') ?? 20),
    })
    const unread = conversations.reduce((total: number, row: any) => total + (row.unreadCount ?? 0), 0)
    return c.json({ conversations, unread })
  })

  router.get('/workspaces/:workspaceId/social/inbox/conversations/:conversationId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    try {
      return c.json(
        await getConversation(auth.workspaceId, c.req.param('conversationId'), conversationWindow(c)),
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.post('/workspaces/:workspaceId/social/inbox/conversations/:conversationId/messages', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(
        {
          reply: await replyToConversation(auth.workspaceId, c.req.param('conversationId'), {
            text: body.text,
            idempotencyKey: body.idempotencyKey ?? c.req.header('idempotency-key') ?? null,
          }),
        },
        201,
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/comments', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({
      comments: await listComments(auth.workspaceId, {
        platform: c.req.query('platform') ?? null,
        status: c.req.query('status') ?? null,
        limit: Number(c.req.query('limit') ?? 20),
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/comments/:commentId/reply', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json(
        {
          reply: await replyToComment(auth.workspaceId, c.req.param('commentId'), {
            text: body.text,
            idempotencyKey: body.idempotencyKey ?? c.req.header('idempotency-key') ?? null,
          }),
        },
        201,
      )
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.get('/workspaces/:workspaceId/social/automations', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    return c.json({
      automations: await listAutomations(auth.workspaceId, {
        status: c.req.query('status') ?? null,
        kind: c.req.query('kind') ?? null,
        limit: Number(c.req.query('limit') ?? 50),
      }),
    })
  })

  router.post('/workspaces/:workspaceId/social/automations', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json({ automation: await createAutomation(auth.workspaceId, body) }, 201)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.patch('/workspaces/:workspaceId/social/automations/:automationId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    const body = await readJson(c)
    try {
      return c.json({
        automation: await setAutomationStatus(
          auth.workspaceId,
          c.req.param('automationId'),
          body.status,
        ),
      })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  router.delete('/workspaces/:workspaceId/social/automations/:automationId', async (c) => {
    const auth = await authorize(c)
    if (auth instanceof Response) return auth
    try {
      await deleteAutomation(auth.workspaceId, c.req.param('automationId'))
      return c.json({ ok: true })
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

/**
 * Cloud half of the desktop relay (decision 1: every social call on every
 * surface goes through the cloud, which holds the master key and meters it).
 * It relays operations verbatim — it is not a second domain layer — so a
 * desktop's `client.ts` can target it instead of Zernio.
 */
export function socialRelayRoutes(): Hono {
  const router = new Hono()

  /**
   * Who is calling, and for which local scope. `authMiddleware` resolved the
   * cloud workspace from the Shogo key, so nothing in the request can widen it;
   * `X-Shogo-Local-Workspace` only narrows it to one local workspace of that
   * tenant. A value that is not a workspace id is a caller bug, refused before
   * any provider call — or any row is read.
   */
  function relayCaller(c: any):
    | { workspaceId: string; localWorkspaceId: string }
    | { response: Response } {
    const auth = (c.get('auth') ?? {}) as any
    const workspaceId = typeof auth.workspaceId === 'string' ? auth.workspaceId : ''
    if (!workspaceId) {
      return {
        response: c.json(
          { error: { code: 'unauthorized', message: 'The relay needs a workspace-scoped Shogo key' } },
          401,
        ),
      }
    }

    const localWorkspaceId = (c.req.header(LOCAL_SCOPE_HEADER) ?? '').trim()
    if (localWorkspaceId && !isScopeId(localWorkspaceId)) {
      return {
        response: c.json(
          {
            error: {
              code: 'invalid_local_workspace',
              message: `${LOCAL_SCOPE_HEADER} must be a local workspace id`,
            },
          },
          400,
        ),
      }
    }

    return { workspaceId, localWorkspaceId }
  }

  /**
   * Deliveries waiting for this desktop: relayed Zernio events for the local
   * scopes of the caller's workspace, which the desktop applies in its own DB
   * and then acks. Without the header, every local scope of the tenant is
   * returned (one poll covers the whole machine); with it, just that one.
   *
   * Registered before the catch-all: these are ours, not Zernio paths.
   */
  router.get('/social-relay/events', async (c) => {
    const caller = relayCaller(c)
    if ('response' in caller) return caller.response
    const limitRaw = Number(c.req.query('limit'))
    const events = await listRelayedEvents({
      workspaceId: caller.workspaceId,
      localWorkspaceId: caller.localWorkspaceId || undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    })
    return c.json({ events })
  })

  /**
   * Ack deliveries the desktop has applied, and report the ones it could not.
   * Ids from another tenant change nothing. A reported failure keeps the row in
   * the queue and counts an attempt; past the cap it is dead-lettered rather
   * than retried for ever — the response names those so the desktop can log it.
   */
  router.post('/social-relay/events/ack', async (c) => {
    const caller = relayCaller(c)
    if ('response' in caller) return caller.response
    const body = await readJson(c)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === 'string') : []
    const failures = Array.isArray(body.failed)
      ? body.failed
          .filter((entry: unknown) => !!entry && typeof (entry as any).id === 'string')
          .map((entry: any) => ({
            id: entry.id as string,
            error: typeof entry.error === 'string' ? entry.error : 'apply failed',
          }))
      : []
    const acked = await ackRelayedEvents({ workspaceId: caller.workspaceId, ids })
    const failed = await failRelayedEvents({ workspaceId: caller.workspaceId, failures })
    if (acked > 0 || failed.recorded > 0) await pruneRelayedEvents(caller.workspaceId).catch(() => {})
    return c.json({ ok: true, acked, failed: failed.recorded, deadLettered: failed.deadLettered })
  })

  /** Deliveries the desktop gave up on, so an operator can see what was lost. */
  router.get('/social-relay/events/failed', async (c) => {
    const caller = relayCaller(c)
    if ('response' in caller) return caller.response
    return c.json({ events: await listDeadLettered({ workspaceId: caller.workspaceId }) })
  })

  /**
   * Retry dead-lettered deliveries. The provider will not resend them — it was
   * told `200` — so this is the only way a delivery lost to a bug comes back
   * after the bug is fixed.
   */
  router.post('/social-relay/events/replay', async (c) => {
    const caller = relayCaller(c)
    if ('response' in caller) return caller.response
    const body = await readJson(c)
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === 'string') : []
    const requeued = await requeueRelayedEvents({ workspaceId: caller.workspaceId, ids })
    return c.json({ ok: true, requeued })
  })

  router.all('/social-relay/*', async (c) => {
    const caller = relayCaller(c)
    if ('response' in caller) return caller.response
    const { workspaceId, localWorkspaceId } = caller

    const prefix = '/api/social-relay'
    const rawPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ''
    if (!rawPath.startsWith('/')) {
      return c.json({ error: { code: 'invalid_path', message: 'Relay needs a Zernio path' } }, 400)
    }

    const query: Record<string, string> = {}
    for (const [key, value] of new URL(c.req.url).searchParams) query[key] = value

    const method = c.req.method.toUpperCase()
    const bodyText = method === 'GET' || method === 'DELETE' ? '' : await c.req.text()
    let body: unknown
    if (bodyText) {
      try {
        body = JSON.parse(bodyText)
      } catch {
        return c.json({ error: { code: 'invalid_body', message: 'Relay body must be JSON' } }, 400)
      }
    }

    try {
      const outcome = await relayOperation({
        workspaceId,
        localWorkspaceId,
        method,
        path: rawPath,
        query,
        body,
        idempotencyKey: c.req.header('idempotency-key') ?? undefined,
      })
      return c.json(outcome.body as any, outcome.status as any)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

/**
 * Cloud-only ingress for Zernio's webhooks (`POST /api/webhooks/zernio`).
 *
 * One team-level endpoint serves every workspace: the signature is checked
 * against the raw body, and the profile `externalId` the provider echoes is
 * what decides which workspace (and which of its local scopes) the event
 * belongs to. A webhook that names nothing we own is accepted and dropped —
 * Zernio retries a non-2xx seven times, and "not ours" will never become ours.
 */
export function socialWebhookRoutes(): Hono {
  const router = new Hono()

  router.post('/webhooks/zernio', async (c) => {
    const rawBody = await c.req.text()
    try {
      const result = await handleZernioWebhook({
        rawBody,
        signature: c.req.header(ZERNIO_SIGNATURE_HEADER),
        eventId: c.req.header(ZERNIO_EVENT_ID_HEADER),
      })
      return c.json(result.body as any, result.status as any)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}

export interface SocialEventRoutesConfig {
  /**
   * The runtime token (or local session) the desktop shell presents. When it
   * names a workspace, the body's workspace must be that one.
   */
  authorize: (c: any) => Promise<{ workspaceId?: string } | null>
}

/**
 * Desktop half of the relay for a *local* scope: the cloud verified the event
 * and routed it here, and this applies it in the local DB with the same
 * handler and the same dedupe key (`zernio:<event id>`), so a duplicate
 * delivery — or a retried webhook — lands as one event.
 *
 * Mounted on the desktop composer only: a local scope has no rows in the
 * cloud, so nowhere else can apply it.
 */
export function socialEventRoutes(config: SocialEventRoutesConfig): Hono {
  const router = new Hono()

  router.post('/social/events', async (c) => {
    const identity = await config.authorize(c)
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'This endpoint is for the local runtime' } }, 401)
    }
    const body = await readJson(c)
    try {
      const workspaceId = requireString(body.workspaceId, 'workspaceId')
      if (identity.workspaceId && identity.workspaceId !== workspaceId) {
        throw new SocialError(403, 'workspace_out_of_scope', 'That event belongs to another workspace')
      }
      const localWorkspaceId = typeof body.localWorkspaceId === 'string' ? body.localWorkspaceId.trim() : ''
      if (localWorkspaceId && !isScopeId(localWorkspaceId)) {
        throw new SocialError(400, 'invalid_local_workspace', 'localWorkspaceId must be a workspace id')
      }
      const account = body.account && typeof body.account === 'object'
        ? (body.account as any)
        : null
      const applied = await applySocialEvent({
        workspaceId,
        externalId: requireString(body.externalId, 'externalId'),
        localWorkspaceId,
        eventId: requireString(body.eventId, 'eventId'),
        type: requireString(body.type, 'type'),
        account,
        detail: body.detail ?? null,
        payload: body.payload ?? null,
      })
      return c.json(applied.body as any, applied.status as any)
    } catch (err) {
      return errorResponse(c, err)
    }
  })

  return router
}
