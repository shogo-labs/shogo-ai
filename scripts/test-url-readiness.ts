#!/usr/bin/env bun
/**
 * Test: URL readiness polling via /health endpoint
 *
 * Simulates the DomainMapping propagation race:
 * 1. Starts a local server that returns 404 on /health for the first N requests
 * 2. Then switches to 200
 * 3. Runs the same polling logic as useUrlReadiness
 * 4. Asserts the poll detects the transition correctly
 */

const PORT = 19876

let requestCount = 0
let switch404After = 3
let serverInstance: ReturnType<typeof Bun.serve> | null = null

function startServer(opts?: { alwaysOk?: boolean }) {
  requestCount = 0
  serverInstance = Bun.serve({
    port: PORT,
    reusePort: true,
    fetch(req) {
      requestCount++
      const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }

      if (opts?.alwaysOk || requestCount > switch404After) {
        console.log(`  [server] /health #${requestCount} → 200`)
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers })
      }

      console.log(`  [server] /health #${requestCount} → 404 (ingress, no CORS)`)
      // Real ingress 404 has NO CORS headers — browser fetch will throw TypeError
      return new Response('Not Found', { status: 404 })
    },
  })
}

// ---------------------------------------------------------------------------
// Poll logic — must exactly mirror useUrlReadiness in CanvasWebView.tsx
// ---------------------------------------------------------------------------

async function pollUntilReady(
  baseUrl: string,
  maxAttempts = 30,
  intervalMs = 200,
): Promise<{ ready: boolean; attempts: number; elapsed: number }> {
  const probeUrl = `${baseUrl}/health`
  const start = Date.now()
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(probeUrl, { signal: AbortSignal.timeout(4000) })
      if (res.status !== 404) {
        return { ready: true, attempts: i + 1, elapsed: Date.now() - start }
      }
    } catch { /* network / CORS failure */ }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return { ready: false, attempts: maxAttempts, elapsed: Date.now() - start }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0
  let failed = 0
  const baseUrl = `http://localhost:${PORT}`

  function assert(label: string, ok: boolean) {
    if (ok) { console.log(`  ✅ PASS — ${label}`); passed++ }
    else    { console.log(`  ❌ FAIL — ${label}`); failed++ }
  }

  // Test 1: 404 → 200 after 3 requests
  console.log('\n--- Test 1: 404 → 200 after 3 retries ---')
  switch404After = 3
  startServer()
  const r1 = await pollUntilReady(baseUrl)
  console.log(`  attempts=${r1.attempts} elapsed=${r1.elapsed}ms`)
  assert('detected readiness on attempt 4', r1.ready && r1.attempts === 4)
  serverInstance?.stop(true)

  // Test 2: immediately ready
  console.log('\n--- Test 2: Immediately ready ---')
  switch404After = 0
  startServer()
  const r2 = await pollUntilReady(baseUrl)
  console.log(`  attempts=${r2.attempts} elapsed=${r2.elapsed}ms`)
  assert('ready on first attempt', r2.ready && r2.attempts === 1)
  serverInstance?.stop(true)

  // Test 3: 10 retries then ready
  console.log('\n--- Test 3: 10 retries then ready ---')
  switch404After = 10
  startServer()
  const r3 = await pollUntilReady(baseUrl)
  console.log(`  attempts=${r3.attempts} elapsed=${r3.elapsed}ms`)
  assert('ready on attempt 11', r3.ready && r3.attempts === 11)
  serverInstance?.stop(true)

  // Test 4: server offline then comes back
  console.log('\n--- Test 4: Server down → recovers ---')
  // Don't start server yet — poll will get connection-refused errors
  setTimeout(() => {
    console.log('  [test] Starting server after 800ms delay')
    startServer({ alwaysOk: true })
  }, 800)
  const r4 = await pollUntilReady(baseUrl, 30, 300)
  console.log(`  attempts=${r4.attempts} elapsed=${r4.elapsed}ms`)
  assert('recovered after server came back', r4.ready)
  serverInstance?.stop(true)

  // Summary
  console.log(`\n========================================`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`========================================\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
