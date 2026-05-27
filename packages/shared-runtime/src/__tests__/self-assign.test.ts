// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

const originalEnv = { ...process.env }

const mockFetch = mock((url: string, options?: any) => {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({
      projectId: 'test-project-123',
      env: {
        PROJECT_ID: 'test-project-123',
        AI_PROXY_TOKEN: 'test-token',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
      },
    }),
  })
})
global.fetch = mockFetch as any

describe('Self-Assign', () => {
  beforeEach(() => {
    mockFetch.mockClear()
    process.env = { ...originalEnv }
    delete process.env.ASSIGNED_PROJECT
    delete process.env.SHOGO_API_URL
    delete process.env.API_URL
    delete process.env.AI_PROXY_URL
    delete process.env.KNATIVE_SERVICE_NAME
    delete process.env.WORKSPACE_DIR
    process.env.SYSTEM_NAMESPACE = 'test-system'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('should return null when no ASSIGNED_PROJECT env var', async () => {
    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign()
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('should return null when ASSIGNED_PROJECT is __POOL__', async () => {
    process.env.ASSIGNED_PROJECT = '__POOL__'
    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign()
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('should return null when ASSIGNED_PROJECT is empty', async () => {
    process.env.ASSIGNED_PROJECT = ''
    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign()
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('should fetch config when ASSIGNED_PROJECT is set', async () => {
    process.env.ASSIGNED_PROJECT = 'test-project-123'
    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign('http://api.test-system.svc.cluster.local')

    expect(result).not.toBeNull()
    expect(result!.projectId).toBe('test-project-123')
    expect(result!.env.PROJECT_ID).toBe('test-project-123')
    expect(result!.env.AI_PROXY_TOKEN).toBe('test-token')

    expect(mockFetch).toHaveBeenCalledWith(
      'http://api.test-system.svc.cluster.local/api/internal/pod-config/test-project-123',
      expect.objectContaining({ method: 'GET' })
    )
  })

  test('should derive API URL from AI_PROXY_URL', async () => {
    process.env.ASSIGNED_PROJECT = 'test-project-456'
    process.env.AI_PROXY_URL = 'http://api.my-ns.svc.cluster.local/api/ai/v1'
    const { checkSelfAssign } = await import('../self-assign')
    await checkSelfAssign()

    expect(mockFetch).toHaveBeenCalledWith(
      'http://api.my-ns.svc.cluster.local/api/internal/pod-config/test-project-456',
      expect.anything()
    )
  })

  test('should return null when config fetch fails', async () => {
    process.env.ASSIGNED_PROJECT = 'test-project-fail'
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve('Internal Server Error'),
    } as any)

    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign('http://api.test.local')
    expect(result).toBeNull()
  })

  test('should return null when fetch throws', async () => {
    process.env.ASSIGNED_PROJECT = 'test-project-throw'
    mockFetch.mockRejectedValueOnce(new Error('Network error'))

    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign('http://api.test.local')
    expect(result).toBeNull()
  })
})

describe('Self-Assign whoami fallback', () => {
  beforeEach(async () => {
    mockFetch.mockClear()
    process.env = { ...originalEnv }
    delete process.env.ASSIGNED_PROJECT
    delete process.env.SHOGO_API_URL
    delete process.env.API_URL
    delete process.env.AI_PROXY_URL
    delete process.env.WORKSPACE_DIR
    process.env.SYSTEM_NAMESPACE = 'test-system'
    // Override the K8s SA token so the whoami branch can authenticate
    // without touching /var/run/secrets/...
    process.env.K8S_SA_TOKEN_OVERRIDE = 'fake-sa-token'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('skips whoami when KNATIVE_SERVICE_NAME is unset', async () => {
    delete process.env.KNATIVE_SERVICE_NAME
    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('discovers project via whoami when env + marker are absent', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-abc123'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projectId: 'recovered-project-id' }),
    } as any)

    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')

    expect(result).toBe('recovered-project-id')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const call = mockFetch.mock.calls[0]
    expect(call[0]).toBe('http://api.test.local/api/internal/whoami/warm-pool-abc123')
    const init = call[1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer fake-sa-token')
  })

  test('treats whoami 200 with projectId=null as not assigned', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-pool-only'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projectId: null }),
    } as any)

    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')
    expect(result).toBeNull()
  })

  test('returns null when whoami returns non-2xx', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-xyz'
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    } as any)

    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')
    expect(result).toBeNull()
  })

  test('returns null when whoami non-2xx and res.text() also rejects (covers .catch arrow)', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-text-fail'
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.reject(new Error('body unreadable')),
    } as any)
    const { discoverAssignedProject } = await import('../self-assign')
    const r = await discoverAssignedProject(undefined, 'http://api.test.local')
    expect(r).toBeNull()
  })

  test('returns null when whoami fetch throws', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-net-fail'
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')
    expect(result).toBeNull()
  })

  test('skips whoami when SA token is unavailable', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-no-token'
    delete process.env.K8S_SA_TOKEN_OVERRIDE

    const { discoverAssignedProject, _selfAssignSeams } = await import('../self-assign')
    const prevPath = _selfAssignSeams.saTokenPath
    _selfAssignSeams.saTokenPath = '/dev/null/nonexistent-sa-token-path'
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')
    _selfAssignSeams.saTokenPath = prevPath
    expect(result).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('ASSIGNED_PROJECT takes priority over whoami', async () => {
    process.env.ASSIGNED_PROJECT = 'env-project'
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-should-be-ignored'

    const { discoverAssignedProject } = await import('../self-assign')
    const result = await discoverAssignedProject(undefined, 'http://api.test.local')

    expect(result).toBe('env-project')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('checkSelfAssign uses whoami fallback then fetches pod-config', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'warm-pool-recover'
    process.env.SHOGO_API_URL = 'http://api.test.local'
    // First call: whoami → projectId. Second call: pod-config → env.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projectId: 'recovered' }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          projectId: 'recovered',
          env: {
            PROJECT_ID: 'recovered',
            AI_PROXY_TOKEN: 'fresh',
            RUNTIME_AUTH_SECRET: 'fresh-secret',
          },
        }),
      } as any)

    const { checkSelfAssign } = await import('../self-assign')
    const result = await checkSelfAssign('http://api.test.local')

    expect(result).not.toBeNull()
    expect(result!.projectId).toBe('recovered')
    expect(result!.env.RUNTIME_AUTH_SECRET).toBe('fresh-secret')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[0][0]).toBe('http://api.test.local/api/internal/whoami/warm-pool-recover')
    expect(mockFetch.mock.calls[1][0]).toBe('http://api.test.local/api/internal/pod-config/recovered')
  })
})

