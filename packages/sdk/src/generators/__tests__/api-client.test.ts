/**
 * API Client Generator Tests
 *
 * Tests that the generated API client code properly handles query parameters
 */

import { describe, it, expect } from 'bun:test'
import { generateApiClient } from '../api-client'
import type { PrismaModel } from '../prisma-generator'

// ============================================================================
// Test Fixtures
// ============================================================================

const mockProjectModel: PrismaModel = {
  name: 'Project',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'workspaceId', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'status', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
    { name: 'createdAt', kind: 'scalar', type: 'DateTime', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: true },
  ],
}

const mockWorkspaceModel: PrismaModel = {
  name: 'Workspace',
  dbName: null,
  fields: [
    { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
    { name: 'name', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: false, isUnique: false, hasDefaultValue: false },
  ],
}

// ============================================================================
// Tests
// ============================================================================

describe('API Client Generator', () => {
  it('should generate client code with correct structure', () => {
    const code = generateApiClient([mockProjectModel])

    expect(code).toContain('export interface ApiResponse<T>')
    expect(code).toContain('export interface ApiClientConfig')
    expect(code).toContain('export function configureApiClient')
    expect(code).toContain('export const projectApi')
    expect(code).toContain('export const api')
  })

  it('should include type imports', () => {
    const code = generateApiClient([mockProjectModel])

    expect(code).toContain("import type {")
    expect(code).toContain("ProjectType,")
    expect(code).toContain("ProjectCreateInput,")
    expect(code).toContain("ProjectUpdateInput,")
    expect(code).toContain("} from './types'")
  })

  describe('list() method', () => {
    it('should generate list method with query parameter support', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async list(options?: {')
      expect(code).toContain('where?: Record<string, unknown>')
      expect(code).toContain('limit?: number')
      expect(code).toContain('offset?: number')
      expect(code).toContain('params?: Record<string, string | number | boolean>')
    })

    it('should include documentation for query parameters', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('@param options - Query options including where filters')
      expect(code).toContain('@param options.where - Filter conditions (passed as query params to the API)')
      expect(code).toContain('@param options.params - Additional query parameters')
    })

    it('should serialize where filters to query params', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('// Add where filters as query params')
      expect(code).toContain('if (options?.where) {')
      expect(code).toContain('for (const [key, value] of Object.entries(options.where)) {')
      expect(code).toContain('if (value !== undefined && value !== null) {')
      expect(code).toContain('params.set(key, String(value))')
    })

    it('should serialize custom params to query params', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('// Add additional params')
      expect(code).toContain('if (options?.params) {')
      expect(code).toContain('for (const [key, value] of Object.entries(options.params)) {')
      expect(code).toContain('if (value !== undefined && value !== null) {')
      expect(code).toContain('params.set(key, String(value))')
    })

    it('should include pagination params', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('if (options?.limit) params.set(\'limit\', String(options.limit))')
      expect(code).toContain('if (options?.offset) params.set(\'offset\', String(options.offset))')
    })

    it('should include userId if configured', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('if (config.userId) params.set(\'userId\', config.userId)')
    })

    it('should construct query string correctly', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('const query = params.toString() ? `?${params.toString()}` : \'\'')
      expect(code).toContain('const result = await request<ProjectType>(\'GET\', `/projects${query}`)')
    })
  })

  describe('get() method', () => {
    it('should generate get by ID method', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async get(id: string): Promise<ApiResponse<ProjectType>>')
      expect(code).toContain('return request<ProjectType>(\'GET\', `/projects/${id}`)')
    })
  })

  describe('create() method', () => {
    it('should generate create method', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async create(input: ProjectCreateInput): Promise<ApiResponse<ProjectType>>')
      expect(code).toContain('const body = config.userId ? { ...input, userId: config.userId } : input')
      expect(code).toContain('return request<ProjectType>(\'POST\', `/projects`, body)')
    })
  })

  describe('update() method', () => {
    it('should generate update method', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async update(id: string, input: ProjectUpdateInput): Promise<ApiResponse<ProjectType>>')
      expect(code).toContain('return request<ProjectType>(\'PATCH\', `/projects/${id}`, input)')
    })
  })

  describe('delete() method', () => {
    it('should generate delete method', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async delete(id: string): Promise<ApiResponse<void>>')
      expect(code).toContain('return request<void>(\'DELETE\', `/projects/${id}`)')
    })
  })

  describe('combined API client', () => {
    it('should generate combined API object for multiple models', () => {
      const code = generateApiClient([mockWorkspaceModel, mockProjectModel])

      expect(code).toContain('export const api = {')
      expect(code).toContain('workspace: workspaceApi,')
      expect(code).toContain('project: projectApi,')
      expect(code).toContain('}')
      expect(code).toContain('export default api')
    })
  })

  describe('request helper', () => {
    it('should generate request helper function', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('async function request<T>(')
      expect(code).toContain('method: string,')
      expect(code).toContain('path: string,')
      expect(code).toContain('body?: unknown')
      expect(code).toContain('): Promise<ApiResponse<T>>')
    })

    it('should include error handling', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('try {')
      expect(code).toContain('} catch (error) {')
      expect(code).toContain('return {')
      expect(code).toContain('ok: false,')
      expect(code).toContain('error: {')
      expect(code).toContain('code: \'network_error\',')
    })

    it('should include authorization header support', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('if (config.token) {')
      expect(code).toContain('headers[\'Authorization\'] = `Bearer ${config.token}`')
    })
  })

  describe('route naming', () => {
    it('should convert model names to plural kebab-case routes', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('/projects')
    })

    it('should handle models ending in "y"', () => {
      const categoryModel: PrismaModel = {
        name: 'Category',
        dbName: null,
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
        ],
      }

      const code = generateApiClient([categoryModel])

      expect(code).toContain('/categories')
    })

    it('should handle models ending in "s"', () => {
      const statusModel: PrismaModel = {
        name: 'Status',
        dbName: null,
        fields: [
          { name: 'id', kind: 'scalar', type: 'String', isRequired: true, isList: false, isId: true, isUnique: true, hasDefaultValue: true },
        ],
      }

      const code = generateApiClient([statusModel])

      expect(code).toContain('/statuses')
    })
  })

  describe('configuration', () => {
    it('should generate configureApiClient function', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('export function configureApiClient(newConfig: Partial<ApiClientConfig>)')
      expect(code).toContain('config = { ...config, ...newConfig }')
    })

    it('should generate getApiConfig function', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('export function getApiConfig(): ApiClientConfig')
      expect(code).toContain('return { ...config }')
    })

    it('should define ApiClientConfig interface', () => {
      const code = generateApiClient([mockProjectModel])

      expect(code).toContain('export interface ApiClientConfig {')
      expect(code).toContain('/** Base URL for API requests (e.g., "http://localhost:3000/api") */')
      expect(code).toContain('baseUrl: string')
      expect(code).toContain('/** Optional auth token to include in requests */')
      expect(code).toContain('token?: string')
      expect(code).toContain('/** Optional user ID to include in requests */')
      expect(code).toContain('userId?: string')
    })
  })
})
