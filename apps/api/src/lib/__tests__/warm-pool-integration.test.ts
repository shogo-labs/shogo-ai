// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Warm Pool Integration Tests
 *
 * Tests the integration between WarmPoolController and KnativeProjectManager
 * to ensure seamless warm pod claiming and project creation flows.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { getKnativeProjectManager, getProjectPodUrl } from '../knative-project-manager'
import { getWarmPoolController, WarmPoolController, type WarmPodInfo } from '../warm-pool-controller'
import * as k8s from '@kubernetes/client-node'

// Mock modules
const mockK8sCustomApi = {
  listNamespacedCustomObject: mock(() => Promise.resolve({ items: [] })),
  createNamespacedCustomObject: mock(() => Promise.resolve({})),
  deleteNamespacedCustomObject: mock(() => Promise.resolve({})),
  getNamespacedCustomObject: mock(() => Promise.resolve({})),
  patchNamespacedCustomObject: mock(() => Promise.resolve({})),
}

const mockK8sCoreApi = {
  readNamespacedPersistentVolumeClaim: mock(() => Promise.reject({ code: 404 })),
  createNamespacedPersistentVolumeClaim: mock(() => Promise.resolve({})),
  deleteNamespacedPersistentVolumeClaim: mock(() => Promise.resolve({})),
}

mock.module('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    loadFromOptions() {}
    makeApiClient(type: any) {
      if (type.name === 'CoreV1Api') return mockK8sCoreApi
      return mockK8sCustomApi
    }
  },
  CustomObjectsApi: class {},
  CoreV1Api: class {},
}))

// Mock fetch for health checks and pool assignment
const mockFetch = mock((url: string, options?: any) => {
  if (url.includes('/pool/assign')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, projectId: 'test-project', durationMs: 100 }),
    })
  }
  if (url.includes('/ready') || url.includes('/health')) {
    return Promise.resolve({ ok: true })
  }
  return Promise.resolve({ ok: false })
})
global.fetch = mockFetch as any

// Mock crypto
global.crypto = { randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2, 9) } as any

// Mock prisma
const mockPrismaProject = {
  findUnique: mock(() => Promise.resolve({ workspaceId: 'test-workspace', type: 'PROJECT' })),
}

mock.module('../prisma', () => ({
  prisma: {
    project: mockPrismaProject,
  },
}))

// Mock AI proxy token
mock.module('../ai-proxy-token', () => ({
  generateProxyToken: mock(() => Promise.resolve('test-proxy-token-123')),
}))

// Mock database service
mock.module('../../services/database.service', () => ({
  provisionDatabase: mock(() => Promise.resolve({
    connectionUrl: 'postgresql://test:test@localhost/test',
  })),
}))

// Set up test environment
beforeEach(() => {
  process.env.KUBERNETES_SERVICE_HOST = 'localhost'
  process.env.WARM_POOL_ENABLED = 'true'
  process.env.PROJECT_NAMESPACE = 'test-namespace'
  process.env.PROJECT_RUNTIME_IMAGE = 'test-runtime:latest'
  process.env.AGENT_RUNTIME_IMAGE = 'test-agent:latest'
  process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
  process.env.S3_REGION = 'us-east-1'
  process.env.API_URL = 'http://api.test.local'
})

