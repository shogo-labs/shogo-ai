// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The native OAuth hand-back (SHO-414).
 *
 * Better Auth answers a social sign-in with a 302 to the app's own scheme
 * (`shogo:///?cookie=…`). iOS hands a 302 to a custom scheme to the OS as a
 * deep link instead of back to the `ASWebAuthenticationSession` that opened the
 * browser, so `openAuthSessionAsync` resolves `cancel`, the cookie is never
 * stored, and the next `get-session` is anonymous. The mount point rewrites
 * that redirect into a page that navigates from JavaScript, which the auth
 * session does intercept.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isNativeCallbackUrl, toNativeAuthHandback } from '../lib/auth-handback'

const COOKIE_URL =
  'shogo:///?cookie=shogo.state%3D%3B+Max-Age%3D0%2C+shogo.session_token%3Dabc.sig%253D%3B+Max-Age%3D604800'

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location })
  for (const cookie of setCookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

describe('isNativeCallbackUrl', () => {
  it('recognises the app schemes', () => {
    expect(isNativeCallbackUrl('shogo:///')).toBe(true)
    expect(isNativeCallbackUrl(COOKIE_URL)).toBe(true)
    expect(isNativeCallbackUrl('exp://127.0.0.1:8081/--/')).toBe(true)
  })

  it('leaves web and desktop callbacks alone', () => {
    expect(isNativeCallbackUrl('https://studio.shogo.ai/')).toBe(false)
    expect(isNativeCallbackUrl('http://localhost:8081/auth/cli-link?state=x')).toBe(false)
  })
})

describe('toNativeAuthHandback', () => {
  it('turns a custom-scheme 302 into a page that navigates to the same URL', async () => {
    const res = toNativeAuthHandback(redirect(COOKIE_URL))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('location')).toBeNull()

    const html = await res.text()
    // The exact deep link, cookie param included, is what the app needs.
    expect(html).toContain(JSON.stringify(COOKIE_URL))
    expect(html).toContain('window.location.href')
  })

  it('keeps the Set-Cookie headers the redirect carried', async () => {
    const res = toNativeAuthHandback(
      redirect(COOKIE_URL, ['shogo.state=; Max-Age=0; Path=/', 'shogo.session_token=abc; Path=/']),
    )

    expect(res.headers.getSetCookie()).toEqual([
      'shogo.state=; Max-Age=0; Path=/',
      'shogo.session_token=abc; Path=/',
    ])
  })

  it('leaves an https redirect as a 302', () => {
    const original = redirect('https://studio.shogo.ai/auth/cli-link?state=x')
    const res = toNativeAuthHandback(original)

    expect(res).toBe(original)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://studio.shogo.ai/auth/cli-link?state=x')
  })

  it('leaves non-redirect responses untouched', async () => {
    const ok = new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    expect(toNativeAuthHandback(ok)).toBe(ok)

    const failed = new Response(null, { status: 401 })
    expect(toNativeAuthHandback(failed)).toBe(failed)
  })

  it('does not let a crafted callback URL break out of the script tag', async () => {
    const res = toNativeAuthHandback(redirect('shogo:///?cookie=</script><script>alert(1)</script>'))
    const html = await res.text()

    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })
})

/**
 * The helper is only worth anything if the auth mount point actually calls it.
 * Both servers mount `/api/auth/*` (the cloud monolith in `server.ts` and the
 * desktop/local factory in `app/create-app.ts`), and a later refactor that
 * drops the wrapper would silently restore the broken hand-back.
 */
describe('the auth mount point is wrapped', () => {
  const MOUNTS = ['src/server.ts', 'src/app/create-app.ts']

  for (const file of MOUNTS) {
    it(`${file} hands /api/auth/* through toNativeAuthHandback`, () => {
      const source = readFileSync(join(import.meta.dir, '..', '..', file), 'utf8')
      const mount = source
        .split('\n')
        .find((line) => line.includes("'/api/auth/*'") && line.includes('auth.handler'))

      expect(mount).toBeDefined()
      expect(mount).toContain('toNativeAuthHandback(await auth.handler(')
    })
  }
})
