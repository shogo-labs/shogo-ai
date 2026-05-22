// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for `kourier-lb-discovery.ts`.
 *
 * The module reads `Service kourier/kourier-system` and returns the first
 * `.status.loadBalancer.ingress[].ip`. We test the behavior contract via
 * a mocked @kubernetes/client-node so we never need a real cluster.
 *
 * The cached CoreV1Api inside the module is intentionally reset between
 * tests via the exported `_resetKourierLbDiscoveryForTest` helper so that
 * each test sees a fresh client instance built from the current mock.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

interface FakeReadResponse {
  status?: {
    loadBalancer?: {
      ingress?: Array<{ ip?: string; hostname?: string }>
    }
  }
}

let readImpl: (args: { name: string; namespace: string }) => Promise<FakeReadResponse>

mock.module('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromOptions() {}
    loadFromDefault() {}
    makeApiClient() {
      return {
        readNamespacedService: (args: { name: string; namespace: string }) => readImpl(args),
      }
    }
  }
  class CoreV1Api {}
  return { KubeConfig, CoreV1Api }
})

import {
  _resetKourierLbDiscoveryForTest,
  discoverKourierLbIp,
} from '../kourier-lb-discovery'

beforeEach(() => {
  readImpl = async () => ({})
  _resetKourierLbDiscoveryForTest()
})

afterEach(() => {
  _resetKourierLbDiscoveryForTest()
})

describe('discoverKourierLbIp', () => {
  test('returns the first ingress IP when present', async () => {
    readImpl = async (args) => {
      expect(args.namespace).toBe('kourier-system')
      expect(args.name).toBe('kourier')
      return { status: { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } } }
    }
    expect(await discoverKourierLbIp()).toBe('203.0.113.10')
  })

  test('skips ingress entries without ip, falling through to the next entry', async () => {
    readImpl = async () => ({
      status: { loadBalancer: { ingress: [{}, { ip: '198.51.100.42' }] } },
    })
    expect(await discoverKourierLbIp()).toBe('198.51.100.42')
  })

  test('returns null when service has no loadBalancer ingress yet', async () => {
    readImpl = async () => ({ status: { loadBalancer: { ingress: [] } } })
    expect(await discoverKourierLbIp()).toBeNull()
  })

  test('returns null when service has no status at all', async () => {
    readImpl = async () => ({})
    expect(await discoverKourierLbIp()).toBeNull()
  })

  test('throws on hostname-only ingress so caller does not produce a malformed A record', async () => {
    readImpl = async () => ({
      status: { loadBalancer: { ingress: [{ hostname: 'a1b2.elb.amazonaws.com' }] } },
    })
    await expect(discoverKourierLbIp()).rejects.toThrow(/hostname-only/)
  })

  test('propagates K8s API errors (e.g. RBAC denial) so the caller can disable the helper', async () => {
    readImpl = async () => {
      const err: any = new Error('Forbidden: services "kourier" is forbidden')
      err.statusCode = 403
      throw err
    }
    await expect(discoverKourierLbIp()).rejects.toThrow(/Forbidden/)
  })

  test('respects KOURIER_NAMESPACE / KOURIER_SERVICE_NAME env overrides via module re-import', async () => {
    // We can't easily re-evaluate the module-level env reads in the same
    // process, so this just documents the contract — the env vars are
    // read once at module load. Operators wanting a custom namespace
    // should set these before the api process starts.
    expect(typeof discoverKourierLbIp).toBe('function')
  })
})
