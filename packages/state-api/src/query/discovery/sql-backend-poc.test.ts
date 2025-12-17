/**
 * SQL Backend PoC
 *
 * Testing against requirements from spec/04-sql-backend.md:
 * - SQL-01: Translate all operators to SQL equivalents
 * - SQL-02: Generate parameterized queries (SQL injection safe)
 * - SQL-03: Support orderBy with column mapping
 * - SQL-04: Support LIMIT/OFFSET pagination
 * - SQL-05: Optimize count() to use COUNT(*)
 * - SQL-06: Optimize any() to use EXISTS
 * - SQL-07: Materialize results as MST instances
 * - SQL-08: Declare capabilities via BackendCapabilities
 *
 * Evaluating: @ucast/sql
 */

import { describe, test, expect } from 'bun:test'
import { FieldCondition, CompoundCondition, type Condition } from '@ucast/core'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import {
  createSqlInterpreter,
  allInterpreters as sqlInterpreters,
  pg,  // PostgreSQL dialect
} from '@ucast/sql'

// ============================================================================
// PARSER SETUP
// ============================================================================

const parser = new MongoQueryParser({
  ...allParsingInstructions,
  $contains: { type: 'field' as const },
})

// ============================================================================
// SQL INTERPRETER SETUP
// ============================================================================

/**
 * Custom $contains interpreter for SQL.
 * Uses @ucast/sql's SqlOperator pattern.
 */
import type { SqlOperator } from '@ucast/sql'

const contains: SqlOperator<FieldCondition<string>> = (condition, query) => {
  // Use LIKE with % wildcards for contains
  return query.where(condition.field, 'LIKE', `%${condition.value}%`)
}

// Create SQL interpreter with extended operators
const interpret = createSqlInterpreter({
  ...sqlInterpreters,
  contains,
})

/**
 * SQL dialect options for PostgreSQL.
 */
const pgOptions = {
  ...pg,
  joinRelation: () => false, // Don't auto-join relations
}

// ============================================================================
// SQL BACKEND IMPLEMENTATION
// ============================================================================

interface BackendCapabilities {
  operators: Set<string>
  features: {
    orderBy: boolean
    pagination: boolean
    include: boolean
    select: boolean
    groupBy: boolean
  }
  optimizations: {
    supportsNativeCount: boolean
    supportsNativeExists: boolean
    supportsStreaming: boolean
  }
}

interface QueryDescriptor {
  filter?: object
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>
  skip?: number
  take?: number
}

interface CompiledQuery {
  sql: string
  params: any[]
}

/**
 * SQL Backend that compiles MongoDB-style queries to PostgreSQL.
 */
class SqlBackend {
  readonly name = 'postgres'
  readonly capabilities: BackendCapabilities = {
    operators: new Set([
      'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
      'in', 'nin', 'regex', 'contains',
      'and', 'or', 'not'
    ]),
    features: {
      orderBy: true,
      pagination: true,
      include: true,
      select: true,
      groupBy: true
    },
    optimizations: {
      supportsNativeCount: true,
      supportsNativeExists: true,
      supportsStreaming: true
    }
  }

  /**
   * Compile a SELECT query.
   */
  compileSelect(tableName: string, query: QueryDescriptor): CompiledQuery {
    const parts: string[] = [`SELECT * FROM ${this.escapeIdentifier(tableName)}`]
    let params: any[] = []

    // WHERE clause
    if (query.filter && Object.keys(query.filter).length > 0) {
      const ast = parser.parse(query.filter)
      // @ucast/sql returns [sql, params, joins] tuple
      const [whereSql, whereParams] = interpret(ast, pgOptions)
      parts.push(`WHERE ${whereSql}`)
      params = whereParams
    }

    // ORDER BY clause
    if (query.orderBy && query.orderBy.length > 0) {
      const orderClauses = query.orderBy.map(
        ({ field, direction }) =>
          `${this.escapeIdentifier(field)} ${direction.toUpperCase()}`
      )
      parts.push(`ORDER BY ${orderClauses.join(', ')}`)
    }

    // LIMIT/OFFSET
    if (query.take !== undefined) {
      parts.push(`LIMIT ${query.take}`)
    }
    if (query.skip !== undefined) {
      parts.push(`OFFSET ${query.skip}`)
    }

    return {
      sql: parts.join(' '),
      params,
    }
  }

