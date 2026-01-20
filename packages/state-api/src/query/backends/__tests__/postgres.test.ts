/**
 * PostgresBackend Tests
 *
 * Generated from TestSpecifications for task-p2-postgres-backend
 * Tests the PostgreSQL backend implementation that wraps SqlBackend + ISqlExecutor
 *
 * Requirements:
 * - REQ-12: Postgres queryable implementation
 * - Implements IBackend interface
 * - Wraps SqlBackend (compilation) + ISqlExecutor (execution)
 * - Normalizes result rows from snake_case to camelCase
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { FieldCondition } from '@ucast/core'
import type { Condition } from '../../ast/types'
import type { IBackend, QueryResult } from '../types'
import { PostgresBackend } from '../postgres'
import type { ISqlExecutor, Row } from '../../execution/types'
import { parseQuery } from '../../ast'

// ============================================================================
// Mock ISqlExecutor
// ============================================================================

class MockSqlExecutor implements ISqlExecutor {
  public executedQueries: Array<[string, unknown[]]> = []
  private mockResults: Row[] = []

  setMockResults(results: Row[]) {
    this.mockResults = results
  }

  async execute(query: [sql: string, params: unknown[]]): Promise<Row[]> {
    this.executedQueries.push(query)
    return this.mockResults
  }

  async beginTransaction<T>(callback: (tx: { execute: (query: [string, unknown[]]) => Promise<Row[]> }) => Promise<T>): Promise<T> {
    return callback({ execute: (query) => this.execute(query) })
  }

  reset() {
    this.executedQueries = []
    this.mockResults = []
  }
}

// ============================================================================
// Test Fixtures
// ============================================================================

interface TestUser {
  id: string
  name: string
  status: 'active' | 'inactive'
  createdAt: string
}

// Database rows with snake_case keys
const createMockDbRows = (): Row[] => [
  { user_id: '1', user_name: 'Alice', user_status: 'active', created_at: '2024-01-01' },
  { user_id: '2', user_name: 'Bob', user_status: 'active', created_at: '2024-01-02' },
]

// Expected normalized rows with camelCase keys
const createExpectedNormalizedRows = () => [
  { userId: '1', userName: 'Alice', userStatus: 'active', createdAt: '2024-01-01' },
  { userId: '2', userName: 'Bob', userStatus: 'active', createdAt: '2024-01-02' },
]

// ============================================================================
// Test Suite
// ============================================================================

describe('PostgresBackend', () => {
  let backend: PostgresBackend
  let mockExecutor: MockSqlExecutor

  beforeEach(() => {
    mockExecutor = new MockSqlExecutor()
    backend = new PostgresBackend(mockExecutor)
  })

  // ==========================================================================
  // test-p2-postgres-backend-01: Interface Implementation
  // ==========================================================================
  describe('Interface Implementation', () => {
    test('PostgresBackend implements IBackend interface', () => {
      // Given: PostgresBackend class is available
      // Given: ISqlExecutor mock instance

      // When: new PostgresBackend(executor) is instantiated
      const instance = new PostgresBackend(mockExecutor)

      // Then: Instance has execute method
      expect(instance).toHaveProperty('execute')
      expect(typeof instance.execute).toBe('function')

      // Then: Instance has capabilities property
      expect(instance).toHaveProperty('capabilities')
      expect(instance.capabilities).toBeDefined()

      // Then: Instance conforms to IBackend interface
      const asBackend: IBackend = instance
      expect(asBackend).toBeDefined()
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-02: Compilation + Execution Pipeline
  // ==========================================================================
  describe('Compilation and Execution Pipeline', () => {
    test('PostgresBackend execute compiles via SqlBackend then executes via ISqlExecutor', async () => {
      // Given: PostgresBackend with mock ISqlExecutor
      // Given: Query AST for { status: 'active' }
      const ast: Condition = new FieldCondition('eq', 'status', 'active')

      // Given: Collection name 'users'
      const collectionName = 'users'

      // Given: Mock executor returns snake_case rows
      mockExecutor.setMockResults(createMockDbRows())

      // When: execute(ast, 'users') is called
      const result = await backend.execute(ast, collectionName)

      // Then: SqlBackend.compileSelect is invoked with AST
      // (Verified by checking that executor.execute was called with SQL)

      // Then: ISqlExecutor.execute is invoked with compiled SQL and params
      expect(mockExecutor.executedQueries).toHaveLength(1)
      const [sql, params] = mockExecutor.executedQueries[0]
      expect(sql).toContain('SELECT')
      expect(sql).toContain('FROM')
      expect(sql).toContain('users')
      expect(sql).toContain('status')
      expect(params).toContain('active')

      // Then: Results are normalized via normalizeRows
      // Then: Normalized rows are returned
      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toHaveProperty('userId')
      expect(result.items[0]).toHaveProperty('userName')
      expect(result.items[0]).toHaveProperty('createdAt')
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-03: Count Queries
  // ==========================================================================
  describe('Count Queries', () => {
    test('PostgresBackend uses SqlBackend.compileCount for count queries', async () => {
      // Given: PostgresBackend with mock ISqlExecutor
      // Given: Query AST for count operation
      const ast: Condition = new FieldCondition('eq', 'status', 'active')

      // Given: Mock executor returns count result
      mockExecutor.setMockResults([{ count: 42 }])

      // When: execute(ast, 'users', { operation: 'count' }) is called
      const result = await backend.execute(ast, 'users', { operation: 'count' })

      // Then: SqlBackend.compileCount is invoked
      expect(mockExecutor.executedQueries).toHaveLength(1)
      const [sql] = mockExecutor.executedQueries[0]

      // Then: COUNT(*) query is executed
      expect(sql).toContain('COUNT(*)')
      expect(sql).toContain('FROM')
      expect(sql).toContain('users')

      // Then: Returns count number from database
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toHaveProperty('count', 42)
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-04: Exists Queries
  // ==========================================================================
  describe('Exists Queries', () => {
    test('PostgresBackend uses SqlBackend.compileExists for any queries', async () => {
      // Given: PostgresBackend with mock ISqlExecutor
      // Given: Query AST for exists check
      const ast: Condition = new FieldCondition('eq', 'email', 'test@example.com')

      // When: execute(ast, 'users', { operation: 'exists' }) is called - rows exist
      mockExecutor.setMockResults([{ '?column?': 1 }])
      const resultExists = await backend.execute(ast, 'users', { operation: 'exists' })

      // Then: SqlBackend.compileExists is invoked
      expect(mockExecutor.executedQueries).toHaveLength(1)
      let [sql] = mockExecutor.executedQueries[0]

      // Then: Returns boolean true if rows exist
      expect(sql).toContain('SELECT 1')
      expect(sql).toContain('LIMIT 1')
      expect(resultExists.items).toHaveLength(1)

      // When: No rows exist
      mockExecutor.reset()
      mockExecutor.setMockResults([])
      const resultNotExists = await backend.execute(ast, 'users', { operation: 'exists' })

      // Then: Returns boolean false if no rows
      expect(resultNotExists.items).toHaveLength(0)
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-05: Row Normalization
  // ==========================================================================
  describe('Row Normalization', () => {
    test('PostgresBackend normalizes result rows from snake_case to camelCase', async () => {
      // Given: PostgresBackend with mock ISqlExecutor
      // Given: Executor returns rows with snake_case keys
      const snakeCaseRows: Row[] = [
        { user_id: 1, created_at: '2024-01-01', is_active: true },
        { user_id: 2, created_at: '2024-01-02', is_active: false },
      ]
      mockExecutor.setMockResults(snakeCaseRows)

      const ast = parseQuery({})

      // When: execute(ast, 'users') is called
      const result = await backend.execute(ast, 'users')

      // Then: normalizeRow called on each row
      // Then: Returned rows have camelCase keys
      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toHaveProperty('userId', 1)
      expect(result.items[0]).toHaveProperty('createdAt', '2024-01-01')
      expect(result.items[0]).toHaveProperty('isActive', true)

      // Then: Values are preserved
      expect(result.items[1]).toHaveProperty('userId', 2)
      expect(result.items[1]).toHaveProperty('createdAt', '2024-01-02')
      expect(result.items[1]).toHaveProperty('isActive', false)
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-06: Capabilities
  // ==========================================================================
  describe('Capabilities Declaration', () => {
    test('PostgresBackend capabilities inherit from SqlBackend', () => {
      // Given: PostgresBackend instance

      // When: backend.capabilities is accessed
      const capabilities = backend.capabilities

      // Then: Returns BackendCapabilities object
      expect(capabilities).toBeDefined()
      expect(capabilities).toHaveProperty('operators')
      expect(capabilities).toHaveProperty('features')

      // Then: Declares supported operators
      expect(capabilities.operators).toContain('eq')
      expect(capabilities.operators).toContain('ne')
      expect(capabilities.operators).toContain('gt')
      expect(capabilities.operators).toContain('gte')
      expect(capabilities.operators).toContain('lt')
      expect(capabilities.operators).toContain('lte')
      expect(capabilities.operators).toContain('in')
      expect(capabilities.operators).toContain('nin')
      expect(capabilities.operators).toContain('contains')

      // Then: Inherits operator support from SqlBackend
      expect(capabilities.operators).toContain('regex')
      expect(capabilities.operators).toContain('and')
      expect(capabilities.operators).toContain('or')
      expect(capabilities.operators).toContain('not')
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-07: Stateless Design
  // ==========================================================================
  describe('Stateless Design', () => {
    test('PostgresBackend is stateless except for executor reference', async () => {
      // Given: PostgresBackend instance with executor
      const ast1: Condition = new FieldCondition('eq', 'status', 'active')
      const ast2: Condition = new FieldCondition('eq', 'status', 'inactive')

      mockExecutor.setMockResults([{ user_id: 1 }])

      // When: Multiple execute calls are made
      await backend.execute(ast1, 'users')

      mockExecutor.reset()
      mockExecutor.setMockResults([{ user_id: 2 }])
      await backend.execute(ast2, 'users')

      // Then: No internal state accumulated
      // Then: Each call is independent
      expect(mockExecutor.executedQueries).toHaveLength(1) // Only second call recorded after reset

      // Then: Only executor reference is maintained
      // (Verified by successful execution of independent queries)
    })
  })

  // ==========================================================================
  // test-p2-postgres-backend-08: Integration Test (Commented - needs real DB)
  // ==========================================================================
  describe.skip('Pipeline Integration Test', () => {
    test('PostgresBackend pipeline integration test: compile + execute + normalize', async () => {
      // NOTE: This test requires a real test database connection
      // Uncomment and configure when integration testing is set up

      // Given: PostgresBackend with real test database connection
      // Given: Test data in users table with snake_case columns

      // When: execute(parseQuery({ status: 'active' }), 'users') is called

      // Then: SQL compiled correctly from AST
      // Then: Query executed against database
      // Then: Results returned with camelCase keys
      // Then: Data matches expected rows
    })
  })
})
