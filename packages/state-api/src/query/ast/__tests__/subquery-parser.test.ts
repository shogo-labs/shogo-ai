/**
 * Subquery Parser Tests
 *
 * Tests for parsing $in operator with subquery expressions ($query).
 *
 * @module query/ast/__tests__/subquery-parser.test
 */

import { describe, test, expect } from 'bun:test'
import { parseQuery } from '../parser'
import type { SubqueryCondition } from '../types'

describe('subquery-parser.test.ts - Subquery Parsing', () => {
  // ============================================================================
  // SUBQ-01: Basic Subquery Detection
  // ============================================================================

  describe('SUBQ-01: Basic subquery detection', () => {
    test('Given: $in with $query | When: parsed | Then: returns SubqueryCondition', () => {
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

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.type).toBe('subquery')
      expect(ast.field).toBe('authorId')
      expect(ast.operator).toBe('in')
      expect(ast.subquery.model).toBe('User')
      expect(ast.subquery.selectField).toBe('id') // Default
    })

    test('Given: $in with array | When: parsed | Then: returns standard FieldCondition', () => {
      const filter = {
        status: { $in: ['active', 'pending'] }
      }

      const ast = parseQuery(filter)

      // Standard @ucast FieldCondition
      expect((ast as any).operator).toBe('in')
      expect((ast as any).field).toBe('status')
      expect((ast as any).value).toEqual(['active', 'pending'])
      // NOT a subquery
      expect((ast as any).type).not.toBe('subquery')
    })
  })

  // ============================================================================
  // SUBQ-02: Subquery Field Selection
  // ============================================================================

  describe('SUBQ-02: Subquery field selection', () => {
    test('Given: no field specified | When: parsed | Then: defaults selectField to "id"', () => {
      const filter = {
        foreignKey: {
          $in: { $query: { model: 'OtherModel' } }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.subquery.selectField).toBe('id')
    })

    test('Given: explicit field specified | When: parsed | Then: uses specified field', () => {
      const filter = {
        email: {
          $in: {
            $query: {
              model: 'User',
              field: 'email'
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.subquery.selectField).toBe('email')
    })
  })

  // ============================================================================
  // SUBQ-03: Inner Filter Parsing
  // ============================================================================

  describe('SUBQ-03: Inner filter parsing', () => {
    test('Given: subquery with filter | When: parsed | Then: inner filter is parsed AST', () => {
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

      const ast = parseQuery(filter) as SubqueryCondition

      // Inner filter should be parsed into Condition AST, not raw object
      expect(ast.subquery.filter).toBeDefined()
      expect((ast.subquery.filter as any).operator).toBe('eq')
      expect((ast.subquery.filter as any).field).toBe('role')
      expect((ast.subquery.filter as any).value).toBe('admin')
    })

    test('Given: subquery without filter | When: parsed | Then: filter is undefined', () => {
      const filter = {
        categoryId: {
          $in: { $query: { model: 'Category' } }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.subquery.filter).toBeUndefined()
    })

    test('Given: subquery with complex filter | When: parsed | Then: filter is correctly parsed', () => {
      const filter = {
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: {
                $and: [
                  { role: 'admin' },
                  { isActive: true }
                ]
              }
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.subquery.filter).toBeDefined()
      expect((ast.subquery.filter as any).operator).toBe('and')
      expect((ast.subquery.filter as any).value).toHaveLength(2)
    })
  })

  // ============================================================================
  // SUBQ-04: Nested Subqueries
  // ============================================================================

  describe('SUBQ-04: Nested subqueries', () => {
    test('Given: nested subqueries | When: parsed | Then: all levels are SubqueryConditions', () => {
      // Posts by users in premium organizations
      const filter = {
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: {
                organizationId: {
                  $in: {
                    $query: {
                      model: 'Organization',
                      filter: { tier: 'premium' }
                    }
                  }
                }
              }
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      // Outer subquery
      expect(ast.type).toBe('subquery')
      expect(ast.field).toBe('authorId')
      expect(ast.subquery.model).toBe('User')

      // Inner subquery (nested in filter)
      const innerAst = ast.subquery.filter as SubqueryCondition
      expect(innerAst.type).toBe('subquery')
      expect(innerAst.field).toBe('organizationId')
      expect(innerAst.subquery.model).toBe('Organization')

      // Innermost filter
      expect((innerAst.subquery.filter as any).operator).toBe('eq')
      expect((innerAst.subquery.filter as any).field).toBe('tier')
      expect((innerAst.subquery.filter as any).value).toBe('premium')
    })
  })

  // ============================================================================
  // SUBQ-05: Compound Conditions with Subqueries
  // ============================================================================

  describe('SUBQ-05: Compound conditions with subqueries', () => {
    test('Given: $and with subquery and regular conditions | When: parsed | Then: both are preserved', () => {
      const filter = {
        $and: [
          { status: 'published' },
          {
            authorId: {
              $in: {
                $query: { model: 'User', filter: { role: 'admin' } }
              }
            }
          }
        ]
      }

      const ast = parseQuery(filter)

      expect((ast as any).operator).toBe('and')
      expect((ast as any).value).toHaveLength(2)

      // First condition: regular field
      expect((ast as any).value[0].operator).toBe('eq')
      expect((ast as any).value[0].field).toBe('status')

      // Second condition: subquery
      expect((ast as any).value[1].type).toBe('subquery')
      expect((ast as any).value[1].subquery.model).toBe('User')
    })

    test('Given: $or with multiple subqueries | When: parsed | Then: all subqueries preserved', () => {
      const filter = {
        $or: [
          {
            authorId: {
              $in: { $query: { model: 'User', filter: { role: 'admin' } } }
            }
          },
          {
            categoryId: {
              $in: { $query: { model: 'Category', filter: { featured: true } } }
            }
          }
        ]
      }

      const ast = parseQuery(filter)

      expect((ast as any).operator).toBe('or')
      expect((ast as any).value).toHaveLength(2)

      expect((ast as any).value[0].type).toBe('subquery')
      expect((ast as any).value[0].subquery.model).toBe('User')

      expect((ast as any).value[1].type).toBe('subquery')
      expect((ast as any).value[1].subquery.model).toBe('Category')
    })
  })

  // ============================================================================
  // SUBQ-06: $nin with Subquery
  // ============================================================================

  describe('SUBQ-06: $nin with subquery', () => {
    test('Given: $nin with $query | When: parsed | Then: returns SubqueryCondition with nin operator', () => {
      const filter = {
        authorId: {
          $nin: {
            $query: {
              model: 'User',
              filter: { banned: true }
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.type).toBe('subquery')
      expect(ast.field).toBe('authorId')
      expect(ast.operator).toBe('nin')
      expect(ast.subquery.model).toBe('User')
    })
  })

  // ============================================================================
  // SUBQ-07: Error Cases
  // ============================================================================

  describe('SUBQ-07: Error cases', () => {
    test('Given: $query without model | When: parsed | Then: throws error', () => {
      const filter = {
        authorId: {
          $in: {
            $query: {
              filter: { role: 'admin' }
              // Missing 'model'
            }
          }
        }
      }

      expect(() => parseQuery(filter as any)).toThrow()
    })

    test('Given: $query with empty model | When: parsed | Then: throws error', () => {
      const filter = {
        authorId: {
          $in: {
            $query: {
              model: '',
              filter: { role: 'admin' }
            }
          }
        }
      }

      expect(() => parseQuery(filter)).toThrow()
    })
  })
})
