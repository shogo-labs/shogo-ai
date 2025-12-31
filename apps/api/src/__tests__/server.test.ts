/**
 * Tests for Better Auth handler mounting in server.ts
 * Task: task-ba-007
 *
 * Tests verify that the Better Auth handler is mounted correctly:
 * - Import auth from ./auth
 * - Route mounted at /api/auth/* for GET and POST methods
 * - Handler calls auth.handler(c.req.raw)
 * - Route mounted BEFORE other /api/* routes
 */

import { describe, test, expect, beforeAll, mock } from "bun:test"
import { Hono } from "hono"

describe("Better Auth Handler Mounting (task-ba-007)", () => {
  let serverModule: any

  beforeAll(async () => {
    try {
      // Import the server module to verify auth is integrated
      serverModule = await import("../server")
    } catch (error) {
      serverModule = null
    }
  })

  // test-ba-007-01: Auth is imported and handler is mounted
  describe("Auth Handler Import", () => {
    test("server module exports successfully", () => {
      expect(serverModule).not.toBeNull()
      expect(serverModule.default).toBeDefined()
    })
  })

  // test-ba-007-02: Auth routes respond correctly
  describe("Auth Route Mounting", () => {
    test("GET /api/auth/ok returns 200", async () => {
      // Better Auth has a built-in /ok endpoint for health checks
      const server = serverModule.default
      const req = new Request("http://localhost/api/auth/ok", {
        method: "GET",
      })
      const res = await server.fetch(req)
      expect(res.status).toBe(200)
    })

    test("POST /api/auth/sign-up/email returns response (not 404)", async () => {
      // Even without valid data, the route should exist and not return 404
      const server = serverModule.default
      const req = new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "test@example.com",
          password: "testpassword123",
          name: "Test User",
        }),
      })
      const res = await server.fetch(req)
      // Should not be 404 - route exists (may fail for other reasons like DB not connected)
      expect(res.status).not.toBe(404)
    })

    test("GET /api/auth/get-session returns response (not 404)", async () => {
      const server = serverModule.default
      // Better Auth uses /api/auth/get-session endpoint
      const req = new Request("http://localhost/api/auth/get-session", {
        method: "GET",
      })
      const res = await server.fetch(req)
      // Should not be 404 - route exists (may return 401 or other status without valid session)
      expect(res.status).not.toBe(404)
    })

    test("POST /api/auth/sign-in/email returns response (not 404)", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "test@example.com",
          password: "testpassword123",
        }),
      })
      const res = await server.fetch(req)
      // Should not be 404 - route exists
      expect(res.status).not.toBe(404)
    })
  })

  // test-ba-007-03: Auth routes are mounted before other /api/* routes
  describe("Route Order", () => {
    test("health check still works at /api/health", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/health", {
        method: "GET",
      })
      const res = await server.fetch(req)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    })

    test("/api/chat endpoint still accessible", async () => {
      // We just verify the route exists, not that it works
      // (would need proper message format and AI SDK setup)
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      })
      const res = await server.fetch(req)
      // Should not be 404 - route exists
      expect(res.status).not.toBe(404)
    })
  })

  // test-ba-007-04: Auth wildcard route correctly handles subpaths
  describe("Auth Wildcard Routing", () => {
    test("nested auth paths are handled", async () => {
      const server = serverModule.default
      // Test a nested path that Better Auth should handle
      const req = new Request("http://localhost/api/auth/callback/google", {
        method: "GET",
      })
      const res = await server.fetch(req)
      // Should not be 404 - route should be matched by wildcard
      expect(res.status).not.toBe(404)
    })
  })
})
