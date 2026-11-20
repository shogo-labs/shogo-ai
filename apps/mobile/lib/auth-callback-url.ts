// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The `callbackURL` an OAuth round trip is started with.
 *
 * On native this MUST stay a root-relative path. `@better-auth/expo`'s init
 * hook rewrites a leading `/` into the app's own deep link
 * (`Linking.createURL(path, { scheme })` → `shogo:///`), and that is the URL
 * `WebBrowser.openAuthSessionAsync` waits for. An absolute `https://` URL would
 * send the browser to the website after the provider redirect and never return
 * to the app — the session row would be created server-side and the app would
 * stay signed out (SHO-414).
 *
 * On web the origin is prepended so the round trip lands back on the same
 * origin, keeping `?next=…` (the desktop cloud-login bridge) intact.
 */
export function resolveAuthCallbackUrl(next: string, origin?: string | null): string {
  const path = next.startsWith('/') && !next.startsWith('//') ? next : '/'
  return origin ? `${origin}${path}` : path
}
