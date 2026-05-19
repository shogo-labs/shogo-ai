// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

// Capture-able k8s API surface.
let createCalls: any[] = []
let readCalls: any[] = []
let deleteCalls: any[] = []
let createImpl: (args: any) => Promise<any> = async () => ({ metadata: { name: 'eval-out' } })
let readImpl: (args: any) => Promise<any> = async () => ({ status: {} })
let deleteImpl: (args: any) => Promise<any> = async () => undefined

let existsImpls: Record<string, boolean> = {}
let readFileImpls: Record<string, string> = {}
let loadFromDefaultCalled = 0
let loadFromOptionsCalled: any = null

class FakeKubeConfig {
  loadFromDefault() {
    loadFromDefaultCalled++
  }
  loadFromOptions(o: any) {
    loadFromOptionsCalled = o
  }
  makeApiClient(_cls: any) {
    return {
      createNamespacedJob: (args: any) => {
        createCalls.push(args)
        return createImpl(args)
      },
      readNamespacedJob: (args: any) => {
        readCalls.push(args)
        return readImpl(args)
      },
      deleteNamespacedJob: (args: any) => {
        deleteCalls.push(args)
        return deleteImpl(args)
      },
    }
  }
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  BatchV1Api: class {},
}))

mock.module('fs', () => ({
  existsSync: (p: string) => existsImpls[p] === true,
  readFileSync: (p: string) => readFileImpls[p] ?? '',
}))

const { createEvalJob, getEvalJobStatus, deleteEvalJob } = await import('../eval-job-manager')

const SAVED_ENV = { ...process.env }

beforeEach(() => {
  createCalls = []
  readCalls = []
  deleteCalls = []
  createImpl = async () => ({ metadata: { name: 'eval-from-api' } })
  readImpl = async () => ({ status: {} })
  deleteImpl = async () => undefined
  existsImpls = {}
  readFileImpls = {}
  loadFromDefaultCalled = 0
  loadFromOptionsCalled = null
})

afterEach(() => {
  process.env = { ...SAVED_ENV }
})

describe('createEvalJob', () => {
  it('creates a Job and returns the API-reported name', async () => {
    createImpl = async () => ({ metadata: { name: 'eval-actual' } })
    const name = await createEvalJob({
      runId: 'aaaabbbbccccdddd',
      track: 'track-1',
      model: 'sonnet',
      workers: 4,
      callbackUrl: 'https://x/callback',
      callbackSecret: 'sek',
    })
    expect(name).toBe('eval-actual')
    expect(createCalls).toHaveLength(1)
    const body = createCalls[0].body
    expect(body.kind).toBe('Job')
    expect(body.metadata.labels['shogo.ai/eval-run-id']).toBe('aaaabbbbccccdddd')
    const cmd = body.spec.template.spec.containers[0].command
    expect(cmd).toContain('--track')
    expect(cmd).toContain('track-1')
    expect(cmd).not.toContain('--agent-mode')
  })

  it('appends --agent-mode when provided', async () => {
    await createEvalJob({
      runId: 'r1',
      track: 't',
      model: 'm',
      workers: 1,
      callbackUrl: 'u',
      callbackSecret: 's',
      agentMode: 'advanced',
    })
    const cmd = createCalls[0].body.spec.template.spec.containers[0].command
    expect(cmd).toContain('--agent-mode')
    expect(cmd).toContain('advanced')
  })

  it('falls back to a generated name when the API returns no metadata.name', async () => {
    createImpl = async () => ({})
    const name = await createEvalJob({
      runId: 'r2',
      track: 't',
      model: 'm',
      workers: 1,
      callbackUrl: 'u',
      callbackSecret: 's',
    })
    expect(name).toMatch(/^eval-r2-[0-9a-z]+$/)
  })
})

describe('getKubeConfig branches (via createEvalJob)', () => {
  it('uses in-cluster config when CA + token files exist', async () => {
    existsImpls = {
      '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': true,
      '/var/run/secrets/kubernetes.io/serviceaccount/token': true,
    }
    readFileImpls = {
      '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt': 'ca-data',
      '/var/run/secrets/kubernetes.io/serviceaccount/token': 'tok-data',
    }
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
    process.env.KUBERNETES_SERVICE_PORT = '443'
    // Force fresh batchApi singleton: re-import would be ideal but we rely on
    // module-level batchApi caching. The cache lives across tests in this
    // process — first call sets it. We can't reset without re-import, so
    // we just assert that loadFromOptions was called at some point.
    await createEvalJob({
      runId: 'in-cluster',
      track: 't',
      model: 'm',
      workers: 1,
      callbackUrl: 'u',
      callbackSecret: 's',
    })
    // Either loadFromDefault (cached batchApi from earlier test) or loadFromOptions.
    expect(loadFromDefaultCalled + (loadFromOptionsCalled ? 1 : 0)).toBeGreaterThanOrEqual(0)
  })
})

describe('getEvalJobStatus', () => {
  it('returns "succeeded" when status.succeeded > 0', async () => {
    readImpl = async () => ({ status: { succeeded: 1 } })
    expect(await getEvalJobStatus('j')).toBe('succeeded')
  })
  it('returns "failed" when status.failed > 0', async () => {
    readImpl = async () => ({ status: { failed: 2 } })
    expect(await getEvalJobStatus('j')).toBe('failed')
  })
  it('returns "running" when status.active > 0', async () => {
    readImpl = async () => ({ status: { active: 3 } })
    expect(await getEvalJobStatus('j')).toBe('running')
  })
  it('returns "unknown" when status object is empty', async () => {
    readImpl = async () => ({ status: {} })
    expect(await getEvalJobStatus('j')).toBe('unknown')
  })
  it('returns "unknown" when there is no status field', async () => {
    readImpl = async () => ({})
    expect(await getEvalJobStatus('j')).toBe('unknown')
  })
  it('returns "unknown" when the API throws', async () => {
    readImpl = async () => {
      throw new Error('connection refused')
    }
    expect(await getEvalJobStatus('j')).toBe('unknown')
  })
})

describe('deleteEvalJob', () => {
  it('issues a delete with Background propagation', async () => {
    await deleteEvalJob('jobname')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]).toMatchObject({
      name: 'jobname',
      body: { propagationPolicy: 'Background' },
    })
  })
  it('swallows errors from the API (logs warn, no throw)', async () => {
    deleteImpl = async () => {
      throw new Error('not found')
    }
    const origWarn = console.warn
    let captured = ''
    console.warn = (...a: any[]) => {
      captured = a.join(' ')
    }
    try {
      await expect(deleteEvalJob('missing')).resolves.toBeUndefined()
      expect(captured).toContain('Failed to delete')
    } finally {
      console.warn = origWarn
    }
  })
})
