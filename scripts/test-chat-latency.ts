#!/usr/bin/env bun
/**
 * Chat Latency Test Script
 * 
 * Measures time-to-first-token (TTFT) and identifies latency bottlenecks.
 * 
 * Tests 3 layers:
 *   1. Direct Anthropic API (baseline — how fast can Claude respond?)
 *   2. Platform chat /api/chat (your API server → Claude Code SDK → Anthropic)
 *   3. Project chat /api/projects/:id/chat (API → project pod → Anthropic)
 * 
 * Usage:
 *   bun run scripts/test-chat-latency.ts                          # Full test suite
 *   bun run scripts/test-chat-latency.ts --project <projectId>    # Include project chat
 *   bun run scripts/test-chat-latency.ts --runs 5                 # Run 5 iterations each
 *   bun run scripts/test-chat-latency.ts --anthropic-only         # Only test Anthropic API
 *   bun run scripts/test-chat-latency.ts --chat-only              # Only test /api/chat
 *   bun run scripts/test-chat-latency.ts --verbose                # Show SSE events
 */

import { spawn } from "child_process"

const API_BASE = process.env.API_URL || "http://localhost:8002"
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ""

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}
const hasFlag = (flag: string) => args.includes(flag)

const projectId = getArg("--project")
const runs = parseInt(getArg("--runs") || "3", 10)
const anthropicOnly = hasFlag("--anthropic-only")
const chatOnly = hasFlag("--chat-only")
const verbose = hasFlag("--verbose")
const message = getArg("--message") || "Say hello in exactly one sentence."

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function printHeader(title: string) {
  console.log("\n" + "=".repeat(70))
  console.log(`  ${title}`)
  console.log("=".repeat(70))
}

function printMetric(label: string, value: string, indent = 2) {
  console.log(`${" ".repeat(indent)}${label.padEnd(40)} ${value}`)
}

interface TimingResult {
  label: string
  run: number
  ttfb: number        // Time to first byte (headers received)
  ttft: number        // Time to first text token
  totalTime: number   // Total stream time
  status: number
  textPreview: string
  error?: string
}

