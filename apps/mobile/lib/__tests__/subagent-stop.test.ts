// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for subagent cancellation entrypoint.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { configureSubagentStop, stopSubagent } from "../subagent-stop"
import { subagentStreamStore } from "../subagent-stream-store"

const API_BASE = "https://api.example.com"

describe("stopSubagent", () => {
  beforeEach(() => {
    subagentStreamStore.clear()
    configureSubagentStop(null)
  })

  afterEach(() => {
    subagentStreamStore.clear()
    configureSubagentStop(null)
  })

  test("returns immediately when instanceId is empty", () => {
    const fetchCalls: string[] = []
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      projectId: "proj-1",
      fetchFn: () => {
        fetchCalls.push("called")
        return Promise.resolve(new Response())
      },
    })
    stopSubagent("")
    expect(fetchCalls).toHaveLength(0)
  })

  test("does nothing when config is not set", () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]))
    }
    try {
      stopSubagent("inst-1")
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((w) => w.includes("[subagent-stop]"))).toBe(true)
  })

  test("POSTs to project chat subagent stop URL on web", async () => {
    let capturedUrl = ""
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      projectId: "proj-123",
      fetchFn: (url, init) => {
        capturedUrl = String(url)
        expect(init?.method).toBe("POST")
        return Promise.resolve(new Response(null, { status: 204 }))
      },
    })
    await stopSubagent("inst-abc")
    expect(capturedUrl).toBe(`${API_BASE}/api/projects/proj-123/chat/subagents/inst-abc/stop`)
  })

  test("uses local agent URL when configured", async () => {
    let capturedUrl = ""
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      localAgentUrl: "http://127.0.0.1:9000",
      projectId: "proj-ignored",
      fetchFn: (url) => {
        capturedUrl = String(url)
        return Promise.resolve(new Response())
      },
    })
    await stopSubagent("inst-1")
    expect(capturedUrl).toBe("http://127.0.0.1:9000/agent/subagents/inst-1/stop")
  })

  test("skips fetch when stop request cannot be built", () => {
    let called = false
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      fetchFn: () => {
        called = true
        return Promise.resolve(new Response())
      },
    })
    stopSubagent("inst-1")
    expect(called).toBe(false)
  })

  test("optimistically marks stream completed when toolId provided", async () => {
    subagentStreamStore.init("tool-1", {
      agentId: "a1",
      agentType: "task",
      description: "run",
      status: "running",
    })
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      projectId: "proj-1",
      fetchFn: () => Promise.resolve(new Response()),
    })
    await stopSubagent("inst-1", "tool-1")
    expect(subagentStreamStore.get("tool-1")!.status).toBe("completed")
  })

  test("swallows fetch errors after logging", async () => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]))
    }
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      projectId: "proj-1",
      fetchFn: () => Promise.reject(new Error("network down")),
    })
    try {
      await stopSubagent("inst-1")
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((w) => w.includes("Failed to cancel subagent"))).toBe(true)
  })
})

describe("configureSubagentStop", () => {
  afterEach(() => configureSubagentStop(null))

  test("allows replacing config", async () => {
    let first = false
    configureSubagentStop({
      apiBaseUrl: API_BASE,
      platform: "web",
      projectId: "proj-1",
      fetchFn: () => {
        first = true
        return Promise.resolve(new Response())
      },
    })
    await stopSubagent("inst-1")
    expect(first).toBe(true)

    configureSubagentStop(null)
    first = false
    stopSubagent("inst-1")
    expect(first).toBe(false)
  })
})
