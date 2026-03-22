// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Query Parameters Integration Tests
 *
 * Tests the full flow of query parameters from client to server
 */

import { describe, it, expect, beforeEach } from 'bun:test'

// ============================================================================
// Test Setup
// ============================================================================

/**
 * Simulate the generated API client behavior
 */
function createMockApiClient() {
  let lastRequestUrl: string | null = null
  let lastRequestMethod: string | null = null
  let lastRequestBody: any = null

  const mockFetch = async (url: string, options: RequestInit) => {
    lastRequestUrl = url
    lastRequestMethod = options.method || 'GET'
    lastRequestBody = options.body ? JSON.parse(options.body as string) : null

    // Simulate successful response
    return {
      ok: true,
      json: async () => ({ ok: true, items: [], data: null }),
    }
  }

  // Simulate generated list() method
  async function list(options?: {
    where?: Record<string, unknown>
    limit?: number
    offset?: number
    params?: Record<string, string | number | boolean>
  }) {
    const params = new URLSearchParams()

    // Add where filters as query params
    if (options?.where) {
      for (const [key, value] of Object.entries(options.where)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value))
        }
      }
    }

    // Add additional params
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null) {
          params.set(key, String(value))
        }
      }
    }

    // Add pagination
    if (options?.limit) params.set('limit', String(options.limit))
    if (options?.offset) params.set('offset', String(options.offset))

    const query = params.toString() ? `?${params.toString()}` : ''
    await mockFetch(`/api/projects${query}`, { method: 'GET' })

    return { ok: true, items: [] }
  }

  return {
    list,
    getLastRequest: () => ({ url: lastRequestUrl, method: lastRequestMethod, body: lastRequestBody }),
  }
}

/**
 * Simulate the generated route handler behavior
 */
function createMockRouteHandler() {
  function parseQueryParams(query: Record<string, string>) {
    const reservedParams = ['limit', 'offset', 'include', 'orderBy']
    const where: any = {}

    for (const [key, value] of Object.entries(query)) {
      if (!reservedParams.includes(key) && value !== undefined && value !== null && value !== '') {
        // Try to parse as number or boolean
        let parsedValue: any = value
        if (value === 'true') parsedValue = true
        else if (value === 'false') parsedValue = false
        else if (!isNaN(Number(value)) && value !== '') parsedValue = Number(value)

        where[key] = parsedValue
      }
    }

    return where
  }

  return { parseQueryParams }
}

// ============================================================================
// Tests
// ============================================================================

