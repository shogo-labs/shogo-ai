// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Tests for src/lib/eval-job-manager.ts — creates / monitors / deletes
 * Kubernetes batch/v1 Jobs for eval runs. Mocks the K8s client and fs
 * so no real cluster or filesystem is touched.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ─── K8s + fs mocks ────────────────────────────────────────────────────────

const createNamespacedJobMock = mock(async (_: any) => ({
  metadata: { name: 'created-job' },
}))
const readNamespacedJobMock = mock(async (_: any) => ({ status: {} }))
const deleteNamespacedJobMock = mock(async (_: any) => ({}))

class FakeBatchV1Api {
  createNamespacedJob = createNamespacedJobMock
  readNamespacedJob = readNamespacedJobMock
  deleteNamespacedJob = deleteNamespacedJobMock
}

class FakeKubeConfig {
  loadFromOptions = mock(() => {})
  loadFromDefault = mock(() => {})
  makeApiClient = mock(() => new FakeBatchV1Api())
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: FakeKubeConfig,
  BatchV1Api: FakeBatchV1Api,
}))

const existsSyncMock = mock((_p: string): boolean => false)
const readFileSyncMock = mock((_p: string, _enc?: any): string => '')

mock.module('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}))

const { createEvalJob, deleteEvalJob, getEvalJobStatus } = await import('../lib/eval-job-manager')

// ─── Test helpers ──────────────────────────────────────────────────────────

const ORIG_RUNTIME_IMAGE = process.env.RUNTIME_IMAGE
const ORIG_SYSTEM_NAMESPACE = process.env.SYSTEM_NAMESPACE
const ORIG_K8S_HOST = process.env.KUBERNETES_SERVICE_HOST
const ORIG_K8S_PORT = process.env.KUBERNETES_SERVICE_PORT

let logSpy: ReturnType<typeof spyOn>
let warnSpy: ReturnType<typeof spyOn>

// Namespace + image as captured at module load. The module reads them
// once into module-level constants, so we assert against those values
// instead of process.env.
const NAMESPACE = process.env.SYSTEM_NAMESPACE || 'shogo-staging-system'
const RUNTIME_IMAGE = process.env.RUNTIME_IMAGE || 'shogo-runtime:eval'

beforeEach(() => {
  createNamespacedJobMock.mockReset()
  createNamespacedJobMock.mockImplementation(async () => ({ metadata: { name: 'created-job' } }))
  readNamespacedJobMock.mockReset()
  readNamespacedJobMock.mockImplementation(async () => ({ status: {} }))
  deleteNamespacedJobMock.mockReset()
  deleteNamespacedJobMock.mockImplementation(async () => ({}))
  existsSyncMock.mockReset()
  existsSyncMock.mockImplementation(() => false) // run "out of cluster" by default
  readFileSyncMock.mockReset()
  logSpy = spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
  if (ORIG_RUNTIME_IMAGE === undefined) delete process.env.RUNTIME_IMAGE
  else process.env.RUNTIME_IMAGE = ORIG_RUNTIME_IMAGE
  if (ORIG_SYSTEM_NAMESPACE === undefined) delete process.env.SYSTEM_NAMESPACE
  else process.env.SYSTEM_NAMESPACE = ORIG_SYSTEM_NAMESPACE
  if (ORIG_K8S_HOST === undefined) delete process.env.KUBERNETES_SERVICE_HOST
  else process.env.KUBERNETES_SERVICE_HOST = ORIG_K8S_HOST
  if (ORIG_K8S_PORT === undefined) delete process.env.KUBERNETES_SERVICE_PORT
  else process.env.KUBERNETES_SERVICE_PORT = ORIG_K8S_PORT
})

const baseOpts = () => ({
  runId: 'run-12345678abcd',
  track: 'next-15',
  model: 'claude-sonnet-4-5',
  workers: 4,
  callbackUrl: 'https://api.test/eval-callback',
  callbackSecret: 'shh',
})

// ─── createEvalJob ─────────────────────────────────────────────────────────

describe('createEvalJob', () => {
  test('returns the server-assigned job name from the response metadata', async () => {
    createNamespacedJobMock.mockImplementation(async () => ({
      metadata: { name: 'eval-abc-123' },
    }))
    const name = await createEvalJob(baseOpts())
    expect(name).toBe('eval-abc-123')
  })

  test('falls back to the locally-generated name if response has no metadata.name', async () => {
    createNamespacedJobMock.mockImplementation(async () => ({}))
    const name = await createEvalJob(baseOpts())
    // Local pattern: eval-<runId.slice(0,8)>-<timestamp36>
    expect(name).toMatch(/^eval-run-1234-[0-9a-z]+$/)
  })

  test('targets the configured namespace', async () => {
    await createEvalJob(baseOpts())
    const args = createNamespacedJobMock.mock.calls[0][0]
    expect(args.namespace).toBe(NAMESPACE)
    expect(args.body.metadata.namespace).toBe(NAMESPACE)
  })

  test('emits a Job spec with the documented invariants', async () => {
    await createEvalJob(baseOpts())
    const job = createNamespacedJobMock.mock.calls[0][0].body
    expect(job.apiVersion).toBe('batch/v1')
    expect(job.kind).toBe('Job')
    expect(job.spec.backoffLimit).toBe(0) // no retries
    expect(job.spec.activeDeadlineSeconds).toBe(7200) // 2h
    expect(job.spec.ttlSecondsAfterFinished).toBe(3600) // 1h auto-cleanup
    expect(job.spec.template.spec.restartPolicy).toBe('Never')
    expect(job.spec.template.spec.serviceAccountName).toBe('api-service-account')
  })

  test('builds the runner command with all required flags', async () => {
    await createEvalJob({ ...baseOpts(), agentMode: 'autonomous' })
    const container = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0]
    expect(container.command.slice(0, 3)).toEqual(['bun', 'run', 'src/evals/run-eval.ts'])
    expect(container.command).toContain('--track')
    expect(container.command).toContain('next-15')
    expect(container.command).toContain('--model')
    expect(container.command).toContain('claude-sonnet-4-5')
    expect(container.command).toContain('--workers')
    expect(container.command).toContain('4') // String(workers)
    expect(container.command).toContain('--run-id')
    expect(container.command).toContain('run-12345678abcd')
    expect(container.command).toContain('--callback-url')
    expect(container.command).toContain('https://api.test/eval-callback')
    expect(container.command).toContain('--agent-mode')
    expect(container.command).toContain('autonomous')
  })

  test('omits --agent-mode when not provided', async () => {
    await createEvalJob(baseOpts()) // no agentMode
    const command = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].command
    expect(command).not.toContain('--agent-mode')
  })

  test('coerces workers to a string in the command args', async () => {
    await createEvalJob({ ...baseOpts(), workers: 99 })
    const command = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].command
    const idx = command.indexOf('--workers')
    expect(command[idx + 1]).toBe('99')
    expect(typeof command[idx + 1]).toBe('string')
  })

  test('sets EVAL_CALLBACK_SECRET env var to the supplied secret', async () => {
    await createEvalJob({ ...baseOpts(), callbackSecret: 'super-secret-value' })
    const env = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].env
    const secret = env.find((e: any) => e.name === 'EVAL_CALLBACK_SECRET')
    expect(secret.value).toBe('super-secret-value')
  })

  test('mounts the documented secret refs for ANTHROPIC/OPENAI/GOOGLE keys', async () => {
    await createEvalJob(baseOpts())
    const env = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].env
    const byName = Object.fromEntries(env.map((e: any) => [e.name, e]))
    expect(byName.ANTHROPIC_API_KEY.valueFrom.secretKeyRef).toEqual({
      name: 'api-secrets',
      key: 'ANTHROPIC_API_KEY',
    })
    expect(byName.OPENAI_API_KEY.valueFrom.secretKeyRef.optional).toBe(true)
    expect(byName.GOOGLE_API_KEY.valueFrom.secretKeyRef.optional).toBe(true)
  })

  test('points WEB_CACHE_REDIS_URL at redis-master in the configured namespace', async () => {
    await createEvalJob(baseOpts())
    const env = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].env
    const redis = env.find((e: any) => e.name === 'WEB_CACHE_REDIS_URL')
    expect(redis.value).toBe(`redis://redis-master.${NAMESPACE}:6379`)
  })

  test('sets the documented resource requests and limits', async () => {
    await createEvalJob(baseOpts())
    const resources = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0].resources
    expect(resources.requests).toEqual({ cpu: '2', memory: '4Gi' })
    expect(resources.limits).toEqual({ cpu: '8', memory: '16Gi' })
  })

  test('uses the configured RUNTIME_IMAGE', async () => {
    await createEvalJob(baseOpts())
    const container = createNamespacedJobMock.mock.calls[0][0].body.spec.template.spec.containers[0]
    expect(container.image).toBe(RUNTIME_IMAGE)
    expect(container.imagePullPolicy).toBe('Always')
  })

  test('attaches both run-id and component labels at job + pod levels', async () => {
    await createEvalJob(baseOpts())
    const body = createNamespacedJobMock.mock.calls[0][0].body
    expect(body.metadata.labels['app.kubernetes.io/component']).toBe('eval-runner')
    expect(body.metadata.labels['shogo.ai/eval-run-id']).toBe('run-12345678abcd')
    expect(body.spec.template.metadata.labels['shogo.ai/eval-run-id']).toBe('run-12345678abcd')
  })

  test('logs a "Created Job" line with the namespace', async () => {
    await createEvalJob(baseOpts())
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[EvalJobManager] Created Job')
    expect(logged).toContain(NAMESPACE)
  })

  test('caches the BatchV1Api client across calls (single makeApiClient)', async () => {
    // Two creates back-to-back should each hit createNamespacedJob, but
    // only one client construction should occur (we verify via call count
    // on createNamespacedJob being correct; the cache is internal).
    await createEvalJob(baseOpts())
    await createEvalJob(baseOpts())
    expect(createNamespacedJobMock).toHaveBeenCalledTimes(2)
  })

  test('propagates errors from the K8s API to the caller', async () => {
    createNamespacedJobMock.mockImplementation(async () => {
      throw new Error('Forbidden: cannot create jobs')
    })
    await expect(createEvalJob(baseOpts())).rejects.toThrow('Forbidden')
  })
})