// ---------------------------------------------------------------------------
// Test 1: Direct Anthropic API (baseline)
// ---------------------------------------------------------------------------
function testAnthropicDirect(runNum: number): Promise<TimingResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: message }],
    })

    const startTime = performance.now()
    let firstByteTime = 0
    let firstTokenTime = 0
    let endTime = 0
    let status = 0
    let textContent = ""
    let buffer = ""

    const curlArgs = [
      "-s", "-S", "--no-buffer",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-H", `x-api-key: ${ANTHROPIC_API_KEY}`,
      "-H", "anthropic-version: 2023-06-01",
      "-d", body,
      "-w", "\n__TIMING__%{http_code}|%{time_namelookup}|%{time_connect}|%{time_appconnect}|%{time_starttransfer}|%{time_total}",
      "--max-time", "60",
      "https://api.anthropic.com/v1/messages",
    ]

    const proc = spawn("curl", curlArgs)
    let fullOutput = ""

    proc.stdout.on("data", (data: Buffer) => {
      const now = performance.now()
      const text = data.toString()
      fullOutput += text

      if (!firstByteTime) firstByteTime = now

      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const sseData = line.slice(6).trim()
        if (!sseData || sseData === "[DONE]") continue

        try {
          const parsed = JSON.parse(sseData)
          if (parsed.type === "content_block_delta" && parsed.delta?.text) {
            if (!firstTokenTime) firstTokenTime = now
            textContent += parsed.delta.text
            if (verbose) process.stdout.write(`\x1b[2m${parsed.delta.text}\x1b[0m`)
          }
        } catch {}
      }
    })

    proc.stderr.on("data", (data: Buffer) => {
      if (verbose) console.log(`\x1b[31m  [curl] ${data.toString().trim()}\x1b[0m`)
    })

    proc.on("close", () => {
      endTime = performance.now()
      if (verbose && textContent) console.log()

      // Parse curl timing
      const match = fullOutput.match(/__TIMING__(\d+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/)
      let curlTtfb = 0
      if (match) {
        status = parseInt(match[1])
        curlTtfb = parseFloat(match[5]) * 1000  // time_starttransfer
      }

      if (!firstByteTime) firstByteTime = endTime
      if (!firstTokenTime) firstTokenTime = endTime

      resolve({
        label: "Anthropic API (direct)",
        run: runNum,
        ttfb: curlTtfb || (firstByteTime - startTime),
        ttft: firstTokenTime - startTime,
        totalTime: endTime - startTime,
        status,
        textPreview: textContent.slice(0, 120),
        error: status >= 400 ? `HTTP ${status}` : undefined,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Test 2: Platform /api/chat (Claude Code SDK path)
// ---------------------------------------------------------------------------
function testPlatformChat(runNum: number): Promise<TimingResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      messages: [{
        id: `test-${Date.now()}-${runNum}`,
        role: "user",
        content: message,
        parts: [{ type: "text", text: message }],
      }],
      agentMode: "basic",
    })

    const startTime = performance.now()
    let firstByteTime = 0
    let firstTokenTime = 0
    let endTime = 0
    let status = 0
    let textContent = ""
    let buffer = ""
    let eventCount = 0
    let eventTypes: string[] = []

    const curlArgs = [
      "-s", "-S", "--no-buffer",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", body,
      "-w", "\n__TIMING__%{http_code}|%{time_namelookup}|%{time_connect}|%{time_starttransfer}|%{time_total}",
      "--max-time", "120",
      `${API_BASE}/api/chat`,
    ]

    const proc = spawn("curl", curlArgs)
    let fullOutput = ""

    proc.stdout.on("data", (data: Buffer) => {
      const now = performance.now()
      const text = data.toString()
      fullOutput += text

      if (!firstByteTime) firstByteTime = now

      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const sseData = line.slice(6).trim()
        if (!sseData || sseData === "[DONE]") continue

        eventCount++

        try {
          // AI SDK UI Message Stream format
          const parsed = JSON.parse(sseData)
          const eventType = parsed.type || "unknown"
          if (!eventTypes.includes(eventType)) eventTypes.push(eventType)

          // Look for text content in various formats
          if (parsed.type === "text" && parsed.value) {
            if (!firstTokenTime) firstTokenTime = now
            textContent += parsed.value
            if (verbose) process.stdout.write(`\x1b[2m${parsed.value}\x1b[0m`)
          } else if (parsed.type === "text-delta" && (parsed.textDelta || parsed.value)) {
            if (!firstTokenTime) firstTokenTime = now
            textContent += parsed.textDelta || parsed.value
            if (verbose) process.stdout.write(`\x1b[2m${parsed.textDelta || parsed.value}\x1b[0m`)
          } else if (verbose) {
            console.log(`\x1b[33m  [SSE] ${eventType}: ${JSON.stringify(parsed).slice(0, 120)}\x1b[0m`)
          }
        } catch {
          // Try AI SDK compact format: 0:"text"
          if (sseData.startsWith("0:")) {
            if (!firstTokenTime) firstTokenTime = now
            try { textContent += JSON.parse(sseData.slice(2)) } catch { textContent += sseData.slice(2) }
            if (verbose) process.stdout.write(`\x1b[2m${sseData.slice(2)}\x1b[0m`)
          } else if (verbose) {
            console.log(`\x1b[33m  [SSE raw] ${sseData.slice(0, 120)}\x1b[0m`)
          }
        }
      }
    })

    proc.stderr.on("data", (data: Buffer) => {
      if (verbose) console.log(`\x1b[31m  [curl] ${data.toString().trim()}\x1b[0m`)
    })

    proc.on("close", () => {
      endTime = performance.now()
      if (verbose && textContent) console.log()

      const match = fullOutput.match(/__TIMING__(\d+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/)
      let curlTtfb = 0
      if (match) {
        status = parseInt(match[1])
        curlTtfb = parseFloat(match[4]) * 1000
      }

      if (!firstByteTime) firstByteTime = endTime
      if (!firstTokenTime) firstTokenTime = endTime

      resolve({
        label: "Platform /api/chat",
        run: runNum,
        ttfb: curlTtfb || (firstByteTime - startTime),
        ttft: firstTokenTime - startTime,
        totalTime: endTime - startTime,
        status,
        textPreview: textContent.slice(0, 120) || `(no text deltas — ${eventCount} events: ${eventTypes.join(", ")})`,
        error: status === 0 ? "Connection failed (server may have restarted)" : status >= 400 ? `HTTP ${status}` : undefined,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Test 3: Project chat (if projectId provided)
// ---------------------------------------------------------------------------
function testProjectChat(projId: string, runNum: number): Promise<TimingResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      messages: [{
        role: "user",
        content: message,
        parts: [{ type: "text", text: message }],
      }],
      agentMode: "basic",
    })

    const startTime = performance.now()
    let firstByteTime = 0
    let firstTokenTime = 0
    let endTime = 0
    let status = 0
    let textContent = ""
    let buffer = ""
    let eventCount = 0
    let eventTypes: string[] = []

    const curlArgs = [
      "-s", "-S", "--no-buffer",
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "-d", body,
      "-w", "\n__TIMING__%{http_code}|%{time_namelookup}|%{time_connect}|%{time_starttransfer}|%{time_total}",
      "--max-time", "120",
      `${API_BASE}/api/projects/${projId}/chat`,
    ]

    const proc = spawn("curl", curlArgs)
    let fullOutput = ""

    proc.stdout.on("data", (data: Buffer) => {
      const now = performance.now()
      const text = data.toString()
      fullOutput += text

      if (!firstByteTime) firstByteTime = now

      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const sseData = line.slice(6).trim()
        if (!sseData || sseData === "[DONE]") continue

        eventCount++

        try {
          const parsed = JSON.parse(sseData)
          const eventType = parsed.type || "unknown"
          if (!eventTypes.includes(eventType)) eventTypes.push(eventType)

          if (parsed.type === "text" && parsed.value) {
            if (!firstTokenTime) firstTokenTime = now
            textContent += parsed.value
          } else if (parsed.type === "text-delta" && (parsed.textDelta || parsed.value)) {
            if (!firstTokenTime) firstTokenTime = now
            textContent += parsed.textDelta || parsed.value
          }
        } catch {
          if (sseData.startsWith("0:")) {
            if (!firstTokenTime) firstTokenTime = now
            try { textContent += JSON.parse(sseData.slice(2)) } catch { textContent += sseData.slice(2) }
          }
        }
      }
    })

    proc.stderr.on("data", (data: Buffer) => {
      if (verbose) console.log(`\x1b[31m  [curl] ${data.toString().trim()}\x1b[0m`)
    })

    proc.on("close", () => {
      endTime = performance.now()

      const match = fullOutput.match(/__TIMING__(\d+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/)
      let curlTtfb = 0
      if (match) {
        status = parseInt(match[1])
        curlTtfb = parseFloat(match[4]) * 1000
      }

      if (!firstByteTime) firstByteTime = endTime
      if (!firstTokenTime) firstTokenTime = endTime

      resolve({
        label: `Project /api/projects/${projId}/chat`,
        run: runNum,
        ttfb: curlTtfb || (firstByteTime - startTime),
        ttft: firstTokenTime - startTime,
        totalTime: endTime - startTime,
        status,
        textPreview: textContent.slice(0, 120) || `(no text deltas — ${eventCount} events: ${eventTypes.join(", ")})`,
        error: status >= 400 ? `HTTP ${status}` : undefined,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
function testHealth(): Promise<{ ok: boolean; ttfb: number }> {
  return new Promise((resolve) => {
    const proc = spawn("curl", [
      "-s", "-S",
      "-w", "\n__T__%{http_code}|%{time_starttransfer}",
      `${API_BASE}/api/health`,
    ])
    let out = ""
    proc.stdout.on("data", (d: Buffer) => { out += d.toString() })
    proc.on("close", () => {
      const m = out.match(/__T__(\d+)\|([\d.]+)/)
      resolve({ ok: m?.[1] === "200", ttfb: m ? parseFloat(m[2]) * 1000 : 0 })
    })
  })
}

// ---------------------------------------------------------------------------
// Print run result
// ---------------------------------------------------------------------------
function printRunResult(r: TimingResult) {
  if (r.error) {
    console.log(`    \x1b[31m❌ Run ${r.run}: ${r.error}\x1b[0m`)
    return
  }

  const ttftColor = r.ttft < 1000 ? "\x1b[32m" : r.ttft < 3000 ? "\x1b[33m" : "\x1b[1;31m"
  console.log(`    Run ${r.run}:  TTFB ${fmt(r.ttfb).padEnd(8)}  TTFT ${ttftColor}${fmt(r.ttft).padEnd(8)}\x1b[0m  Total ${fmt(r.totalTime).padEnd(8)}  ${r.textPreview ? `"${r.textPreview.slice(0, 60).replace(/\n/g, "↵")}${r.textPreview.length > 60 ? "…" : ""}"` : ""}`)
}

// ---------------------------------------------------------------------------
// Run a test suite
// ---------------------------------------------------------------------------
async function runSuite(
  label: string,
  testFn: (runNum: number) => Promise<TimingResult>,
  numRuns: number,
): Promise<TimingResult[]> {
  console.log(`\n  \x1b[1m${label}\x1b[0m`)
  const results: TimingResult[] = []

  for (let i = 1; i <= numRuns; i++) {
    const r = await testFn(i)
    results.push(r)
    printRunResult(r)
    if (i < numRuns) await new Promise((r) => setTimeout(r, 1000))
  }

  return results
}

// ---------------------------------------------------------------------------
// Summary comparison
// ---------------------------------------------------------------------------
function printComparison(suites: { label: string; results: TimingResult[] }[]) {
  printHeader("COMPARISON SUMMARY")

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const min = (arr: number[]) => arr.length ? Math.min(...arr) : 0
  const max = (arr: number[]) => arr.length ? Math.max(...arr) : 0
  const p50 = (arr: number[]) => {
    if (!arr.length) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  // Table: Label | TTFB avg | TTFT avg | Total avg
  console.log()
  const header = "  " + "Layer".padEnd(30) + "│ " + "TTFB (avg)".padEnd(14) + "│ " + "TTFT (avg)".padEnd(14) + "│ " + "Total (avg)".padEnd(14)
  console.log(header)
  console.log("  " + "─".repeat(header.length - 2))

  for (const { label, results } of suites) {
    const ok = results.filter((r) => !r.error)
    if (!ok.length) {
      console.log("  " + label.padEnd(30) + "│ " + "\x1b[31mFAILED\x1b[0m")
      continue
    }

    const ttfbAvg = avg(ok.map((r) => r.ttfb))
    const ttftAvg = avg(ok.map((r) => r.ttft))
    const totalAvg = avg(ok.map((r) => r.totalTime))

    const ttftColor = ttftAvg < 1000 ? "\x1b[32m" : ttftAvg < 3000 ? "\x1b[33m" : "\x1b[1;31m"
    console.log(
      "  " + label.padEnd(30) + "│ " +
      fmt(ttfbAvg).padEnd(14) + "│ " +
      `${ttftColor}${fmt(ttftAvg)}\x1b[0m`.padEnd(25) + "│ " +
      fmt(totalAvg).padEnd(14)
    )
  }

  // Overhead analysis
  const anthropicSuite = suites.find((s) => s.label.includes("Anthropic"))
  const platformSuite = suites.find((s) => s.label.includes("Platform"))
  const projectSuite = suites.find((s) => s.label.includes("Project"))

  if (anthropicSuite && platformSuite) {
    const anthropicOk = anthropicSuite.results.filter((r) => !r.error)
    const platformOk = platformSuite.results.filter((r) => !r.error)

    if (anthropicOk.length && platformOk.length) {
      const anthropicTtft = avg(anthropicOk.map((r) => r.ttft))
      const platformTtft = avg(platformOk.map((r) => r.ttft))
      const overhead = platformTtft - anthropicTtft

      console.log()
      printHeader("OVERHEAD ANALYSIS")
      console.log()
      printMetric("Anthropic API baseline TTFT", fmt(anthropicTtft))
      printMetric("Platform /api/chat TTFT", fmt(platformTtft))
      printMetric("Claude Code SDK overhead", `\x1b[1;31m${fmt(overhead)}\x1b[0m`)
      console.log()

      if (overhead > 3000) {
        console.log("  \x1b[1;31m⚠️  Claude Code SDK adds significant overhead (>3s)\x1b[0m")
        console.log("  This is likely caused by:")
        console.log("    1. Claude Code CLI subprocess spawn/initialization")
        console.log("    2. MCP server startup (wavesmith subprocess, virtual-tools)")
        console.log("    3. Session file I/O (reading/writing conversation state)")
        console.log("    4. Permission/tool configuration processing")
        console.log()
        console.log("  Possible mitigations:")
        console.log("    - Pre-warm Claude Code session on server startup")
        console.log("    - Cache and reuse CLI subprocess across requests")
        console.log("    - Reduce number of allowed tools (currently ~50+)")
        console.log("    - Consider direct Anthropic API for simple queries")
      } else if (overhead > 1000) {
        console.log("  \x1b[33m⚠️  Moderate Claude Code SDK overhead (1-3s)\x1b[0m")
        console.log("  The SDK adds some latency for session management and tool setup.")
      } else {
        console.log("  \x1b[32m✅ Claude Code SDK overhead is minimal (<1s)\x1b[0m")
      }

      if (projectSuite) {
        const projectOk = projectSuite.results.filter((r) => !r.error)
        if (projectOk.length) {
          const projectTtft = avg(projectOk.map((r) => r.ttft))
          const proxyOverhead = projectTtft - platformTtft
          console.log()
          printMetric("Project chat additional overhead", fmt(proxyOverhead))
          console.log("  (proxy → pod routing, pod cold start if applicable)")
        }
      }
    }
  }

  // Cold start analysis
  for (const { label, results } of suites) {
    const ok = results.filter((r) => !r.error)
    if (ok.length >= 2) {
      const first = ok[0].ttft
      const restAvg = avg(ok.slice(1).map((r) => r.ttft))
      const penalty = first - restAvg
      if (Math.abs(penalty) > 500) {
        console.log()
        console.log(`  \x1b[33m${label} — Cold start:\x1b[0m`)
        printMetric("   First run TTFT", fmt(first))
        printMetric("   Subsequent avg TTFT", fmt(restAvg))
        printMetric("   Cold start penalty", fmt(penalty))
      }
    }
  }

  console.log()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("\x1b[1m🔬 Chat Latency Diagnostic\x1b[0m")
  console.log(`   API Base:  ${API_BASE}`)
  console.log(`   Message:   "${message}"`)
  console.log(`   Runs:      ${runs} per test`)
  console.log(`   Has key:   ${ANTHROPIC_API_KEY ? "✅" : "❌ (set ANTHROPIC_API_KEY for direct API test)"}`)

  // Health check
  printHeader("HEALTH CHECK")
  const health = await testHealth()
  if (!health.ok) {
    console.log(`  \x1b[31m❌ API server not reachable at ${API_BASE}\x1b[0m`)
    console.log(`  \x1b[31m   Run: bun run api:dev\x1b[0m`)
    if (!anthropicOnly) process.exit(1)
  } else {
    printMetric("Status", "✅ OK")
    printMetric("Health TTFB", fmt(health.ttfb))
  }

  const suites: { label: string; results: TimingResult[] }[] = []

  // Test 1: Direct Anthropic API
  if (!chatOnly && ANTHROPIC_API_KEY) {
    printHeader("TEST 1: Direct Anthropic API (baseline)")
    console.log("  Model: claude-3-5-haiku-latest (streaming)")
    const results = await runSuite("Anthropic API (direct)", testAnthropicDirect, runs)
    suites.push({ label: "Anthropic API (direct)", results })
  }

  if (anthropicOnly) {
    if (suites.length) printComparison(suites)
    return
  }

  // Test 2: Platform chat
  printHeader("TEST 2: Platform Chat /api/chat")
  console.log("  Path: Client → API Server → Claude Code SDK → Anthropic")
  const platformResults = await runSuite("Platform /api/chat", testPlatformChat, runs)
  suites.push({ label: "Platform /api/chat", results: platformResults })

  // Test 3: Project chat
  if (projectId) {
    printHeader(`TEST 3: Project Chat /api/projects/${projectId}/chat`)
    console.log("  Path: Client → API Server → Project Pod → Anthropic")
    const projectResults = await runSuite(
      `Project chat`,
      (n) => testProjectChat(projectId!, n),
      runs,
    )
    suites.push({ label: "Project chat", results: projectResults })
  }

  // Comparison
  printComparison(suites)
}

main().catch((e) => {
  console.error("Fatal error:", e)
  process.exit(1)
})