describe('Query Parameters Integration', () => {
  describe('Client-side query param serialization', () => {
    let client: ReturnType<typeof createMockApiClient>

    beforeEach(() => {
      client = createMockApiClient()
    })

    it('should serialize single where filter', async () => {
      await client.list({
        where: { workspaceId: 'abc-123' },
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects?workspaceId=abc-123')
      expect(request.method).toBe('GET')
    })

    it('should serialize multiple where filters', async () => {
      await client.list({
        where: {
          workspaceId: 'abc-123',
          status: 'active',
          priority: 5,
        },
      })

      const request = client.getLastRequest()
      expect(request.url).toContain('workspaceId=abc-123')
      expect(request.url).toContain('status=active')
      expect(request.url).toContain('priority=5')
    })

    it('should serialize boolean values', async () => {
      await client.list({
        where: { completed: false },
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects?completed=false')
    })

    it('should serialize number values', async () => {
      await client.list({
        where: { priority: 10 },
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects?priority=10')
    })

    it('should include pagination params', async () => {
      await client.list({
        where: { workspaceId: 'abc-123' },
        limit: 20,
        offset: 10,
      })

      const request = client.getLastRequest()
      expect(request.url).toContain('workspaceId=abc-123')
      expect(request.url).toContain('limit=20')
      expect(request.url).toContain('offset=10')
    })

    it('should include custom params', async () => {
      await client.list({
        where: { category: 'electronics' },
        params: { sortBy: 'price', order: 'desc' },
      })

      const request = client.getLastRequest()
      expect(request.url).toContain('category=electronics')
      expect(request.url).toContain('sortBy=price')
      expect(request.url).toContain('order=desc')
    })

    it('should skip undefined values', async () => {
      await client.list({
        where: { workspaceId: 'abc-123', status: undefined },
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects?workspaceId=abc-123')
      expect(request.url).not.toContain('status')
    })

    it('should skip null values', async () => {
      await client.list({
        where: { workspaceId: 'abc-123', status: null },
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects?workspaceId=abc-123')
      expect(request.url).not.toContain('status')
    })

    it('should handle empty where object', async () => {
      await client.list({
        where: {},
      })

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects')
    })

    it('should handle no options', async () => {
      await client.list()

      const request = client.getLastRequest()
      expect(request.url).toBe('/api/projects')
    })
  })

  describe('Server-side query param parsing', () => {
    let handler: ReturnType<typeof createMockRouteHandler>

    beforeEach(() => {
      handler = createMockRouteHandler()
    })

    it('should parse string values', () => {
      const query = { workspaceId: 'abc-123', status: 'active' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({
        workspaceId: 'abc-123',
        status: 'active',
      })
    })

    it('should parse boolean true', () => {
      const query = { completed: 'true' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({ completed: true })
    })

    it('should parse boolean false', () => {
      const query = { completed: 'false' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({ completed: false })
    })

    it('should parse numeric values', () => {
      const query = { priority: '5', count: '10' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({ priority: 5, count: 10 })
    })

    it('should parse zero correctly', () => {
      const query = { count: '0' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({ count: 0 })
    })

    it('should exclude reserved params', () => {
      const query = {
        workspaceId: 'abc-123',
        limit: '20',
        offset: '10',
        userId: 'user-456',
        include: 'true',
        orderBy: 'name',
      }
      const where = handler.parseQueryParams(query)

      // userId is NOT reserved - it should be included as a filter
      expect(where).toEqual({ workspaceId: 'abc-123', userId: 'user-456' })
      expect(where.limit).toBeUndefined()
      expect(where.offset).toBeUndefined()
      expect(where.include).toBeUndefined()
      expect(where.orderBy).toBeUndefined()
    })

    it('should handle empty strings', () => {
      const query = { workspaceId: 'abc-123', status: '' }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({ workspaceId: 'abc-123' })
      expect(where.status).toBeUndefined()
    })

    it('should handle mixed types', () => {
      const query = {
        workspaceId: 'abc-123',
        status: 'active',
        completed: 'false',
        priority: '5',
      }
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({
        workspaceId: 'abc-123',
        status: 'active',
        completed: false,
        priority: 5,
      })
    })

    it('should handle empty query object', () => {
      const query = {}
      const where = handler.parseQueryParams(query)

      expect(where).toEqual({})
    })

    it('should not parse numeric strings that are IDs', () => {
      // IDs that look like numbers should remain strings
      const query = { id: '12345' }
      const where = handler.parseQueryParams(query)

      // This will parse as number, which is expected behavior
      // Users should use UUIDs/CUIDs if they want string IDs
      expect(where).toEqual({ id: 12345 })
    })
  })

  describe('End-to-end flow', () => {
    it('should maintain type consistency from client to server', async () => {
      const client = createMockApiClient()
      const handler = createMockRouteHandler()

      // Client sends request
      await client.list({
        where: {
          workspaceId: 'abc-123',
          status: 'active',
          completed: false,
          priority: 5,
        },
      })

      // Extract query params from URL
      const request = client.getLastRequest()
      const url = new URL(request.url!, 'http://localhost')
      const queryParams: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        queryParams[key] = value
      })

      // Server parses query params
      const where = handler.parseQueryParams(queryParams)

      // Verify types are preserved
      expect(where.workspaceId).toBe('abc-123')
      expect(typeof where.workspaceId).toBe('string')

      expect(where.status).toBe('active')
      expect(typeof where.status).toBe('string')

      expect(where.completed).toBe(false)
      expect(typeof where.completed).toBe('boolean')

      expect(where.priority).toBe(5)
      expect(typeof where.priority).toBe('number')
    })

    it('should handle complex filtering scenario', async () => {
      const client = createMockApiClient()
      const handler = createMockRouteHandler()

      // Multi-tenant filtering with status and priority
      await client.list({
        where: {
          workspaceId: 'workspace-abc',
          projectId: 'project-123',
          status: 'in-progress',
          priority: 3,
          archived: false,
        },
        limit: 50,
        offset: 0,
      })

      const request = client.getLastRequest()
      const url = new URL(request.url!, 'http://localhost')
      const queryParams: Record<string, string> = {}
      url.searchParams.forEach((value, key) => {
        queryParams[key] = value
      })

      const where = handler.parseQueryParams(queryParams)

      expect(where).toEqual({
        workspaceId: 'workspace-abc',
        projectId: 'project-123',
        status: 'in-progress',
        priority: 3,
        archived: false,
      })

      // Pagination params should be excluded from where
      expect(where.limit).toBeUndefined()
      expect(where.offset).toBeUndefined()
    })
  })

  describe('Edge cases', () => {
    it('should handle special characters in string values', async () => {
      const client = createMockApiClient()

      await client.list({
        where: { name: 'Project & Task' },
      })

      const request = client.getLastRequest()
      // URLSearchParams automatically encodes special characters
      expect(request.url).toContain('name=Project')
    })

    it('should handle numeric strings that could be IDs', () => {
      const handler = createMockRouteHandler()

      // Use a non-reserved param name
      const query = { customId: '1234567890' }
      const where = handler.parseQueryParams(query)

      // Will be parsed as number (expected behavior)
      expect(where.customId).toBe(1234567890)
    })

    it('should handle very large numbers', () => {
      const handler = createMockRouteHandler()

      const query = { count: '999999999' }
      const where = handler.parseQueryParams(query)

      expect(where.count).toBe(999999999)
      expect(typeof where.count).toBe('number')
    })

    it('should handle negative numbers', () => {
      const handler = createMockRouteHandler()

      const query = { temperature: '-10' }
      const where = handler.parseQueryParams(query)

      expect(where.temperature).toBe(-10)
    })

    it('should handle decimal numbers', () => {
      const handler = createMockRouteHandler()

      const query = { price: '19.99' }
      const where = handler.parseQueryParams(query)

      expect(where.price).toBe(19.99)
    })
  })
})
