// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
#!/usr/bin/env bun
/**
 * Test: Restart server, kill conflicting processes, then verify SSE tool call
 * events are emitted correctly by the /api/chat endpoint.
 *
 * Usage:  bun scripts/test-tool-call-ui.ts
 *
 * What it does:
 *   1. Kill everything on ports 8002, 6200, 5200-5211
 *   2. Start API server fresh (bun run api:dev style)
 *   3. Wait for server ready + prewarm
 *   4. Authenticate via Better Auth (sign-up or sign-in)
 *   5. Send a chat message that asks the agent to use a tool
 *   6. Capture the raw SSE stream and categorize every chunk
 *   7. Report whether tool events appeared
 *   8. Kill everything and exit
 */

import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'

const PROJECT_ROOT = resolve(import.meta.dir, '..')
const API_BASE = 'http://localhost:8002'
const PORTS_TO_KILL = [8002, 6200, 5200, 5201, 5202, 5203, 5210, 5211]
const TEST_EMAIL = 'tooltest@test.com'
const TEST_PASSWORD = 'TestPassword123!'
const TEST_NAME = 'Tool Test'

// ─── Logging ─────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
}
const log = (msg: string) => console.log(`${c.cyan}[test]${c.reset} ${msg}`)
const ok = (msg: string) => console.log(`${c.green}  ✅ ${msg}${c.reset}`)
const fail = (msg: string) => console.log(`${c.red}  ❌ ${msg}${c.reset}`)
const warn = (msg: string) => console.log(`${c.yellow}  ⚠️  ${msg}${c.reset}`)
const event = (msg: string) => console.log(`${c.yellow}  📨 ${msg}${c.reset}`)
const dim = (msg: string) => console.log(`${c.dim}     ${msg}${c.reset}`)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── Kill port ───────────────────────────────────────────────────────────────

async function killPort(port: number): Promise<number> {
  try {
    const proc = Bun.spawn(['lsof', '-ti', `:${port}`], { stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    const pids = text.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n))
    let killed = 0
    for (const pid of pids) {
      try { process.kill(pid, 9); killed++ } catch {}
    }
    return killed
  } catch { return 0 }
}

// ─── Wait for server ─────────────────────────────────────────────────────────

async function waitForServer(url: string, timeoutMs = 60000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (res.status < 500) return true
    } catch {}
    await sleep(2000)
  }
  return false
}

// =============================================================================
// Step 1: Kill everything
// =============================================================================

log('Step 1: Killing all running servers and runtimes...')
let totalKilled = 0
for (const port of PORTS_TO_KILL) {
  const killed = await killPort(port)
  if (killed > 0) dim(`Killed ${killed} process(es) on port ${port}`)
  totalKilled += killed
}
if (totalKilled > 0) {
  log(`Killed ${totalKilled} total processes. Waiting for cleanup...`)
  await sleep(3000)
} else {
  log('No existing processes found.')
}

// Double-check port 8002 is free
const doubleCheck = await killPort(8002)
if (doubleCheck > 0) {
  warn(`Had to kill ${doubleCheck} more processes on 8002`)
  await sleep(2000)
}

// =============================================================================
// Step 2: Start API server
// =============================================================================

log('Step 2: Starting API server...')

// Load .env.local if it exists
const envPath = resolve(PROJECT_ROOT, '.env.local')
const apiEnvPath = resolve(PROJECT_ROOT, 'apps/api/.env')
let extraEnv: Record<string, string> = {}
for (const p of [envPath, apiEnvPath]) {
  if (existsSync(p)) {
    const lines = readFileSync(p, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      extraEnv[key] = val
    }
    dim(`Loaded env from ${p}`)
  }
}

const serverProc = Bun.spawn(['bun', 'run', 'apps/api/src/server.ts'], {
  cwd: PROJECT_ROOT,
  stdout: 'pipe',
  stderr: 'pipe',
  env: { ...process.env, ...extraEnv },
})

// Collect stdout/stderr in background
let serverStdout = ''
let serverStderr = ''

const readStream = async (stream: ReadableStream<Uint8Array>, target: 'stdout' | 'stderr') => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const text = decoder.decode(value, { stream: true })
      if (target === 'stdout') serverStdout += text
      else serverStderr += text
      // Echo server output in real time (dimmed)
      const lines = text.split('\n')
      for (const line of lines) {
        if (line.trim()) dim(`[server] ${line.trim()}`)
      }
    }
  } catch {}
}
readStream(serverProc.stdout, 'stdout')
readStream(serverProc.stderr, 'stderr')

log('Waiting for API server to accept requests (up to 60s)...')
const serverUp = await waitForServer(`${API_BASE}/api/health`, 60000)
if (!serverUp) {
  fail('API server did not start within 60s')
  dim('stdout tail: ' + serverStdout.slice(-500))
  dim('stderr tail: ' + serverStderr.slice(-500))
  serverProc.kill()
  process.exit(1)
}
ok('API server is responding')