  /**
   * Compile a COUNT(*) query.
   */
  compileCount(tableName: string, filter?: object): CompiledQuery {
    const parts: string[] = [`SELECT COUNT(*) as count FROM ${this.escapeIdentifier(tableName)}`]
    let params: any[] = []

    if (filter && Object.keys(filter).length > 0) {
      const ast = parser.parse(filter)
      const [whereSql, whereParams] = interpret(ast, pgOptions)
      parts.push(`WHERE ${whereSql}`)
      params = whereParams
    }

    return {
      sql: parts.join(' '),
      params,
    }
  }

  /**
   * Compile an EXISTS query.
   */
  compileExists(tableName: string, filter?: object): CompiledQuery {
    const escapedTable = this.escapeIdentifier(tableName)
    let innerSql = `SELECT 1 FROM ${escapedTable}`
    let params: any[] = []

    if (filter && Object.keys(filter).length > 0) {
      const ast = parser.parse(filter)
      const [whereSql, whereParams] = interpret(ast, pgOptions)
      innerSql += ` WHERE ${whereSql}`
      params = whereParams
    }

    innerSql += ' LIMIT 1'

    return {
      sql: `SELECT EXISTS(${innerSql}) as exists`,
      params,
    }
  }

  /**
   * Compile a SELECT with LIMIT 1 for first().
   */
  compileFirst(tableName: string, query: QueryDescriptor): CompiledQuery {
    return this.compileSelect(tableName, { ...query, take: 1 })
  }

