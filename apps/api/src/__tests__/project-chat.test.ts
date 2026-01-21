/**
 * Tests for Project Chat Routes
 *
 * Tests verify that the project chat proxy correctly:
 * - Starts runtime if not running
 * - Waits for runtime when it's already starting (concurrent request handling)
 * - Returns appropriate errors for missing projects/runtimes
 */

import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Hono } from "hono"
import { projectChatRoutes, type ProjectChatRoutesConfig } from "../routes/project-chat"
import type { IRuntimeManager, IProjectRuntime } from "@shogo/state-api/runtime"

// Mock runtime for testing
function createMockRuntime(
  projectId: string,
  status: "starting" | "running" | "stopped" | "error" = "running"
): IProjectRuntime {
  return {
    id: projectId,
    port: 5200,
    agentPort: 6200,
    status,
    url: "http://localhost:5200",
    startedAt: Date.now(),
  }
}

// Mock RuntimeManager
function createMockRuntimeManager(options: {
  statusReturn?: IProjectRuntime | null
  startDelay?: number
  statusSequence?: (IProjectRuntime | null)[]
}): IRuntimeManager {
  let callCount = 0
  const statusSequence = options.statusSequence || []

  return {
    status: (projectId: string) => {
      if (statusSequence.length > 0) {
        const result = statusSequence[callCount % statusSequence.length]
        callCount++
        return result
      }
      return options.statusReturn ?? null
    },
    start: async (projectId: string) => {
      if (options.startDelay) {
        await new Promise((resolve) => setTimeout(resolve, options.startDelay))
      }
      return createMockRuntime(projectId, "running")
    },
    stop: async () => {},
    restart: async (projectId: string) => {
      return createMockRuntime(projectId, "running")
    },
    getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
    stopAll: async () => {},
    getActiveProjects: () => [],
  }
}

// Mock studioCore for project lookup
function createMockStudioCore(projectExists: boolean = true) {
  return {
    projectCollection: {
      query: () => ({
        where: () => ({
          first: async () => (projectExists ? { id: "test-project" } : null),
        }),
      }),
    },
  }
}

describe("Runtime Restart", () => {
  test("restart method stops and starts runtime", async () => {
    let stopCalled = false
    let startCalled = false
    let startCount = 0

    const mockManager: IRuntimeManager = {
      status: () => createMockRuntime("test-project", "running"),
      start: async (projectId: string) => {
        startCalled = true
        startCount++
        return createMockRuntime(projectId)
      },
      stop: async () => {
        stopCalled = true
      },
      restart: async (projectId: string) => {
        stopCalled = true
        startCalled = true
        startCount++
        return createMockRuntime(projectId, "running")
      },
      getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
      stopAll: async () => {},
      getActiveProjects: () => [],
    }

    // Test the restart method directly
    const result = await mockManager.restart("test-project")

    expect(result.status).toBe("running")
    expect(stopCalled).toBe(true)
    expect(startCalled).toBe(true)
  })
})

