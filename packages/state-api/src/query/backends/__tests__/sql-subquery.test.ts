/**
 * SqlBackend Subquery Compilation Tests
 *
 * Tests for compiling SubqueryCondition nodes to SQL IN (SELECT ...) clauses.
 *
 * @module query/backends/__tests__/sql-subquery.test
 */

import { describe, test, expect } from 'bun:test'
import { FieldCondition, CompoundCondition } from '@ucast/core'
import { SqlBackend } from '../sql'
import type { ModelResolver } from '../types'
import type { SubqueryCondition } from '../../ast/types'
import { parseQuery } from '../../ast/parser'

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Mock ModelResolver for testing.
 * Simple naming: Model → "models" table, camelCase → snake_case column
 *
 * @param dialect - SQL dialect for proper identifier quoting
 */
const createMockResolver = (dialect: 'pg' | 'sqlite' = 'pg'): ModelResolver => ({
  getTableName: (model) => {
    const tableName = `${model.toLowerCase()}s`
    // Use dialect-appropriate quoting
    return dialect === 'sqlite' ? `\`${tableName}\`` : `"${tableName}"`
  },
  getColumnName: (_model, prop) => {
    // Simple camelCase to snake_case
    return prop.replace(/([A-Z])/g, '_$1').toLowerCase()
  },
  getIdentifierField: () => 'id'
})

// ============================================================================
// Tests
// ============================================================================

