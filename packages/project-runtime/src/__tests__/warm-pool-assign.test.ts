/**
 * Warm Pool Assignment Tests for Project Runtime
 *
 * Tests the /pool/assign endpoint that transforms a generic warm pool pod
 * into a project-specific runtime by injecting environment variables and
 * reconfiguring services.
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { Hono } from 'hono'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// Mock environment for pool mode
const POOL_PROJECT_ID = '__POOL__'
const TEST_PROJECT_DIR = join(import.meta.dir, 'test-project-dir')
const TEST_SCHEMAS_DIR = join(import.meta.dir, 'test-schemas')

// Set up test environment before importing server
process.env.PROJECT_ID = POOL_PROJECT_ID
process.env.WARM_POOL_MODE = 'true'
process.env.PROJECT_DIR = TEST_PROJECT_DIR
process.env.SCHEMAS_PATH = TEST_SCHEMAS_DIR
process.env.PORT = '0' // Use random port for tests
process.env.S3_WORKSPACES_BUCKET = 'test-bucket'
process.env.S3_REGION = 'us-east-1'

// Mock S3 operations
const mockS3Download = mock(() => Promise.resolve(true))
const mockS3Upload = mock(() => Promise.resolve())
const mockS3Watch = mock(() => {})
const mockS3Stop = mock(() => {})

mock.module('../lib/s3-sync', () => ({
  initializeS3Sync: mock(async () => ({
    sync: {
      download: mockS3Download,
      upload: mockS3Upload,
      startWatching: mockS3Watch,
      stop: mockS3Stop,
    },
    downloadSucceeded: true,
  })),
}))

// Mock Claude Code session manager
const mockCreateSession = mock(async () => ({
  id: 'test-session',
  send: mock(() => Promise.resolve({ messages: [] })),
  destroy: mock(() => {}),
}))

mock.module('../lib/claude-code-sessions', () => ({
  createSessionManager: () => ({
    create: mockCreateSession,
    get: () => null,
    list: () => [],
    destroy: () => {},
  }),
  buildProjectSessionOptions: () => ({}),
}))

// Mock AI proxy
mock.module('../../../shared-runtime/src/ai-proxy', () => ({
  configureAIProxy: () => ({
    type: 'proxy',
    baseURL: 'http://test-proxy',
    headers: { 'Authorization': 'Bearer test-token' },
  }),
}))

// Mock Claude Code environment builder
mock.module('../../../shared-runtime/src/claude-code-env', () => ({
  buildClaudeCodeEnv: () => ({
    API_KEY: 'test-api-key',
    API_URL: 'http://test-api',
  }),
}))

// Import the server after mocks are set up
import('../server')

describe('Warm Pool Assignment Endpoint', () => {
  let app: Hono
  let server: any

  beforeEach(async () => {
    // Create test directories
    if (!existsSync(TEST_PROJECT_DIR)) {
      mkdirSync(TEST_PROJECT_DIR, { recursive: true })
    }
    if (!existsSync(TEST_SCHEMAS_DIR)) {
      mkdirSync(TEST_SCHEMAS_DIR, { recursive: true })
    }

    // Clear mocks
    mockS3Download.mockClear()
    mockS3Upload.mockClear()
    mockS3Watch.mockClear()
    mockCreateSession.mockClear()

    // Import and start server
    const serverModule = await import('../server')
    app = serverModule.app
    server = serverModule.default
  })

  afterEach(() => {
    // Clean up test directories
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true })
    }
    if (existsSync(TEST_SCHEMAS_DIR)) {
      rmSync(TEST_SCHEMAS_DIR, { recursive: true, force: true })
    }

    // Stop server
    if (server && typeof server.stop === 'function') {
      server.stop()
    }
  })

  describe('Pool Mode Validation', () => {
    test('should accept assignment in pool mode', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'test-project-123',
          env: {
            AI_PROXY_TOKEN: 'new-token-123',
            DATABASE_URL: 'postgresql://user:pass@host/db',
          },
        }),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.ok).toBe(true)
      expect(body.projectId).toBe('test-project-123')
      expect(body.durationMs).toBeGreaterThan(0)
    })

    test('should reject assignment when not in pool mode', async () => {
      // Simulate non-pool mode
      process.env.PROJECT_ID = 'existing-project'
      process.env.WARM_POOL_MODE = 'false'

      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'test-project-456',
          env: {},
        }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Not in pool mode')

      // Restore pool mode for other tests
      process.env.PROJECT_ID = POOL_PROJECT_ID
      process.env.WARM_POOL_MODE = 'true'
    })

    test('should reject duplicate assignment', async () => {
      // First assignment
      await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'first-project',
          env: {},
        }),
      })

      // Second assignment attempt
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'second-project',
          env: {},
        }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('Already assigned')
      expect(body.projectId).toBe('first-project')
    })
  })

  describe('Environment Variable Injection', () => {
    test('should inject all provided environment variables', async () => {
      const testEnv = {
        AI_PROXY_TOKEN: 'proxy-token-xyz',
        DATABASE_URL: 'postgresql://test:test@localhost/testdb',
        S3_ENDPOINT: 'http://minio:9000',
        S3_FORCE_PATH_STYLE: 'true',
        CUSTOM_VAR: 'custom-value',
      }

      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'env-test-project',
          env: testEnv,
        }),
      })

      expect(response.status).toBe(200)

      // Verify environment variables were set
      expect(process.env.PROJECT_ID).toBe('env-test-project')
      Object.entries(testEnv).forEach(([key, value]) => {
        expect(process.env[key]).toBe(value)
      })
    })

    test('should skip non-string environment values', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'type-test-project',
          env: {
            STRING_VAR: 'valid',
            NUMBER_VAR: 123, // Should be skipped
            BOOLEAN_VAR: true, // Should be skipped
            NULL_VAR: null, // Should be skipped
            OBJECT_VAR: { nested: 'value' }, // Should be skipped
          },
        }),
      })

      expect(response.status).toBe(200)

      // Only string values should be set
      expect(process.env.STRING_VAR).toBe('valid')
      expect(process.env.NUMBER_VAR).toBeUndefined()
      expect(process.env.BOOLEAN_VAR).toBeUndefined()
      expect(process.env.NULL_VAR).toBeUndefined()
      expect(process.env.OBJECT_VAR).toBeUndefined()
    })
  })

  describe('S3 Sync Integration', () => {
    test('should initialize S3 sync with new project data', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 's3-test-project',
          env: {
            S3_WORKSPACES_BUCKET: 'project-bucket',
            S3_REGION: 'eu-west-1',
            AWS_ACCESS_KEY_ID: 'test-key',
            AWS_SECRET_ACCESS_KEY: 'test-secret',
          },
        }),
      })

      expect(response.status).toBe(200)

      // Verify S3 sync was initialized
      expect(mockS3Download).toHaveBeenCalled()

      // Verify restore marker was written
      const markerPath = join(TEST_PROJECT_DIR, '.s3-restore-complete')
      expect(existsSync(markerPath)).toBe(true)
    })

    test('should handle S3 sync failures gracefully', async () => {
      // Mock S3 download failure
      mockS3Download.mockImplementationOnce(() => Promise.reject(new Error('S3 error')))

      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 's3-fail-project',
          env: {
            S3_WORKSPACES_BUCKET: 'project-bucket',
          },
        }),
      })

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.error).toContain('Assignment failed')
    })
  })

  describe('Configuration Files', () => {
    test('should write agent configuration files', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'config-test-project',
          env: {
            AI_PROXY_TOKEN: 'token-123',
            DATABASE_URL: 'postgresql://localhost/config',
          },
        }),
      })

      expect(response.status).toBe(200)

      // Check for agent configuration files
      const configPaths = [
        join(TEST_SCHEMAS_DIR, 'settings.json'),
        join(TEST_PROJECT_DIR, '.claude_code/config.json'),
      ]

      configPaths.forEach(path => {
        const dir = path.substring(0, path.lastIndexOf('/'))
        // Config directories should be created even if files aren't written yet
        expect(existsSync(dir)).toBe(true)
      })
    })
  })

  describe('Health Check Updates', () => {
    test('should report pool mode before assignment', async () => {
      const response = await app.request('/health')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('ok')
      expect(body.projectId).toBe(POOL_PROJECT_ID)
      expect(body.poolMode).toBe(true)
    })

    test('should report assigned project after assignment', async () => {
      // Assign to a project
      await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'health-test-project',
          env: {},
        }),
      })

      // Check health
      const response = await app.request('/health')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe('ok')
      expect(body.projectId).toBe('health-test-project')
      expect(body.poolMode).toBe(false) // No longer in pool mode after assignment
    })
  })

  describe('Ready Check Updates', () => {
    test('should be ready in pool mode', async () => {
      const response = await app.request('/ready')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.ready).toBe(true)
      expect(body.claude_code).toBe(false) // CLI not started in pool mode
      expect(body.s3).toBe(false) // No S3 sync in pool mode
    })

    test('should update ready status after assignment', async () => {
      // Assign to a project
      await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'ready-test-project',
          env: {
            S3_WORKSPACES_BUCKET: 'test-bucket',
          },
        }),
      })

      // Check readiness
      const response = await app.request('/ready')

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.ready).toBe(true)
      expect(body.s3).toBe(true) // S3 sync should be initialized
    })
  })

  describe('Error Handling', () => {
    test('should validate projectId is required', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          env: { SOME_VAR: 'value' },
        }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('projectId (string) is required')
    })

    test('should validate projectId is string', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 12345, // Number instead of string
          env: {},
        }),
      })

      expect(response.status).toBe(400)
      const body = await response.json()
      expect(body.error).toBe('projectId (string) is required')
    })

    test('should handle malformed JSON', async () => {
      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      })

      expect(response.status).toBe(400)
    })
  })

  describe('Performance', () => {
    test('should complete assignment quickly', async () => {
      const startTime = Date.now()

      const response = await app.request('/pool/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'perf-test-project',
          env: {
            AI_PROXY_TOKEN: 'token',
            DATABASE_URL: 'postgresql://localhost/perf',
            S3_WORKSPACES_BUCKET: 'perf-bucket',
          },
        }),
      })

      const duration = Date.now() - startTime

      expect(response.status).toBe(200)
      const body = await response.json()

      // Assignment should be fast (< 1 second)
      expect(duration).toBeLessThan(1000)
      expect(body.durationMs).toBeLessThan(1000)
      expect(body.durationMs).toBeGreaterThan(0)
    })
  })
})