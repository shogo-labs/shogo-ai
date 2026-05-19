// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, it, mock } from 'bun:test'

// Non-local mode but force connect() to throw so the catch path in
// _doInit runs (line ~169-186 in tunnel-redis.ts).
delete (process.env as any).SHOGO_LOCAL_MODE
process.env.HOSTNAME = 'pod-initfail'
process.env.REDIS_URL = 'redis://broken:6379'

class BrokenRedis {
  constructor(_url: string, _opts: any) {}
  on() { return this }
  async connect() { throw new Error('refused connection') }
  async subscribe() {}
  async unsubscribe() {}
  disconnect() {}
  status = 'wait'
}

mock.module('ioredis', () => ({ default: BrokenRedis }))

const tr = await import('../tunnel-redis')

describe('tunnel-redis init failure path', () => {
  it('marks the pod degraded and clears publisher when connect throws', async () => {
    const origErr = console.error
    const errs: any[] = []
    ;(console as any).error = (...a: any[]) => errs.push(a)
    try {
      await tr.initTunnelRedis()
      expect(tr.isTunnelRedisDegraded()).toBe(true)
      expect(tr.getSharedRedis()).toBeNull()
      expect(errs.some((e) => String(e[0]).includes('CRITICAL'))).toBe(true)
    } finally {
      ;(console as any).error = origErr
    }
  })

  it('checkRedisHealth returns error when publisher is null', async () => {
    const r = await tr.checkRedisHealth()
    expect(r.healthy).toBe(false)
    expect(r.error).toMatch(/publisher not initialized/)
  })

  it('shutdownTunnelRedis is safe to call after a failed init', async () => {
    await tr.shutdownTunnelRedis()
  })
})
