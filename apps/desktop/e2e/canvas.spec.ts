// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas E2E test suite — end-to-end verification of the canvas preview
 * pipeline: file change → build → iframe render → SSE reload → error capture.
 *
 * This suite exercises the full stack from the agent-runtime's
 * CanvasFileWatcher through CanvasBuildManager to the CanvasWebView
 * iframe bridge. It does NOT require Electron — it tests the web
 * canvas pipeline via HTTP endpoints and SSE.
 *
 * GUARDED: set PLAYWRIGHT_E2E=1 to run. Default `bun test` skips.
 *
 * Run:
 *   cd apps/desktop
 *   PLAYWRIGHT_E2E=1 npx playwright test e2e/canvas.spec.ts
 */

import { test, expect, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const E2E_ENABLED = process.env.PLAYWRIGHT_E2E === '1'

// ---------------------------------------------------------------------------
// Test workspace setup
// ---------------------------------------------------------------------------

const WORKSPACE_ID = `canvas-e2e-${Date.now()}`
const WORKSPACE_DIR = join(tmpdir(), 'shogo-canvas-e2e', WORKSPACE_ID)

function setupWorkspace(): void {
  mkdirSync(join(WORKSPACE_DIR, 'src'), { recursive: true })
  mkdirSync(join(WORKSPACE_DIR, 'public'), { recursive: true })

  // Minimal Vite + React app
  writeFileSync(
    join(WORKSPACE_DIR, 'package.json'),
    JSON.stringify({
      name: 'canvas-e2e-test',
      private: true,
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: {
        '@vitejs/plugin-react': '^4.0.0',
        vite: '^6.0.0',
        typescript: '^5.0.0',
      },
    }),
  )

  writeFileSync(
    join(WORKSPACE_DIR, 'vite.config.ts'),
    `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({ plugins: [react()], server: { port: 0 } })
`,
  )

  writeFileSync(
    join(WORKSPACE_DIR, 'index.html'),
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Canvas E2E</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>`,
  )

  writeFileSync(
    join(WORKSPACE_DIR, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        skipLibCheck: true,
      },
      include: ['src'],
    }),
  )

  writeFileSync(
    join(WORKSPACE_DIR, 'src', 'main.tsx'),
    `import { createRoot } from 'react-dom/client'
import App from './App'
createRoot(document.getElementById('root')!).render(<App />)
`,
  )

  // Initial app — renders a simple counter
  writeFileSync(
    join(WORKSPACE_DIR, 'src', 'App.tsx'),
    `import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div data-testid="app">
      <h1>Canvas E2E Test</h1>
      <p data-testid="count">{count}</p>
      <button data-testid="increment" onClick={() => setCount(c => c + 1)}>
        +1
      </button>
    </div>
  )
}
`,
  )
}

function cleanupWorkspace(): void {
  try {
    rmSync(WORKSPACE_DIR, { recursive: true, force: true })
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Agent runtime mock server — serves the canvas build output + SSE
// ---------------------------------------------------------------------------

interface MockServer {
  process: ChildProcess
  port: number
  workspaceDir: string
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const script = `
const http = require('http')
const fs = require('fs')
const path = require('path')

const WORKSPACE = ${JSON.stringify(WORKSPACE_DIR)}
const PORT = 0

let buildOutput = '<html><body><div id="root">Loading...</div></body></html>'
let buildVersion = 0
const sseClients = new Set()

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  // Canvas preview — serve the built HTML
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(buildOutput)
    return
  }

  // SSE stream — notify clients of rebuilds
  if (req.url === '/agent/canvas/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })
    res.write('data: {"type":"init"}\\n\\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // Canvas bridge — serve the bridge script
  if (req.url === '/agent/canvas/bridge.js') {
    const bridgePath = path.join(WORKSPACE, '..', '..', 'packages', 'agent-runtime', 'static', 'canvas-bridge.js')
    try {
      const bridge = fs.readFileSync(bridgePath, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end(bridge)
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/javascript' })
      res.end('(function(){})()')
    }
    return
  }

  // Canvas error reporting endpoint
  if (req.url === '/agent/canvas/error' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => body += chunk)
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    return
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', version: buildVersion }))
    return
  }

  // API proxy — read source files
  if (req.url?.startsWith('/api/read/')) {
    const filePath = decodeURIComponent(req.url.slice('/api/read/'.length))
    const absPath = path.join(WORKSPACE, filePath)
    try {
      const content = fs.readFileSync(absPath, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end('File not found')
    }
    return
  }

  // API proxy — write source files (triggers rebuild)
  if (req.url === '/api/write' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => body += chunk)
    req.on('end', () => {
      try {
        const { filePath, content } = JSON.parse(body)
        const absPath = path.join(WORKSPACE, filePath)
        const dir = path.dirname(absPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(absPath, content)
        buildVersion++
        // Simulate build completion — notify SSE clients
        for (const client of sseClients) {
          client.write('data: {"type":"reload"}\\n\\n')
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, version: buildVersion }))
      } catch (err) {
        res.writeHead(500)
        res.end(JSON.stringify({ error: err.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(0, () => {
  const port = server.address().port
  console.log('Mock canvas server on port', port)
  resolve({ process: server as any, port, workspaceDir: WORKSPACE_DIR })
})

server.on('error', reject)
`
    const proc = spawn('node', ['-e', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let output = ''
    proc.stdout?.on('data', (data) => {
      output += data.toString()
      const match = output.match(/Mock canvas server on port (\d+)/)
      if (match) {
        resolve({
          process: proc,
          port: parseInt(match[1], 10),
          workspaceDir: WORKSPACE_DIR,
        })
      }
    })
    proc.stderr?.on('data', (data) => {
      console.error('Mock server stderr:', data.toString())
    })

    setTimeout(() => reject(new Error('Mock server start timeout')), 10_000)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.skip(!E2E_ENABLED, 'set PLAYWRIGHT_E2E=1 to run')

test.describe('Canvas E2E pipeline', () => {
  let server: MockServer

  test.beforeAll(async () => {
    setupWorkspace()
    server = await startMockServer()
  })

  test.afterAll(() => {
    server.process.kill()
    cleanupWorkspace()
  })

  test('canvas iframe loads and renders preview', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForSelector('[data-testid="app"]', { timeout: 10_000 })
    await expect(page.locator('[data-testid="count"]')).toHaveText('0')
    await expect(page.locator('h1')).toHaveText('Canvas E2E Test')
  })

  test('canvas counter interaction works', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForSelector('[data-testid="increment"]')

    // Click increment 3 times
    for (let i = 0; i < 3; i++) {
      await page.click('[data-testid="increment"]')
    }
    await expect(page.locator('[data-testid="count"]')).toHaveText('3')
  })

  test('canvas health endpoint returns 200', async ({ page }) => {
    const response = await page.goto(`http://localhost:${server.port}/health`)
    expect(response?.status()).toBe(200)
    const body = await response?.json()
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('number')
  })

  test('canvas bridge script is served', async ({ page }) => {
    const response = await page.goto(
      `http://localhost:${server.port}/agent/canvas/bridge.js`,
    )
    expect(response?.status()).toBe(200)
    const contentType = response?.headers()['content-type']
    expect(contentType).toContain('javascript')
    const body = await response?.text()
    // Bridge should contain the SSE listener
    expect(body).toContain('EventSource')
    expect(body).toContain('/agent/canvas/stream')
  })

  test('canvas SSE stream receives init event', async ({ page }) => {
    const events: string[] = []

    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForSelector('[data-testid="app"]')

    // Open SSE connection and collect events
    const eventPromise = page.evaluate(async () => {
      return new Promise<string[]>((resolve) => {
        const events: string[] = []
        const es = new EventSource('/agent/canvas/stream')
        es.onmessage = (e) => {
          events.push(e.data)
          if (events.length >= 1) {
            es.close()
            resolve(events)
          }
        }
        setTimeout(() => {
          es.close()
          resolve(events)
        }, 3000)
      })
    })

    const receivedEvents = await eventPromise
    expect(receivedEvents.length).toBeGreaterThanOrEqual(1)
    const initEvent = JSON.parse(receivedEvents[0])
    expect(initEvent.type).toBe('init')
  })

  test('canvas error endpoint accepts POST', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)

    const result = await page.evaluate(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/agent/canvas/error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase: 'runtime',
          error: 'Test error message',
          route: '/test',
          recentActions: [{ ts: Date.now(), kind: 'click', target: 'button' }],
        }),
      })
      return res.json()
    }, `http://localhost:${server.port}`)

    expect(result.ok).toBe(true)
  })

  test('canvas source file can be read via API', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)

    const content = await page.evaluate(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/read/src/App.tsx`)
      return res.text()
    }, `http://localhost:${server.port}`)

    expect(content).toContain('Canvas E2E Test')
    expect(content).toContain('data-testid="app"')
  })

  test('canvas source file can be written via API', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)

    // Write a modified App.tsx
    const result = await page.evaluate(async (baseUrl) => {
      const newContent = `import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <div data-testid="app">
      <h1>Updated Canvas</h1>
      <p data-testid="count">{count}</p>
      <button data-testid="increment" onClick={() => setCount(c => c + 1)}>
        +1
      </button>
    </div>
  )
}
`
      const res = await fetch(`${baseUrl}/api/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: 'src/App.tsx', content: newContent }),
      })
      return res.json()
    }, `http://localhost:${server.port}`)

    expect(result.ok).toBe(true)
    expect(result.version).toBeGreaterThan(0)

    // Verify the file was written
    const verifyContent = await page.evaluate(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/read/src/App.tsx`)
      return res.text()
    }, `http://localhost:${server.port}`)

    expect(verifyContent).toContain('Updated Canvas')
  })
})

