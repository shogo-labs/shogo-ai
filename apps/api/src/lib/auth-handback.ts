// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native OAuth hand-back.
 *
 * Better Auth ends a social sign-in by redirecting to the `callbackURL` the
 * client asked for. On native that URL is the app's own scheme
 * (`shogo:///?cookie=…`, written by `@better-auth/expo`'s after-hook), and the
 * redirect is an HTTP 302.
 *
 * iOS does not hand a 302 to a custom scheme back to the
 * `ASWebAuthenticationSession` that opened the browser — the OS treats it as a
 * deep link, opens the app and dismisses the session. `expo-web-browser`'s
 * `openAuthSessionAsync` therefore resolves `{ type: 'cancel' }`, the Expo
 * client plugin's `if (result.type !== 'success') return` bails, the session
 * cookie is never written to SecureStore, and the next `get-session` is
 * anonymous. Nothing throws, so the failure is invisible (SHO-414).
 *
 * A navigation started from the page itself *is* intercepted by the auth
 * session, so a custom-scheme hand-back is served as a tiny HTML page that
 * navigates to the same URL. `/api/integrations/callback` already does this
 * for the Composio flow; this is the same fix at the auth mount point, so it
 * covers every social provider and both the desktop and cloud servers.
 *
 * Web and desktop callbacks are `http(s)://` and keep their 302.
 */

/** Schemes the mobile app registers for its OAuth deep link. */
const NATIVE_CALLBACK_SCHEMES = ['shogo:', 'exp:']

export function isNativeCallbackUrl(url: string): boolean {
  return NATIVE_CALLBACK_SCHEMES.some((scheme) => url.startsWith(scheme))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function handbackPage(target: string): string {
  // `target` is a URL, so JSON.stringify is a safe JS string literal and the
  // only escaping that matters is `</script>`.
  const literal = JSON.stringify(target).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signing in…</title>
</head>
<body style="font-family:-apple-system,system-ui,sans-serif;padding:2rem;text-align:center;color:#111">
<p>Signing you in…</p>
<p style="margin-top:1rem"><a href="${escapeHtml(target)}" style="color:#4F46E5">Tap here if you are not redirected</a></p>
<script>window.location.href = ${literal};</script>
</body>
</html>`
}

/**
 * Rewrite a redirect to a native callback scheme into an HTML page that
 * performs the same navigation from JavaScript. Any other response (including
 * an `http(s)` redirect) is returned untouched.
 */
export function toNativeAuthHandback(response: Response): Response {
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get('location')
  if (!location || !isNativeCallbackUrl(location)) return response

  const headers = new Headers()
  for (const [key, value] of response.headers) {
    if (key === 'location' || key === 'content-type' || key === 'content-length') continue
    headers.set(key, value)
  }
  // `Headers` folds repeated `set-cookie` values into one comma-joined string,
  // which corrupts them; copy them individually.
  const setCookies = response.headers.getSetCookie?.() ?? []
  headers.delete('set-cookie')
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  headers.set('content-type', 'text/html; charset=utf-8')
  headers.set('cache-control', 'no-store')

  return new Response(handbackPage(location), { status: 200, headers })
}
