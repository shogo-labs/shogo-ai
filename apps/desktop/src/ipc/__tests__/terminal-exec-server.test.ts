// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * HTTP-contract tests for terminal-exec-server.
 *
 * The real Electron + PTY host can't run under `bun test`, so we mock both
 * before importing the module. These tests pin the security-critical edges of
 * the bridge — the auth gate, body-size cap, routing, and input validation —
 * by driving the actual `node:http` server over loopback. The command-runner
 * paths (executeViaPtyHost / executeInBackground) are intentionally NOT
 * exercised here; they require a live PTY host.
 */
import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test'

mock.module('electron', () => ({
  default: { BrowserWindow: { getAllWindows: () => [] } },
  BrowserWindow: { getAllWindows: () => [] },
}))

// Stub the lazily-imported PTY host so the fire-and-forget event subscription
// in startTerminalExecServer() stays headless and deterministic.
const fakeHost = {
  on() {},
  removeListener() {},
  list: async () => [],
  signal: async () => {},
  write: async () => {},
  spawn: async () => ({ id: 's1', cwd: null }),
  kill: async () => {},
}
mock.module('../../pty-host-client', () => ({
  getPtyHostClient: () => fakeHost,
}))

const {
  startTerminalExecServer,
  stopTerminalExecServer,
  getTerminalExecToken,
  getTerminalExecPort,
} = await import('../terminal-exec-server')

const AUTH_HEADER = 'x-shogo-bridge-token'

let baseUrl = ''
let token = ''

beforeAll(async () => {
  baseUrl = await startTerminalExecServer()
  token = getTerminalExecToken()
})

afterAll(() => {
  stopTerminalExecServer()
})

function authedHeaders(extra?: Record<string, string>): Record<string, string> {
  return { [AUTH_HEADER]: token, 'content-type': 'application/json', ...extra }
}

describe('terminal-exec-server — startup', () => {
  it('binds a loopback port and issues a non-empty hex token', () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(getTerminalExecPort()).toBeGreaterThan(0)
    expect(token).toMatch(/^[0-9a-f]{48}$/)
  })
})

describe('terminal-exec-server — auth gate', () => {
  it('rejects /terminal/exec with no token (401)', async () => {
    const res = await fetch(`${baseUrl}/terminal/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('rejects a wrong token (401)', async () => {
    const res = await fetch(`${baseUrl}/terminal/exec`, {
      method: 'POST',
      headers: authedHeaders({ [AUTH_HEADER]: 'deadbeef' }),
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects the interrupt route without a token (401)', async () => {
    const res = await fetch(`${baseUrl}/terminal/interrupt`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('allows CORS preflight (OPTIONS) without a token (204)', async () => {
    const res = await fetch(`${baseUrl}/terminal/exec`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
  })
})

describe('terminal-exec-server — routing & validation (authed)', () => {
  it('returns 404 for an unknown route', async () => {
    const res = await fetch(`${baseUrl}/nope`, { headers: authedHeaders() })
    expect(res.status).toBe(404)
  })

  it('rejects POST /terminal/exec with a missing command (400)', async () => {
    const res = await fetch(`${baseUrl}/terminal/exec`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('command')
  })

  it('rejects POST /terminal/exec with a non-string command (400)', async () => {
    const res = await fetch(`${baseUrl}/terminal/exec`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({ command: 123 }),
    })
    expect(res.status).toBe(400)
  })

  it('caps the request body size (does not accept >1MiB)', async () => {
    // The server destroys the request once the body exceeds the cap, so the
    // fetch may surface either a non-2xx response or a connection error —
    // both are acceptable; what matters is it is never accepted (2xx).
    let status = 0
    try {
      const res = await fetch(`${baseUrl}/terminal/exec`, {
        method: 'POST',
        headers: authedHeaders(),
        body: JSON.stringify({ command: 'x'.repeat(1024 * 1024 + 64) }),
      })
      status = res.status
    } catch {
      status = -1
    }
    expect(status === -1 || status >= 400).toBe(true)
  })
})

describe('terminal-exec-server — interrupt with no active command', () => {
  it('reports interrupted:false instead of touching the PTY host', async () => {
    const res = await fetch(`${baseUrl}/terminal/interrupt`, {
      method: 'POST',
      headers: authedHeaders(),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.interrupted).toBe(false)
    expect(body.error).toBeTruthy()
  })
})

describe('terminal-exec-server — shutdown', () => {
  it('clears the token and port on stop, and is idempotent', async () => {
    // Use a throwaway server lifecycle so we don't disturb the suite-wide one
    // (afterAll stops the shared instance). Stopping twice must not throw.
    stopTerminalExecServer()
    expect(getTerminalExecToken()).toBe('')
    expect(getTerminalExecPort()).toBe(0)
    stopTerminalExecServer()
    // Restart so afterAll's stop has a server to close (and to confirm restart).
    const url = await startTerminalExecServer()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
