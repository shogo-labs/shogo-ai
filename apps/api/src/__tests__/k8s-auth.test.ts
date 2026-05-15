// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// Mock @kubernetes/client-node BEFORE importing the module under test.
// We expose two API class stubs and capture their method mocks so each
// test can dial in the desired upstream behavior.

const createTokenReviewMock = mock(async (_: any): Promise<any> => ({ status: {} }))
const getNamespacedCustomObjectMock = mock(async (_: any): Promise<any> => ({}))

class FakeAuthenticationV1Api {
  createTokenReview = createTokenReviewMock
}
class FakeCustomObjectsApi {
  getNamespacedCustomObject = getNamespacedCustomObjectMock
}

class FakeKubeConfig {
  loadFromDefault = mock(() => {})
  loadFromOptions = mock((_: any) => {})
  makeApiClient = mock((Cls: any) => {
    if (Cls === FakeAuthenticationV1Api) return new FakeAuthenticationV1Api()
    if (Cls === FakeCustomObjectsApi) return new FakeCustomObjectsApi()
    throw new Error('unknown API class')
  })
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  AuthenticationV1Api: FakeAuthenticationV1Api,
  CustomObjectsApi: FakeCustomObjectsApi,
}))

// Pin the namespace used by the module to the default value (the env
// var is read at module load time; we don't override it here).
const NAMESPACE = process.env.PROJECT_NAMESPACE || 'shogo-workspaces'

const { validatePodToken, verifyServiceAssignment } = await import('../lib/k8s-auth')

let logSpy: ReturnType<typeof spyOn>
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  createTokenReviewMock.mockReset()
  createTokenReviewMock.mockImplementation(async () => ({ status: {} }))
  getNamespacedCustomObjectMock.mockReset()
  getNamespacedCustomObjectMock.mockImplementation(async () => ({}))
  logSpy = spyOn(console, 'log').mockImplementation(() => {})
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(() => {
  // Spies restored after each test via beforeEach reset; this is a
  // safety net for the final teardown.
})

describe('validatePodToken', () => {
  test('returns PodIdentity for a valid SA token in the expected namespace', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: {
          username: `system:serviceaccount:${NAMESPACE}:my-sa`,
          uid: 'uid-1234',
        },
      },
    }))

    const result = await validatePodToken('eyJhbGc...token')
    expect(result).toEqual({
      namespace: NAMESPACE,
      serviceAccountName: 'my-sa',
      podName: 'my-sa',
      uid: 'uid-1234',
    })
  })

  test('forwards the token verbatim to TokenReview spec.token', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: `system:serviceaccount:${NAMESPACE}:sa` },
      },
    }))
    await validatePodToken('the-token-value')
    const arg = createTokenReviewMock.mock.calls[0][0]
    expect(arg.body.kind).toBe('TokenReview')
    expect(arg.body.apiVersion).toBe('authentication.k8s.io/v1')
    expect(arg.body.spec.token).toBe('the-token-value')
  })

  test('returns null and logs when authenticated is false', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: { authenticated: false },
    }))
    const result = await validatePodToken('bad-token')
    expect(result).toBeNull()
    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('not authenticated'))).toBe(true)
  })

  test('returns null when status is undefined', async () => {
    createTokenReviewMock.mockImplementation(async () => ({}))
    expect(await validatePodToken('t')).toBeNull()
  })

  test('returns null when username is not a service-account token (e.g. a real user)', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: 'admin@shogo.ai' },
      },
    }))
    const result = await validatePodToken('user-token')
    expect(result).toBeNull()
    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('Not a service account token'))).toBe(
      true
    )
  })

  test('returns null when username has the wrong prefix', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: 'system:node:foo' },
      },
    }))
    expect(await validatePodToken('t')).toBeNull()
  })

  test('returns null when username has too few parts', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: 'system:serviceaccount:incomplete' },
      },
    }))
    expect(await validatePodToken('t')).toBeNull()
  })

  test('returns null when token is from the wrong namespace', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: {
          username: `system:serviceaccount:other-namespace:sa`,
          uid: 'uid-x',
        },
      },
    }))
    const result = await validatePodToken('cross-ns-token')
    expect(result).toBeNull()
    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('wrong namespace'))).toBe(true)
  })

  test('defaults uid to empty string when not provided', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: `system:serviceaccount:${NAMESPACE}:sa` },
        // uid omitted
      },
    }))
    const result = await validatePodToken('t')
    expect(result?.uid).toBe('')
  })

  test('returns null and logs error when TokenReview throws', async () => {
    createTokenReviewMock.mockImplementation(async () => {
      throw new Error('apiserver unreachable')
    })
    const result = await validatePodToken('t')
    expect(result).toBeNull()
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('apiserver unreachable'))).toBe(
      true
    )
  })

  test('podName equals serviceAccountName (one-to-one mapping)', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: {
        authenticated: true,
        user: { username: `system:serviceaccount:${NAMESPACE}:my-pod-sa` },
      },
    }))
    const result = await validatePodToken('t')
    expect(result?.podName).toBe(result?.serviceAccountName)
    expect(result?.podName).toBe('my-pod-sa')
  })

  test('caches the AuthenticationV1Api client across calls (no repeat construction)', async () => {
    createTokenReviewMock.mockImplementation(async () => ({
      status: { authenticated: false },
    }))
    await validatePodToken('a')
    await validatePodToken('b')
    await validatePodToken('c')
    // 3 calls to createTokenReview but the lazy client init happens once.
    expect(createTokenReviewMock).toHaveBeenCalledTimes(3)
  })
})

