// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// ---- k8s mocks ----
let tokenReviewResult: any = null
let tokenReviewThrows: any = null
let customObjectResult: any = null
let customObjectThrows: any = null

const tokenReviewCalls: any[] = []
const customObjectCalls: any[] = []

class FakeAuthenticationV1Api {
  async createTokenReview(args: any) {
    tokenReviewCalls.push(args)
    if (tokenReviewThrows) throw tokenReviewThrows
    return { status: tokenReviewResult }
  }
}

class FakeCustomObjectsApi {
  async getNamespacedCustomObject(args: any) {
    customObjectCalls.push(args)
    if (customObjectThrows) throw customObjectThrows
    return customObjectResult
  }
}

const loadFromOptionsCalls: any[] = []
const loadFromDefaultCalls: number[] = []

class FakeKubeConfig {
  loadFromDefault() { loadFromDefaultCalls.push(1) }
  loadFromOptions(opts: any) { loadFromOptionsCalls.push(opts) }
  makeApiClient(cls: any) {
    if (cls === FakeAuthenticationV1Api) return new FakeAuthenticationV1Api()
    if (cls === FakeCustomObjectsApi) return new FakeCustomObjectsApi()
    throw new Error('unknown api class')
  }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  AuthenticationV1Api: FakeAuthenticationV1Api,
  CustomObjectsApi: FakeCustomObjectsApi,
}))

// ---- fs mock (k8s-auth uses require('fs')) ----
let fsExists: Record<string, boolean> = {}
let fsRead: Record<string, string> = {}
mock.module('fs', () => ({
  existsSync: (p: string) => fsExists[p] === true,
  readFileSync: (p: string, _enc?: string) => fsRead[p] ?? '',
}))

const { validatePodToken, verifyServiceAssignment } = await import('../k8s-auth')

const origConsole = { log: console.log, error: console.error }
const logs: any[][] = []

beforeEach(() => {
  tokenReviewResult = null
  tokenReviewThrows = null
  customObjectResult = null
  customObjectThrows = null
  tokenReviewCalls.length = 0
  customObjectCalls.length = 0
  loadFromOptionsCalls.length = 0
  loadFromDefaultCalls.length = 0
  fsExists = {}
  fsRead = {}
  logs.length = 0
  console.log = (...a: any[]) => logs.push(a)
  console.error = (...a: any[]) => logs.push(a)
})

afterEach(() => {
  console.log = origConsole.log
  console.error = origConsole.error
})

// Note: getAuthApi() caches the api singleton across tests. Because the
// underlying FakeKubeConfig is constructed lazily on first call, we can
// only test the in-cluster vs default branch ONCE per process. We hit
// the default branch first via validatePodToken; verifyServiceAssignment
// reuses the second cache (customApi) which also goes through getKubeConfig
// — but by then authApi is already cached. To exercise the in-cluster
// branch we'd need a separate file; the default branch suffices for
// coverage of the success/early-return arms.

describe('validatePodToken', () => {
  it('returns null when token review is not authenticated', async () => {
    tokenReviewResult = { authenticated: false }
    const r = await validatePodToken('bad-token')
    expect(r).toBeNull()
    expect(logs.some((l) => String(l[0]).includes('Not authenticated') || String(l[0]).includes('not authenticated'))).toBe(true)
  })

  it('returns null when username is empty', async () => {
    tokenReviewResult = { authenticated: true, user: { username: '' } }
    expect(await validatePodToken('t')).toBeNull()
  })

  it('returns null when username is not a service-account format', async () => {
    tokenReviewResult = { authenticated: true, user: { username: 'kubernetes-admin' } }
    expect(await validatePodToken('t')).toBeNull()
    expect(logs.some((l) => String(l[0]).includes('Not a service account'))).toBe(true)
  })

  it('returns null when the SA token is from a wrong namespace', async () => {
    tokenReviewResult = {
      authenticated: true,
      user: { username: 'system:serviceaccount:other-ns:pod-1', uid: 'u-1' },
    }
    expect(await validatePodToken('t')).toBeNull()
    expect(logs.some((l) => String(l[0]).includes('wrong namespace'))).toBe(true)
  })

  it('returns the pod identity on a valid token', async () => {
    tokenReviewResult = {
      authenticated: true,
      user: { username: 'system:serviceaccount:shogo-workspaces:my-sa', uid: 'uid-xyz' },
    }
    const r = await validatePodToken('good-token')
    expect(r).toEqual({
      namespace: 'shogo-workspaces',
      serviceAccountName: 'my-sa',
      podName: 'my-sa',
      uid: 'uid-xyz',
    })
    const sent = tokenReviewCalls[0]
    expect(sent.body.kind).toBe('TokenReview')
    expect(sent.body.spec.token).toBe('good-token')
  })

  it('defaults uid to empty string when missing', async () => {
    tokenReviewResult = {
      authenticated: true,
      user: { username: 'system:serviceaccount:shogo-workspaces:sa' },
    }
    const r = await validatePodToken('t')
    expect(r?.uid).toBe('')
  })

  it('returns null and logs error when TokenReview throws', async () => {
    tokenReviewThrows = new Error('api down')
    expect(await validatePodToken('t')).toBeNull()
    expect(logs.some((l) => String(l[0]).includes('TokenReview failed'))).toBe(true)
  })
})

describe('verifyServiceAssignment', () => {
  it('returns true when annotation matches expected project', async () => {
    customObjectResult = {
      metadata: { annotations: { 'shogo.io/assigned-project': 'proj-A' } },
    }
    expect(await verifyServiceAssignment('svc-1', 'proj-A')).toBe(true)
  })

  it('returns false when annotation does not match', async () => {
    customObjectResult = {
      metadata: { annotations: { 'shogo.io/assigned-project': 'proj-B' } },
    }
    expect(await verifyServiceAssignment('svc-1', 'proj-A')).toBe(false)
    expect(logs.some((l) => String(l[0]).includes('annotation mismatch'))).toBe(true)
  })

  it('returns false when annotation is missing entirely', async () => {
    customObjectResult = { metadata: { annotations: {} } }
    expect(await verifyServiceAssignment('svc-1', 'proj-A')).toBe(false)
  })

  it('returns false when metadata is missing', async () => {
    customObjectResult = {}
    expect(await verifyServiceAssignment('svc-1', 'proj-A')).toBe(false)
  })

  it('returns false on API error', async () => {
    customObjectThrows = new Error('not found')
    expect(await verifyServiceAssignment('svc-1', 'proj-A')).toBe(false)
    expect(logs.some((l) => String(l[0]).includes('Failed to verify service assignment'))).toBe(true)
  })

  it('passes the right group/version/namespace/plural to the API', async () => {
    customObjectResult = {
      metadata: { annotations: { 'shogo.io/assigned-project': 'proj-A' } },
    }
    await verifyServiceAssignment('svc-x', 'proj-A')
    const c = customObjectCalls[customObjectCalls.length - 1]
    expect(c.group).toBe('serving.knative.dev')
    expect(c.version).toBe('v1')
    expect(c.plural).toBe('services')
    expect(c.name).toBe('svc-x')
  })
})

// Singleton cache behavior is verified implicitly: across all tests in this
// file the K8s API is constructed at most once. Counters are reset per
// test so a direct assertion isn't possible without exposing a reset hook.