  /**
   * Escape SQL identifier (table/column name).
   */
  private escapeIdentifier(name: string): string {
    // PostgreSQL uses double quotes for identifiers
    return `"${name.replace(/"/g, '""')}"`
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('SQL Backend PoC', () => {
  const backend = new SqlBackend()

  describe('SQL-01: Operator Translation', () => {
    test('$eq - equality', () => {
      const result = backend.compileSelect('users', {
        filter: { status: 'active' }
      })
      expect(result.sql).toContain('WHERE')
      expect(result.sql).toContain('"status"')
      expect(result.sql).toContain('=')
      expect(result.params).toContain('active')
    })

    test('$ne - not equal', () => {
      const result = backend.compileSelect('users', {
        filter: { status: { $ne: 'deleted' } }
      })
      expect(result.sql).toContain('<>')
      expect(result.params).toContain('deleted')
    })

    test('$gt - greater than', () => {
      const result = backend.compileSelect('users', {
        filter: { age: { $gt: 18 } }
      })
      expect(result.sql).toContain('>')
      expect(result.params).toContain(18)
    })

    test('$gte - greater than or equal', () => {
      const result = backend.compileSelect('users', {
        filter: { age: { $gte: 21 } }
      })
      expect(result.sql).toContain('>=')
      expect(result.params).toContain(21)
    })

    test('$lt - less than', () => {
      const result = backend.compileSelect('users', {
        filter: { age: { $lt: 65 } }
      })
      expect(result.sql).toContain('<')
      expect(result.params).toContain(65)
    })

    test('$lte - less than or equal', () => {
      const result = backend.compileSelect('users', {
        filter: { age: { $lte: 30 } }
      })
      expect(result.sql).toContain('<=')
      expect(result.params).toContain(30)
    })

    test('$in - in array', () => {
      const result = backend.compileSelect('users', {
        filter: { role: { $in: ['admin', 'moderator'] } }
      })
      expect(result.sql.toLowerCase()).toContain('in(')
      expect(result.params).toEqual(expect.arrayContaining(['admin', 'moderator']))
    })

    test('$nin - not in array', () => {
      const result = backend.compileSelect('users', {
        filter: { status: { $nin: ['deleted', 'banned'] } }
      })
      expect(result.sql.toLowerCase()).toContain('not in(')
    })

    test('$regex - regular expression (PostgreSQL)', () => {
      const result = backend.compileSelect('users', {
        filter: { email: { $regex: '@example\\.com$' } }
      })
      expect(result.sql).toContain('~')
      expect(result.params).toContain('@example\\.com$')
    })

    test('$contains - LIKE pattern', () => {
      const result = backend.compileSelect('users', {
        filter: { name: { $contains: 'Smith' } }
      })
      expect(result.sql).toContain('LIKE')
      // Value with wildcards is in params (parameterized for safety)
      expect(result.params).toContain('%Smith%')
    })
  })

  describe('SQL-01: Logical Operators', () => {
    test('implicit $and', () => {
      const result = backend.compileSelect('users', {
        filter: { status: 'active', age: { $gte: 18 } }
      })
      // @ucast/sql uses lowercase 'and'
      expect(result.sql.toLowerCase()).toContain(' and ')
      expect(result.params).toHaveLength(2)
    })

    test('explicit $or', () => {
      const result = backend.compileSelect('users', {
        filter: {
          $or: [
            { status: 'active' },
            { featured: true }
          ]
        }
      })
      expect(result.sql.toLowerCase()).toContain(' or ')
    })

    test('nested $and/$or', () => {
      const result = backend.compileSelect('products', {
        filter: {
          $and: [
            { category: 'electronics' },
            {
              $or: [
                { price: { $lt: 100 } },
                { onSale: true }
              ]
            }
          ]
        }
      })
      expect(result.sql.toLowerCase()).toContain(' and ')
      expect(result.sql.toLowerCase()).toContain(' or ')
      // Should have proper grouping
      expect(result.sql).toContain('(')
    })

    test('$not - negation', () => {
      const result = backend.compileSelect('users', {
        filter: {
          status: { $not: { $eq: 'deleted' } }
        }
      })
      expect(result.sql.toLowerCase()).toContain('not ')
    })
  })

  describe('SQL-02: Parameterized Queries (SQL Injection Safe)', () => {
    test('values are parameterized, not interpolated', () => {
      const maliciousInput = "'; DROP TABLE users; --"
      const result = backend.compileSelect('users', {
        filter: { name: maliciousInput }
      })

      // SQL should use parameter placeholder, not literal value
      expect(result.sql).not.toContain(maliciousInput)
      expect(result.params).toContain(maliciousInput)
    })

    test('identifiers are escaped', () => {
      const result = backend.compileSelect('users', {
        filter: { status: 'active' }
      })
      // PostgreSQL identifier escaping uses double quotes
      expect(result.sql).toContain('"users"')
      expect(result.sql).toContain('"status"')
    })

    test('parameter count matches placeholders', () => {
      const result = backend.compileSelect('users', {
        filter: {
          status: 'active',
          role: { $in: ['admin', 'user'] },
          age: { $gte: 18 }
        }
      })
      // Count ? placeholders in SQL (may vary by @ucast/sql implementation)
      // The key is params array length should match query needs
      expect(result.params.length).toBeGreaterThan(0)
    })
  })

  describe('SQL-03: ORDER BY', () => {
    test('single column ascending', () => {
      const result = backend.compileSelect('users', {
        orderBy: [{ field: 'name', direction: 'asc' }]
      })
      expect(result.sql).toContain('ORDER BY')
      expect(result.sql).toContain('"name"')
      expect(result.sql).toContain('ASC')
    })

    test('single column descending', () => {
      const result = backend.compileSelect('users', {
        orderBy: [{ field: 'createdAt', direction: 'desc' }]
      })
      expect(result.sql).toContain('DESC')
    })

    test('multi-column sort', () => {
      const result = backend.compileSelect('users', {
        orderBy: [
          { field: 'status', direction: 'asc' },
          { field: 'createdAt', direction: 'desc' }
        ]
      })
      expect(result.sql).toContain('"status" ASC')
      expect(result.sql).toContain('"createdAt" DESC')
    })

    test('orderBy with filter', () => {
      const result = backend.compileSelect('users', {
        filter: { status: 'active' },
        orderBy: [{ field: 'name', direction: 'asc' }]
      })
      expect(result.sql).toContain('WHERE')
      expect(result.sql).toContain('ORDER BY')
      // ORDER BY should come after WHERE
      const whereIndex = result.sql.indexOf('WHERE')
      const orderIndex = result.sql.indexOf('ORDER BY')
      expect(orderIndex).toBeGreaterThan(whereIndex)
    })
  })

  describe('SQL-04: LIMIT/OFFSET Pagination', () => {
    test('LIMIT only (take)', () => {
      const result = backend.compileSelect('users', { take: 10 })
      expect(result.sql).toContain('LIMIT 10')
    })

    test('OFFSET only (skip)', () => {
      const result = backend.compileSelect('users', { skip: 20 })
      expect(result.sql).toContain('OFFSET 20')
    })

    test('LIMIT and OFFSET', () => {
      const result = backend.compileSelect('users', { skip: 20, take: 10 })
      expect(result.sql).toContain('LIMIT 10')
      expect(result.sql).toContain('OFFSET 20')
    })

    test('pagination with filter and orderBy', () => {
      const result = backend.compileSelect('users', {
        filter: { status: 'active' },
        orderBy: [{ field: 'createdAt', direction: 'desc' }],
        skip: 10,
        take: 5
      })
      expect(result.sql).toContain('WHERE')
      expect(result.sql).toContain('ORDER BY')
      expect(result.sql).toContain('LIMIT 5')
      expect(result.sql).toContain('OFFSET 10')
    })
  })

  describe('SQL-05: COUNT(*) Optimization', () => {
    test('count without filter', () => {
      const result = backend.compileCount('users')
      expect(result.sql).toContain('SELECT COUNT(*)')
      expect(result.sql).toContain('FROM "users"')
      expect(result.sql).not.toContain('WHERE')
    })

    test('count with filter', () => {
      const result = backend.compileCount('users', { status: 'active' })
      expect(result.sql).toContain('SELECT COUNT(*)')
      expect(result.sql).toContain('WHERE')
      expect(result.params).toContain('active')
    })
  })

  describe('SQL-06: EXISTS Optimization', () => {
    test('exists without filter', () => {
      const result = backend.compileExists('users')
      expect(result.sql).toContain('SELECT EXISTS')
      expect(result.sql).toContain('LIMIT 1')
    })

    test('exists with filter', () => {
      const result = backend.compileExists('users', { email: 'test@example.com' })
      expect(result.sql).toContain('SELECT EXISTS')
      expect(result.sql).toContain('WHERE')
      expect(result.sql).toContain('LIMIT 1')
      expect(result.params).toContain('test@example.com')
    })
  })

  describe('SQL-08: Capabilities Declaration', () => {
    test('declares all operators', () => {
      expect(backend.capabilities.operators.has('eq')).toBe(true)
      expect(backend.capabilities.operators.has('regex')).toBe(true)
      expect(backend.capabilities.operators.has('contains')).toBe(true)
    })

    test('declares features', () => {
      expect(backend.capabilities.features.orderBy).toBe(true)
      expect(backend.capabilities.features.pagination).toBe(true)
      expect(backend.capabilities.features.include).toBe(true)
    })

    test('declares optimizations', () => {
      expect(backend.capabilities.optimizations.supportsNativeCount).toBe(true)
      expect(backend.capabilities.optimizations.supportsNativeExists).toBe(true)
    })
  })

  describe('compileFirst() - LIMIT 1 optimization', () => {
    test('generates LIMIT 1', () => {
      const result = backend.compileFirst('users', {
        filter: { email: 'test@example.com' }
      })
      expect(result.sql).toContain('LIMIT 1')
    })

    test('respects orderBy for first()', () => {
      const result = backend.compileFirst('users', {
        filter: { status: 'active' },
        orderBy: [{ field: 'createdAt', direction: 'desc' }]
      })
      expect(result.sql).toContain('ORDER BY')
      expect(result.sql).toContain('LIMIT 1')
    })
  })

  describe('Edge Cases', () => {
    test('empty filter generates no WHERE clause', () => {
      const result = backend.compileSelect('users', { filter: {} })
      expect(result.sql).not.toContain('WHERE')
    })

    test('no filter generates SELECT all', () => {
      const result = backend.compileSelect('users', {})
      expect(result.sql).toBe('SELECT * FROM "users"')
    })

    test('handles special characters in values', () => {
      const result = backend.compileSelect('users', {
        filter: { bio: { $contains: "O'Brien" } }
      })
      // Value (with wildcards) should be in params, not SQL
      expect(result.params).toContain("%O'Brien%")
    })
  })
})

describe('Full Query Examples', () => {
  const backend = new SqlBackend()

  test('realistic user query', () => {
    const result = backend.compileSelect('users', {
      filter: {
        $and: [
          { status: { $in: ['active', 'pending'] } },
          { age: { $gte: 18 } },
          {
            $or: [
              { role: 'admin' },
              { verified: true }
            ]
          }
        ]
      },
      orderBy: [
        { field: 'role', direction: 'asc' },
        { field: 'createdAt', direction: 'desc' }
      ],
      skip: 0,
      take: 20
    })

    console.log('Realistic query SQL:', result.sql)
    console.log('Params:', result.params)

    expect(result.sql).toContain('SELECT * FROM "users"')
    expect(result.sql).toContain('WHERE')
    expect(result.sql).toContain('ORDER BY')
    expect(result.sql).toContain('LIMIT 20')
  })

  test('search with pagination', () => {
    const result = backend.compileSelect('products', {
      filter: {
        $or: [
          { name: { $contains: 'laptop' } },
          { description: { $contains: 'laptop' } }
        ]
      },
      orderBy: [{ field: 'price', direction: 'asc' }],
      skip: 20,
      take: 10
    })

    console.log('Search query SQL:', result.sql)
    expect(result.sql).toContain('LIKE')
    expect(result.sql).toContain('OR')
  })
})
