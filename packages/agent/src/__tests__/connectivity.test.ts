// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the connectivity probe + park-and-wait used by the agent loop's
 * offline-outage tier (see `../connectivity.ts`'s module doc).
 *
 * Run: bun test packages/agent/src/__tests__/connectivity.test.ts
 */
import { describe, test, expect, mock } from 'bun:test'
import {
  probeConnectivity,
  waitForConnectivity,
  resolveMaxWaitMs,
  type ConnectivityWaitInfo,
} from '../connectivity'

describe('probeConnectivity', () => {
  test('reachable when fetch resolves, even with an error status', async () => {
    const fetchImpl = mock(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const reachable = await probeConnectivity('https://example.test/health', { fetchImpl })
    expect(reachable).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('unreachable when fetch rejects (DNS/connection failure)', async () => {
    const fetchImpl = mock(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const reachable = await probeConnectivity('https://example.test/health', { fetchImpl })
    expect(reachable).toBe(false)
  })

  test('unreachable when fetch throws a timeout-style abort', async () => {
    const fetchImpl = mock(async () => {
      throw new DOMException('The operation was aborted', 'TimeoutError')
    }) as unknown as typeof fetch
    const reachable = await probeConnectivity('https://example.test/health', { fetchImpl, timeoutMs: 10 })
    expect(reachable).toBe(false)
  })

  test('passes an AbortSignal derived from timeoutMs', async () => {
    let receivedSignal: AbortSignal | undefined
    const fetchImpl = mock(async (_url: any, init: any) => {
      receivedSignal = init?.signal
      return new Response('ok')
    }) as unknown as typeof fetch
    await probeConnectivity('https://example.test/health', { fetchImpl, timeoutMs: 5000 })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('resolveMaxWaitMs', () => {
  const originalEnv = process.env.SHOGO_OFFLINE_MAX_WAIT_MS

  test('defaults to 30 minutes when nothing is configured', () => {
    delete process.env.SHOGO_OFFLINE_MAX_WAIT_MS
    expect(resolveMaxWaitMs()).toBe(30 * 60 * 1000)
    restoreEnv()
  })

  test('explicit value wins over env and default', () => {
    process.env.SHOGO_OFFLINE_MAX_WAIT_MS = '999'
    expect(resolveMaxWaitMs(5000)).toBe(5000)
    restoreEnv()
  })

  test('explicit 0 means unlimited, distinct from "unset"', () => {
    delete process.env.SHOGO_OFFLINE_MAX_WAIT_MS
    expect(resolveMaxWaitMs(0)).toBe(0)
    restoreEnv()
  })

  test('reads SHOGO_OFFLINE_MAX_WAIT_MS when no explicit value is given', () => {
    process.env.SHOGO_OFFLINE_MAX_WAIT_MS = '12345'
    expect(resolveMaxWaitMs()).toBe(12345)
    restoreEnv()
  })

  test('ignores a non-numeric env override and falls back to default', () => {
    process.env.SHOGO_OFFLINE_MAX_WAIT_MS = 'not-a-number'
    expect(resolveMaxWaitMs()).toBe(30 * 60 * 1000)
    restoreEnv()
  })

  function restoreEnv() {
    if (originalEnv === undefined) delete process.env.SHOGO_OFFLINE_MAX_WAIT_MS
    else process.env.SHOGO_OFFLINE_MAX_WAIT_MS = originalEnv
  }
})

/** Builds an injectable fake clock + sleep pair that advances in lockstep with `sleep()` calls, so tests run instantly with no real timers. */
function makeFakeClock() {
  let now = 0
  const sleepCalls: number[] = []
  const sleep = async (ms: number) => {
    sleepCalls.push(ms)
    now += ms
  }
  return { now: () => now, sleep, sleepCalls, advance: (ms: number) => { now += ms } }
}

describe('waitForConnectivity', () => {
  test('resolves "no_probe_url" immediately when no probeUrl is configured', async () => {
    const result = await waitForConnectivity({})
    expect(result).toBe('no_probe_url')
  })

  test('resolves "aborted" immediately if the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await waitForConnectivity({ probeUrl: 'https://x.test', signal: controller.signal })
    expect(result).toBe('aborted')
  })

  test('resolves "reconnected" the moment a probe succeeds, with no backoff sleep on the first successful attempt', async () => {
    const clock = makeFakeClock()
    const probe = mock(async () => true)
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep: clock.sleep,
      now: clock.now,
    })
    expect(result).toBe('reconnected')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(clock.sleepCalls).toEqual([])
  })

  test('backs off 1s -> 5s -> 15s -> 15s (capped) across repeated failures before reconnecting', async () => {
    const clock = makeFakeClock()
    let attempts = 0
    const probe = mock(async () => {
      attempts++
      return attempts > 4 // fail 4 times, succeed on the 5th
    })
    const waitingTicks: ConnectivityWaitInfo[] = []
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep: clock.sleep,
      now: clock.now,
      onWaiting: (info) => waitingTicks.push(info),
    })
    expect(result).toBe('reconnected')
    expect(probe).toHaveBeenCalledTimes(5)
    // 4 failures -> 4 backoff sleeps: 1s, 5s, 15s, 15s (capped after step 3).
    expect(clock.sleepCalls).toEqual([1_000, 5_000, 15_000, 15_000])
    expect(waitingTicks.map((t) => t.nextProbeInMs)).toEqual([1_000, 5_000, 15_000, 15_000])
    expect(waitingTicks.map((t) => t.attempt)).toEqual([1, 2, 3, 4])
  })

  test('resolves "aborted" if the signal fires while parked in a backoff sleep', async () => {
    const controller = new AbortController()
    const probe = mock(async () => false)
    // A sleep stand-in that aborts partway through the "wait" instead of
    // resolving normally — simulates a Stop click landing mid-backoff.
    const sleep = async (_ms: number) => {
      controller.abort()
      return new Promise<void>(() => {}) // never resolves on its own
    }
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep,
      signal: controller.signal,
      now: () => 0,
    })
    expect(result).toBe('aborted')
  })

  test('resolves "timed_out" once maxWaitMs elapses without reconnecting', async () => {
    const clock = makeFakeClock()
    const probe = mock(async () => false)
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep: clock.sleep,
      now: clock.now,
      maxWaitMs: 3_000, // smaller than even the first 1s + second 5s backoff step
    })
    expect(result).toBe('timed_out')
    // First probe at t=0 (fail), sleep 1s -> t=1000, second probe (fail),
    // remaining budget is 2000ms < the 5s step so it's clamped and consumed
    // rather than overshooting past maxWaitMs.
    expect(clock.sleepCalls.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000)
  })

  test('maxWaitMs: 0 means unlimited — keeps retrying past what a finite budget would allow', async () => {
    const clock = makeFakeClock()
    let attempts = 0
    const probe = mock(async () => {
      attempts++
      return attempts > 10
    })
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep: clock.sleep,
      now: clock.now,
      maxWaitMs: 0,
    })
    expect(result).toBe('reconnected')
    expect(attempts).toBe(11)
  })

  test('checks the abort signal between a failed probe and its backoff sleep', async () => {
    const controller = new AbortController()
    let probeCount = 0
    const probe = mock(async () => {
      probeCount++
      if (probeCount === 1) controller.abort()
      return false
    })
    const sleep = mock(async () => {})
    const result = await waitForConnectivity({
      probeUrl: 'https://x.test',
      probe,
      sleep,
      signal: controller.signal,
      now: () => 0,
    })
    expect(result).toBe('aborted')
    expect(probeCount).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})