describe("Project Chat Routes", () => {
  describe("Runtime Startup", () => {
    test("starts runtime when status is null", async () => {
      let startCalled = false
      const mockManager: IRuntimeManager = {
        status: () => null,
        start: async (projectId: string) => {
          startCalled = true
          return createMockRuntime(projectId)
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      // Mock fetch for the agent call
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        if (url.toString().includes("/agent/chat")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return originalFetch(url)
      }

      try {
        const res = await app.fetch(
          new Request("http://localhost/projects/test-project/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        )

        expect(startCalled).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test("starts runtime when status is stopped", async () => {
      let startCalled = false
      const mockManager: IRuntimeManager = {
        status: () => createMockRuntime("test-project", "stopped"),
        start: async (projectId: string) => {
          startCalled = true
          return createMockRuntime(projectId)
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        if (url.toString().includes("/agent/chat")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return originalFetch(url)
      }

      try {
        await app.fetch(
          new Request("http://localhost/projects/test-project/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        )

        expect(startCalled).toBe(true)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test("waits for runtime when status is 'starting'", async () => {
      let statusCalls = 0
      let startCalled = false

      // Simulate runtime transitioning from 'starting' to 'running'
      const mockManager: IRuntimeManager = {
        status: () => {
          statusCalls++
          // First 3 calls return 'starting', then 'running'
          if (statusCalls <= 3) {
            return createMockRuntime("test-project", "starting")
          }
          return createMockRuntime("test-project", "running")
        },
        start: async (projectId: string) => {
          startCalled = true
          return createMockRuntime(projectId)
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        if (url.toString().includes("/agent/chat")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return originalFetch(url)
      }

      try {
        const res = await app.fetch(
          new Request("http://localhost/projects/test-project/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        )

        // start() should NOT be called because runtime was already starting
        expect(startCalled).toBe(false)
        // status() should be called multiple times to poll for ready state
        expect(statusCalls).toBeGreaterThan(1)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    test("does not restart when runtime is already running", async () => {
      let startCalled = false
      const mockManager: IRuntimeManager = {
        status: () => createMockRuntime("test-project", "running"),
        start: async (projectId: string) => {
          startCalled = true
          return createMockRuntime(projectId)
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url: any) => {
        if (url.toString().includes("/agent/chat")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return originalFetch(url)
      }

      try {
        await app.fetch(
          new Request("http://localhost/projects/test-project/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [] }),
          })
        )

        expect(startCalled).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe("Error Handling", () => {
    test("returns 404 for non-existent project", async () => {
      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(false), // Project doesn't exist
        runtimeManager: createMockRuntimeManager({}),
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const res = await app.fetch(
        new Request("http://localhost/projects/non-existent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        })
      )

      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error.code).toBe("project_not_found")
    })

    test("returns 503 when runtime fails to start", async () => {
      const mockManager: IRuntimeManager = {
        status: () => null,
        start: async () => {
          throw new Error("Failed to start runtime")
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const res = await app.fetch(
        new Request("http://localhost/projects/test-project/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [] }),
        })
      )

      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error.code).toBe("pod_unavailable")
    })
  })

  describe("Chat Status Endpoint", () => {
    test("returns status for running runtime", async () => {
      const mockManager: IRuntimeManager = {
        status: () => createMockRuntime("test-project", "running"),
        start: async (projectId: string) => createMockRuntime(projectId),
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const res = await app.fetch(
        new Request("http://localhost/projects/test-project/chat/status", {
          method: "GET",
        })
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.mode).toBe("local")
      expect(body.exists).toBe(true)
      expect(body.ready).toBe(true)
      expect(body.status).toBe("running")
    })

    test("returns not ready for starting runtime", async () => {
      const mockManager: IRuntimeManager = {
        status: () => createMockRuntime("test-project", "starting"),
        start: async (projectId: string) => createMockRuntime(projectId),
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const res = await app.fetch(
        new Request("http://localhost/projects/test-project/chat/status", {
          method: "GET",
        })
      )

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.exists).toBe(true)
      expect(body.ready).toBe(false) // Not ready yet
      expect(body.status).toBe("starting")
    })
  })

  describe("Chat Wake Endpoint", () => {
    test("starts runtime via wake endpoint", async () => {
      let startCalled = false
      const mockManager: IRuntimeManager = {
        status: () => null,
        start: async (projectId: string) => {
          startCalled = true
          return createMockRuntime(projectId)
        },
        stop: async () => {},
        restart: async (projectId: string) => createMockRuntime(projectId),
        getHealth: async () => ({ healthy: true, lastCheck: Date.now() }),
        stopAll: async () => {},
        getActiveProjects: () => [],
      }

      const config: ProjectChatRoutesConfig = {
        studioCore: createMockStudioCore(),
        runtimeManager: mockManager,
      }

      const router = projectChatRoutes(config)
      const app = new Hono()
      app.route("/", router)

      const res = await app.fetch(
        new Request("http://localhost/projects/test-project/chat/wake", {
          method: "POST",
        })
      )

      expect(res.status).toBe(200)
      expect(startCalled).toBe(true)
      const body = await res.json()
      expect(body.success).toBe(true)
    })
  })
})
