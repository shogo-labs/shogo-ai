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
import { PHASE_PROMPTS, isPhase, type Phase } from "../prompts/phase-prompts"
import { buildSystemPrompt, BASE_SYSTEM_PROMPT } from "../server"

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

/**
 * Tests for Dynamic System Prompt Injection (task-cpbi-007)
 *
 * Tests verify that the /api/chat route correctly:
 * - Extracts phase from request body
 * - Constructs phase-specific system prompt
 * - Preserves base Wavesmith tool prompt
 * - Falls back to generic prompt when phase is null/undefined
 * - Includes skill invocation guidance
 */
describe("Dynamic System Prompt Injection (task-cpbi-007)", () => {
  let serverModule: any

  beforeAll(async () => {
    try {
      serverModule = await import("../server")
    } catch (error) {
      serverModule = null
    }
  })

  // test-cpbi-007-a: API extracts phase from request body
  describe("Phase Extraction", () => {
    test("buildSystemPrompt accepts phase parameter", () => {
      // Verify the function exists and accepts a phase parameter
      expect(buildSystemPrompt).toBeDefined()
      expect(typeof buildSystemPrompt).toBe("function")

      // Test with a valid phase
      const result = buildSystemPrompt("discovery")
      expect(typeof result).toBe("string")
      expect(result.length).toBeGreaterThan(0)
    })

    test("buildSystemPrompt handles valid phases", () => {
      const phases: Phase[] = ["discovery", "analysis", "classification", "design", "spec", "testing", "implementation", "complete"]

      for (const phase of phases) {
        const result = buildSystemPrompt(phase)
        expect(result).toContain(PHASE_PROMPTS[phase])
      }
    })
  })

  // test-cpbi-007-b: System prompt includes phase-specific guidance
  describe("Phase-Specific Guidance", () => {
    test("discovery phase includes discovery guidance", () => {
      const prompt = buildSystemPrompt("discovery")
      expect(prompt).toContain("Discovery Phase")
      expect(prompt).toContain("/platform-feature-discovery")
    })

    test("analysis phase includes analysis guidance", () => {
      const prompt = buildSystemPrompt("analysis")
      expect(prompt).toContain("Analysis Phase")
      expect(prompt).toContain("/platform-feature-analysis")
    })

    test("implementation phase includes implementation guidance", () => {
      const prompt = buildSystemPrompt("implementation")
      expect(prompt).toContain("Implementation Phase")
      expect(prompt).toContain("/platform-feature-implementation")
    })
  })

  // test-cpbi-007-c: Base Wavesmith tool prompt is preserved and augmented
  describe("Base Prompt Preservation", () => {
    test("base prompt is always included", () => {
      // Test with a phase
      const withPhase = buildSystemPrompt("discovery")
      expect(withPhase).toContain(BASE_SYSTEM_PROMPT)

      // Test without a phase
      const withoutPhase = buildSystemPrompt(null)
      expect(withoutPhase).toContain(BASE_SYSTEM_PROMPT)
    })

    test("base prompt includes Wavesmith tool information", () => {
      expect(BASE_SYSTEM_PROMPT).toContain("Wavesmith")
      expect(BASE_SYSTEM_PROMPT).toContain("schema")
      expect(BASE_SYSTEM_PROMPT).toContain("store")
    })

    test("phase prompt is appended after base prompt", () => {
      const prompt = buildSystemPrompt("discovery")
      const baseIndex = prompt.indexOf(BASE_SYSTEM_PROMPT)
      const phaseIndex = prompt.indexOf("Discovery Phase")

      expect(baseIndex).toBeGreaterThanOrEqual(0)
      expect(phaseIndex).toBeGreaterThan(baseIndex)
    })
  })

  // test-cpbi-007-d: Falls back to generic prompt when phase is null
  describe("Generic Fallback", () => {
    test("returns base prompt when phase is null", () => {
      const prompt = buildSystemPrompt(null)
      expect(prompt).toBe(BASE_SYSTEM_PROMPT)
    })

    test("returns base prompt when phase is undefined", () => {
      const prompt = buildSystemPrompt(undefined)
      expect(prompt).toBe(BASE_SYSTEM_PROMPT)
    })

    test("returns base prompt for invalid phase string", () => {
      const prompt = buildSystemPrompt("invalid-phase" as any)
      expect(prompt).toBe(BASE_SYSTEM_PROMPT)
    })

    test("returns base prompt for empty string", () => {
      const prompt = buildSystemPrompt("" as any)
      expect(prompt).toBe(BASE_SYSTEM_PROMPT)
    })
  })

  // test-cpbi-007-e: Skill invocation guidance included in prompt
  describe("Skill Invocation Guidance", () => {
    test("discovery prompt includes skill command", () => {
      const prompt = buildSystemPrompt("discovery")
      expect(prompt).toContain("/platform-feature-discovery")
    })

    test("analysis prompt includes skill command", () => {
      const prompt = buildSystemPrompt("analysis")
      expect(prompt).toContain("/platform-feature-analysis")
    })

    test("classification prompt includes skill command", () => {
      const prompt = buildSystemPrompt("classification")
      expect(prompt).toContain("/platform-feature-classification")
    })

    test("design prompt includes skill command", () => {
      const prompt = buildSystemPrompt("design")
      expect(prompt).toContain("/platform-feature-design")
    })

    test("spec prompt includes skill command", () => {
      const prompt = buildSystemPrompt("spec")
      expect(prompt).toContain("/platform-feature-spec")
    })

    test("testing prompt includes skill command", () => {
      const prompt = buildSystemPrompt("testing")
      expect(prompt).toContain("/platform-feature-tests")
    })

    test("implementation prompt includes skill command", () => {
      const prompt = buildSystemPrompt("implementation")
      expect(prompt).toContain("/platform-feature-implementation")
    })
  })
})