// Wait for prewarm
log('Waiting for session prewarm (checking every 5s, up to 60s)...')
const prewarmStart = Date.now()
let prewarmed = false
while (Date.now() - prewarmStart < 60000) {
  if (serverStdout.includes('Pre-warm complete') || serverStdout.includes('Pre-warm first response')) {
    prewarmed = true
    break
  }
  await sleep(5000)
}
if (prewarmed) {
  ok(`Session prewarmed in ${((Date.now() - prewarmStart) / 1000).toFixed(1)}s`)
} else {
  warn('Prewarm may not have completed, continuing anyway...')
}

// =============================================================================
// Step 3: Authenticate
// =============================================================================

log('Step 3: Authenticating...')

let cookies = ''

// Try sign-in first
try {
  const signInRes = await fetch(`${API_BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    redirect: 'manual',
  })
  const setCookies = signInRes.headers.getSetCookie()
  if (setCookies && setCookies.length > 0) {
    cookies = setCookies.map(c => c.split(';')[0]).join('; ')
    ok(`Signed in (got ${setCookies.length} cookies)`)
  } else {
    dim(`Sign-in response: ${signInRes.status}`)
    // Try sign-up
    const signUpRes = await fetch(`${API_BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME }),
      redirect: 'manual',
    })
    const signUpCookies = signUpRes.headers.getSetCookie()
    if (signUpCookies && signUpCookies.length > 0) {
      cookies = signUpCookies.map(c => c.split(';')[0]).join('; ')
      ok(`Signed up new user (got ${signUpCookies.length} cookies)`)
    } else {
      const body = await signUpRes.text()
      warn(`Sign-up returned ${signUpRes.status}: ${body.slice(0, 200)}`)
    }
  }
} catch (e) {
  fail(`Auth error: ${e}`)
}

if (!cookies) {
  warn('No auth cookies obtained. Trying chat without auth (may work if middleware is ordered after route).')
}

// Verify session
if (cookies) {
  try {
    const sessionRes = await fetch(`${API_BASE}/api/auth/get-session`, {
      headers: { Cookie: cookies },
    })
    const sessionData = await sessionRes.json() as any
    if (sessionData?.user?.email) {
      ok(`Session verified for: ${sessionData.user.email}`)
    } else {
      warn(`Session check: ${JSON.stringify(sessionData).slice(0, 200)}`)
    }
  } catch {}
}

// =============================================================================
// Step 4: Send chat message
// =============================================================================

log('Step 4: Sending chat message that should trigger tool use...')
log('  Message: "Write hello world to /tmp/shogo-tool-test.txt"')

const chatBody = {
  messages: [
    {
      role: 'user',
      content: 'Write the text "hello world" to the file /tmp/shogo-tool-test.txt. Use the Write tool.',
    }
  ],
}

const chatRes = await fetch(`${API_BASE}/api/chat`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(cookies ? { Cookie: cookies } : {}),
  },
  body: JSON.stringify(chatBody),
})

if (!chatRes.ok) {
  const errText = await chatRes.text()
  fail(`Chat failed with status ${chatRes.status}: ${errText.slice(0, 500)}`)
  serverProc.kill()
  process.exit(1)
}

ok(`Chat response started (status ${chatRes.status}, content-type: ${chatRes.headers.get('content-type')})`)

// =============================================================================
// Step 5: Parse SSE stream
// =============================================================================

log('Step 5: Reading SSE stream (timeout: 120s)...')
log('')

const reader = chatRes.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

// Event counters
const eventCounts = new Map<string, number>()
const toolEventDetails: Array<{ type: string; toolCallId?: string; toolName?: string; [k: string]: any }> = []
let totalEvents = 0

const streamTimeout = setTimeout(() => {
  warn('Stream timeout after 120s — cancelling')
  reader.cancel()
}, 120000)

