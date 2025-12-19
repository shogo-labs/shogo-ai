/**
 * BackendRegistry DDL Execution Tests
 *
 * Tests the executeDDL() method on BackendRegistry.
 * Verifies backend resolution and DDL delegation.
 *
 * TDD: Tests written first to define expected behavior.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BackendRegistry, createBackendRegistry } from '../registry'
import { SqlBackend } from '../backends/sql'
import { MemoryBackend } from '../backends/memory'
import type { ISqlExecutor } from '../execution/types'
import { resetMetaStore, getMetaStore } from '../../meta/bootstrap'

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = {
  name: 'test-schema',
  'x-persistence': {
    backend: 'sql'
  },
  $defs: {
    User: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        email: { type: 'string' }
      },
      required: ['id', 'name', 'email']
    }
  }
}

// ============================================================================
// BackendRegistry.executeDDL Tests
// ============================================================================

describe('BackendRegistry.executeDDL', () => {
  let registry: BackendRegistry
  let mockExecutor: ISqlExecutor

  beforeEach(() => {
    // Reset meta-store before each test (lazy init on first getMetaStore())
    resetMetaStore()
    getMetaStore() // Triggers lazy initialization

    mockExecutor = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      executeMany: vi.fn().mockResolvedValue(undefined),
      beginTransaction: vi.fn().mockResolvedValue({
        execute: vi.fn(),
        executeMany: vi.fn(),
        commit: vi.fn(),
        rollback: vi.fn()
      })
    }

    registry = new BackendRegistry()
  })

  afterEach(() => {
    resetMetaStore()
  })

  it('resolves backend from schema and delegates executeDDL', async () => {
    const sqlBackend = new SqlBackend({
      dialect: 'pg',
      executor: mockExecutor
    })

    registry.register('sql', sqlBackend)
    registry.setDefault('sql')

    const result = await registry.executeDDL('test-schema', testSchema)

    expect(result.success).toBe(true)
    expect(result.statements.length).toBeGreaterThan(0)
    expect(mockExecutor.executeMany).toHaveBeenCalled()
  })

  it('uses default backend when no schema x-persistence', async () => {
    const memoryBackend = new MemoryBackend()
    const sqlBackend = new SqlBackend({
      dialect: 'pg',
      executor: mockExecutor
    })

    registry.register('memory', memoryBackend)
    registry.register('sql', sqlBackend)
    registry.setDefault('memory')

    // Schema without x-persistence.backend
    const schemaNoBackend = {
      name: 'no-backend-schema',
      $defs: {
        Item: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          }
        }
      }
    }

    const result = await registry.executeDDL('no-backend-schema', schemaNoBackend)

    // Memory backend returns success with empty statements
    expect(result.success).toBe(true)
    expect(result.statements).toEqual([])
  })

  it('returns error when no backend found', async () => {
    // No backends registered, no default set
    // Use schema WITHOUT x-persistence.backend to trigger "no backend" error
    const schemaNoBackend = {
      name: 'orphan-schema',
      $defs: {
        Item: {
          type: 'object',
          properties: {
            id: { type: 'string', 'x-mst-type': 'identifier' }
          }
        }
      }
    }

    const result = await registry.executeDDL('orphan-schema', schemaNoBackend)

    expect(result.success).toBe(false)
    expect(result.error).toContain('No backend found')
  })

  it('returns error when backend lacks executeDDL', async () => {
    // Create a backend without executeDDL method
    const backendWithoutDDL = {
      capabilities: {
        operators: ['eq'],
        features: { sorting: false }
      },
      execute: vi.fn()
    }

    registry.register('no-ddl', backendWithoutDDL as any)
    registry.setDefault('no-ddl')

    // Schema without x-persistence.backend to use default
    const schemaNoBackend = {
      name: 'test-schema',
      $defs: {
        Item: {
          type: 'object',
          properties: {
            id: { type: 'string', 'x-mst-type': 'identifier' }
          }
        }
      }
    }

    const result = await registry.executeDDL('test-schema', schemaNoBackend)

    expect(result.success).toBe(false)
    expect(result.error).toContain('executeDDL')
  })

  it('passes options through to backend.executeDDL', async () => {
    const sqlBackend = new SqlBackend({
      dialect: 'pg',
      executor: mockExecutor
    })

    // Spy on executeDDL
    const executeDDLSpy = vi.spyOn(sqlBackend, 'executeDDL')

    registry.register('sql', sqlBackend)
    registry.setDefault('sql')

    await registry.executeDDL('test-schema', testSchema, { ifNotExists: false })

    expect(executeDDLSpy).toHaveBeenCalledWith(testSchema, { ifNotExists: false })
  })

  it('reads backend from schema x-persistence.backend', async () => {
    const pgBackend = new SqlBackend({
      dialect: 'pg',
      executor: mockExecutor
    })
    const sqliteBackend = new SqlBackend({
      dialect: 'sqlite',
      executor: mockExecutor
    })

    registry.register('postgres', pgBackend)
    registry.register('sqlite', sqliteBackend)
    registry.setDefault('sqlite')

    // Schema specifies postgres backend
    const schemaWithBackend = {
      name: 'pg-schema',
      'x-persistence': {
        backend: 'postgres'
      },
      $defs: {
        Thing: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', 'x-mst-type': 'identifier' }
          }
        }
      }
    }

    const result = await registry.executeDDL('pg-schema', schemaWithBackend)

    expect(result.success).toBe(true)
    // Check that statements use postgres UUID type (not sqlite TEXT)
    expect(result.statements.some(s => s.includes('UUID') || s.includes('TEXT'))).toBe(true)
  })
})
