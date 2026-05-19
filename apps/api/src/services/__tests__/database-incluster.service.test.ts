// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

// Isolated test for the in-cluster KubeConfig path. The k8sCoreApi singleton
// in database.service.ts is initialized on first use and never reset; mocking
// existsSync after the singleton is set doesn't change anything. This file
// gets its own bun process via scripts/run-tests-isolated.ts so the singleton
// starts fresh, with the in-cluster filesystem probe returning true.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

process.env.PROJECTS_DB_ADMIN_URL = 'postgres://admin:pw@admin-host:5432/projects'
process.env.PROJECTS_DB_HOST = 'projects-pg-test.svc'
process.env.PROJECTS_DB_PORT = '6432'
process.env.PROJECT_NAMESPACE = 'shogo-test-ns'
process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
process.env.KUBERNETES_SERVICE_PORT = '443'

const k8sCalls = {
  configLoadOptions: [] as any[],
  configLoadDefault: 0,
  create: [] as any[],
}

class FakePool {
  ended = false
  constructor(public opts: any) {}
  on() { return this }
  async connect() {
    return {
      async query(_sql: string, _params?: unknown[]) { return { rows: [] } },
      release() {},
    }
  }
  async end() { this.ended = true }
}

mock.module('pg', () => ({ Pool: FakePool }))

class FakeKubeConfig {
  loadFromOptions(opts: any) { k8sCalls.configLoadOptions.push(opts) }
  loadFromDefault() { k8sCalls.configLoadDefault++ }
  makeApiClient(_cls: any) {
    return {
      async readNamespacedSecret() {
        throw Object.assign(new Error('not found'), { code: 404 })
      },
      async createNamespacedSecret(args: any) {
        k8sCalls.create.push(args)
      },
      async replaceNamespacedSecret() {},
      async deleteNamespacedSecret() {},
    }
  }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  CoreV1Api: class {},
}))

mock.module('fs', () => ({
  existsSync: (p: string) => p.includes('serviceaccount/ca.crt') || p.includes('serviceaccount/token'),
  readFileSync: (p: string) =>
    p.includes('ca.crt') ? 'fake-ca' : p.includes('token') ? 'fake-token' : '',
}))

const svc = await import('../database.service')

beforeEach(() => {
  k8sCalls.configLoadOptions.length = 0
  k8sCalls.configLoadDefault = 0
  k8sCalls.create.length = 0
})

afterEach(async () => {
  await svc.shutdown()
})

describe('KubeConfig in-cluster path', () => {
  it('calls loadFromOptions with base64-encoded CA and the token from the service-account dir', async () => {
    const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    await svc.provisionDatabase(UUID)
    expect(k8sCalls.configLoadDefault).toBe(0)
    expect(k8sCalls.configLoadOptions).toHaveLength(1)
    const opts = k8sCalls.configLoadOptions[0]
    expect(opts.clusters[0].server).toBe('https://10.0.0.1:443')
    expect(opts.clusters[0].caData).toBe(Buffer.from('fake-ca').toString('base64'))
    expect(opts.users[0].token).toBe('fake-token')
    expect(opts.currentContext).toBe('in-cluster')
    // Provisioning still proceeded end-to-end
    expect(k8sCalls.create).toHaveLength(1)
  })
})
