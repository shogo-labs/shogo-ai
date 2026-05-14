// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const cloudInstance = { kind: 'cloud-scheduler-instance' }
const localInstance = { kind: 'local-scheduler-instance' }

let cloudCalls = 0
let localCalls = 0

mock.module('../heartbeat-scheduler', () => ({
  getHeartbeatScheduler: () => {
    cloudCalls += 1
    return cloudInstance
  },
}))

mock.module('../local-heartbeat-scheduler', () => ({
  getLocalHeartbeatScheduler: () => {
    localCalls += 1
    return localInstance
  },
}))

const { getActiveHeartbeatScheduler, getSchedulerKind } = await import('../admin-heartbeat')

const originalK8sHost = process.env.KUBERNETES_SERVICE_HOST

beforeEach(() => {
  cloudCalls = 0
  localCalls = 0
})

afterEach(() => {
  if (originalK8sHost === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = originalK8sHost
})

describe('getSchedulerKind', () => {
  it("returns 'cloud' when KUBERNETES_SERVICE_HOST is set", () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(getSchedulerKind()).toBe('cloud')
  })

  it("returns 'local' when KUBERNETES_SERVICE_HOST is unset", () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(getSchedulerKind()).toBe('local')
  })

  it("returns 'local' when KUBERNETES_SERVICE_HOST is the empty string", () => {
    process.env.KUBERNETES_SERVICE_HOST = ''
    expect(getSchedulerKind()).toBe('local')
  })

  it('re-reads the env var on each call (no module-level caching)', () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(getSchedulerKind()).toBe('local')
    process.env.KUBERNETES_SERVICE_HOST = 'host'
    expect(getSchedulerKind()).toBe('cloud')
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(getSchedulerKind()).toBe('local')
  })
})

describe('getActiveHeartbeatScheduler', () => {
  it('returns the cloud scheduler when KUBERNETES_SERVICE_HOST is set', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    const result = await getActiveHeartbeatScheduler()
    expect(result).toBe(cloudInstance as any)
    expect(cloudCalls).toBe(1)
    expect(localCalls).toBe(0)
  })

  it('returns the local scheduler when KUBERNETES_SERVICE_HOST is unset', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    const result = await getActiveHeartbeatScheduler()
    expect(result).toBe(localInstance as any)
    expect(localCalls).toBe(1)
    expect(cloudCalls).toBe(0)
  })

  it('does not import the cloud module when running locally', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST
    await getActiveHeartbeatScheduler()
    expect(cloudCalls).toBe(0)
  })

  it('does not import the local module when running in K8s', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    await getActiveHeartbeatScheduler()
    expect(localCalls).toBe(0)
  })

  it('switches back to local when KUBERNETES_SERVICE_HOST is removed mid-process', async () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    expect(await getActiveHeartbeatScheduler()).toBe(cloudInstance as any)
    delete process.env.KUBERNETES_SERVICE_HOST
    expect(await getActiveHeartbeatScheduler()).toBe(localInstance as any)
  })
})
