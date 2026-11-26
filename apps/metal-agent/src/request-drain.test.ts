// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A restarting agent drops no control call: calls in flight finish, new ones
 * get a 503 the control plane retries (`x-metal-restarting`), and liveness
 * reads keep being answered. Driven over real HTTP, as server.ts wires it.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { RESTARTING_HEADER, RequestDrain } from './request-drain'

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
})

function agent(drain: RequestDrain, handler: (req: Request) => Promise<Response>) {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => drain.run(() => handler(req), { exempt: req.method === 'GET' || new URL(req.url).pathname === '/status' }),
  })
  servers.push(server)
  return `http://127.0.0.1:${server.port}`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('RequestDrain', () => {
  test('an in-flight call finishes; new calls are refused retryably; reads stay up', async () => {
    const drain = new RequestDrain()
    const gate = deferred()
    const url = agent(drain, async (req) => {
      if (new URL(req.url).pathname === '/assign') await gate.promise
      return Response.json({ ok: true })
    })

    const inFlight = fetch(`${url}/assign`, { method: 'POST' })
    while (drain.active === 0) await Bun.sleep(1)
    const drained = drain.drain(5_000)
    expect(drain.isDraining).toBe(true)

    const refused = await fetch(`${url}/assign`, { method: 'POST' })
    expect(refused.status).toBe(503)
    expect(refused.headers.get(RESTARTING_HEADER)).toBe('1')
    expect(await refused.json()).toMatchObject({ retryable: true })

    expect((await fetch(`${url}/version`)).status).toBe(200)
    expect((await fetch(`${url}/status`, { method: 'POST' })).status).toBe(200)

    gate.resolve()
    expect((await inFlight).status).toBe(200)
    expect(await drained).toBe(true)
    expect(drain.active).toBe(0)
  })

  test('drain resolves at once when idle, and gives up at the timeout', async () => {
    expect(await new RequestDrain().drain(1_000)).toBe(true)

    const drain = new RequestDrain()
    const url = agent(drain, () => new Promise(() => {}))
    void fetch(`${url}/assign`, { method: 'POST' }).catch(() => {})
    while (drain.active === 0) await Bun.sleep(1)
    const started = Date.now()
    expect(await drain.drain(50)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(drain.active).toBe(1)
  })

  test('a cold OPEN gets its own deadline instead of the short one (SHO-584)', async () => {
    // An /assign hydrating an 812 MB member takes about a minute. The old 10 s
    // drain cut it off, and the next agent adopted the half-hydrated VM as a
    // normal assigned one — it could never back up, so it never stopped.
    const drain = new RequestDrain()
    const gate = deferred()
    const url = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname
        return drain.run(
          async () => {
            if (path === '/assign') await gate.promise
            return Response.json({ ok: true })
          },
          { exempt: req.method === 'GET', long: path === '/assign' },
        )
      },
    })
    servers.push(url)

    const inFlight = fetch(`http://127.0.0.1:${url.port}/assign`, { method: 'POST' })
    while (drain.active === 0) await Bun.sleep(1)
    expect(drain.activeLong).toBe(1)

    const started = Date.now()
    const drained = drain.drain(50, { openTimeoutMs: 5_000 })
    // The short window expired, the open did NOT — so the drain keeps waiting
    // and finishes as soon as the hydrate does.
    await Bun.sleep(150)
    expect(drain.active).toBe(1)
    gate.resolve()
    expect(await drained).toBe(true)
    expect((await inFlight).status).toBe(200)
    // It waited past the short timeout rather than cutting the open off.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
  })

  test('a client that retries the 503 lands on the restarted agent', async () => {
    const old = new RequestDrain()
    const oldUrl = agent(old, async () => Response.json({ from: 'old' }))
    await old.drain(1_000)

    // The control plane's retry loop, against the same address after a restart.
    let target = oldUrl
    const restart = setTimeout(() => {
      servers[0]!.stop(true)
      target = agent(new RequestDrain(), async () => Response.json({ from: 'new' }))
    }, 20)
    let res: Response
    for (let i = 0; ; i++) {
      res = await fetch(`${target}/assign`, { method: 'POST' }).catch(() => new Response(null, { status: 599 }))
      if (res.status === 200) break
      expect(res.status === 599 || res.headers.get(RESTARTING_HEADER) === '1').toBe(true)
      if (i > 200) throw new Error('never recovered')
      await Bun.sleep(5)
    }
    clearTimeout(restart)
    expect(await res.json()).toEqual({ from: 'new' })
  })
})
