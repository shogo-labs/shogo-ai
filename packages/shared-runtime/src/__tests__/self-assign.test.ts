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
