// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio SDK Integration E2E Tests
 *
 * Validates the full Composio SDK-based integration:
 * - SDK client initialization
 * - Session creation (no MCP)
 * - Schema fetching with timing
 * - Direct tool execution via SDK
 * - Auth checking via connectedAccounts.list()
 * - Proxy tool registration and execution
 * - Timing infrastructure
 * - Session reset and error handling
 *
 * Requires COMPOSIO_API_KEY env var. Tests are skipped if not set.
 * Tests that require an authenticated connection (e.g. Gmail fetch)
 * are gated behind COMPOSIO_TEST_AUTHENTICATED=true.
 */

import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import {
  initComposioSession,
  resetComposioSession,
  isComposioInitialized,
  isComposioEnabled,
  getComposio,
  checkComposioAuth,
  registerToolkitProxyTools,
  getComposioTimings,
  clearComposioTimings,
  buildComposioUserId,
  buildLegacyComposioUserId,
} from '../composio'
import { fetchComposioToolSchemas } from '../composio-auto-bind'

const API_KEY = process.env.COMPOSIO_API_KEY
const SKIP = !API_KEY
const SKIP_AUTH = SKIP || process.env.COMPOSIO_TEST_AUTHENTICATED !== 'true'

const TEST_USER_ID = `e2e-test-${Date.now()}`
const TEST_WORKSPACE_ID = 'e2e-workspace'
const TEST_PROJECT_ID = 'e2e-project'

afterEach(() => {
  resetComposioSession()
  clearComposioTimings()
})

// ---------------------------------------------------------------------------
// SDK client initialization
// ---------------------------------------------------------------------------

describe('SDK client initialization', () => {
  test.skipIf(SKIP)('isComposioEnabled returns true when API key is set', () => {
    expect(isComposioEnabled()).toBe(true)
  })

  test.skipIf(SKIP)('getComposio returns a valid Composio instance', () => {
    const client = getComposio()
    expect(client).not.toBeNull()
    expect(client).toHaveProperty('tools')
    expect(client).toHaveProperty('connectedAccounts')
    expect(client).toHaveProperty('toolkits')
  })
})

// ---------------------------------------------------------------------------
// Session creation
// ---------------------------------------------------------------------------

