// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The page Zernio sends the browser back to after a platform's sign-in.
 *
 * Whoever finishes an OAuth leaves Shogo and lands on the platform's own consent
 * screen; without a page here they land on nothing at all (the old default was
 * `/settings/social`, which is not a route), so the last thing they see is the
 * app falling over. This renders the outcome in plain words instead.
 *
 * Pure and display-only on purpose: the query string decides what the page says
 * and nothing else. It carries no session and writes no rows — the account is
 * recorded by the app calling `POST /social/accounts/sync` once it is back in
 * front, which is the only path that can prove whose workspace it belongs to.
 */

export interface ConnectPageResult {
  status: number
  html: string
}

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
  twitter: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  threads: 'Threads',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  bluesky: 'Bluesky',
  googlebusiness: 'Google Business Profile',
  snapchat: 'Snapchat',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
}

/** Plain words for the errors a person can actually do something about. */
const ERROR_HINTS: Record<string, string> = {
  oauth_denied: 'Sign-in was cancelled before it finished. Try again and accept the permissions on the platform’s own screen.',
  account_mismatch: 'A different account was signed in than the one this connect was for. Try again with the right account.',
  missing_tiktok_permissions: 'TikTok needs every permission on its consent screen for the account to work. Try again and accept them all.',
  instagram_login_method_mismatch: 'This Instagram account is connected a different way. Disconnect it first, then connect it again.',
  no_facebook_pages: 'No Facebook Page was available to connect. Pick a Page on Meta’s screen and try again.',
  platform_account_limit: 'This Zernio plan has no room for another account on this platform.',
  PLATFORM_BETA_RESTRICTED: 'That platform is not available yet.',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function platformLabel(raw: string | null | undefined): string {
  const key = (raw ?? '').trim().toLowerCase()
  return PLATFORM_LABELS[key] ?? (key ? key : 'Your account')
}

function page(args: { title: string; heading: string; body: string; tone: 'ok' | 'error' }): string {
  const accent = args.tone === 'ok' ? '#16a34a' : '#dc2626'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(args.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: Canvas; color: CanvasText; padding: 24px; }
  main { max-width: 30rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .5rem; }
  p { margin: 0 0 .75rem; opacity: .8; }
  .mark { width: 2.5rem; height: 2.5rem; border-radius: 999px; background: ${accent};
          color: #fff; display: flex; align-items: center; justify-content: center;
          font-size: 1.4rem; margin-bottom: 1rem; }
  code { font-size: .85em; opacity: .7; }
</style>
</head>
<body>
<main>
  <div class="mark">${args.tone === 'ok' ? '&#10003;' : '!'}</div>
  <h1>${escapeHtml(args.heading)}</h1>
  ${args.body}
</main>
</body>
</html>`
}

/**
 * The page for one OAuth return. Success reads Zernio's
 * `connected, accountId, username`; failure its `error, error_message, platform`.
 */
export function connectReturnPage(params: URLSearchParams): ConnectPageResult {
  const platform = params.get('platform') ?? params.get('connected')
  const label = platformLabel(platform)
  const username = (params.get('username') ?? '').trim()
  const accountId = (params.get('accountId') ?? '').trim()
  const error = (params.get('error') ?? '').trim()
  const errorMessage = (params.get('error_message') ?? '').trim()

  // Zernio's own note: a redeemed-again code means the earlier request already
  // connected it, so the person is connected either way.
  const connected = !!accountId && (!error || error === 'code_already_redeemed')

  if (connected) {
    const handle = username ? `${label} @${username}` : label
    const hint =
      platform && platform.toLowerCase() === 'instagram'
        ? '<p>Instagram needs a professional (Business or Creator) account to publish; Instagram converts a personal one during sign-in.</p>'
        : ''
    return {
      status: 200,
      html: page({
        tone: 'ok',
        title: `${handle} connected`,
        heading: `${handle} is connected`,
        body: `<p>You can close this tab and go back to Shogo. The account shows up under Social once the app syncs.</p>${hint}`,
      }),
    }
  }

  const hint = ERROR_HINTS[error] ?? ''
  const detail = errorMessage || hint
  return {
    status: 400,
    html: page({
      tone: 'error',
      title: `${label} did not connect`,
      heading: `${label} did not connect`,
      body:
        `<p>${escapeHtml(detail || 'The sign-in did not finish. Go back to Shogo and try again.')}</p>` +
        (hint && errorMessage ? `<p>${escapeHtml(hint)}</p>` : '') +
        (error ? `<p><code>${escapeHtml(error)}</code></p>` : ''),
    }),
  }
}
