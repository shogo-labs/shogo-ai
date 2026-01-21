/**
 * Subquery Schema Property Tests
 *
 * Tests for cross-schema subquery support via the optional `schema` property.
 * This enables authorization filters that query membership data from a different
 * schema (e.g., studio-core.Member) to filter entities in another schema.
 *
 * @module query/ast/__tests__/subquery-schema.test
 */

import { describe, test, expect } from 'bun:test'
import { parseQuery } from '../parser'
import { serializeCondition, deserializeCondition } from '../serialization'
import type { SubqueryCondition } from '../types'

describe('Subquery Schema Property', () => {
  // =========================================================================
  // SP-01: Schema property parsing
  // =========================================================================
  describe('SP-01: Schema property parsing', () => {
    test('GIVEN subquery with schema property WHEN parsed THEN includes schema in SubqueryCondition', () => {
      const filter = {
        workspaceId: {
          $in: {
            $query: {
              schema: 'studio-core',
              model: 'Member',
              filter: { userId: 'u1', workspace: { $ne: null } },
              field: 'workspace'
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.type).toBe('subquery')
      expect(ast.subquery.schema).toBe('studio-core')
      expect(ast.subquery.model).toBe('Member')
      expect(ast.subquery.selectField).toBe('workspace')
    })
  })

  // =========================================================================
  // SP-02: Schema property is optional (backward compatibility)
  // =========================================================================
  describe('SP-02: Backward compatibility', () => {
    test('GIVEN subquery without schema WHEN parsed THEN schema is undefined', () => {
      const filter = {
        authorId: {
          $in: {
            $query: {
              model: 'User'
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      expect(ast.type).toBe('subquery')
      expect(ast.subquery.schema).toBeUndefined()
      expect(ast.subquery.model).toBe('User')
    })
  })

  // =========================================================================
  // SP-03: Serialization preserves schema
  // =========================================================================
  describe('SP-03: Serialization', () => {
    test('GIVEN SubqueryCondition with schema WHEN serialized THEN schema in output', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'workspaceId',
        operator: 'in',
        subquery: {
          schema: 'studio-core',
          model: 'Member',
          selectField: 'workspace'
        }
      }

      const serialized = serializeCondition(ast) as any

      expect(serialized.type).toBe('subquery')
      expect(serialized.subquery.schema).toBe('studio-core')
      expect(serialized.subquery.model).toBe('Member')
      expect(serialized.subquery.field).toBe('workspace')
    })

    test('GIVEN SubqueryCondition without schema WHEN serialized THEN schema is undefined', () => {
      const ast: SubqueryCondition = {
        type: 'subquery',
        field: 'authorId',
        operator: 'in',
        subquery: {
          model: 'User',
          selectField: 'id'
        }
      }

      const serialized = serializeCondition(ast) as any

      expect(serialized.subquery.schema).toBeUndefined()
      expect(serialized.subquery.model).toBe('User')
    })
  })

  // =========================================================================
  // SP-04: Deserialization preserves schema
  // =========================================================================
  describe('SP-04: Deserialization', () => {
    test('GIVEN serialized subquery with schema WHEN deserialized THEN schema preserved', () => {
      const serialized = {
        type: 'subquery',
        field: 'workspaceId',
        operator: 'in',
        subquery: {
          schema: 'studio-core',
          model: 'Member',
          field: 'workspace'
        }
      }

      const restored = deserializeCondition(serialized) as SubqueryCondition

      expect(restored.type).toBe('subquery')
      expect(restored.subquery.schema).toBe('studio-core')
      expect(restored.subquery.model).toBe('Member')
      expect(restored.subquery.selectField).toBe('workspace')
    })

    test('GIVEN serialized subquery without schema WHEN deserialized THEN schema is undefined', () => {
      const serialized = {
        type: 'subquery',
        field: 'authorId',
        operator: 'in',
        subquery: {
          model: 'User',
          field: 'id'
        }
      }

      const restored = deserializeCondition(serialized) as SubqueryCondition

      expect(restored.subquery.schema).toBeUndefined()
      expect(restored.subquery.model).toBe('User')
    })
  })

  // =========================================================================
  // SP-05: Round-trip preserves schema
  // =========================================================================
  describe('SP-05: Round-trip (parse → serialize → deserialize)', () => {
    test('GIVEN subquery with schema WHEN serialize→deserialize THEN schema preserved', () => {
      const original = parseQuery({
        id: {
          $in: {
            $query: {
              schema: 'auth-schema',
              model: 'User',
              field: 'id'
            }
          }
        }
      })

      const serialized = serializeCondition(original)
      const restored = deserializeCondition(serialized) as SubqueryCondition

      expect(restored.type).toBe('subquery')
      expect(restored.subquery.schema).toBe('auth-schema')
      expect(restored.subquery.model).toBe('User')
      expect(restored.subquery.selectField).toBe('id')
    })

    test('GIVEN subquery without schema WHEN serialize→deserialize THEN schema remains undefined', () => {
      const original = parseQuery({
        authorId: {
          $in: {
            $query: {
              model: 'User',
              filter: { role: 'admin' }
            }
          }
        }
      })

      const serialized = serializeCondition(original)
      const restored = deserializeCondition(serialized) as SubqueryCondition

      expect(restored.type).toBe('subquery')
      expect(restored.subquery.schema).toBeUndefined()
      expect(restored.subquery.model).toBe('User')
    })
  })

  // =========================================================================
  // SP-06: Complex nested subqueries with schema
  // =========================================================================
  describe('SP-06: Nested subqueries with schema', () => {
    test('GIVEN nested subquery with different schemas WHEN parsed THEN both schemas preserved', () => {
      // Posts authored by users in premium organizations (cross-schema)
      const filter = {
        authorId: {
          $in: {
            $query: {
              schema: 'users-schema',
              model: 'User',
              filter: {
                organizationId: {
                  $in: {
                    $query: {
                      schema: 'orgs-schema',
                      model: 'Organization',
                      filter: { tier: 'premium' },
                      field: 'id'
                    }
                  }
                }
              },
              field: 'id'
            }
          }
        }
      }

      const ast = parseQuery(filter) as SubqueryCondition

      // Outer subquery
      expect(ast.type).toBe('subquery')
      expect(ast.subquery.schema).toBe('users-schema')
      expect(ast.subquery.model).toBe('User')

      // Inner subquery (nested in filter)
      const innerFilter = ast.subquery.filter as any
      expect(innerFilter.type).toBe('subquery')
      expect(innerFilter.subquery.schema).toBe('orgs-schema')
      expect(innerFilter.subquery.model).toBe('Organization')
    })
  })
})
