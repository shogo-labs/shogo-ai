// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * What the relay is allowed to do, as a pure decision.
 *
 * Kept free of database imports so the tenant boundary is testable on its own
 * and so no test that exercises it can drag Prisma (or a mocked Prisma) in.
 */

import type { SocialProfileRow } from './profiles.service'

export type RelayPlan =
  | {
      kind: 'forward'
      path: string
      query: Record<string, string>
      body?: unknown
      /** Post-forward bookkeeping the cloud needs to own: routing + billing. */
      record?: 'profile-created' | 'accounts-listed' | 'post-created' | 'automation-created'
      /**
       * The relay may create the scope's profile before forwarding. Only a
       * connect does this: a workspace's first-ever call is a connect, and it
       * has no profile row for the desktop to be scoped against.
       */
      ensureProfile?: boolean
      /** Resource id the route must prove belongs to the caller first. */
      verifyAccountId?: string
      verifyPostId?: string
      /** An automation/workflow id this workspace already recorded. */
      verifyAutomationId?: string
    }
  | { kind: 'deny'; status: number; code: string; message: string }

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])

function deny(status: number, code: string, message: string): RelayPlan {
  return { kind: 'deny', status, code, message }
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function needsProfile(profile: SocialProfileRow | null): RelayPlan | null {
  if (profile) return null
  return deny(
    412,
    'social_profile_missing',
    'This workspace has no social profile yet — start a connect to create it.',
  )
}

/**
 * Decide what the relay may do for one *scope* of a workspace, and rewrite the
 * operation so it can only ever touch that scope's Zernio profile.
 *
 * `externalId` is the derived routing id for the scope (`ws_<workspaceId>` or
 * `lws_<localWorkspaceId>`), never a value from the request: a desktop's local
 * workspaces each own a profile, so the caller's own local scope is the only
 * thing that may select one.
 */
export function planRelayRequest(args: {
  method: string
  path: string
  query: Record<string, string>
  body: any
  workspaceId: string
  localWorkspaceId?: string
  /** Derived routing id for the scope; never read from the request. */
  externalId: string
  profile: SocialProfileRow | null
}): RelayPlan {
  const method = args.method.toUpperCase()
  if (!METHODS.has(method)) return deny(405, 'method_not_allowed', `${method} is not relayed`)

  const seg = segments(args.path)
  if (seg.length === 0) return deny(400, 'invalid_path', 'Relay needs a Zernio path')

  // ── profiles ────────────────────────────────────────────────────────────
  if (seg[0] === 'profiles' && seg.length === 1) {
    if (method === 'GET') {
      // Only ever the caller's own profile, resolved by the routing id we own.
      return { kind: 'forward', path: '/profiles', query: { externalId: args.externalId } }
    }
    if (method === 'POST') {
      return {
        kind: 'forward',
        path: '/profiles',
        query: {},
        body: {
          name: typeof args.body?.name === 'string' && args.body.name ? args.body.name : (args.profile?.name ?? 'Shogo workspace'),
          externalId: args.externalId,
        },
        record: 'profile-created',
      }
    }
    return deny(405, 'method_not_allowed', `${method} /profiles is not relayed`)
  }

  if (seg[0] === 'profiles' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (seg[1] !== args.profile!.zernioProfileId) {
      return deny(403, 'profile_out_of_scope', 'That profile belongs to another workspace.')
    }
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /profiles/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/profiles/${encodeURIComponent(args.profile!.zernioProfileId)}`,
      query: {},
      body: method === 'PATCH' ? { name: args.body?.name } : undefined,
    }
  }

  // ── connect ─────────────────────────────────────────────────────────────
  // A connect is the one operation a scope with no profile may make: it is how
  // a brand-new workspace creates its profile. The relay creates and records it
  // (`ensureProfile`) and then plans this same request again with the profile
  // in hand, so the forwarded call is identical either way.
  if (seg[0] === 'connect') {
    if (method !== 'GET' || seg.length !== 2) {
      return deny(405, 'method_not_allowed', `${method} ${args.path} is not relayed`)
    }
    const query: Record<string, string> = {}
    if (typeof args.query.redirect_url === 'string') query.redirect_url = args.query.redirect_url
    // `forceReauth` and `expectedUsername` are how "connect *this* account"
    // holds: without them a desktop's connect lands on whichever account the
    // device already has signed in.
    if (typeof args.query.forceReauth === 'string') query.forceReauth = args.query.forceReauth
    if (typeof args.query.expectedUsername === 'string') query.expectedUsername = args.query.expectedUsername
    if (typeof args.query.reconnectAccountId === 'string') {
      query.reconnectAccountId = args.query.reconnectAccountId
    }
    if (!args.profile) {
      return {
        kind: 'forward',
        path: `/connect/${encodeURIComponent(seg[1]!)}`,
        query,
        ensureProfile: true,
      }
    }
    return {
      kind: 'forward',
      path: `/connect/${encodeURIComponent(seg[1]!)}`,
      query: { profileId: args.profile.zernioProfileId, ...query },
    }
  }

  // ── media: presigned uploads ────────────────────────────────────────────
  //
  // An upload slot is scoped to the caller's Zernio account, not to a profile,
  // so this needs no profile. It is still an allowlist entry rather than a
  // pass-through: only the mint is relayed (never the PUT, which carries no
  // Shogo credential anyway), and a generic content type is refused before the
  // provider sees it.
  if (seg[0] === 'media' && seg.length === 2 && seg[1] === 'presign') {
    if (method !== 'POST') {
      return deny(405, 'method_not_allowed', `${method} /media/presign is not relayed`)
    }
    const contentType =
      typeof args.body?.contentType === 'string' ? args.body.contentType.trim().toLowerCase() : ''
    if (!contentType || contentType === 'application/octet-stream') {
      return deny(
        400,
        'invalid_content_type',
        'contentType must be the file\'s real media type (image/png, video/mp4, …); application/octet-stream is not accepted.',
      )
    }
    const size = args.body?.size
    return {
      kind: 'forward',
      path: '/media/presign',
      query: {},
      body: {
        filename: args.body?.filename,
        contentType,
        ...(typeof size === 'number' ? { size } : {}),
      },
    }
  }

  // ── accounts ────────────────────────────────────────────────────────────
  if (seg[0] === 'accounts' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method !== 'GET') return deny(405, 'method_not_allowed', `${method} /accounts is not relayed`)
    return {
      kind: 'forward',
      path: '/accounts',
      query: { profileId: args.profile!.zernioProfileId },
      record: 'accounts-listed',
    }
  }

  if (seg[0] === 'accounts' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /accounts/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/accounts/${encodeURIComponent(seg[1]!)}`,
      query: { profileId: args.profile!.zernioProfileId },
      body: method === 'PATCH' ? { profileId: args.profile!.zernioProfileId } : undefined,
      verifyAccountId: seg[1]!,
    }
  }

  // ── posts ───────────────────────────────────────────────────────────────
  if (seg[0] === 'posts' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method === 'GET') {
      return {
        kind: 'forward',
        path: '/posts',
        query: { profileId: args.profile!.zernioProfileId },
      }
    }
    if (method === 'POST') {
      return {
        kind: 'forward',
        path: '/posts',
        query: {},
        body: { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId },
        record: 'post-created',
      }
    }
    return deny(405, 'method_not_allowed', `${method} /posts is not relayed`)
  }

  if (seg[0] === 'posts' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /posts/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/posts/${encodeURIComponent(seg[1]!)}`,
      query: { profileId: args.profile!.zernioProfileId },
      body: method === 'PATCH' ? { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId } : undefined,
      verifyPostId: seg[1]!,
    }
  }

  // ── inbox: DMs and comments ─────────────────────────────────────────────
  //
  // These read and write customer conversations, so every one of them is
  // pinned: `profileId` is rewritten to the caller's own profile, and an
  // `accountId` (query or body) has to be proved to belong to the workspace
  // before a single byte reaches the provider.
  if (seg[0] === 'inbox' && seg[1] === 'conversations' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method !== 'GET') return deny(405, 'method_not_allowed', `${method} /inbox/conversations is not relayed`)
    const query: Record<string, string> = { profileId: args.profile!.zernioProfileId }
    if (typeof args.query.limit === 'string') query.limit = args.query.limit
    if (typeof args.query.accountId === 'string') query.accountId = args.query.accountId
    if (typeof args.query.status === 'string') query.status = args.query.status
    if (typeof args.query.platform === 'string') query.platform = args.query.platform
    return {
      kind: 'forward',
      path: '/inbox/conversations',
      query,
      ...(query.accountId ? { verifyAccountId: query.accountId } : {}),
    }
  }

  if (seg[0] === 'inbox' && seg[1] === 'conversations' && seg.length === 4 && seg[3] === 'messages') {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    const queryAccountId = typeof args.query.accountId === 'string' ? args.query.accountId : ''
    const bodyAccountId = typeof args.body?.accountId === 'string' ? args.body.accountId : ''
    const accountId = method === 'POST' ? bodyAccountId : queryAccountId
    // Both directions address one account's thread. Without it we cannot prove
    // whose thread this is, so we do not forward.
    if (!accountId) return deny(400, 'invalid_body', 'accountId is required for an inbox thread')
    const path = `/inbox/conversations/${encodeURIComponent(seg[2]!)}/messages`
    if (method === 'GET') {
      const query: Record<string, string> = { accountId }
      if (typeof args.query.limit === 'string') query.limit = args.query.limit
      if (typeof args.query.sortOrder === 'string') query.sortOrder = args.query.sortOrder
      return { kind: 'forward', path, query, verifyAccountId: accountId }
    }
    if (method === 'POST') {
      if (typeof args.body?.message !== 'string' || !args.body.message.trim()) {
        return deny(400, 'invalid_body', 'message is required')
      }
      return {
        kind: 'forward',
        path,
        query: {},
        body: { accountId, message: args.body.message },
        verifyAccountId: accountId,
      }
    }
    return deny(405, 'method_not_allowed', `${method} ${args.path} is not relayed`)
  }

  if (seg[0] === 'inbox' && seg[1] === 'comments' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method !== 'GET') return deny(405, 'method_not_allowed', `${method} /inbox/comments is not relayed`)
    const query: Record<string, string> = { profileId: args.profile!.zernioProfileId }
    if (typeof args.query.limit === 'string') query.limit = args.query.limit
    if (typeof args.query.platform === 'string') query.platform = args.query.platform
    return { kind: 'forward', path: '/inbox/comments', query }
  }

  if (seg[0] === 'inbox' && seg[1] === 'comments' && seg.length === 3) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    const queryAccountId = typeof args.query.accountId === 'string' ? args.query.accountId : ''
    const bodyAccountId = typeof args.body?.accountId === 'string' ? args.body.accountId : ''
    const accountId = method === 'POST' ? bodyAccountId : queryAccountId
    if (!accountId) return deny(400, 'invalid_body', 'accountId is required for a comment thread')
    const path = `/inbox/comments/${encodeURIComponent(seg[2]!)}`
    if (method === 'GET') {
      const query: Record<string, string> = { accountId }
      if (typeof args.query.limit === 'string') query.limit = args.query.limit
      if (typeof args.query.commentId === 'string') query.commentId = args.query.commentId
      return { kind: 'forward', path, query, verifyAccountId: accountId }
    }
    if (method === 'POST') {
      if (typeof args.body?.message !== 'string' || !args.body.message.trim()) {
        return deny(400, 'invalid_body', 'message is required')
      }
      const body: Record<string, unknown> = { accountId, message: args.body.message }
      if (typeof args.body?.commentId === 'string') body.commentId = args.body.commentId
      return { kind: 'forward', path, query: {}, body, verifyAccountId: accountId }
    }
    return deny(405, 'method_not_allowed', `${method} ${args.path} is not relayed`)
  }

  // ── automations: comment→DM and DM sequences ────────────────────────────
  //
  // Same rule as posts: the profile is forced onto the caller's own, an account
  // in the body has to be proved, and a resource id has to be one we recorded
  // for this workspace — an automation sends DMs, so a cross-tenant id would be
  // sending messages as somebody else.
  if (seg[0] === 'comment-automations' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method === 'GET') {
      return {
        kind: 'forward',
        path: '/comment-automations',
        query: { profileId: args.profile!.zernioProfileId },
      }
    }
    if (method === 'POST') {
      const accountId = typeof args.body?.accountId === 'string' ? args.body.accountId : ''
      if (!accountId) return deny(400, 'invalid_body', 'accountId is required for an automation')
      return {
        kind: 'forward',
        path: '/comment-automations',
        query: {},
        body: { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId },
        record: 'automation-created',
        verifyAccountId: accountId,
      }
    }
    return deny(405, 'method_not_allowed', `${method} /comment-automations is not relayed`)
  }

  if (seg[0] === 'comment-automations' && seg.length === 2) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /comment-automations/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: `/comment-automations/${encodeURIComponent(seg[1]!)}`,
      query: {},
      body: method === 'PATCH' ? { ...(args.body ?? {}) } : undefined,
      verifyAutomationId: seg[1]!,
    }
  }

  if (seg[0] === 'workflows' && seg.length === 1) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    if (method === 'GET') {
      return {
        kind: 'forward',
        path: '/workflows',
        query: { profileId: args.profile!.zernioProfileId },
      }
    }
    if (method === 'POST') {
      const accountId = typeof args.body?.accountId === 'string' ? args.body.accountId : ''
      if (!accountId) return deny(400, 'invalid_body', 'accountId is required for a workflow')
      return {
        kind: 'forward',
        path: '/workflows',
        query: {},
        body: { ...(args.body ?? {}), profileId: args.profile!.zernioProfileId },
        record: 'automation-created',
        verifyAccountId: accountId,
      }
    }
    return deny(405, 'method_not_allowed', `${method} /workflows is not relayed`)
  }

  if (seg[0] === 'workflows' && (seg.length === 2 || (seg.length === 3 && seg[2] === 'activate'))) {
    const missing = needsProfile(args.profile)
    if (missing) return missing
    const activation = seg.length === 3
    if (activation) {
      if (method !== 'POST') {
        return deny(405, 'method_not_allowed', `${method} /workflows/:id/activate is not relayed`)
      }
    } else if (!['GET', 'PATCH', 'DELETE'].includes(method)) {
      return deny(405, 'method_not_allowed', `${method} /workflows/:id is not relayed`)
    }
    return {
      kind: 'forward',
      path: activation
        ? `/workflows/${encodeURIComponent(seg[1]!)}/activate`
        : `/workflows/${encodeURIComponent(seg[1]!)}`,
      query: {},
      body: method === 'PATCH' ? { ...(args.body ?? {}) } : undefined,
      verifyAutomationId: seg[1]!,
    }
  }

  return deny(403, 'relay_path_not_allowed', `The relay does not serve ${method} ${args.path}.`)
}