describe('self-assign gap coverage', () => {
  const { mkdirSync, writeFileSync, rmSync } = require('node:fs')
  const { join: pj } = require('node:path')
  const origEnv = { ...process.env }

  beforeEach(async () => {
    mockFetch.mockClear()
    process.env = { ...origEnv }
    delete process.env.ASSIGNED_PROJECT
    delete process.env.SHOGO_API_URL
    delete process.env.API_URL
    delete process.env.AI_PROXY_URL
    delete process.env.KNATIVE_SERVICE_NAME
    delete process.env.WORKSPACE_DIR
    delete process.env.K8S_SA_TOKEN_OVERRIDE
    process.env.SYSTEM_NAMESPACE = 'test-system'
    const m = await import('../self-assign')
    m._selfAssignSeams.saTokenPath = '/nonexistent-sa-token-path'
    m._selfAssignSeams.overrideDeriveApiUrl = null
  })

  afterEach(() => { process.env = { ...origEnv } })

  test('DA:51 — checkSelfAssign returns null when no assignment found', async () => {
    const { checkSelfAssign } = await import('../self-assign')
    expect(await checkSelfAssign('http://api.test.local')).toBeNull()
  })

  test('DA:57,58 — dead !baseUrl guard via overrideDeriveApiUrl seam', async () => {
    process.env.ASSIGNED_PROJECT = 'proj-deadcode'
    const { checkSelfAssign, _selfAssignSeams } = await import('../self-assign')
    _selfAssignSeams.overrideDeriveApiUrl = () => null
    try {
      expect(await checkSelfAssign()).toBeNull()
    } finally { _selfAssignSeams.overrideDeriveApiUrl = null }
  })

  test('DA:114 — readSAToken returns token when saTokenPath exists', async () => {
    const tmp = '/tmp/__sa-token-test__'
    writeFileSync(tmp, '  my-token  ', 'utf-8')
    const { readSAToken, _selfAssignSeams } = await import('../self-assign')
    _selfAssignSeams.saTokenPath = tmp
    try {
      expect(readSAToken()).toBe('my-token')
    } finally {
      _selfAssignSeams.saTokenPath = '/nonexistent-sa-token-path'
      rmSync(tmp, { force: true })
    }
  })

  test('DA:115 — readSAToken catch fires when saTokenPath is a directory', async () => {
    const tmp = '/tmp/__sa-token-dir-test__'
    mkdirSync(tmp, { recursive: true })
    const { readSAToken, _selfAssignSeams } = await import('../self-assign')
    _selfAssignSeams.saTokenPath = tmp
    try {
      expect(readSAToken()).toBeNull()
    } finally {
      _selfAssignSeams.saTokenPath = '/nonexistent-sa-token-path'
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('DA:140 — deriveApiUrl catch fires for unparseable AI_PROXY_URL', async () => {
    process.env.AI_PROXY_URL = 'not a valid url'
    const { deriveApiUrl } = await import('../self-assign')
    expect(deriveApiUrl()).toContain('test-system')
  })

  test('DA:160,161 — readAssignmentMarker returns valid project from marker file', async () => {
    const tmp = '/tmp/__marker-test__'
    mkdirSync(tmp, { recursive: true })
    writeFileSync(pj(tmp, '.shogo-pool-assignment'), 'marker-proj-id', 'utf-8')
    const { discoverAssignedProject } = await import('../self-assign')
    try {
      expect(await discoverAssignedProject(tmp, null)).toBe('marker-proj-id')
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test('DA:162 — readAssignmentMarker catch fires when marker is a directory', async () => {
    const tmp = '/tmp/__marker-catch-test__'
    mkdirSync(pj(tmp, '.shogo-pool-assignment'), { recursive: true })
    const { discoverAssignedProject } = await import('../self-assign')
    try {
      expect(await discoverAssignedProject(tmp, null)).toBeNull()
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test('DA:168 — readAssignmentMarker skips __POOL__ marker', async () => {
    const tmp = '/tmp/__marker-pool-test__'
    mkdirSync(tmp, { recursive: true })
    writeFileSync(pj(tmp, '.shogo-pool-assignment'), '__POOL__', 'utf-8')
    const { discoverAssignedProject } = await import('../self-assign')
    try {
      expect(await discoverAssignedProject(tmp, null)).toBeNull()
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test('DA:205,206 — whoamiLookup warns when KNATIVE set but no apiUrl', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'no-url'
    process.env.K8S_SA_TOKEN_OVERRIDE = 'tok'
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    const { discoverAssignedProject } = await import('../self-assign')
    try {
      expect(await discoverAssignedProject(undefined, null)).toBeNull()
      expect(warns.some(w => w.includes('no API URL'))).toBe(true)
    } finally { console.warn = origWarn }
  })

  test('DA:212 — whoamiLookup returns null when KNATIVE set but no SA token', async () => {
    process.env.KNATIVE_SERVICE_NAME = 'no-token'
    const { discoverAssignedProject } = await import('../self-assign')
    expect(await discoverAssignedProject(undefined, 'http://api.test.local')).toBeNull()
  })
})
