/**
 * SQL Parameter Numbering Tests
 *
 * Tests for correct parameter placeholder numbering in compound conditions
 * with multiple subqueries, ensuring $1, $2, $3, $4... sequence is maintained.
 *
 * @module query/backends/__tests__/sql-param-numbering.test
 */

import { describe, test, expect } from 'bun:test'
import { SqlBackend } from '../sql'
import { parseQuery } from '../../ast'
import type { ModelResolver } from '../types'

// Mock ModelResolver for subquery compilation
const mockResolver: ModelResolver = {
  getTableName: (model: string) => `"test_schema"."${model.toLowerCase()}"`,
  getColumnName: (model: string, field: string) =>
    field === 'id' ? 'id' : `${field}_id`,
  getIdentifierField: () => 'id'
}

describe('SQL Parameter Numbering', () => {
  // =========================================================================
  // PN-01: $or with multiple subqueries - each has parameters
  // =========================================================================
  describe('PN-01: Compound conditions with multiple subqueries', () => {
    test('GIVEN $or with 2 subqueries each having 2 params WHEN compiled THEN params numbered $1-$4', () => {
      const backend = new SqlBackend('pg')

      const filter = {
        $or: [
          {
            projectId: {
              $in: {
                $query: {
                  model: 'Member',
                  filter: { userId: 'user1', project: { $ne: null } },
                  field: 'project'
                }
              }
            }
          },
          {
            workspaceId: {
              $in: {
                $query: {
                  model: 'Member',
                  filter: { userId: 'user1', workspace: { $ne: null } },
                  field: 'workspace'
                }
              }
            }
          }
        ]
      }

      const ast = parseQuery(filter)
      const [sql, params] = backend.compileSelect(ast, 'project', {}, { modelResolver: mockResolver })

      // Params: ['user1', 'user1'] - null values are now IS NOT NULL, not params
      // (The 'ne: null' becomes 'exists: true' which generates IS NOT NULL)
      expect(params).toEqual(['user1', 'user1'])

      // First subquery should use $1 (userId) and IS NOT NULL (not $2)
      expect(sql).toContain('$1')
      expect(sql).toContain('is not null')

      // Second subquery should use $2 (userId) - NOT $1 again
      expect(sql).toContain('$2')

      // Should NOT have duplicate $1 after the first subquery
      const firstDollarOneIndex = sql.indexOf('$1')
      const secondDollarOneIndex = sql.indexOf('$1', firstDollarOneIndex + 2)
      expect(secondDollarOneIndex).toBe(-1)  // No second $1
    })
  })

  // =========================================================================
  // PN-02: Single subquery with regular field conditions
  // =========================================================================
  describe('PN-02: Subquery combined with field conditions', () => {
    test('GIVEN subquery AND field condition WHEN compiled THEN params numbered sequentially', () => {
      const backend = new SqlBackend('pg')

      const filter = {
        $and: [
          {
            authorId: {
              $in: {
                $query: {
                  model: 'User',
                  filter: { role: 'admin' },
                  field: 'id'
                }
              }
            }
          },
          { status: 'active' },
          { category: 'tech' }
        ]
      }

      const ast = parseQuery(filter)
      const [sql, params] = backend.compileSelect(ast, 'post', {}, { modelResolver: mockResolver })

      // Params: ['admin', 'active', 'tech']
      expect(params).toEqual(['admin', 'active', 'tech'])

      // Should have $1, $2, $3 in sequence
      expect(sql).toContain('$1')
      expect(sql).toContain('$2')
      expect(sql).toContain('$3')
    })
  })

  // =========================================================================
  // PN-03: Nested compound with subqueries
  // =========================================================================
  describe('PN-03: Nested compound conditions', () => {
    test('GIVEN nested $or inside $and with subqueries WHEN compiled THEN all params numbered correctly', () => {
      const backend = new SqlBackend('pg')

      const filter = {
        $and: [
          { status: 'active' },
          {
            $or: [
              {
                ownerId: {
                  $in: {
                    $query: {
                      model: 'User',
                      filter: { tier: 'premium' },
                      field: 'id'
                    }
                  }
                }
              },
              {
                teamId: {
                  $in: {
                    $query: {
                      model: 'Team',
                      filter: { plan: 'enterprise' },
                      field: 'id'
                    }
                  }
                }
              }
            ]
          }
        ]
      }

      const ast = parseQuery(filter)
      const [sql, params] = backend.compileSelect(ast, 'project', {}, { modelResolver: mockResolver })

      // Params: ['active', 'premium', 'enterprise']
      expect(params).toEqual(['active', 'premium', 'enterprise'])

      // Verify sequential numbering
      expect(sql).toContain('$1')  // status = 'active'
      expect(sql).toContain('$2')  // tier = 'premium'
      expect(sql).toContain('$3')  // plan = 'enterprise'
    })
  })

  // =========================================================================
  // PN-04: SQLite uses ? placeholders (no numbering)
  // =========================================================================
  describe('PN-04: SQLite dialect', () => {
    test('GIVEN $or with subqueries in SQLite WHEN compiled THEN uses ? placeholders', () => {
      const backend = new SqlBackend('sqlite')

      const filter = {
        $or: [
          {
            projectId: {
              $in: {
                $query: {
                  model: 'Member',
                  filter: { userId: 'user1' },
                  field: 'project'
                }
              }
            }
          },
          {
            workspaceId: {
              $in: {
                $query: {
                  model: 'Member',
                  filter: { userId: 'user1' },
                  field: 'workspace'
                }
              }
            }
          }
        ]
      }

      const ast = parseQuery(filter)
      const [sql, params] = backend.compileSelect(ast, 'project', {}, { modelResolver: mockResolver })

      // SQLite uses ? for all params, no numbering needed
      expect(sql).not.toContain('$')
      expect(sql.match(/\?/g)?.length).toBe(2)
      expect(params).toEqual(['user1', 'user1'])
    })
  })
})
