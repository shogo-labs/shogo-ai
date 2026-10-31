// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Chromium permission decisions for the desktop session, kept pure so they can
 * be unit-tested without booting Electron.
 *
 * Chromium asks the session before anything privileged happens. The handler
 * used to answer `false` to everything except `'media'`, and `'fullscreen'`
 * rides the same request path: a `<video>`'s native fullscreen control, the
 * huddle window's Fullscreen button and IDE zen mode all call
 * `requestFullscreen()`, which Chromium gates on the `'fullscreen'` permission.
 * Denying it rejects the promise, so the button does nothing at all and no
 * error reaches the page (SHO-262).
 *
 * So: media keeps its own path (the TCC check lives in `main.ts`), fullscreen
 * is allowed for our own app origins, and everything else stays denied.
 */

export interface TrustedOriginOptions {
  isDev: boolean
  /** `DESKTOP_DEV_URL` — Metro's origin in a dev build. */
  devUrl?: string
  /** `getCloudUrl()` — the app's own origin in cloud mode. */
  cloudUrl?: string
}

export type PermissionDecision =
  /** Trusted mic/camera request: needs the macOS TCC gate before answering. */
  | 'media'
  /** Trusted request with no OS gate — answer yes straight away. */
  | 'allow'
  | 'deny'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])

/** Origin of a well-formed URL, or `null` when it cannot be parsed. */
function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/**
 * Is `url` one of our own app origins?
 *
 * Ours are the packaged `shogo://app` renderer, a `http(s)://localhost` or
 * `http(s)://127.0.0.1` dev/canvas-preview origin (so a video inside a local
 * canvas iframe works too), the configured dev URL and — in cloud mode — the
 * cloud URL. Hosts are compared exactly: `http://localhost.evil.com` is not
 * localhost, and neither is `https://studio.shogo.ai.evil.com`.
 */
export function isTrustedAppOrigin(url: string, options: TrustedOriginOptions): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol === 'shogo:') return true
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOCAL_HOSTS.has(parsed.hostname)) {
    return true
  }

  const ownOrigin = parsed.origin
  if (options.isDev) {
    const devOrigin = originOf(options.devUrl)
    if (devOrigin && devOrigin === ownOrigin) return true
  }
  const cloudOrigin = originOf(options.cloudUrl)
  if (cloudOrigin && cloudOrigin === ownOrigin) return true

  return false
}

/**
 * What the session handlers should do with `permission` from `requestingUrl`.
 *
 * An unparseable or empty requesting URL is untrusted — that is the old
 * behaviour for anything we cannot attribute to our own renderer.
 */
export function decidePermission(
  permission: string,
  requestingUrl: string,
  options: TrustedOriginOptions,
): PermissionDecision {
  const trusted = isTrustedAppOrigin(requestingUrl, options)
  switch (permission) {
    case 'media':
      return trusted ? 'media' : 'deny'
    case 'fullscreen':
      return trusted ? 'allow' : 'deny'
    default:
      return 'deny'
  }
}
