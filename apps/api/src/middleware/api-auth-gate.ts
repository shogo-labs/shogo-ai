// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Global `/api/*` authentication gate, mounted in server.ts right after
 * `authMiddleware`. Requests on a public path pass through; everything else
 * goes to `requireAuth`.
 *
 * Public paths come from two lists:
 *  - `PUBLIC_PREFIXES` (./auth) — exempt wherever `requireAuth` runs, including
 *    sub-router guards. Key-authenticated endpoints belong there.
 *  - `GATE_PUBLIC_PREFIXES` below — exempt from this gate only, so a sub-router
 *    can still apply `requireAuth` to a narrower path under the same prefix.
 * Don't repeat a `PUBLIC_PREFIXES` entry here.
 */
import type { Context, Next } from 'hono'
import { isPublicPath, requireAuth } from './auth'

export const GATE_PUBLIC_PREFIXES = [
  '/api/billing/ios/notifications',
  // Shared-file downloads: the signed token in the path is the credential
  // (verified in routes/shared-files.ts).
  '/api/f/',
  // Huddle join links: guests open them without an account. The link token or
  // request id is the credential (checked in routes/huddles.ts).
  '/api/huddle-links/',
  '/api/marketplace',
  '/api/tech-stacks',
  '/api/instances/heartbeat',
  '/api/instances/ws',
  // Native MLM affiliate program — public surfaces:
  //   /lookup  → marketing site validates a code before redirect
  //   /click   → Cloudflare Pages Function records the click using
  //              SHOGO_INTERNAL_SECRET (auth handled in-route)
  //   /visit   → in-app /r/<code> route records the click from the
  //              browser (no secret; analytics-only, validated in-route)
  '/api/affiliates/lookup',
  '/api/affiliates/click',
  '/api/affiliates/visit',
  // Anonymous wake endpoints hit by the edge Workers / loading page when a
  // visitor lands on a sleeping published subdomain or preview link. They
  // only nudge the activator / provision a pod keyed by a real published
  // subdomain or (UUID) project id; no tenant data is exposed.
  '/api/published/',
  '/api/preview/',
  // The page a browser lands on after a social (Instagram/TikTok) sign-in. The
  // tab came back from the platform and carries no Shogo session; the handler is
  // display-only and writes nothing, so there is nothing to protect.
  '/api/social/connect/return',
]

function isWebchatProxyPath(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/agent-proxy\/agent\/channels\/webchat\//.test(path)
}

export function isAllowedUnauthWebchatProxyPath(path: string): boolean {
  if (!isWebchatProxyPath(path)) return false
  const match = path.match(/^\/api\/projects\/[^/]+\/agent-proxy(\/agent\/channels\/webchat\/.*)$/)
  const relative = match?.[1] || ''
  return relative === '/agent/channels/webchat/widget.js' ||
    relative === '/agent/channels/webchat/health' ||
    relative === '/agent/channels/webchat/config' ||
    relative === '/agent/channels/webchat/session' ||
    relative === '/agent/channels/webchat/message' ||
    relative.startsWith('/agent/channels/webchat/events/')
}

// Thumbnail image bytes, served to an <img> / RN <Image> that can present no
// ambient credentials. The per-project token in `?t=` is the credential and is
// verified in-route, so session gating must not run. See deriveThumbnailToken.
export function isTokenGatedThumbnailPath(path: string): boolean {
  return /^\/api\/projects\/[^/]+\/thumbnail\.png$/.test(path)
}

function isTokenGatedChatAttachmentPath(path: string): boolean {
  return path.startsWith('/api/chat-attachments/')
}

// A file shared into team chat (photo, video, voice note), served to an <img> /
// <video> / RN <Image> that can present no ambient credentials: a native Image
// sends no cookie and a link handed to the system browser has none either. The
// `?t=` capability token is the credential and is verified in-route, which also
// falls back to the session. Only the bare file route: `/meta` and `/text`
// answer to a signed-in user and stay behind the gate.
export function isTokenGatedConversationFilePath(path: string): boolean {
  return /^\/api\/conversation-files\/[^/]+\/?$/.test(path)
}

// Profile picture bytes, served to an <img> / RN <Image> that can present no
// ambient credentials. The token in `?t=` is the credential and is verified
// in-route (routes/local-user.ts), so session gating must not run.
export function isTokenGatedUserAvatarPath(path: string): boolean {
  return path.startsWith('/api/user-avatar/')
}

/** True when the global gate lets `path` through without a session. */
export function isGatePublicPath(path: string): boolean {
  if (isPublicPath(path)) return true
  if (GATE_PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true
  if (isAllowedUnauthWebchatProxyPath(path)) return true
  if (isTokenGatedThumbnailPath(path)) return true
  if (isTokenGatedChatAttachmentPath(path)) return true
  if (isTokenGatedConversationFilePath(path)) return true
  if (isTokenGatedUserAvatarPath(path)) return true
  // Heartbeat sync is called by the runtime with x-runtime-token auth
  if (path.endsWith('/heartbeat/sync')) return true
  // Voice provider webhooks (signature-verified in-handler). These have
  // to bypass session-cookie / API-key auth entirely because the caller
  // is ElevenLabs or Twilio — no Shogo credentials are present.
  if (
    path === '/api/voice/elevenlabs/webhook' ||
    path.startsWith('/api/voice/twilio/status/')
  ) {
    return true
  }
  // GitHub App webhook (routes/github.ts), verified with HMAC-SHA256 over
  // `GH_APP_WEBHOOK_SECRET` inside the handler via `verifyWebhookSignature`.
  // GitHub's delivery carries no Shogo session or API key.
  if (path === '/api/github/webhook') return true
  // GitHub App Setup URL / OAuth callback (routes/github.ts). The browser
  // returning from GitHub has no Shogo session; the HMAC-signed `state` and
  // the OAuth code are verified in services/github-authorize.ts.
  if (path === '/api/github/callback') return true
  return false
}

export async function apiAuthGate(c: Context, next: Next) {
  if (isGatePublicPath(new URL(c.req.url).pathname)) return next()
  return requireAuth(c, next)
}
