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

// Mock crypto.randomUUID
const mockRandomUUID = mock(() => 'test-uuid-1234')
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
    mockRandomUUID.mockClear()

    // Set test environment
    process.env.WARM_POOL_ENABLED = 'true'
    process.env.PROJECT_NAMESPACE = 'test-namespace'
    process.env.S3_WORKSPACES_BUCKET = 'test-bucket'

    controller = new WarmPoolController({
      projectPoolSize: 2,
      agentPoolSize: 1,
      reconcileIntervalMs: 1000,
      maxPodAgeMs: 60000, // 1 minute for testing
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
      process.env.WARM_POOL_ENABLED = 'false'
      const disabledController = new WarmPoolController()
      await disabledController.start()

      const status = disabledController.getStatus()
      expect(status.enabled).toBe(false)
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
      // Empty pool initially
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should create 2 project pods + 1 agent pod = 3 total
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(3)

      // Verify pod specs
      const calls = mockK8sCustomApi.createNamespacedCustomObject.mock.calls
      const projectPodCall = calls.find(call =>
        call[0].body.metadata.labels['shogo.io/warm-pool-type'] === 'project'
      )
      const agentPodCall = calls.find(call =>
        call[0].body.metadata.labels['shogo.io/warm-pool-type'] === 'agent'
      )

      expect(projectPodCall).toBeDefined()
      expect(agentPodCall).toBeDefined()

      // Check project pod configuration
      const projectPod = projectPodCall![0].body
      expect(projectPod.spec.template.spec.containers[0].env).toContainEqual({
        name: 'PROJECT_ID',
        value: '__POOL__',
      })
      expect(projectPod.spec.template.spec.containers[0].env).toContainEqual({
        name: 'WARM_POOL_MODE',
        value: 'true',
      })
    })

    test('should handle concurrent creation attempts', async () => {
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      // Slow down creation to test concurrency protection
      mockK8sCustomApi.createNamespacedCustomObject.mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 500))
      )

      await controller.start()

      // Trigger multiple reconciliations quickly
      await Promise.all([
        controller.reconcile(),
        controller.reconcile(),
        controller.reconcile(),
      ])

      // Should not create duplicate pods due to pendingCreations tracking
      // Allow some extra calls due to timing, but not 9 (3x3)
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(3)
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
      const staleTimestamp = now - 120000 // 2 minutes old (exceeds test maxPodAgeMs)

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

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({
        items: mockServices,
      })

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Initial discovery should add the pod
      let status = controller.getStatus()
      expect(status.available.project).toBe(1)

      // Trigger reconciliation which should detect and remove stale pod
      await controller.reconcile()

      expect(mockK8sCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'warm-pool-project-stale',
        })
      )

      status = controller.getStatus()
      expect(status.available.project).toBe(0) // Should be removed
    })

    test('should clean up assigned pods when real service is ready', async () => {
      // Mock a pod assigned to a project
      const mockPod: WarmPodInfo = {
        id: 'test-pod',
        serviceName: 'warm-pool-project-test',
        type: 'project',
        url: 'http://warm-pool-project-test.test-namespace.svc.cluster.local',
        createdAt: Date.now(),
        ready: true,
      }

      // Manually set up assigned pod
      await controller.assign(mockPod, 'test-project-123', {})
      expect(controller.isAssigned('test-project-123')).toBe(true)

      // Mock that the real service is now ready
      mockK8sCustomApi.getNamespacedCustomObject.mockResolvedValueOnce({
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      })

      // Mock successful health check
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('project-test-project-123') && url.includes('/ready')) {
          return Promise.resolve({ ok: true })
        }
        return Promise.resolve({ ok: false })
      })

      await controller.reconcile()

      // Should have cleaned up the assigned pod
      expect(controller.isAssigned('test-project-123')).toBe(false)
      expect(mockK8sCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'warm-pool-project-test',
        })
      )
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

      await controller.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Clear previous calls
      mockK8sCustomApi.createNamespacedCustomObject.mockClear()

      // Claim the pod
      const pod = controller.claim('project')
      expect(pod).not.toBeNull()

      // Should trigger creation of a replacement pod
      await new Promise(resolve => setTimeout(resolve, 200))
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

    // Simulate concurrent discovery calls
    const discoveries = Array(5).fill(null).map(() =>
      controller.reconcile()
    )

    await Promise.all(discoveries)

    // Should not crash or create duplicate entries
    const status = controller.getStatus()
    expect(status.enabled).toBe(true)
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
  })
})