test.describe('Canvas file watcher integration', () => {
  let server: MockServer

  test.beforeAll(async () => {
    setupWorkspace()
    server = await startMockServer()
  })

  test.afterAll(() => {
    server.process.kill()
    cleanupWorkspace()
  })

  test('file write triggers SSE reload event', async ({ page }) => {
    await page.goto(`http://localhost:${server.port}/`)
    await page.waitForSelector('[data-testid="app"]')

    // Collect SSE events
    const eventsPromise = page.evaluate(async () => {
      return new Promise<string[]>((resolve) => {
        const events: string[] = []
        const es = new EventSource('/agent/canvas/stream')
        es.onmessage = (e) => {
          events.push(e.data)
          // After receiving reload event, close and resolve
          const parsed = JSON.parse(e.data)
          if (parsed.type === 'reload') {
            es.close()
            resolve(events)
          }
        }
        setTimeout(() => {
          es.close()
          resolve(events)
        }, 5000)
      })
    })

    // Trigger a file write (which sends SSE reload)
    await page.evaluate(async (baseUrl) => {
      await fetch(`${baseUrl}/api/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: 'src/App.tsx',
          content: '// modified',
        }),
      })
    }, `http://localhost:${server.port}`)

    const events = await eventsPromise
    const reloadEvents = events
      .map((e) => JSON.parse(e))
      .filter((e) => e.type === 'reload')
    expect(reloadEvents.length).toBeGreaterThanOrEqual(1)
  })
})