try {
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue

      try {
        const evt = JSON.parse(data)
        totalEvents++
        const type = evt.type || 'unknown'
        eventCounts.set(type, (eventCounts.get(type) || 0) + 1)

        // Log tool events in detail
        if (type.startsWith('tool-')) {
          const detail = {
            type,
            toolCallId: evt.toolCallId,
            toolName: evt.toolName,
          }
          toolEventDetails.push(detail)

          if (type === 'tool-input-start') {
            event(`${c.bold}tool-input-start${c.reset}${c.yellow} → ${evt.toolName} (${evt.toolCallId})`)
          } else if (type === 'tool-input-delta') {
            const preview = (evt.inputTextDelta || '').slice(0, 60)
            event(`tool-input-delta → ${preview}...`)
          } else if (type === 'tool-input-available') {
            event(`${c.bold}tool-input-available${c.reset}${c.yellow} → ${evt.toolName} (${evt.toolCallId})`)
            const inputPreview = JSON.stringify(evt.input || {}).slice(0, 100)
            dim(`  input: ${inputPreview}`)
          } else if (type === 'tool-output-available') {
            event(`${c.bold}tool-output-available${c.reset}${c.yellow} → ${evt.toolCallId}`)
          } else if (type === 'tool-output-error') {
            event(`${c.bold}tool-output-error${c.reset}${c.yellow} → ${evt.toolCallId}: ${evt.errorText}`)
          } else {
            event(`${type} → ${JSON.stringify(evt).slice(0, 80)}`)
          }
        }

        // Log text content briefly
        if (type === 'text-delta') {
          // Don't flood — just count
        }

        // Log lifecycle events
        if (type === 'start-step' || type === 'finish-step') {
          dim(`${type}`)
        }
      } catch {}
    }
  }
} finally {
  clearTimeout(streamTimeout)
}

// =============================================================================
// Step 6: Report results
// =============================================================================

console.log('')
console.log(`${c.bold}${'═'.repeat(60)}${c.reset}`)
console.log(`${c.bold}                    RESULTS${c.reset}`)
console.log(`${c.bold}${'═'.repeat(60)}${c.reset}`)
console.log('')

log(`Total SSE events parsed: ${totalEvents}`)
console.log('')

// Show all event types with counts
log('Event type breakdown:')
const sortedTypes = [...eventCounts.entries()].sort((a, b) => b[1] - a[1])
for (const [type, count] of sortedTypes) {
  const isToolType = type.startsWith('tool-')
  const color = isToolType ? c.green : c.dim
  console.log(`  ${color}${type.padEnd(30)} ${count}${c.reset}`)
}
console.log('')

const toolEventCount = toolEventDetails.length
if (toolEventCount > 0) {
  ok(`Tool events ARE in the stream: ${toolEventCount} total`)
  console.log('')

  // Group by toolCallId
  const byCallId = new Map<string, typeof toolEventDetails>()
  for (const d of toolEventDetails) {
    const id = d.toolCallId || 'unknown'
    if (!byCallId.has(id)) byCallId.set(id, [])
    byCallId.get(id)!.push(d)
  }

  for (const [callId, events] of byCallId) {
    const name = events.find(e => e.toolName)?.toolName || '?'
    const types = events.map(e => e.type.replace('tool-', ''))
    log(`  Tool call: ${name} (${callId})`)
    log(`    Lifecycle: ${types.join(' → ')}`)

    // Check completeness
    const hasStart = types.includes('input-start')
    const hasAvailable = types.includes('input-available')
    const hasOutput = types.includes('output-available') || types.includes('output-error')
    if (hasStart && hasAvailable && hasOutput) {
      ok(`    Complete lifecycle ✓`)
    } else {
      warn(`    Missing: ${!hasStart ? 'input-start ' : ''}${!hasAvailable ? 'input-available ' : ''}${!hasOutput ? 'output ' : ''}`)
    }
  }
} else {
  fail('NO tool events found in stream!')
  console.log('')
  log('This could mean:')
  log('  1. The agent responded with text only (no tool use)')
  log('  2. The SDK is not emitting tool_use blocks in stream_event or assistant messages')
  log('  3. The server code is not correctly translating SDK messages to UIMessageChunks')
  console.log('')

  // Look for clues in server output
  log('Server output analysis:')
  const stdoutLines = serverStdout.split('\n')
  const relevantLines = stdoutLines.filter(l =>
    l.includes('tool') || l.includes('Tool') || l.includes('TOOL') ||
    l.includes('assistant') || l.includes('stream_event') ||
    l.includes('content_block') || l.includes('Result:')
  )
  if (relevantLines.length > 0) {
    for (const line of relevantLines.slice(-20)) {
      dim(line.trim().slice(0, 120))
    }
  } else {
    dim('No tool-related server logs found')
  }
}

// Check if the file was actually created
console.log('')
if (existsSync('/tmp/shogo-tool-test.txt')) {
  const content = readFileSync('/tmp/shogo-tool-test.txt', 'utf-8').trim()
  ok(`File was created: /tmp/shogo-tool-test.txt → "${content}"`)
  if (toolEventCount === 0) {
    warn('File exists but NO tool events in stream — tools execute silently!')
  }
} else {
  dim('File /tmp/shogo-tool-test.txt was NOT created (tool may not have executed)')
}

console.log('')
console.log(`${c.bold}${'═'.repeat(60)}${c.reset}`)

// =============================================================================
// Cleanup
// =============================================================================

log('Cleaning up...')
serverProc.kill()
await sleep(1500)
for (const port of PORTS_TO_KILL) {
  await killPort(port)
}
ok('Done.')
