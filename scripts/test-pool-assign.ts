// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pool Assignment Latency Test
 *
 * Starts the agent-runtime in warm pool mode, waits for it to pre-seed
 * the workspace, then sends a /pool/assign request and measures the
 * response time. Asserts durationMs < threshold.
 *
 * Usage:
 *   bun run scripts/test-pool-assign.ts
 *   bun run scripts/test-pool-assign.ts --threshold 5000   # custom max ms
 *   bun run scripts/test-pool-assign.ts --verbose           # show server output
 */

import { spawn, type ChildProcess } from "child_process"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : undefined
}
const verbose = args.includes("--verbose")
const threshold = parseInt(getArg("--threshold") || "3000", 10)
const PORT = 18999

const workspaceDir = mkdtempSync(join(tmpdir(), "shogo-pool-test-"))

let serverProc: ChildProcess | null = null

function cleanup() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill("SIGTERM")
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true })
  } catch {}
}

process.on("SIGINT", () => { cleanup(); process.exit(1) })
process.on("SIGTERM", () => { cleanup(); process.exit(1) })

async function waitForReady(port: number, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`)
}

async function waitForPreSeed(port: number, timeoutMs = 120_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        // Give the background pre-seed a moment to complete after server is healthy.
        // The pre-seed runs as a fire-and-forget promise; health is available before it finishes.
        await new Promise(r => setTimeout(r, 3000))
        return
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`Server did not become healthy within ${timeoutMs}ms`)
}

async function main() {
  console.log("=== Pool Assignment Latency Test ===\n")
  console.log(`Workspace:  ${workspaceDir}`)
  console.log(`Port:       ${PORT}`)
  console.log(`Threshold:  ${threshold}ms\n`)

  const runtimeEntry = join(__dirname, "..", "packages", "agent-runtime", "src", "server.ts")

  console.log("Starting agent-runtime in pool mode...")
  serverProc = spawn("bun", ["run", runtimeEntry], {
    env: {
      ...process.env,
      PROJECT_ID: "__POOL__",
      WARM_POOL_MODE: "true",
      WORKSPACE_DIR: workspaceDir,
      PORT: String(PORT),
      RUNTIME_AUTH_SECRET: "test-secret",
      S3_WORKSPACES_BUCKET: "",
      S3_BUCKET: "",
      COMPOSIO_API_KEY: "",
    },
    stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
  })

  if (!verbose) {
    let serverOutput = ""
    serverProc.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString() })
    serverProc.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString() })
    serverProc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`\nServer exited with code ${code}. Output:\n${serverOutput}`)
      }
    })
  }

  try {
    console.log("Waiting for server to be ready and pre-seed workspace...")
    await waitForPreSeed(PORT)
    console.log("Server ready and workspace pre-seeded.\n")

    console.log("Sending POST /pool/assign...")
    const assignStart = Date.now()
    const res = await fetch(`http://localhost:${PORT}/pool/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer test-secret",
      },
      body: JSON.stringify({
        projectId: "test-project-" + Date.now(),
        env: {},
      }),
      signal: AbortSignal.timeout(60_000),
    })

    const wallClockMs = Date.now() - assignStart
    const body = await res.json() as any

    console.log(`\nResponse: ${res.status}`)
    console.log(`Wall-clock: ${wallClockMs}ms`)
    console.log(`Server durationMs: ${body.durationMs ?? "N/A"}`)
    console.log(`Body: ${JSON.stringify(body, null, 2)}\n`)

    const effectiveMs = body.durationMs ?? wallClockMs

    if (!res.ok) {
      console.error("FAIL: Assignment request failed")
      cleanup()
      process.exit(1)
    }

    if (effectiveMs > threshold) {
      console.error(`FAIL: Assignment took ${effectiveMs}ms (threshold: ${threshold}ms)`)
      cleanup()
      process.exit(1)
    }

    console.log(`PASS: Assignment completed in ${effectiveMs}ms (threshold: ${threshold}ms)`)
  } catch (err: any) {
    console.error(`\nFAIL: ${err.message}`)
    cleanup()
    process.exit(1)
  }

  cleanup()
  process.exit(0)
}

main()
