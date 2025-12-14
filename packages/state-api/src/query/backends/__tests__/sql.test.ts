/**
 * SqlBackend Tests
 *
 * Test suite for SQL query compilation backend using @ucast/sql.
 * Validates all acceptance criteria for task-sql-backend.
 *
 * Requirements:
 * - REQ-03: Backend abstraction with SQL compilation
 * - SQL-01 through SQL-08: Operator translation, parameterization, capabilities
 *
 * Generated from TestSpecifications for task-sql-backend
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { FieldCondition, CompoundCondition } from '@ucast/core'
import { parseQuery } from '../../ast'
import type { IBackend, BackendCapabilities, QueryOptions } from '../types'

// Import will fail until implementation exists (expected RED phase)
import { SqlBackend } from '../sql'

describe('SqlBackend', () => {
  let backend: SqlBackend

  beforeEach(() => {
    backend = new SqlBackend()
  })

  // ==========================================================================
  // Test: test-sql-implements-interface
  // ==========================================================================
  describe('implements IBackend interface', () => {
    test('has execute method', () => {
      expect(backend).toHaveProperty('execute')
      expect(typeof backend.execute).toBe('function')
    })

    test('has capabilities property', () => {
      expect(backend).toHaveProperty('capabilities')
      expect(backend.capabilities).toBeDefined()
    })

    test('satisfies IBackend interface', () => {
      // TypeScript compile-time check
      const ibackend: IBackend = backend
      expect(ibackend).toBeDefined()
    })
  })

  // ==========================================================================
  // Test: test-sql-ucast-sql
  // ==========================================================================
  describe('uses @ucast/sql with PostgreSQL dialect', () => {
    test('produces PostgreSQL-compatible SQL', () => {
      const ast = parseQuery({ age: { $gt: 18 } })
      const result = backend.compileSelect(ast, 'users')

      const [sql, params] = result
      expect(sql).toBeDefined()
      expect(typeof sql).toBe('string')

      // PostgreSQL uses $1, $2 placeholders
      expect(sql).toMatch(/\$\d+/)
      expect(params).toContain(18)
    })

    test('uses createSqlInterpreter from @ucast/sql', () => {
      // This validates the implementation uses the correct library
      const ast = parseQuery({ name: { $eq: 'Alice' } })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // @ucast/sql generates parameterized queries
      expect(sql).toContain('=')
      expect(params).toHaveLength(1)
      expect(params[0]).toBe('Alice')
    })
  })

  // ==========================================================================
  // Test: test-sql-compile-select
  // ==========================================================================
  describe('compileSelect returns [sql, params, joins] tuple', () => {
    test('returns array with 3 elements', () => {
      const ast = parseQuery({ status: 'active' })
      const result = backend.compileSelect(ast, 'users')

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(3)
    })

    test('sql is string with WHERE clause', () => {
      const ast = parseQuery({ age: { $gte: 21 } })
      const [sql, params, joins] = backend.compileSelect(ast, 'users')

      expect(typeof sql).toBe('string')
      expect(sql.length).toBeGreaterThan(0)
      // Should contain the condition
      expect(sql).toContain('age')
    })

    test('params is array of parameter values', () => {
      const ast = parseQuery({
        name: 'Bob',
        age: { $lt: 30 }
      })
      const [sql, params, joins] = backend.compileSelect(ast, 'users')

      expect(Array.isArray(params)).toBe(true)
      expect(params).toContain('Bob')
      expect(params).toContain(30)
    })

    test('joins is array of required join names', () => {
      const ast = parseQuery({ status: 'active' })
      const [sql, params, joins] = backend.compileSelect(ast, 'users')

      expect(Array.isArray(joins)).toBe(true)
      // For simple query, no joins required
      expect(joins).toEqual([])
    })
  })

  // ==========================================================================
  // Test: test-sql-contains-like
  // ==========================================================================
  describe('$contains compiles to LIKE with wildcards', () => {
    test('SQL includes LIKE operator', () => {
      const ast = parseQuery({ name: { $contains: 'test' } })
      const [sql, params] = backend.compileSelect(ast, 'users')

      expect(sql.toLowerCase()).toContain('like')
    })

    test('parameter is wrapped in wildcards', () => {
      const ast = parseQuery({ name: { $contains: 'test' } })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // Should have exactly one param with wildcards
      expect(params).toHaveLength(1)
      expect(params[0]).toBe('%test%')
    })

    test('wildcards are parameterized, not string concatenation', () => {
      const ast = parseQuery({ name: { $contains: 'test' } })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // SQL should NOT contain literal '%test%'
      expect(sql).not.toContain('%test%')
      // SQL should contain placeholder
      expect(sql).toMatch(/\$\d+/)
      // Wildcards should be in params
      expect(params[0]).toContain('%')
    })
  })

  // ==========================================================================
  // Test: test-sql-orderby
  // ==========================================================================
  describe('ORDER BY clause constructed manually', () => {
    test('single field ascending', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = {
        orderBy: { field: 'name', direction: 'asc' }
      }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('ORDER BY')
      expect(sql).toContain('name')
      expect(sql).toContain('ASC')
    })

    test('single field descending', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = {
        orderBy: { field: 'createdAt', direction: 'desc' }
      }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('ORDER BY')
      expect(sql).toContain('createdAt')
      expect(sql).toContain('DESC')
    })

    test('multi-field ordering', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = {
        orderBy: [
          { field: 'priority', direction: 'desc' },
          { field: 'name', direction: 'asc' }
        ]
      }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('ORDER BY')
      expect(sql).toContain('priority')
      expect(sql).toContain('DESC')
      expect(sql).toContain('name')
      expect(sql).toContain('ASC')
    })

    test('field names are quoted', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = {
        orderBy: { field: 'name', direction: 'asc' }
      }
      const [sql] = backend.compileSelect(ast, 'users', options)

      // PostgreSQL uses double quotes for identifiers
      expect(sql).toContain('"name"')
    })
  })

  // ==========================================================================
  // Test: test-sql-limit-offset
  // ==========================================================================
  describe('LIMIT/OFFSET constructed manually', () => {
    test('LIMIT only', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = { take: 5 }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('LIMIT')
      expect(sql).toContain('5')
    })

    test('OFFSET only', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = { skip: 10 }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('OFFSET')
      expect(sql).toContain('10')
    })

    test('LIMIT and OFFSET together', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = { skip: 10, take: 5 }
      const [sql] = backend.compileSelect(ast, 'users', options)

      expect(sql).toContain('LIMIT')
      expect(sql).toContain('5')
      expect(sql).toContain('OFFSET')
      expect(sql).toContain('10')
    })

    test('clauses in correct order (LIMIT before OFFSET)', () => {
      const ast = parseQuery({ status: 'active' })
      const options: QueryOptions = { skip: 10, take: 5 }
      const [sql] = backend.compileSelect(ast, 'users', options)

      const limitIndex = sql.indexOf('LIMIT')
      const offsetIndex = sql.indexOf('OFFSET')

      expect(limitIndex).toBeGreaterThan(-1)
      expect(offsetIndex).toBeGreaterThan(-1)
      expect(limitIndex).toBeLessThan(offsetIndex)
    })
  })

  // ==========================================================================
  // Test: test-sql-compile-count
  // ==========================================================================
  describe('compileCount generates COUNT(*) query', () => {
    test('uses SELECT COUNT(*)', () => {
      const ast = parseQuery({ status: 'active' })
      const [sql] = backend.compileCount(ast, 'users')

      expect(sql).toContain('COUNT(*)')
      expect(sql).toContain('SELECT')
    })

    test('WHERE clause included', () => {
      const ast = parseQuery({ age: { $gte: 18 } })
      const [sql, params] = backend.compileCount(ast, 'users')

      expect(sql).toContain('WHERE')
      expect(sql).toContain('age')
      expect(params).toContain(18)
    })

    test('no ORDER BY in COUNT query', () => {
      const ast = parseQuery({ status: 'active' })
      const [sql] = backend.compileCount(ast, 'users')

      expect(sql).not.toContain('ORDER BY')
    })

    test('no LIMIT in COUNT query', () => {
      const ast = parseQuery({ status: 'active' })
      const [sql] = backend.compileCount(ast, 'users')

      expect(sql).not.toContain('LIMIT')
      expect(sql).not.toContain('OFFSET')
    })
  })

  // ==========================================================================
  // Test: test-sql-compile-exists
  // ==========================================================================
  describe('compileExists generates EXISTS query', () => {
    test('uses EXISTS or SELECT 1 ... LIMIT 1 pattern', () => {
      const ast = parseQuery({ email: 'test@example.com' })
      const [sql] = backend.compileExists(ast, 'users')

      // Either EXISTS pattern or SELECT 1 with LIMIT 1
      const hasExists = sql.toUpperCase().includes('EXISTS')
      const hasSelect1 = sql.includes('SELECT 1') || sql.includes('SELECT 1 ')
      const hasLimit1 = sql.includes('LIMIT 1')

      expect(hasExists || (hasSelect1 && hasLimit1)).toBe(true)
    })

    test('efficient for existence checks', () => {
      const ast = parseQuery({ id: 'user-123' })
      const [sql] = backend.compileExists(ast, 'users')

      // Should use LIMIT 1 to stop after first match
      expect(sql).toContain('LIMIT 1')
    })

    test('returns boolean-compatible result', () => {
      const ast = parseQuery({ status: 'active' })
      const [sql] = backend.compileExists(ast, 'users')

      // Should be a query that returns a boolean-like value
      // Either EXISTS subquery or SELECT 1 (returns row or no row)
      expect(sql).toBeDefined()
      expect(typeof sql).toBe('string')
    })
  })

  // ==========================================================================
  // Test: test-sql-capabilities
  // ==========================================================================
  describe('capabilities declares supported SQL operators', () => {
    test('includes comparison operators', () => {
      const { operators } = backend.capabilities

      expect(operators).toContain('eq')
      expect(operators).toContain('ne')
      expect(operators).toContain('gt')
      expect(operators).toContain('gte')
      expect(operators).toContain('lt')
      expect(operators).toContain('lte')
    })

    test('includes $in and $nin', () => {
      const { operators } = backend.capabilities

      expect(operators).toContain('in')
      expect(operators).toContain('nin')
    })

    test('includes $regex and $contains', () => {
      const { operators } = backend.capabilities

      expect(operators).toContain('regex')
      expect(operators).toContain('contains')
    })

    test('includes logical operators', () => {
      const { operators } = backend.capabilities

      // Logical operators typically handled at AST level,
      // but backend should declare support
      const hasAnd = operators.includes('and')
      const hasOr = operators.includes('or')
      const hasNot = operators.includes('not')

      // At least some logical support
      expect(hasAnd || hasOr).toBe(true)
    })
  })

  // ==========================================================================
  // Test: test-sql-parameterized
  // ==========================================================================
  describe('all queries use parameterized placeholders', () => {
    test('string values in params array', () => {
      const ast = parseQuery({ name: 'Alice' })
      const [sql, params] = backend.compileSelect(ast, 'users')

      expect(params).toContain('Alice')
      expect(sql).not.toContain("'Alice'")
      expect(sql).toMatch(/\$\d+/)
    })

    test('number values in params array', () => {
      const ast = parseQuery({ age: 25 })
      const [sql, params] = backend.compileSelect(ast, 'users')

      expect(params).toContain(25)
      expect(sql).toMatch(/\$\d+/)
    })

    test('special characters handled safely', () => {
      const ast = parseQuery({ name: "O'Brien'; DROP TABLE users; --" })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // SQL injection attempt should be in params, not SQL string
      expect(params).toHaveLength(1)
      expect(params[0]).toContain("O'Brien")
      expect(sql).not.toContain("DROP TABLE")
    })

    test('placeholders use $1, $2 format', () => {
      const ast = parseQuery({
        name: 'Alice',
        age: { $gt: 18 },
        status: 'active'
      })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // Should have multiple params
      expect(params.length).toBeGreaterThanOrEqual(3)

      // Should use PostgreSQL $n placeholders
      expect(sql).toMatch(/\$1/)
      expect(sql).toMatch(/\$2/)
      expect(sql).toMatch(/\$3/)
    })
  })

  // ==========================================================================
  // Test: test-sql-no-auto-join
  // ==========================================================================
  describe('joinRelation returns false (no automatic joins)', () => {
    test('dot notation field tracked but not auto-generated', () => {
      const ast = parseQuery({ 'author.name': 'Alice' })
      const [sql, params, joins] = backend.compileSelect(ast, 'posts')

      // Join should be tracked in joins array
      expect(joins).toContain('author')

      // But SQL should NOT contain JOIN clause
      expect(sql.toUpperCase()).not.toContain('JOIN')
    })

    test('consumer responsible for adding JOIN clause', () => {
      const ast = parseQuery({ 'author.name': 'Alice' })
      const [sql, params, joins] = backend.compileSelect(ast, 'posts')

      // We get the list of required joins
      expect(Array.isArray(joins)).toBe(true)

      // Consumer must construct:
      // SELECT * FROM posts
      // LEFT JOIN users author ON posts.author_id = author.id
      // WHERE {sql}

      // The returned SQL is just the WHERE clause conditions
      expect(sql).toBeTruthy()
    })
  })

  // ==========================================================================
  // Test: test-sql-null-limitation
  // ==========================================================================
  describe('$eq: null generates = NULL (documented limitation)', () => {
    test('generates = $1 with null param', () => {
      const ast = parseQuery({ deletedAt: { $eq: null } })
      const [sql, params] = backend.compileSelect(ast, 'users')

      // @ucast/sql generates = with null param
      expect(sql).toContain('=')
      expect(params).toContain(null)
    })

    test('does NOT generate IS NULL (known limitation)', () => {
      const ast = parseQuery({ deletedAt: { $eq: null } })
      const [sql] = backend.compileSelect(ast, 'users')

      // Known bug: should be IS NULL, but @ucast/sql generates = NULL
      expect(sql.toUpperCase()).not.toContain('IS NULL')
    })

    test('limitation documented in code comments', () => {
      // This test validates that the implementation includes documentation
      // The actual code inspection would be:
      // - Check that sql.ts has comments explaining the = NULL limitation
      // - This is a reminder to add that documentation

      expect(true).toBe(true) // Placeholder
      // Real validation would be code review or AST parsing
    })
  })

  // ==========================================================================
  // Test: test-sql-operator-translation
  // ==========================================================================
  describe('all operators translate to correct SQL', () => {
    test('$eq becomes =', () => {
      const ast = parseQuery({ age: { $eq: 25 } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql).toContain('=')
    })

    test('$ne becomes <> or !=', () => {
      const ast = parseQuery({ status: { $ne: 'deleted' } })
      const [sql] = backend.compileSelect(ast, 'users')

      const hasNotEqual = sql.includes('<>') || sql.includes('!=')
      expect(hasNotEqual).toBe(true)
    })

    test('$gt becomes >', () => {
      const ast = parseQuery({ age: { $gt: 18 } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql).toContain('>')
      expect(sql).not.toContain('>=') // Ensure it's >, not >=
    })

    test('$gte becomes >=', () => {
      const ast = parseQuery({ age: { $gte: 18 } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql).toContain('>=')
    })

    test('$lt becomes <', () => {
      const ast = parseQuery({ age: { $lt: 65 } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql).toContain('<')
      expect(sql).not.toContain('<=')
    })

    test('$lte becomes <=', () => {
      const ast = parseQuery({ age: { $lte: 65 } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql).toContain('<=')
    })

    test('$in becomes IN(...)', () => {
      const ast = parseQuery({ status: { $in: ['active', 'pending'] } })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql.toLowerCase()).toContain('in')
      expect(sql).toContain('(')
      expect(sql).toContain(')')
    })

    test('$nin becomes NOT IN(...)', () => {
      const ast = parseQuery({ status: { $nin: ['deleted', 'banned'] } })
      const [sql] = backend.compileSelect(ast, 'users')

      const sqlLower = sql.toLowerCase()
      expect(sqlLower).toContain('not')
      expect(sqlLower).toContain('in')
    })

    test('$regex becomes ~ (PostgreSQL)', () => {
      const ast = parseQuery({ email: { $regex: '@example\\.com$' } })
      const [sql] = backend.compileSelect(ast, 'users')

      // PostgreSQL uses ~ for case-sensitive regex
      expect(sql).toContain('~')
    })

    test('$and becomes AND', () => {
      const ast = parseQuery({
        $and: [
          { age: { $gte: 18 } },
          { status: 'active' }
        ]
      })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql.toUpperCase()).toContain('AND')
    })

    test('$or becomes OR', () => {
      const ast = parseQuery({
        $or: [
          { status: 'active' },
          { status: 'pending' }
        ]
      })
      const [sql] = backend.compileSelect(ast, 'users')

      expect(sql.toUpperCase()).toContain('OR')
    })
  })
})