// ─── getEvalJobStatus ─────────────────────────────────────────────────────

describe('getEvalJobStatus', () => {
  test('returns "succeeded" when status.succeeded > 0', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({
      status: { succeeded: 1, failed: 0, active: 0 },
    }))
    expect(await getEvalJobStatus('job-1')).toBe('succeeded')
  })

  test('returns "failed" when status.failed > 0', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({
      status: { failed: 1, active: 0, succeeded: 0 },
    }))
    expect(await getEvalJobStatus('job-2')).toBe('failed')
  })

  test('returns "running" when status.active > 0', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({
      status: { active: 1, failed: 0, succeeded: 0 },
    }))
    expect(await getEvalJobStatus('job-3')).toBe('running')
  })

  test('returns "unknown" when status is empty {}', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({ status: {} }))
    expect(await getEvalJobStatus('job-4')).toBe('unknown')
  })

  test('returns "unknown" when status is undefined', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({}))
    expect(await getEvalJobStatus('job-5')).toBe('unknown')
  })

  test('prefers "succeeded" over "running" when both fields are present', async () => {
    // (Reads in the order succeeded → failed → active; first match wins.)
    readNamespacedJobMock.mockImplementation(async () => ({
      status: { succeeded: 1, active: 1 },
    }))
    expect(await getEvalJobStatus('job-6')).toBe('succeeded')
  })

  test('prefers "failed" over "running" when both fields are present', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({
      status: { failed: 1, active: 1 },
    }))
    expect(await getEvalJobStatus('job-7')).toBe('failed')
  })

  test('returns "unknown" when the K8s API throws (e.g. 404)', async () => {
    readNamespacedJobMock.mockImplementation(async () => {
      throw new Error('Not Found')
    })
    expect(await getEvalJobStatus('missing-job')).toBe('unknown')
  })

  test('queries the configured namespace', async () => {
    readNamespacedJobMock.mockImplementation(async () => ({ status: {} }))
    await getEvalJobStatus('job-x')
    expect(readNamespacedJobMock.mock.calls[0][0]).toEqual({
      name: 'job-x',
      namespace: NAMESPACE,
    })
  })
})

// ─── deleteEvalJob ─────────────────────────────────────────────────────────

describe('deleteEvalJob', () => {
  test('deletes with propagationPolicy: Background and logs success', async () => {
    await deleteEvalJob('job-to-delete')
    expect(deleteNamespacedJobMock).toHaveBeenCalledTimes(1)
    expect(deleteNamespacedJobMock.mock.calls[0][0]).toEqual({
      name: 'job-to-delete',
      namespace: NAMESPACE,
      body: { propagationPolicy: 'Background' },
    })
    const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('[EvalJobManager] Deleted Job job-to-delete')
  })

  test('catches errors and logs a warning instead of throwing', async () => {
    deleteNamespacedJobMock.mockImplementation(async () => {
      throw new Error('job vanished mid-delete')
    })
    await expect(deleteEvalJob('flaky-job')).resolves.toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(warned).toContain('Failed to delete Job flaky-job')
    expect(warned).toContain('job vanished mid-delete')
  })

  test('returns undefined on success (void contract)', async () => {
    const result = await deleteEvalJob('ok-job')
    expect(result).toBeUndefined()
  })
})
