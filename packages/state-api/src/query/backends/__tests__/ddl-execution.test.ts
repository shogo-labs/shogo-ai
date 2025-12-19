/**
 * DDL Execution Tests for IBackend
 *
 * Tests the executeDDL() capability added to backends.
 * Verifies dialect-specific DDL generation and execution flow.
 *
 * TDD Red Phase: These tests define expected behavior before implementation.
 */

import { describe, it, expect, beforeEach, jest } from 'bun:test'
import { SqlBackend } from '../sql'
import { MemoryBackend } from '../memory'
import type { ISqlExecutor } from '../../execution/types'

// ============================================================================
// Test Schema
// ============================================================================

const testSchema = {
  $defs: {
    User: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', 'x-mst-type': 'identifier' },
        name: { type: 'string' },
        email: { type: 'string' },
        createdAt: { type: 'number' }
      },
      required: ['id', 'name', 'email', 'createdAt']
    }
  }
}

// ============================================================================
// SqlBackend.executeDDL Tests
// ============================================================================

describe('SqlBackend.executeDDL', () => {
  describe('with postgres dialect', () => {
    it('generates DDL using postgres dialect', async () => {
      const mockExecutor: ISqlExecutor = {
        execute: jest.fn().mockResolvedValue({ rows: [] }),
        executeMany: jest.fn().mockResolvedValue(undefined),
        beginTransaction: jest.fn()
      }

      const backend = new SqlBackend({
        dialect: 'pg',
        executor: mockExecutor
      })

      const result = await backend.executeDDL(testSchema, { ifNotExists: true })

      expect(result.success).toBe(true)
      expect(result.statements.length).toBeGreaterThan(0)
      // Postgres-specific: UUID type
      expect(result.statements.some(s => s.includes('UUID'))).toBe(true)
    })

    it('executes statements via backend executor', async () => {
      const mockExecutor: ISqlExecutor = {
        execute: jest.fn().mockResolvedValue({ rows: [] }),
        executeMany: jest.fn().mockResolvedValue(undefined),
        beginTransaction: jest.fn()
      }

      const backend = new SqlBackend({
        dialect: 'pg',
        executor: mockExecutor
      })

      await backend.executeDDL(testSchema)

      expect(mockExecutor.executeMany).toHaveBeenCalled()
      const statements = (mockExecutor.executeMany as any).mock.calls[0][0]
      expect(Array.isArray(statements)).toBe(true)
    })
  })

  describe('with sqlite dialect', () => {
    it('generates DDL using sqlite dialect', async () => {
      const mockExecutor: ISqlExecutor = {
        execute: jest.fn().mockResolvedValue({ rows: [] }),
        executeMany: jest.fn().mockResolvedValue(undefined),
        beginTransaction: jest.fn()
      }

      const backend = new SqlBackend({
        dialect: 'sqlite',
        executor: mockExecutor
      })

      const result = await backend.executeDDL(testSchema, { ifNotExists: true })

      expect(result.success).toBe(true)
      expect(result.statements.length).toBeGreaterThan(0)
      // SQLite-specific: TEXT type instead of UUID
      expect(result.statements.some(s => s.includes('TEXT'))).toBe(true)
    })
  })

  describe('error handling', () => {
    it('returns error when no executor configured', async () => {
      const backend = new SqlBackend({
        dialect: 'pg'
        // No executor provided
      })

      const result = await backend.executeDDL(testSchema)

      expect(result.success).toBe(false)
      expect(result.error).toContain('executor')
    })

    it('returns statements even on execution failure', async () => {
      const mockExecutor: ISqlExecutor = {
        execute: jest.fn().mockResolvedValue({ rows: [] }),
        executeMany: jest.fn().mockRejectedValue(new Error('Connection failed')),
        beginTransaction: jest.fn()
      }

      const backend = new SqlBackend({
        dialect: 'pg',
        executor: mockExecutor
      })

      const result = await backend.executeDDL(testSchema)

      expect(result.success).toBe(false)
      expect(result.statements.length).toBeGreaterThan(0)
      expect(result.error).toContain('Connection failed')
    })
  })
})

// ============================================================================
// MemoryBackend.executeDDL Tests
// ============================================================================

describe('MemoryBackend.executeDDL', () => {
  it('returns success with empty statements (no-op)', async () => {
    const backend = new MemoryBackend()

    const result = await backend.executeDDL(testSchema)

    expect(result.success).toBe(true)
    expect(result.statements).toEqual([])
    expect(result.executed).toBe(0)
  })

  it('does not throw on any schema input', async () => {
    const backend = new MemoryBackend()

    // Empty schema
    const result1 = await backend.executeDDL({})
    expect(result1.success).toBe(true)

    // Complex schema
    const result2 = await backend.executeDDL(testSchema)
    expect(result2.success).toBe(true)

    // Schema with references
    const schemaWithRefs = {
      $defs: {
        Post: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            authorId: { type: 'string', 'x-reference-target': 'User' }
          }
        }
      }
    }
    const result3 = await backend.executeDDL(schemaWithRefs)
    expect(result3.success).toBe(true)
  })
})
