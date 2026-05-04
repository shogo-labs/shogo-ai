// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"
import {
  createApiKeyButton,
  createApiKeySubmitButton,
  expandManualApiKeys,
  makeTestUser,
  signUpAndOnboard,
} from "./helpers"

/**
 * Streaming Relay Latency — E2E Tests
 *
 * Establishes a real WebSocket tunnel to the staging server and measures
 * the end-to-end latency of the SSE → WS → SSE relay for chat and canvas
 * streaming paths.
 *
 * Architecture:
 *   Browser (page.evaluate)
 *     → HTTP request to staging /api/instances/:id/p/agent/chat
 *       → Staging sends tunnel request via WebSocket
 *         → Test-process WS handler generates mock SSE chunks
 *       ← Staging relays chunks as SSE back to browser
 *     ← Browser measures chunk arrival timing
 *
 * Metrics captured:
 *   - Tunnel RTT baseline (ping)
 *   - TTFC: Time to first chunk through the relay
 *   - Inter-chunk jitter (deviation from expected interval)
 *   - Total stream time vs expected minimum
 *   - High-frequency and large-payload relay behaviour
 *
 * Prerequisites:
 *   - Node 22+ or Bun (for global WebSocket)
 *   - Instance tables migrated on target environment
 *
 * Run:
 *   STAGING_URL=https://studio.staging.shogo.ai \
 *     npx playwright test --config e2e/playwright.config.ts streaming-latency
 */

const API_BASE =
  process.env.E2E_API_URL ||
  process.env.STAGING_API_URL ||
  process.env.E2E_TARGET_URL ||
  process.env.STAGING_URL ||
  "http://localhost:8081"

const WS_BASE = API_BASE.replace(/^http/, "ws")

const TEST_USER = makeTestUser("StreamLat")

const STREAM_TEST_TIMEOUT = 60_000