describe('Warm Pool + Knative Integration', () => {
  let warmPoolController: WarmPoolController

  beforeEach(() => {
    // Reset all mocks
    Object.values(mockK8sCustomApi).forEach(m => m.mockClear())
    Object.values(mockK8sCoreApi).forEach(m => m.mockClear())
    mockFetch.mockClear()
    mockPrismaProject.findUnique.mockClear()

    // Initialize warm pool with specific config
    warmPoolController = new WarmPoolController({
      projectPoolSize: 2,
      agentPoolSize: 1,
      reconcileIntervalMs: 30000,
      maxPodAgeMs: 30 * 60 * 1000,
    })
  })

  afterEach(() => {
    warmPoolController.stop()
  })

  describe('Cold Start vs Warm Start', () => {
    test('should use warm pool when available', async () => {
      // Set up a warm pod in the pool
      const warmPod = {
        metadata: {
          name: 'warm-pool-project-test123',
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date().toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: [warmPod],
      })

      // Start warm pool
      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock that the project doesn't exist yet
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })

      const startTime = Date.now()
      const url = await getProjectPodUrl('new-project-123')
      const duration = Date.now() - startTime

      // Should be very fast (< 1 second)
      expect(duration).toBeLessThan(1000)
      expect(url).toBe('http://warm-pool-project-test123.test-namespace.svc.cluster.local')

      // Verify pool assignment was called
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/pool/assign'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('new-project-123'),
        })
      )

      // Verify background Knative Service creation was triggered
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: expect.objectContaining({
              name: 'project-new-project-123',
            }),
          }),
        })
      )
    })

    test('should fall back to cold start when no warm pods available', async () => {
      // Empty warm pool
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock project doesn't exist
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })

      // Mock successful Knative Service creation
      mockK8sCustomApi.createNamespacedCustomObject.mockResolvedValueOnce({})

      // Mock ready status after creation
      mockK8sCustomApi.getNamespacedCustomObject.mockResolvedValue({
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          url: 'http://project-test.test-namespace.svc.cluster.local',
        },
      })

      const url = await getProjectPodUrl('cold-start-project')

      expect(url).toBe('http://project-cold-start-project.test-namespace.svc.cluster.local')

      // Should have created the Knative Service directly
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            kind: 'Service',
            metadata: expect.objectContaining({
              name: 'project-cold-start-project',
            }),
          }),
        })
      )
    })

    test('should handle agent projects correctly', async () => {
      mockPrismaProject.findUnique.mockResolvedValueOnce({
        workspaceId: 'test-workspace',
      })

      // Set up a warm pod
      const warmAgentPod = {
        metadata: {
          name: 'warm-pool-agent-abc456',
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date().toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: [warmAgentPod],
      })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock project doesn't exist
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })

      const url = await getProjectPodUrl('agent-project-789')

      expect(url).toBe('http://warm-pool-agent-abc456.test-namespace.svc.cluster.local')
      expect(warmPoolController.isAssigned('agent-project-789')).toBe(true)
    })
  })

  describe('Concurrent Request Handling', () => {
    test('should handle multiple requests for same project', async () => {
      // Set up warm pods
      const warmPods = Array.from({ length: 3 }, (_, i) => ({
        metadata: {
          name: `warm-pool-project-${i}`,
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date(Date.now() - i * 1000).toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }))

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: warmPods,
      })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock project doesn't exist
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValue({ code: 404 })

      // Simulate 5 concurrent requests for the same project
      const requests = Array(5).fill(null).map(() =>
        getProjectPodUrl('concurrent-project')
      )

      const urls = await Promise.all(requests)

      // All should get the same URL
      const uniqueUrls = new Set(urls)
      expect(uniqueUrls.size).toBe(1)

      // Should only claim one warm pod
      expect(mockFetch).toHaveBeenCalledTimes(1) // Only one /pool/assign call
    })

    test('should handle requests for different projects', async () => {
      // Set up multiple warm pods
      const warmPods = Array.from({ length: 3 }, (_, i) => ({
        metadata: {
          name: `warm-pool-project-${i}`,
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date(Date.now() - i * 1000).toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }))

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({
        items: warmPods,
      })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock projects don't exist
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValue({ code: 404 })

      // Request URLs for 3 different projects
      const projects = ['project-a', 'project-b', 'project-c']
      const urls = await Promise.all(
        projects.map(p => getProjectPodUrl(p))
      )

      // Each should get a different warm pod
      const uniqueUrls = new Set(urls)
      expect(uniqueUrls.size).toBe(3)

      // All projects should be assigned
      projects.forEach(p => {
        expect(warmPoolController.isAssigned(p)).toBe(true)
      })
    })
  })

  describe('Pool Lifecycle Management', () => {
    test('should clean up warm pods when real service is ready', async () => {
      // Manually assign a pod to simulate existing assignment
      const assignedPod: WarmPodInfo = {
        id: 'warm-pool-project-cleanup',
        serviceName: 'warm-pool-project-cleanup',
        
        url: 'http://warm-pool-project-cleanup.test-namespace.svc.cluster.local',
        createdAt: Date.now(),
        ready: true,
      }

      await warmPoolController.start()
      await warmPoolController.assign(assignedPod, 'cleanup-test-project', {
        PROJECT_ID: 'cleanup-test-project',
      })

      expect(warmPoolController.isAssigned('cleanup-test-project')).toBe(true)

      // Mock that real service is now ready
      mockK8sCustomApi.getNamespacedCustomObject.mockImplementation(({ name }) => {
        if (name === 'project-cleanup-test-project') {
          return Promise.resolve({
            status: {
              conditions: [{ type: 'Ready', status: 'True' }],
              url: 'http://project-cleanup-test-project.test-namespace.svc.cluster.local',
            },
          })
        }
        return Promise.reject({ code: 404 })
      })

      // Mock health check success
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('project-cleanup-test-project') && url.includes('/ready')) {
          return Promise.resolve({ ok: true })
        }
        return mockFetch(url) // Delegate to default mock
      })

      // Trigger reconciliation
      await warmPoolController.reconcile()

      // Warm pod should be cleaned up
      expect(warmPoolController.isAssigned('cleanup-test-project')).toBe(false)
      expect(mockK8sCustomApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'warm-pool-project-cleanup',
        })
      )
    })

    test('should replenish pool after claiming pods', async () => {
      // Start with one warm pod
      const initialPod = {
        metadata: {
          name: 'warm-pool-project-initial',
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date().toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: [initialPod],
      })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Clear previous creation calls
      mockK8sCustomApi.createNamespacedCustomObject.mockClear()

      // Mock updated list without the claimed pod
      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({
        items: [],
      })

      // Claim the pod
      const pod = warmPoolController.claim()
      expect(pod).not.toBeNull()

      // Wait for replenishment
      await new Promise(resolve => setTimeout(resolve, 200))

      // Should create new pods to maintain pool size
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(2) // Back to target size of 2
    })
  })

  describe('Error Handling', () => {
    test('should handle warm pod assignment failures gracefully', async () => {
      // Set up a warm pod
      const warmPod = {
        metadata: {
          name: 'warm-pool-project-error',
          labels: {
            'shogo.io/warm-pool': 'true',
            
            'shogo.io/warm-pool-status': 'available',
          },
          creationTimestamp: new Date().toISOString(),
        },
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
        },
      }

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValueOnce({
        items: [warmPod],
      })

      await warmPoolController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Mock assignment failure
      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Assignment failed'),
        })
      )

      // Mock project doesn't exist
      mockK8sCustomApi.getNamespacedCustomObject.mockRejectedValueOnce({ code: 404 })

      // Should fall back to cold start
      mockK8sCustomApi.createNamespacedCustomObject.mockResolvedValueOnce({})
      mockK8sCustomApi.getNamespacedCustomObject.mockResolvedValue({
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          url: 'http://project-error-project.test-namespace.svc.cluster.local',
        },
      })

      const url = await getProjectPodUrl('error-project')

      // Should get cold start URL, not warm pod URL
      expect(url).toBe('http://project-error-project.test-namespace.svc.cluster.local')
      expect(warmPoolController.isAssigned('error-project')).toBe(false)
    })

    test('should handle Kubernetes API errors during pool operations', async () => {
      await warmPoolController.start()

      // Mock API errors
      mockK8sCustomApi.listNamespacedCustomObject.mockRejectedValueOnce(
        new Error('API server unavailable')
      )

      // Should not crash during reconciliation
      await warmPoolController.reconcile()

      const status = warmPoolController.getStatus()
      expect(status.enabled).toBe(true)
    })
  })

  describe('Pool Configuration', () => {
    test('should respect pool size configuration', async () => {
      const customController = new WarmPoolController({
        projectPoolSize: 5,
        agentPoolSize: 3,
        reconcileIntervalMs: 1000,
      } as any)

      mockK8sCustomApi.listNamespacedCustomObject.mockResolvedValue({ items: [] })

      await customController.start()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Should create 5 project + 3 agent = 8 total pods
      expect(mockK8sCustomApi.createNamespacedCustomObject).toHaveBeenCalledTimes(8)

      const projectPods = (mockK8sCustomApi.createNamespacedCustomObject.mock.calls as any[]).filter(
        (call: any) => call[0].body.metadata.labels['shogo.io/warm-pool-type'] === 'project'
      )
      const agentPods = (mockK8sCustomApi.createNamespacedCustomObject.mock.calls as any[]).filter(
        (call: any) => call[0].body.metadata.labels['shogo.io/warm-pool-type'] === 'agent'
      )

      expect(projectPods).toHaveLength(5)
      expect(agentPods).toHaveLength(3)

      customController.stop()
    })

    test('should handle disabled warm pool', async () => {
      process.env.WARM_POOL_ENABLED = 'false'
      const disabledController = new WarmPoolController()

      await disabledController.start()

      const status = disabledController.getStatus()
      expect(status.enabled).toBe(false)

      // Should not create any pods
      expect(mockK8sCustomApi.createNamespacedCustomObject).not.toHaveBeenCalled()

      // Should return null when claiming
      const pod = disabledController.claim()
      expect(pod).toBeNull()
    })
  })
})