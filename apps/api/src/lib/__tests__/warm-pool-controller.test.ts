/**
 * Warm Pool Controller Test Suite
 *
 * Tests the warm pool controller that maintains pre-warmed pods for instant project startup.
 * The warm pool eliminates cold start latency by keeping generic runtime pods already running
 * and reassigning them to specific projects on demand.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { WarmPoolController, type WarmPodInfo, type RuntimeType } from '../warm-pool-controller'
import * as k8s from '@kubernetes/client-node'

// Mock Kubernetes API responses
const mockK8sCustomApi = {
  listNamespacedCustomObject: mock(() => Promise.resolve({ items: [] })),
  createNamespacedCustomObject: mock(() => Promise.resolve({})),
  deleteNamespacedCustomObject: mock(() => Promise.resolve({})),
  getNamespacedCustomObject: mock(() => Promise.resolve({})),
}

// Mock the Kubernetes client
mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    loadFromOptions() {}
    makeApiClient() {
      return mockK8sCustomApi
    }
  },
  CustomObjectsApi: class {},
  CoreV1Api: class {},
}))

// Mock fetch for pool assignment calls
const mockFetch = mock((url: string, options?: any) => {
  if (url.includes('/pool/assign')) {
    return Promise.resolve({
      ok: true,
      text: () => Promise.resolve('OK'),
    })
  }
  if (url.includes('/ready')) {
    return Promise.resolve({ ok: true })
  }
  return Promise.resolve({ ok: false })
})
global.fetch = mockFetch as any

// Counter for generating unique UUIDs across calls
let uuidCounter = 0
const mockRandomUUID = mock(() => `${String(++uuidCounter).padStart(8, '0')}-test-uuid`)
global.crypto = { randomUUID: mockRandomUUID } as any

// Mock the prisma client
mock.module('../prisma', () => ({
  prisma: {
    project: {
      findUnique: mock(() => Promise.resolve({ workspaceId: 'test-workspace' })),
    },
  },
}))

// Mock AI proxy token generation
mock.module('../ai-proxy-token', () => ({
  generateProxyToken: mock(() => Promise.resolve('test-proxy-token')),
}))

// Mock database service
mock.module('../../services/database.service', () => ({
  provisionDatabase: mock(() => Promise.resolve({
    connectionUrl: 'postgresql://test:test@localhost/test',
  })),
}))

describe('WarmPoolController', () => {
  let controller: WarmPoolController

  beforeEach(() => {
    // Reset all mocks
    mockK8sCustomApi.listNamespacedCustomObject.mockClear()
    mockK8sCustomApi.createNamespacedCustomObject.mockClear()
    mockK8sCustomApi.deleteNamespacedCustomObject.mockClear()
    mockK8sCustomApi.getNamespacedCustomObject.mockClear()
    mockFetch.mockClear()
    uuidCounter = 0

    // Restore default fetch behavior
    mockFetch.mockImplementation((url: string, options?: any) => {
      if (url.includes('/pool/assign')) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('OK'),
        })
      }
      if (url.includes('/ready')) {
        return Promise.resolve({ ok: true })
      }
      return Promise.resolve({ ok: false })
    })

    // Set test environment
    process.env.WARM_POOL_ENABLED = 'true'
    process.env.PROJECT_NAMESPACE = 'test-namespace'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'

    controller = new WarmPoolController({
      projectPoolSize: 2,
      agentPoolSize: 1,
      reconcileIntervalMs: 1000,
      maxPodAgeMs: 60000,
    })
  })

  afterEach(() => {
    controller.stop()
  })

  describe('Basic Operations', () => {
    test('should start and initialize pool', async () => {
      await controller.start()
      const status = controller.getStatus()

      expect(status.enabled).toBe(true)
      expect(status.targetSize.project).toBe(2)
      expect(status.targetSize.agent).toBe(1)
    })

    test('should handle disabled state', async () => {
      // A controller that is never started reports enabled=false
      // (WARM_POOL_ENABLED is a module-level constant — the "disabled" path
      //  only matters in the real module load where env is set before import)
      const freshController = new WarmPoolController()
      const status = freshController.getStatus()
      expect(status.enabled).toBe(false)
      freshController.stop()
    })
  })

  describe('Pod Discovery', () => {
    test('should discover existing warm pool services', async () => {
      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-abc123',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date().toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
        {
          metadata: {
            name: 'warm-pool-agent-def456',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'agent',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date().toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })

      await controller.start()

      // Wait for initial reconciliation
      await new Promise(resolve => setTimeout(resolve, 100))

      const status = controller.getStatus()
      expect(status.available.project).toBe(1)
      expect(status.available.agent).toBe(1)
    })

    test('should skip assigned pods during discovery', async () => {
      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-abc123',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'assigned', // Already assigned
            },
            creationTimestamp: new Date().toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      const status = controller.getStatus()
      expect(status.available.project).toBe(0) // Should not count assigned pods
    })
  })

  describe('Pod Creation', () => {
    test('should create warm pods to meet target pool size', async () => {
      // Empty pool initially — return empty on every discovery call
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await controller.start()
      // createWarmPod is fire-and-forget; give promises time to resolve
      await new Promise(resolve => setTimeout(resolve, 200))

      // Should create 2 project pods + 1 agent pod = 3 total
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(3)

      // Verify pod specs include warm pool config
      const calls = mockK8sCustomApi.createNamespacedCustomObject.mock.calls
      const bodies = calls.map((call: any) => {
        const arg = call[0]
        return arg?.body || arg
      })

      const projectBodies = bodies.filter(
        (b: any) => b?.metadata?.labels?.['shogo.io/warm-pool-type'] === 'project'
      )
      const agentBodies = bodies.filter(
        (b: any) => b?.metadata?.labels?.['shogo.io/warm-pool-type'] === 'agent'
      )

      expect(projectBodies.length).toBe(2)
      expect(agentBodies.length).toBe(1)

      // Check project pod has pool env vars
      const projectPod = projectBodies[0]
      const envVars = projectPod.spec.template.spec.containers[0].env
      expect(envVars).toContainEqual({ name: 'PROJECT_ID', value: '__POOL__' })
      expect(envVars).toContainEqual({ name: 'WARM_POOL_MODE', value: 'true' })
    })

    test('should handle concurrent creation attempts without crashing', async () => {
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      // Slow down creation to simulate real latency
      mockK8sCustomApi.createNamespacedCustomObject.mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 50))
      )

      await controller.start()

      // Trigger multiple reconciliations concurrently — should not throw or deadlock
      await Promise.all([
        controller.reconcile(),
        controller.reconcile(),
        controller.reconcile(),
      ])
      await new Promise(resolve => setTimeout(resolve, 200))

      // Verify the controller is still healthy after concurrent reconciles
      const status = controller.getStatus()
      expect(status.enabled).toBe(true)
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalled()
    })
  })

  describe('Pod Lifecycle', () => {
    test('should claim oldest available pod', async () => {
      const now = Date.now()
      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-old',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date(now - 30000).toISOString(), // Older
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
        {
          metadata: {
            name: 'warm-pool-project-new',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date(now - 10000).toISOString(), // Newer
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      const pod = controller.claim('project')
      expect(pod).not.toBeNull()
      expect(pod?.serviceName).toBe('warm-pool-project-old') // Should claim older pod

      const status = controller.getStatus()
      expect(status.available.project).toBe(1) // One remaining
    })

    test('should return null when no pods available', async () => {
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      const pod = controller.claim('project')
      expect(pod).toBeNull()
    })

    test('should not claim pods that are not ready', async () => {
      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-notready',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date().toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'False' }], // Not ready
          },
        },
      ]

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      const pod = controller.claim('project')
      expect(pod).toBeNull()
    })
  })

  describe('Pod Assignment', () => {
    test('should assign pod to project and track assignment', async () => {
      const mockPod: WarmPodInfo = {
        id: 'test-pod',
        serviceName: 'warm-pool-project-test',
        type: 'project',
        url: 'http://warm-pool-project-test.test-namespace.svc.cluster.local',
        createdAt: Date.now(),
        ready: true,
      }

      await controller.assign(mockPod, 'test-project-123', {
        PROJECT_ID: 'test-project-123',
        AI_PROXY_TOKEN: 'test-token',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        'http://warm-pool-project-test.test-namespace.svc.cluster.local/pool/assign',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: 'test-project-123',
            env: {
              PROJECT_ID: 'test-project-123',
              AI_PROXY_TOKEN: 'test-token',
            },
          }),
        })
      )

      expect(controller.isAssigned('test-project-123')).toBe(true)
      expect(controller.getAssignedUrl('test-project-123')).toBe(mockPod.url)
    })

    test('should handle assignment failures', async () => {
      const mockPod: WarmPodInfo = {
        id: 'test-pod',
        serviceName: 'warm-pool-project-test',
        type: 'project',
        url: 'http://warm-pool-project-test.test-namespace.svc.cluster.local',
        createdAt: Date.now(),
        ready: true,
      }

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })

      await expect(
        controller.assign(mockPod, 'test-project-123', {})
      ).rejects.toThrow('Assignment failed (500): Internal Server Error')

      expect(controller.isAssigned('test-project-123')).toBe(false)
    })
  })

  describe('Pool Maintenance', () => {
    test('should recycle stale pods', async () => {
      const now = Date.now()
      const staleTimestamp = now - 120000 // 2 minutes old (exceeds test maxPodAgeMs of 60s)

      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-stale',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date(staleTimestamp).toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]

      // First call (start's reconcile): return the stale pod
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })
      // Second call (explicit reconcile below): still returns it so discovery re-adds it
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // The initial reconcile should have found and recycled the stale pod
      // But the stale check in reconcile runs after discoverExistingPods,
      // so the pod is added then removed in the same cycle
      expect(mockK8sCustomApi.deleteNamespacedCustomObject).toHaveBeenCalled()

      // Verify the delete was called with the stale pod's name
      const deleteCalls = mockK8sCustomApi.deleteNamespacedCustomObject.mock.calls
      const deleteArg = deleteCalls[0]?.[0] as any
      expect(deleteArg?.name ?? deleteArg).toBe('warm-pool-project-stale')
    })

    test('should clean up assigned pods when real service is ready', async () => {
      await controller.start()

      // Manually assign a pod
      const mockPod: WarmPodInfo = {
        id: 'test-pod',
        serviceName: 'warm-pool-project-test',
        type: 'project',
        url: 'http://warm-pool-project-test.test-namespace.svc.cluster.local',
        createdAt: Date.now(),
        ready: true,
      }

      await controller.assign(mockPod, 'test-project-123', {})
      expect(controller.isAssigned('test-project-123')).toBe(true)

      // Mock the real Knative service (project-test-project-123) as ready
      mockK8sCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      })

      // Mock health check for the real service
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('project-test-project-123') && url.includes('/ready')) {
          return Promise.resolve({ ok: true })
        }
        if (url.includes('/pool/assign')) {
          return Promise.resolve({ ok: true, text: () => Promise.resolve('OK') })
        }
        return Promise.resolve({ ok: false })
      })

      // Empty discovery so reconcile doesn't try to add/remove available pods
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({ items: [] })

      await controller.reconcile()
      await new Promise(resolve => setTimeout(resolve, 100))

      // The assigned pod should have been cleaned up
      expect(controller.isAssigned('test-project-123')).toBe(false)
    })

    test('should trigger replenishment after claiming a pod', async () => {
      const mockServices = [
        {
          metadata: {
            name: 'warm-pool-project-abc',
            labels: {
              'shogo.io/warm-pool': 'true',
              'shogo.io/warm-pool-type': 'project',
              'shogo.io/warm-pool-status': 'available',
            },
            creationTimestamp: new Date().toISOString(),
          },
          status: {
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        },
      ]

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: mockServices,
      })
      // Subsequent discovery calls return empty (the claimed pod is gone from k8s)
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Clear previous calls from initial reconcile
      mockK8sCustomApi.createNamespacedCustomObject.mockClear()

      // Claim the pod — this triggers async reconcile() for replenishment
      const pod = controller.claim('project')
      expect(pod).not.toBeNull()

      // Give the async replenishment reconcile time to fire
      await new Promise(resolve => setTimeout(resolve, 300))

      // Should have tried to create replacement pod(s)
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalled()
    })
  })

  describe('Environment Variable Building', () => {
    test('should build complete project environment', async () => {
      const env = await controller.buildProjectEnv('test-project-456')

      expect(env).toHaveProperty('PROJECT_ID', 'test-project-456')
      expect(env).toHaveProperty('AI_PROXY_TOKEN', 'test-proxy-token')
      expect(env).toHaveProperty('DATABASE_URL', 'postgresql://test:test@localhost/test')
      expect(env).toHaveProperty('S3_WORKSPACES_BUCKET', 'test-bucket')
      expect(env).toHaveProperty('S3_REGION', 'us-east-1')
      expect(env).toHaveProperty('S3_WATCH_ENABLED', 'true')
      expect(env).toHaveProperty('S3_SYNC_INTERVAL', '30000')
    })

    test('should handle missing project gracefully', async () => {
      const { prisma } = await import('../prisma')
      ;(prisma.project.findUnique as any).mockResolvedValueOnce(null)

      const env = await controller.buildProjectEnv('non-existent-project')

      expect(env).toHaveProperty('PROJECT_ID', 'non-existent-project')
      expect(env).not.toHaveProperty('AI_PROXY_TOKEN') // Should skip if project not found
    })
  })
})

describe('Warm Pool Integration', () => {
  test('should handle race conditions during discovery', async () => {
    const controller = new WarmPoolController()
    // Must start before reconcile will do anything (reconcile returns early if !started)
    await controller.start()

    // Simulate concurrent reconcile calls
    const discoveries = Array(5).fill(null).map(() =>
      controller.reconcile()
    )

    await Promise.all(discoveries)

    const status = controller.getStatus()
    expect(status.enabled).toBe(true)
    controller.stop()
  })

  test('should handle Kubernetes API errors gracefully', async () => {
    const controller = new WarmPoolController()

    // Mock API failure
    mockK8sCustomApi.listNamespacedCustomObject.mockRejectedValueOnce(
      new Error('Network error')
    )

    await controller.start()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Should continue running despite error
    const status = controller.getStatus()
    expect(status.enabled).toBe(true)
    controller.stop()
  })
})