describe('initComposioSession', () => {
  test.skipIf(SKIP)('creates session and sets initialized state', async () => {
    expect(isComposioInitialized()).toBe(false)

    const result = await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    expect(result).toBe(true)
    expect(isComposioInitialized()).toBe(true)
  })

  test.skipIf(SKIP)('returns true immediately if already initialized', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    const result = await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    expect(result).toBe(true)
  })

  test.skipIf(SKIP)('records session init timing', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)

    const timings = getComposioTimings()
    const initTiming = timings.find(t => t.operation === 'session init')
    expect(initTiming).toBeDefined()
    expect(initTiming!.durationMs).toBeGreaterThan(0)
    expect(initTiming!.timestamp).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Session reset
// ---------------------------------------------------------------------------

describe('resetComposioSession', () => {
  test.skipIf(SKIP)('clears initialized state', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    expect(isComposioInitialized()).toBe(true)

    resetComposioSession()
    expect(isComposioInitialized()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Schema fetch with timing
// ---------------------------------------------------------------------------

describe('fetchComposioToolSchemas with timing', () => {
  test.skipIf(SKIP)('fetches gmail schemas and logs timing', async () => {
    const schemas = await fetchComposioToolSchemas('gmail')
    expect(schemas.length).toBeGreaterThan(0)

    const hasFetchEmails = schemas.some(s => s.slug.includes('FETCH') || s.slug.includes('LIST'))
    expect(hasFetchEmails).toBe(true)
  })

  test.skipIf(SKIP)('schemas have expected structure', async () => {
    const schemas = await fetchComposioToolSchemas('gmail', { limit: 5 })
    for (const schema of schemas) {
      expect(schema.slug).toBeTruthy()
      expect(schema.name).toBeTruthy()
      expect(schema.input_parameters).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Direct tool execution via SDK
// ---------------------------------------------------------------------------

describe('direct SDK tool execution', () => {
  test.skipIf(SKIP_AUTH)('executes GMAIL_FETCH_EMAILS and returns data', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)

    const client = getComposio()!
    const composioUserId = buildComposioUserId(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)

    const t0 = performance.now()
    const result = await client.tools.execute('GMAIL_FETCH_EMAILS', {
      userId: composioUserId,
      arguments: { max_results: 10 },
      dangerouslySkipVersionCheck: true,
    })
    const elapsed = performance.now() - t0

    console.log(`[Test] GMAIL_FETCH_EMAILS took ${elapsed.toFixed(0)}ms`)
    console.log(`[Test] Result successful: ${result.successful}`)
    console.log(`[Test] Data keys: ${Object.keys(result.data || {})}`)

    expect(result).toHaveProperty('successful')
    expect(result).toHaveProperty('data')
    expect(result.successful).toBe(true)
    expect(result.error).toBeNull()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Tool execution timing
// ---------------------------------------------------------------------------

describe('tool execution timing', () => {
  test.skipIf(SKIP)('getComposioTimings returns empty array initially', () => {
    const timings = getComposioTimings()
    expect(timings).toEqual([])
  })

  test.skipIf(SKIP)('clearComposioTimings clears recorded timings', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    expect(getComposioTimings().length).toBeGreaterThan(0)

    clearComposioTimings()
    expect(getComposioTimings()).toEqual([])
  })

  test.skipIf(SKIP)('timings are immutable snapshots', async () => {
    await initComposioSession(TEST_USER_ID, TEST_WORKSPACE_ID, TEST_PROJECT_ID)
    const snapshot1 = getComposioTimings()
    const snapshot2 = getComposioTimings()
    expect(snapshot1).not.toBe(snapshot2)
    expect(snapshot1).toEqual(snapshot2)
  })
})

// ---------------------------------------------------------------------------
// Auth check via SDK
// ---------------------------------------------------------------------------

describe('checkComposioAuth', () => {
  test.skipIf(SKIP)('returns needs_auth when session not initialized', async () => {
    const result = await checkComposioAuth('gmail')
    expect(result.status).toBe('needs_auth')
  })

  test.skipIf(SKIP)('returns a valid status after session init', async () => {
    await initComposioSession(TEST_USER_ID, TEST_PROJECT_ID)
    const result = await checkComposioAuth('gmail')

    expect(['active', 'needs_auth']).toContain(result.status)
    if (result.status === 'needs_auth' && result.authUrl) {
      expect(result.authUrl).toMatch(/^https?:\/\//)
    }
  }, 30_000)

  test.skipIf(SKIP)('records auth check timing', async () => {
    await initComposioSession(TEST_USER_ID, TEST_PROJECT_ID)
    clearComposioTimings()

    await checkComposioAuth('gmail')

    const timings = getComposioTimings()
    const authTiming = timings.find(t => t.operation.includes('auth check'))
    expect(authTiming).toBeDefined()
    expect(authTiming!.durationMs).toBeGreaterThan(0)
  }, 30_000)

  test.skipIf(SKIP_AUTH)('returns active for authenticated toolkit', async () => {
    await initComposioSession(TEST_USER_ID, TEST_PROJECT_ID)
    const result = await checkComposioAuth('gmail')
    expect(result.status).toBe('active')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  test.skipIf(SKIP)('buildComposioUserId formats correctly', () => {
    const id = buildComposioUserId('user123', 'workspace789', 'project456')
    expect(id).toBe('shogo_user123_workspace789_project456')
  })

  test.skipIf(SKIP)('buildLegacyComposioUserId formats correctly', () => {
    const id = buildLegacyComposioUserId('user123', 'project456')
    expect(id).toBe('shogo_user123_project456')
  })
})
