// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A desktop must not rate-limit itself (SHO-603).
 *
 * Every local request reaches the API over loopback with no `x-forwarded-for`,
 * so `getClientIp` keys them all as `'unknown'` and one 600/min bucket is
 * shared by the UI, the agent runtimes and the runtime→API internal calls. A
 * team of agents then opens a chat, moves a card and records a checkpoint past
 * 600 in a minute, and the API answers 429 to its own user and agents.
 *
 * The IP limiters exist to protect a shared, internet-facing server, so the
 * local profile does not mount them ("Local mode is unlimited", SHO-43). The
 * per-user/per-agent limits in `lib/chat-limits.ts` still guard loops — they
 * are keyed by user, not by IP.
 */

import { describe, expect, test } from 'bun:test'
import { createApp } from '../create-app'

/** No forwarding headers — exactly what the renderer, runtimes and agents send. */
const call = (app: ReturnType<typeof createApp>, path: string) => app.request(path)

function statuses(count: number, res: () => Promise<Response>): Promise<Map<number, number>> {
  return (async () => {
    const seen = new Map<number, number>()
    for (let i = 0; i < count; i++) {
      const { status } = await res()
      seen.set(status, (seen.get(status) ?? 0) + 1)
    }
    return seen
  })()
}

describe('local profile does not rate-limit by IP (SHO-603)', () => {
  test('2,000 /api/* requests in a row all succeed', async () => {
    const app = createApp({ profile: 'local' })
    const seen = await statuses(2_000, () => call(app, '/api/version'))

    expect(Object.fromEntries(seen)).toEqual({ 200: 2_000 })
  })

  test('/api/* responses carry no X-RateLimit-* headers', async () => {
    const app = createApp({ profile: 'local' })
    const res = await call(app, '/api/version')

    expect(res.status).toBe(200)
    expect(res.headers.get('x-ratelimit-limit')).toBeNull()
    expect(res.headers.get('x-ratelimit-remaining')).toBeNull()
    expect(res.headers.get('retry-after')).toBeNull()
  })

  test('runtime internal calls and the auth handler are not throttled either', async () => {
    const app = createApp({ profile: 'local' })

    // /api/internal/* is where the runtime's checkpoint and trust calls land.
    const internal = await statuses(700, () => call(app, '/api/internal/does-not-exist'))
    expect(internal.get(429)).toBeUndefined()

    const auth = await statuses(120, () => call(app, '/api/auth/get-session'))
    expect(auth.get(429)).toBeUndefined()
  })
})

describe('cloud profile keeps the IP limiters (SHO-603)', () => {
  // A cloud caller arrives through the proxy, which sets x-forwarded-for; each
  // test uses its own client IP so the process-wide limiter stores stay apart.
  const from = (app: ReturnType<typeof createApp>, ip: string, path: string) =>
    app.request(path, { headers: { 'x-forwarded-for': ip } })

  test('the 601st /api/* request in a minute from one IP is 429', async () => {
    const app = createApp({ profile: 'cloud' })
    const ip = '203.0.113.10'

    let firstBlocked: number | null = null
    for (let i = 1; i <= 620 && firstBlocked === null; i++) {
      const res = await from(app, ip, '/api/version')
      if (res.status === 429) {
        expect(res.headers.get('x-ratelimit-limit')).toBe('600')
        firstBlocked = i
      }
    }

    expect(firstBlocked).toBe(601)
  })

  test('the 61st /api/auth/* request in a minute from one IP is 429', async () => {
    const app = createApp({ profile: 'cloud' })
    const ip = '203.0.113.11'

    const seen = new Map<number, number>()
    for (let i = 0; i < 61; i++) {
      const { status } = await from(app, ip, '/api/auth/get-session')
      seen.set(status, (seen.get(status) ?? 0) + 1)
    }

    expect(seen.get(429)).toBe(1)
    expect(seen.get(200)).toBe(60)
  })
})
