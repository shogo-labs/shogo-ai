// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock both scheduler modules BEFORE importing admin-heartbeat.
const cloudScheduler = { __kind: 'cloud-scheduler' }
const localScheduler = { __kind: 'local-scheduler' }

const getHeartbeatScheduler = mock(() => cloudScheduler)
const getLocalHeartbeatScheduler = mock(() => localScheduler)

mock.module('../lib/heartbeat-scheduler', () => ({
  getHeartbeatScheduler,
}))
mock.module('../lib/local-heartbeat-scheduler', () => ({
  getLocalHeartbeatScheduler,
}))

// Dynamic import AFTER mock.module — admin-heartbeat itself uses dynamic
// `await import(...)` for the schedulers, so this works either way, but
// keeps the pattern consistent with the other prisma-style tests.
const { getActiveHeartbeatScheduler, getSchedulerKind } = await import(
  '../lib/admin-heartbeat'
)

const ORIGINAL_K8S = process.env.KUBERNETES_SERVICE_HOST

beforeEach(() => {
  delete process.env.KUBERNETES_SERVICE_HOST
  getHeartbeatScheduler.mockClear()
  getLocalHeartbeatScheduler.mockClear()
})

afterEach(() => {
  if (ORIGINAL_K8S === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = ORIGINAL_K8S
})

describe('getSchedulerKind', () => {
  test('returns "local" when KUBERNETES_SERVICE_HOST is unset', () => {
    expect(getSchedulerKind()).toBe('local')
  })

  test('returns "cloud" when KUBERNETES_SERVICE_HOST is set to a host', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(getSchedulerKind()).toBe('cloud')
  })

  test('returns "local" when KUBERNETES_SERVICE_HOST is empty string (falsy)', () => {
    process.env.KUBERNETES_SERVICE_HOST = ''
    expect(getSchedulerKind()).toBe('local')
  })

  test('returns "cloud" for any non-empty value (the convention K8s itself uses)', () => {
    for (const v of ['kubernetes.default.svc', '127.0.0.1', '0', 'false']) {
      process.env.KUBERNETES_SERVICE_HOST = v
      expect(getSchedulerKind()).toBe('cloud')
    }
  })

  test('reads the env var on each call (does not cache)', () => {
    expect(getSchedulerKind()).toBe('local')
    process.env.KUBERNETES_SERVICE_HOST = 'cluster.local'
    expect(getSchedulerKind()).toBe('cloud')
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(getSchedulerKind()).toBe('local')
  })
})

describe('getActiveHeartbeatScheduler', () => {
  test('returns the local scheduler when not running in Kubernetes', async () => {
    const result = await getActiveHeartbeatScheduler()
    expect(result).toBe(localScheduler as unknown as Awaited<ReturnType<typeof getActiveHeartbeatScheduler>>)
    expect(getLocalHeartbeatScheduler).toHaveBeenCalledTimes(1)
    expect(getHeartbeatScheduler).not.toHaveBeenCalled()
  })

  test('returns the cloud (K8s) scheduler when running in Kubernetes', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    const result = await getActiveHeartbeatScheduler()
    expect(result).toBe(cloudScheduler as unknown as Awaited<ReturnType<typeof getActiveHeartbeatScheduler>>)
    expect(getHeartbeatScheduler).toHaveBeenCalledTimes(1)
    expect(getLocalHeartbeatScheduler).not.toHaveBeenCalled()
  })

  test('re-evaluates the env var on every call (no module-level caching)', async () => {
    await getActiveHeartbeatScheduler()
    expect(getLocalHeartbeatScheduler).toHaveBeenCalledTimes(1)

    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    await getActiveHeartbeatScheduler()
    expect(getHeartbeatScheduler).toHaveBeenCalledTimes(1)

    delete process.env.KUBERNETES_SERVICE_HOST
    await getActiveHeartbeatScheduler()
    expect(getLocalHeartbeatScheduler).toHaveBeenCalledTimes(2)
  })

  test('treats empty KUBERNETES_SERVICE_HOST as local (parity with getSchedulerKind)', async () => {
    process.env.KUBERNETES_SERVICE_HOST = ''
    const result = await getActiveHeartbeatScheduler()
    expect(result).toBe(localScheduler as unknown as Awaited<ReturnType<typeof getActiveHeartbeatScheduler>>)
  })

  test('returns a Promise (always async, even though dispatch is sync-ish)', () => {
    const ret = getActiveHeartbeatScheduler()
    expect(ret).toBeInstanceOf(Promise)
    return ret // make Bun await it so the mock cleanup is clean
  })

  test('getSchedulerKind and getActiveHeartbeatScheduler agree on every env state', async () => {
    // Invariant: if kind says 'local' you get the local scheduler, etc.
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(getSchedulerKind()).toBe('local')
    expect(await getActiveHeartbeatScheduler()).toBe(
      localScheduler as unknown as Awaited<ReturnType<typeof getActiveHeartbeatScheduler>>
    )

    process.env.KUBERNETES_SERVICE_HOST = 'cluster.local'
    expect(getSchedulerKind()).toBe('cloud')
    expect(await getActiveHeartbeatScheduler()).toBe(
      cloudScheduler as unknown as Awaited<ReturnType<typeof getActiveHeartbeatScheduler>>
    )
  })
})