test.describe("Streaming Relay Latency — E2E", () => {
  test.describe.configure({ mode: "serial" })

  let page: Page
  let request: APIRequestContext
  let workspaceId: string
  let apiKey: string
  let instanceId: string
  let tunnelWs: WebSocket | null = null

  // ─── Tunnel protocol handler ─────────────────────────────────────────────
  //
  // Simulates a local agent: responds to non-streaming requests immediately,
  // and generates SSE chunks at configurable intervals for streaming requests.

  interface StreamConfig {
    numChunks: number
    intervalMs: number
    chunkSize: number
  }

  let streamConfig: StreamConfig = { numChunks: 10, intervalMs: 100, chunkSize: 50 }
  const activeTimers: ReturnType<typeof setInterval>[] = []

  function handleTunnelMessage(ws: WebSocket, raw: string) {
    let msg: any
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }))
      return
    }

    if (msg.type !== "request") return

    if (msg.stream) {
      let sent = 0
      const { numChunks, intervalMs, chunkSize } = streamConfig
      const payload = "x".repeat(chunkSize)

      const timer = setInterval(() => {
        if (sent >= numChunks || ws.readyState !== WebSocket.OPEN) {
          clearInterval(timer)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "stream-end", requestId: msg.requestId }))
          }
          return
        }
        ws.send(
          JSON.stringify({
            type: "stream-chunk",
            requestId: msg.requestId,
            data: `data: {"seq":${sent},"ts":${Date.now()},"p":"${payload}"}\n\n`,
          }),
        )
        sent++
      }, intervalMs)
      activeTimers.push(timer)
    } else {
      ws.send(
        JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, path: msg.path, ts: Date.now() }),
        }),
      )
    }
  }

  // ─── Setup ──────────────────────────────────────────────────────────────

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
    request = page.request
    await signUpAndOnboard(page, TEST_USER)
  })

  test.afterAll(async () => {
    for (const t of activeTimers) clearInterval(t)
    activeTimers.length = 0
    if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
      tunnelWs.close(1000, "Test complete")
    }
    tunnelWs = null
    await page.close()
  })

  // =========================================================================
  // 0. Prerequisites — API key, instance, and WebSocket tunnel
  // =========================================================================

  test("0a — create API key for tunnel auth", async () => {
    await page.goto("/api-keys")
    await page.waitForSelector("text=API Keys", { timeout: 15_000 })
    await page
      .waitForSelector("text=Loading API keys...", { state: "hidden", timeout: 15_000 })
      .catch(() => {})
    await page.waitForTimeout(500)

    // v1.5.0: "Create Key" lives behind the "Manual API keys" accordion on /api-keys
    await expandManualApiKeys(page)

    const createBtn = createApiKeyButton(page)
    await createBtn.waitFor({ state: "visible", timeout: 10_000 })
    await createBtn.click()

    await page.waitForSelector("text=Create API Key", { timeout: 5_000 })
    const modal = page.getByRole("dialog", { name: "Create API Key" })
    await modal.waitFor({ state: "visible", timeout: 5_000 })
    await createApiKeySubmitButton(page).click()

    await page.waitForSelector("text=API Key Created", { timeout: 15_000 })
    const createdDialog = page.getByRole("dialog", { name: "API Key Created" })
    const keyElement = createdDialog.locator("text=shogo_sk_").last()
    await keyElement.waitFor({ state: "visible", timeout: 5_000 })
    const keyText = await keyElement.textContent()
    expect(keyText).toMatch(/^shogo_sk_/)
    apiKey = keyText!.trim()

    await createdDialog.getByText("Done").click()
    await page.waitForTimeout(500)
  })

  test("0b — resolve workspace ID", async () => {
    const res = await request.post(`${API_BASE}/api/api-keys/validate`, {
      data: { key: apiKey },
    })
    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    expect(body.valid).toBe(true)
    workspaceId = body.workspace.id
  })

  test("0c — register instance via heartbeat", async () => {
    const res = await request.post(`${API_BASE}/api/instances/heartbeat`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      data: {
        hostname: "e2e-stream-bench",
        name: "E2E Stream Bench",
        os: "darwin",
        arch: "arm64",
      },
    })

    if (res.status() === 500) {
      const body = await res.json()
      if (body?.error?.message?.includes("does not exist")) {
        test.skip(true, "Instance table not yet migrated")
        return
      }
    }

    expect(res.ok()).toBeTruthy()
    const body = await res.json()
    instanceId = body.instanceId
  })

  test("0d — request-connect to trigger WS flag", async () => {
    const res = await request.post(
      `${API_BASE}/api/instances/${instanceId}/request-connect`,
      { headers: { "Content-Type": "application/json" } },
    )
    expect(res.ok()).toBeTruthy()
  })

  test("0e — establish WebSocket tunnel", async () => {
    test.setTimeout(30_000)

    if (typeof globalThis.WebSocket === "undefined") {
      test.skip(true, "WebSocket not available (requires Node 22+ or Bun)")
      return
    }

    const wsUrl =
      `${WS_BASE}/api/instances/ws` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&hostname=e2e-stream-bench&os=darwin&arch=arm64` +
      `&name=${encodeURIComponent("E2E Stream Bench")}`

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket connect timeout (15 s)")),
        15_000,
      )

      tunnelWs = new WebSocket(wsUrl)

      tunnelWs.onopen = () => {
        clearTimeout(timeout)
        resolve()
      }

      tunnelWs.onmessage = (event) => {
        handleTunnelMessage(
          tunnelWs!,
          typeof event.data === "string" ? event.data : event.data.toString(),
        )
      }

      tunnelWs.onerror = (event) => {
        clearTimeout(timeout)
        reject(new Error(`WebSocket error: ${(event as any).message || "unknown"}`))
      }

      tunnelWs.onclose = () => {}
    })
  })

  test("0f — verify instance is online via tunnel", async () => {
    let online = false
    for (let attempt = 0; attempt < 15; attempt++) {
      const res = await request.get(`${API_BASE}/api/instances/${instanceId}`)
      if (res.ok()) {
        const body = await res.json()
        if (body.status === "online") { online = true; break }
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
    expect(online).toBe(true)
  })

  // =========================================================================
  // 1. Baseline — tunnel round-trip time
  // =========================================================================

  test("1a — tunnel RTT baseline via /ping", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    const runs = 5
    const rtts: number[] = []

    for (let i = 0; i < runs; i++) {
      const res = await request.post(
        `${API_BASE}/api/instances/${instanceId}/ping`,
        { headers: { "Content-Type": "application/json" } },
      )
      expect(res.ok()).toBeTruthy()
      const body = await res.json()
      expect(body.ok).toBe(true)
      rtts.push(body.rttMs)
    }

    const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length

    test.info().annotations.push({
      type: "tunnel_rtt",
      description:
        `Tunnel RTT (${runs} runs): avg=${avg.toFixed(0)}ms ` +
        `min=${Math.min(...rtts)}ms max=${Math.max(...rtts)}ms`,
    })

    expect(avg).toBeLessThan(5_000)
  })

  // =========================================================================
  // 2. POST /agent/chat streaming
  // =========================================================================

  test("2a — chat stream: TTFC and total time", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    streamConfig = { numChunks: 10, intervalMs: 100, chunkSize: 50 }

    await page.goto("/")
    await page.waitForSelector("text=What's on your mind", { timeout: 30_000 })

    const metrics: any = await page.evaluate(
      async ({ id }) => {
        const start = performance.now()
        const res = await fetch(`/api/instances/${id}/p/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "stream-latency-test" }),
        })
        if (!res.ok) return { error: res.status, statusText: res.statusText }

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const arrivals: number[] = []
        let totalData = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          arrivals.push(performance.now() - start)
          totalData += decoder.decode(value, { stream: true })
        }

        return {
          ttfcMs: arrivals[0] ?? -1,
          totalMs: performance.now() - start,
          chunkCount: arrivals.length,
          arrivals,
          dataLength: totalData.length,
        }
      },
      { id: instanceId },
    )

    expect(metrics).not.toHaveProperty("error")
    expect(metrics.chunkCount).toBeGreaterThanOrEqual(1)
    expect(metrics.ttfcMs).toBeGreaterThan(0)

    const expectedMinMs = (streamConfig.numChunks - 1) * streamConfig.intervalMs
    const overheadMs = metrics.totalMs - expectedMinMs

    test.info().annotations.push({
      type: "chat_stream",
      description: [
        `POST /agent/chat stream:`,
        `  TTFC: ${metrics.ttfcMs.toFixed(0)}ms`,
        `  Total: ${metrics.totalMs.toFixed(0)}ms (expected min ${expectedMinMs}ms)`,
        `  Relay overhead: ${overheadMs.toFixed(0)}ms`,
        `  Chunks: ${metrics.chunkCount}, Data: ${metrics.dataLength}B`,
      ].join("\n"),
    })

    expect(metrics.ttfcMs).toBeLessThan(10_000)
  })

  test("2b — chat stream: inter-chunk jitter", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    streamConfig = { numChunks: 20, intervalMs: 50, chunkSize: 100 }

    const metrics: any = await page.evaluate(
      async ({ id }) => {
        const start = performance.now()
        const res = await fetch(`/api/instances/${id}/p/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "jitter-test" }),
        })
        if (!res.ok) return { error: res.status }

        const reader = res.body!.getReader()
        const arrivals: number[] = []
        while (true) {
          const { done } = await reader.read()
          if (done) break
          arrivals.push(performance.now() - start)
        }

        const intervals: number[] = []
        for (let i = 1; i < arrivals.length; i++) {
          intervals.push(arrivals[i] - arrivals[i - 1])
        }
        const avg = intervals.length
          ? intervals.reduce((a, b) => a + b, 0) / intervals.length
          : 0
        const sorted = [...intervals].sort((a, b) => a - b)

        return {
          chunkCount: arrivals.length,
          avgIntervalMs: avg,
          p50IntervalMs: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
          p95IntervalMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          maxJitterMs: Math.max(...intervals.map((i) => Math.abs(i - avg)), 0),
        }
      },
      { id: instanceId },
    )

    expect(metrics).not.toHaveProperty("error")

    test.info().annotations.push({
      type: "jitter",
      description: [
        `Inter-chunk jitter (${metrics.chunkCount} chunks, target ${streamConfig.intervalMs}ms):`,
        `  Avg: ${metrics.avgIntervalMs.toFixed(1)}ms  P50: ${metrics.p50IntervalMs.toFixed(1)}ms`,
        `  P95: ${metrics.p95IntervalMs.toFixed(1)}ms  Max jitter: ${metrics.maxJitterMs.toFixed(1)}ms`,
      ].join("\n"),
    })
  })

  // =========================================================================
  // 3. GET /agent/canvas/stream
  // =========================================================================

  test("3a — canvas stream: TTFC and total time", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    streamConfig = { numChunks: 8, intervalMs: 200, chunkSize: 200 }

    const metrics: any = await page.evaluate(
      async ({ id }) => {
        const start = performance.now()
        const res = await fetch(`/api/instances/${id}/p/agent/canvas/stream`)
        if (!res.ok) return { error: res.status }

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const arrivals: number[] = []
        let totalData = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          arrivals.push(performance.now() - start)
          totalData += decoder.decode(value, { stream: true })
        }

        return {
          ttfcMs: arrivals[0] ?? -1,
          totalMs: performance.now() - start,
          chunkCount: arrivals.length,
          dataLength: totalData.length,
        }
      },
      { id: instanceId },
    )

    expect(metrics).not.toHaveProperty("error")
    expect(metrics.chunkCount).toBeGreaterThanOrEqual(1)

    const expectedMinMs = (streamConfig.numChunks - 1) * streamConfig.intervalMs

    test.info().annotations.push({
      type: "canvas_stream",
      description: [
        `GET /agent/canvas/stream:`,
        `  TTFC: ${metrics.ttfcMs.toFixed(0)}ms`,
        `  Total: ${metrics.totalMs.toFixed(0)}ms (expected min ${expectedMinMs}ms)`,
        `  Overhead: ${(metrics.totalMs - expectedMinMs).toFixed(0)}ms`,
        `  Chunks: ${metrics.chunkCount}, Data: ${metrics.dataLength}B`,
      ].join("\n"),
    })

    expect(metrics.ttfcMs).toBeLessThan(10_000)
  })

  // =========================================================================
  // 4. Stress tests
  // =========================================================================

  test("4a — high-frequency streaming (50 chunks at 20ms)", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    streamConfig = { numChunks: 50, intervalMs: 20, chunkSize: 80 }

    const metrics: any = await page.evaluate(
      async ({ id }) => {
        const start = performance.now()
        const res = await fetch(`/api/instances/${id}/p/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "high-freq" }),
        })
        if (!res.ok) return { error: res.status }

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let chunkCount = 0
        let totalData = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunkCount++
          totalData += decoder.decode(value, { stream: true })
        }

        return {
          chunkCount,
          sseEvents: (totalData.match(/data: /g) || []).length,
          totalMs: performance.now() - start,
          dataLength: totalData.length,
        }
      },
      { id: instanceId },
    )

    expect(metrics).not.toHaveProperty("error")
    expect(metrics.sseEvents).toBe(streamConfig.numChunks)

    test.info().annotations.push({
      type: "high_freq",
      description: [
        `High-frequency (${streamConfig.numChunks} @ ${streamConfig.intervalMs}ms):`,
        `  HTTP chunks: ${metrics.chunkCount}, SSE events: ${metrics.sseEvents}`,
        `  Total: ${metrics.totalMs.toFixed(0)}ms, Data: ${metrics.dataLength}B`,
      ].join("\n"),
    })
  })

  test("4b — large payload streaming (10KB chunks)", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT)
    streamConfig = { numChunks: 5, intervalMs: 100, chunkSize: 10_000 }

    const metrics: any = await page.evaluate(
      async ({ id }) => {
        const start = performance.now()
        const res = await fetch(`/api/instances/${id}/p/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "large-payload" }),
        })
        if (!res.ok) return { error: res.status }

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let chunkCount = 0
        let totalData = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunkCount++
          totalData += decoder.decode(value, { stream: true })
        }

        return {
          chunkCount,
          totalMs: performance.now() - start,
          dataLength: totalData.length,
        }
      },
      { id: instanceId },
    )

    expect(metrics).not.toHaveProperty("error")
    expect(metrics.dataLength).toBeGreaterThan(40_000)

    test.info().annotations.push({
      type: "large_payload",
      description: [
        `Large payload (${streamConfig.numChunks} × ${(streamConfig.chunkSize / 1024).toFixed(0)}KB):`,
        `  HTTP chunks: ${metrics.chunkCount}`,
        `  Total: ${metrics.totalMs.toFixed(0)}ms, Data: ${(metrics.dataLength / 1024).toFixed(1)}KB`,
      ].join("\n"),
    })
  })

  // =========================================================================
  // 5. Multi-run summary
  // =========================================================================

  test("5a — multi-run TTFC measurement (3 runs)", async () => {
    test.setTimeout(STREAM_TEST_TIMEOUT * 3)
    streamConfig = { numChunks: 10, intervalMs: 100, chunkSize: 50 }

    const ttfcs: number[] = []
    const totals: number[] = []

    for (let run = 0; run < 3; run++) {
      const m: any = await page.evaluate(
        async ({ id }) => {
          const start = performance.now()
          const res = await fetch(`/api/instances/${id}/p/agent/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: `run-${Date.now()}` }),
          })
          if (!res.ok) return { error: res.status }

          const reader = res.body!.getReader()
          let ttfc = -1
          while (true) {
            const { done } = await reader.read()
            if (done) break
            if (ttfc < 0) ttfc = performance.now() - start
          }
          return { ttfcMs: ttfc, totalMs: performance.now() - start }
        },
        { id: instanceId },
      )

      if (!("error" in m)) {
        ttfcs.push(m.ttfcMs)
        totals.push(m.totalMs)
      }
    }

    expect(ttfcs.length).toBeGreaterThan(0)

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const sorted = [...ttfcs].sort((a, b) => a - b)

    test.info().annotations.push({
      type: "summary",
      description: [
        "=== STREAMING RELAY LATENCY SUMMARY ===",
        `Runs: ${ttfcs.length}`,
        `TTFC — avg: ${avg(ttfcs).toFixed(0)}ms, min: ${sorted[0].toFixed(0)}ms, max: ${sorted[sorted.length - 1].toFixed(0)}ms`,
        `Total — avg: ${avg(totals).toFixed(0)}ms`,
        `Config: ${streamConfig.numChunks} chunks × ${streamConfig.intervalMs}ms`,
      ].join("\n"),
    })
  })

  // =========================================================================
  // Cleanup
  // =========================================================================

  test("9 — cleanup: close tunnel and delete instance", async () => {
    for (const t of activeTimers) clearInterval(t)
    activeTimers.length = 0

    if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
      tunnelWs.close(1000, "Test complete")
    }
    tunnelWs = null

    if (instanceId) {
      const res = await request.delete(
        `${API_BASE}/api/instances/${instanceId}`,
        { headers: { "Content-Type": "application/json" } },
      )
      if (res.ok()) {
        const body = await res.json()
        expect(body.ok).toBe(true)
      }
    }
  })
})