describe('sql-subquery.test.ts - SqlBackend Subquery Compilation', () => {
  // ============================================================================
  // SQLSUB-01: Basic Subquery Compilation
  // ============================================================================

  describe('SQLSUB-01: Basic subquery compilation', () => {
    test('Given: SubqueryCondition with filter | When: compiled (pg) | Then: generates IN (SELECT ...)', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'role', 'admin'),
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('"author_id" IN (SELECT "id" FROM "users" WHERE "role" = $1)')
      expect(params).toEqual(['admin'])
    })

    test('Given: SubqueryCondition without filter | When: compiled | Then: generates IN (SELECT ... without WHERE)', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'category_id',
        operator: 'in',
        subquery: {
          model: 'Category',
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('"category_id" IN (SELECT "id" FROM "categorys")')
      expect(params).toEqual([])
    })

    test('Given: SubqueryCondition with $nin | When: compiled | Then: generates NOT IN', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'nin',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'banned', true),
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('"author_id" NOT IN (SELECT "id" FROM "users" WHERE "banned" = $1)')
      expect(params).toEqual([true])
    })
  })

  // ============================================================================
  // SQLSUB-02: SQLite Dialect
  // ============================================================================

  describe('SQLSUB-02: SQLite dialect', () => {
    test('Given: SubqueryCondition | When: compiled (sqlite) | Then: uses ? placeholders', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'role', 'admin'),
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('sqlite')
      const resolver = createMockResolver('sqlite')  // Use sqlite dialect for resolver
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('`author_id` IN (SELECT `id` FROM `users` WHERE `role` = ?)')
      expect(params).toEqual(['admin'])
    })
  })

  // ============================================================================
  // SQLSUB-03: Nested Subqueries
  // ============================================================================

  describe('SQLSUB-03: Nested subqueries', () => {
    test('Given: nested subqueries | When: compiled | Then: generates nested IN clauses', () => {
      // Posts by users in premium organizations
      const innerSubquery: SubqueryCondition = {
        type: 'subquery',
        field: 'organization_id',
        operator: 'in',
        subquery: {
          model: 'Organization',
          filter: new FieldCondition('eq', 'tier', 'premium'),
          selectField: 'id'
        }
      }

      const outerSubquery: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: innerSubquery,
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(outerSubquery, { modelResolver: resolver })

      // Should have proper nesting
      expect(sql).toContain('"author_id" IN (SELECT "id" FROM "users"')
      expect(sql).toContain('"organization_id" IN (SELECT "id" FROM "organizations"')
      expect(sql).toContain('"tier" = $1')
      expect(params).toEqual(['premium'])
    })

    test('Given: deeply nested subqueries | When: compiled | Then: params numbered correctly', () => {
      // Posts by users in orgs owned by verified accounts
      const level3: SubqueryCondition = {
        type: 'subquery',
        field: 'owner_id',
        operator: 'in',
        subquery: {
          model: 'Account',
          filter: new FieldCondition('eq', 'verified', true),
          selectField: 'id'
        }
      }

      const level2: SubqueryCondition = {
        type: 'subquery',
        field: 'organization_id',
        operator: 'in',
        subquery: {
          model: 'Organization',
          filter: level3,
          selectField: 'id'
        }
      }

      const level1: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: level2,
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(level1, { modelResolver: resolver })

      expect(params).toEqual([true])
      expect(sql).toContain('$1')
      expect(sql).not.toContain('$2')  // Only one param
    })
  })

  // ============================================================================
  // SQLSUB-04: Compound Conditions with Subqueries
  // ============================================================================

  describe('SQLSUB-04: Compound conditions with subqueries', () => {
    test('Given: $and with subquery and regular condition | When: compiled | Then: both included', () => {
      const subquery: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'role', 'admin'),
          selectField: 'id'
        }
      }

      const regularCondition = new FieldCondition('eq', 'status', 'published')
      const compound = new CompoundCondition('and', [regularCondition, subquery as any])

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(compound, { modelResolver: resolver })

      expect(sql).toContain('"status" = $1')
      expect(sql).toContain('"author_id" IN (SELECT "id" FROM "users"')
      expect(sql).toContain('AND')
      expect(params).toContain('published')
      expect(params).toContain('admin')
    })

    test('Given: $or with multiple subqueries | When: compiled | Then: all subqueries included', () => {
      const subquery1: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'role', 'admin'),
          selectField: 'id'
        }
      }

      const subquery2: SubqueryCondition = {
        type: 'subquery',
        field: 'category_id',
        operator: 'in',
        subquery: {
          model: 'Category',
          filter: new FieldCondition('eq', 'featured', true),
          selectField: 'id'
        }
      }

      const compound = new CompoundCondition('or', [subquery1 as any, subquery2 as any])

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(compound, { modelResolver: resolver })

      expect(sql).toContain('"author_id" IN')
      expect(sql).toContain('"category_id" IN')
      expect(sql).toContain('OR')
      expect(params).toHaveLength(2)
    })
  })

  // ============================================================================
  // SQLSUB-05: Integration with parseQuery
  // ============================================================================

  describe('SQLSUB-05: Integration with parseQuery', () => {
    test('Given: filter with subquery | When: parsed and compiled | Then: generates correct SQL', () => {
      const filter = {
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      }

      const ast = parseQuery(filter)
      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast as any, { modelResolver: resolver })

      // authorId → author_id via resolver
      expect(sql).toContain('IN (SELECT "id" FROM "users"')
      expect(sql).toContain('"role" = $1')
      expect(params).toEqual(['admin'])
    })
  })

  // ============================================================================
  // SQLSUB-06: Custom Select Field
  // ============================================================================

  describe('SQLSUB-06: Custom select field', () => {
    test('Given: subquery with custom field | When: compiled | Then: uses specified field', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'email',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'verified', true),
          selectField: 'email'  // Not 'id'
        }
      }

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('"email" IN (SELECT "email" FROM "users" WHERE "verified" = $1)')
      expect(params).toEqual([true])
    })
  })

  // ============================================================================
  // SQLSUB-07: Error Cases
  // ============================================================================

  describe('SQLSUB-07: Error cases', () => {
    test('Given: SubqueryCondition | When: compiled without ModelResolver | Then: throws error', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'author_id',
        operator: 'in',
        subquery: {
          model: 'User',
          filter: new FieldCondition('eq', 'role', 'admin'),
          selectField: 'id'
        }
      }

      const backend = new SqlBackend('pg')

      // No modelResolver provided
      expect(() => backend.compileWhere(ast as any)).toThrow(/ModelResolver/i)
    })
  })

  // ============================================================================
  // SQLSUB-08: Backward Compatibility
  // ============================================================================

  describe('SQLSUB-08: Backward compatibility', () => {
    test('Given: regular FieldCondition | When: compileWhere with context | Then: works normally', () => {
      const ast = new FieldCondition('eq', 'status', 'active')

      const backend = new SqlBackend('pg')
      const resolver = createMockResolver()
      const [sql, params] = backend.compileWhere(ast, { modelResolver: resolver })

      expect(sql).toBe('"status" = $1')
      expect(params).toEqual(['active'])
    })

    test('Given: regular FieldCondition | When: compileWhere without context | Then: works normally', () => {
      const ast = new FieldCondition('eq', 'status', 'active')

      const backend = new SqlBackend('pg')
      // No context provided (backward compat)
      const [sql, params] = backend.compileWhere(ast)

      expect(sql).toBe('"status" = $1')
      expect(params).toEqual(['active'])
    })
  })
})