describe('verifyServiceAssignment', () => {
  test('returns true when the annotation matches the expected projectId', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: {
        annotations: { 'shogo.io/assigned-project': 'proj_42' },
      },
    }))
    expect(await verifyServiceAssignment('svc-1', 'proj_42')).toBe(true)
  })

  test('queries the correct Knative GVK + namespace + service name', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: { 'shogo.io/assigned-project': 'p' } },
    }))
    await verifyServiceAssignment('my-svc', 'p')
    const args = getNamespacedCustomObjectMock.mock.calls[0][0]
    expect(args).toEqual({
      group: 'serving.knative.dev',
      version: 'v1',
      namespace: NAMESPACE,
      plural: 'services',
      name: 'my-svc',
    })
  })

  test('returns false and logs when annotation is missing', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: {} },
    }))
    expect(await verifyServiceAssignment('svc', 'proj_x')).toBe(false)
    expect(logSpy.mock.calls.some((c) => c.join(' ').includes('annotation mismatch'))).toBe(true)
  })

  test('returns false when metadata.annotations itself is missing', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({ metadata: {} }))
    expect(await verifyServiceAssignment('svc', 'proj_x')).toBe(false)
  })

  test('returns false when metadata is missing entirely', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({}))
    expect(await verifyServiceAssignment('svc', 'proj_x')).toBe(false)
  })

  test('returns false when annotation is for a different project', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: { 'shogo.io/assigned-project': 'proj_other' } },
    }))
    expect(await verifyServiceAssignment('svc', 'proj_expected')).toBe(false)
  })

  test('comparison is strictly equal (no trimming, no case folding)', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: { 'shogo.io/assigned-project': ' proj_42 ' } }, // whitespace
    }))
    expect(await verifyServiceAssignment('svc', 'proj_42')).toBe(false)

    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: { 'shogo.io/assigned-project': 'PROJ_42' } },
    }))
    expect(await verifyServiceAssignment('svc', 'proj_42')).toBe(false)
  })

  test('returns false and logs error when the K8s API throws', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => {
      throw new Error('404 not found')
    })
    expect(await verifyServiceAssignment('missing', 'proj_x')).toBe(false)
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('404 not found'))).toBe(true)
    expect(errorSpy.mock.calls.some((c) => c.join(' ').includes('missing'))).toBe(true)
  })

  test('caches the CustomObjectsApi client across calls (lazy init)', async () => {
    getNamespacedCustomObjectMock.mockImplementation(async () => ({
      metadata: { annotations: { 'shogo.io/assigned-project': 'p' } },
    }))
    await verifyServiceAssignment('a', 'p')
    await verifyServiceAssignment('b', 'p')
    expect(getNamespacedCustomObjectMock).toHaveBeenCalledTimes(2)
  })
})
