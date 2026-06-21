// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tunnel-Redis Self-Heal Test
 *
 * Regression guard for the production incident where a pod that booted while
 * Redis was briefly unreachable stayed `publisher=null` / degraded FOREVER:
 * `_doInit` caught the connect error, nulled the clients, and never retried.
 *
 * This proves the cold-start failure path now self-heals via the background
 * reconnect scheduler: first connect throws → pod is degraded → once Redis
 * becomes reachable the scheduled reconnect re-establishes pub/sub and the
 * degraded flag clears with no manual restart.
 *
 * Run: bun test apps/api/src/lib/__tests__/tunnel-redis-selfheal.test.ts
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'

delete (process.env as any).SHOGO_LOCAL_MODE
process.env.HOSTNAME = 'pod-selfheal'
process.env.REDIS_URL = 'redis://flaky:6379'
// Shrink the background reconnect delay so the test runs fast.
process.env.TUNNEL_REDIS_REINIT_MS = '20'

// Number of connect() calls that should fail before the link "comes back".
// The initial init issues two connect() calls (pub + sub); failing both
// forces Promise.all to reject and exercise the catch/self-heal path.
let connectFailuresRemaining = 2

class FlakyRedis {
  status: 'wait' | 'ready' | 'end' = 'wait'
  listeners: Record<string, Array<(...a: any[]) => void>> = {}
  static instances: FlakyRedis[] = []

  constructor(public url: string, public opts: any) {
    FlakyRedis.instances.push(this)
  }
  on(event: string, cb: (...a: any[]) => void) {
    ;(this.listeners[event] ??= []).push(cb)
    return this
  }
  private fire(event: string, ...a: any[]) {
    for (const cb of this.listeners[event] ?? []) cb(...a)
  }
  async connect() {
    if (connectFailuresRemaining > 0) {
      connectFailuresRemaining--
      throw new Error('connect refused')
    }
    this.status = 'ready'
    this.fire('ready')
  }
  async subscribe() {}
  async unsubscribe() {}
  async ping() { return 'PONG' }
  async publish() { return 0 }
  disconnect() { this.status = 'end' }
}

mock.module('ioredis', () => ({ default: FlakyRedis }))

const tr = await import('../tunnel-redis')

afterAll(async () => {
  await tr.shutdownTunnelRedis()
})

describe('tunnel-redis self-heal after cold-start connect failure', () => {
  it('starts degraded when the first connect fails', async () => {
    const origErr = console.error
    ;(console as any).error = () => {}
    try {
      await tr.initTunnelRedis()
    } finally {
      ;(console as any).error = origErr
    }
    // Init completed (whenReady resolves so callers fall back gracefully)
    // but the pod is degraded because pub/sub never connected.
    expect(tr.isTunnelRedisDegraded()).toBe(true)
    expect(tr.getSharedRedis()).toBeNull()
  })

  it('recovers automatically once Redis becomes reachable — no restart needed', async () => {
    const origWarn = console.warn
    ;(console as any).warn = () => {}
    try {
      // Background reconnect is scheduled for ~20ms out; give it room to run.
      await new Promise((r) => setTimeout(r, 120))
    } finally {
      ;(console as any).warn = origWarn
    }
    expect(tr.isTunnelRedisDegraded()).toBe(false)
    expect(tr.getSharedRedis()).not.toBeNull()

    const health = await tr.checkRedisHealth()
    expect(health.healthy).toBe(true)
  })
})