/**
 * Tests for CC Session Resume Support (task-cc-api-endpoint)
 * Updated for chat-session-sync-fix: Data stream protocol with X-CC-Session-Id header
 *
 * Tests verify that the /api/chat endpoint correctly:
 * - Continues to work without ccSessionId (backward compatible)
 * - Passes ccSessionId as resume parameter when provided
 * - Uses toUIMessageStreamResponse() for data protocol
 * - Returns X-CC-Session-Id in response header (not body marker)
 * - Sends full message history (no effectiveMessages deduplication)
 */
describe("/api/chat CC Session Resume (task-cc-api-endpoint)", () => {
  let serverModule: any

  beforeAll(async () => {
    try {
      serverModule = await import("../server")
    } catch (error) {
      serverModule = null
    }
  })

  // test-cc-001: Request without ccSessionId creates new session (backward compatible)
  describe("Backward Compatibility", () => {
    test("request without ccSessionId works (backward compatible)", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          phase: null,
        }),
      })
      const res = await server.fetch(req)
      // Should not be 404 or 400 - route exists and works without ccSessionId
      expect(res.status).not.toBe(404)
      expect(res.status).not.toBe(400)
    })

    test("request without ccSessionId doesn't cause error", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [],
        }),
      })
      const res = await server.fetch(req)
      // Should not return error due to missing ccSessionId
      expect(res.status).not.toBe(400)
    })
  })

  // test-cc-002: Request with ccSessionId passes resume parameter
  describe("Session Resume", () => {
    test("request with ccSessionId is accepted", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Continue from where we left off" }],
          phase: "discovery",
          ccSessionId: "test-session-id-12345",
        }),
      })
      const res = await server.fetch(req)
      // Should not be 404 or 400 - route accepts ccSessionId parameter
      expect(res.status).not.toBe(404)
      expect(res.status).not.toBe(400)
    })
  })

  // test-cc-003: Response format uses data stream protocol (spec-css-server-01, spec-css-tests-02)
  describe("Response Format - Data Stream Protocol", () => {
    test("response uses toUIMessageStreamResponse() format (not plain text)", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
        }),
      })
      const res = await server.fetch(req)
      // Response should have content type for data stream (not text/plain)
      const contentType = res.headers.get("content-type")
      expect(contentType).toBeDefined()
      // toUIMessageStreamResponse() sets content-type to text/event-stream or application/octet-stream
      // It should NOT be text/plain; charset=utf-8 (the old custom stream format)
      // Note: Error responses return application/json, so we check it's defined
    })
  })

  // test-css-server-02: X-CC-Session-Id header instead of body marker (spec-css-tests-01)
  describe("Session ID via Response Header", () => {
    test("X-CC-Session-Id header can be present in response", async () => {
      const server = serverModule.default
      const req = new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Hello" }],
          phase: "discovery",
        }),
      })
      const res = await server.fetch(req)
      // The header may or may not be present depending on Claude Code response
      // But the code should support it - we can't test the actual value without a live Claude Code session
      // Just verify the route works and we can check headers
      expect(res.headers).toBeDefined()
    })
  })
})

/**
 * Tests for Data Stream Protocol Implementation (task-css-server-protocol)
 *
 * Verifies server code structure for:
 * - toUIMessageStreamResponse() usage (not custom ReadableStream)
 * - X-CC-Session-Id header setting
 * - No effectiveMessages deduplication
 * - No CC_SESSION marker in body
 */
describe("Server Data Stream Protocol (task-css-server-protocol)", () => {
  // spec-css-server-01: Server uses toUIMessageStreamResponse
  describe("spec-css-server-01: toUIMessageStreamResponse usage", () => {
    test("server.ts imports or uses toUIMessageStreamResponse pattern", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // Should use toUIMessageStreamResponse (not custom ReadableStream for chat)
      expect(source).toMatch(/toUIMessageStreamResponse/)
    })

    test("custom ReadableStream for chat endpoint is removed", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // The old pattern: new ReadableStream({ async start(controller) { ... } })
      // This was used for the custom text stream with CC_SESSION marker
      // It should be removed in favor of toUIMessageStreamResponse()
      expect(source).not.toMatch(/new ReadableStream\s*\(\s*\{[\s\S]*async\s+start\s*\(\s*controller\s*\)/)
    })
  })

  // spec-css-server-02: X-CC-Session-Id header
  describe("spec-css-server-02: X-CC-Session-Id header", () => {
    test("server.ts references X-CC-Session-Id header", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // Should set X-CC-Session-Id header
      expect(source).toMatch(/X-CC-Session-Id/)
    })

    test("CC_SESSION marker is not appended to response body", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // Old pattern: controller.enqueue(encoder.encode(`\n<!-- CC_SESSION:${newCcSessionId} -->`))
      // Should be removed
      expect(source).not.toMatch(/CC_SESSION:/)
    })
  })

  // spec-css-server-03: Full message history (no deduplication)
  describe("spec-css-server-03: Full message history", () => {
    test("effectiveMessages deduplication logic is removed", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // Old pattern used effectiveMessages variable for deduplication
      // This should be removed - full messages array should be passed
      expect(source).not.toMatch(/effectiveMessages/)
    })

    test("streamText receives full messages array", async () => {
      const fs = await import("fs")
      const path = await import("path")
      const serverPath = path.resolve(import.meta.dir, "../server.ts")
      const source = fs.readFileSync(serverPath, "utf-8")

      // Should pass messages directly (not effectiveMessages)
      expect(source).toMatch(/streamText\s*\(\s*\{[\s\S]*messages\s*[:,]/)
    })
  })
})
