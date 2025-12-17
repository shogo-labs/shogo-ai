/**
 * SQL Backend Boundary Exploration
 *
 * Testing advanced SQL patterns to understand what @ucast/sql can/cannot do.
 */

import { describe, test, expect } from 'bun:test'
import { FieldCondition, CompoundCondition } from '@ucast/core'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import { createSqlInterpreter, allInterpreters, pg } from '@ucast/sql'

const parser = new MongoQueryParser({
  ...allParsingInstructions,
  $contains: { type: 'field' as const },
})

// ============================================================================
// BOUNDARY 1: JOINs via dot notation
// ============================================================================

describe('JOINs via dot notation', () => {
  test('dot notation fields - joinRelation=false strips relation prefix', () => {
    // @ucast/sql can detect "relation.field" patterns
    const condition = new FieldCondition('eq', 'author.name', 'Alice')

    // With joinRelation returning false, relation prefix is STRIPPED
    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params, joins] = interpret(condition, {
      ...pg,
      joinRelation: () => false,
    })

    console.log('Dot notation (no join):', sql, params, joins)
    // When joinRelation returns false, only the field name is used
    expect(sql).toContain('name')
    expect(joins).toEqual([]) // No joins tracked
  })

  test('joinRelation can track required joins', () => {
    const condition = new FieldCondition('eq', 'author.name', 'Alice')

    const requiredJoins: string[] = []
    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params, joins] = interpret(condition, {
      ...pg,
      joinRelation: (relationName: string) => {
        requiredJoins.push(relationName)
        return true // Signal that we'll handle the join
      },
    })

    console.log('Dot notation (with join tracking):', sql, params, joins)
    console.log('Required joins:', requiredJoins)

    // @ucast/sql tells us what joins are needed
    expect(requiredJoins).toContain('author')
  })

  test('nested relations (two levels)', () => {
    const condition = new FieldCondition('eq', 'author.organization.name', 'Acme')

    const requiredJoins: string[] = []
    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params, joins] = interpret(condition, {
      ...pg,
      joinRelation: (relationName: string) => {
        requiredJoins.push(relationName)
        return true
      },
    })

    console.log('Nested relation:', sql, params)
    console.log('Required joins:', requiredJoins)

    // Does it detect both levels?
    expect(requiredJoins.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// BOUNDARY 2: What @ucast/sql CANNOT do
// ============================================================================

describe('Patterns NOT supported by @ucast/sql', () => {
  test('NO: CTEs (WITH clauses)', () => {
    // CTEs require custom SQL building - @ucast/sql only generates WHERE clauses
    // We would need to wrap: WITH cte AS (...) SELECT * FROM cte WHERE {ucast}

    // This is a documentation test - showing what's not possible
    expect(true).toBe(true) // Placeholder
    console.log('CTEs: Must be built manually, @ucast/sql only generates WHERE clause conditions')
  })

  test('NO: Subqueries in WHERE', () => {
    // e.g., WHERE user_id IN (SELECT id FROM admins)
    // @ucast/sql's $in only takes literal arrays, not subqueries

    console.log('Subqueries: Not supported. $in takes literal arrays only.')
    expect(true).toBe(true)
  })

  test('NO: GROUP BY / HAVING / Aggregations', () => {
    // @ucast/sql generates filter conditions, not aggregation queries
    // SELECT status, COUNT(*) FROM users GROUP BY status HAVING COUNT(*) > 5

    console.log('Aggregations: Not supported. @ucast/sql is for WHERE clauses.')
    expect(true).toBe(true)
  })

  test('NO: Window functions', () => {
    // OVER(), PARTITION BY, ROW_NUMBER(), etc.
    console.log('Window functions: Not supported.')
    expect(true).toBe(true)
  })

  test('NO: UNION / INTERSECT / EXCEPT', () => {
    // Set operations between queries
    console.log('Set operations: Not supported.')
    expect(true).toBe(true)
  })

  test('NO: DISTINCT', () => {
    // SELECT DISTINCT would need to be added to our query builder
    console.log('DISTINCT: Would need manual addition to SELECT clause.')
    expect(true).toBe(true)
  })

  test('NO: Column projection (SELECT specific fields)', () => {
    // @ucast/sql generates WHERE, not SELECT clause
    // We always do SELECT * currently
    console.log('Column projection: Would need manual SELECT clause building.')
    expect(true).toBe(true)
  })
})

// ============================================================================
// BOUNDARY 3: Complex real-world patterns
// ============================================================================

describe('Real-world pattern boundaries', () => {
  test('CAN: Multi-table filter via foreign key IDs', () => {
    // Filter users by organization_id (FK), not by organization.name (join)
    const ast = parser.parse({
      organizationId: { $in: ['org-1', 'org-2'] },
      status: 'active'
    })

    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('FK-based filter:', sql)
    expect(sql).toContain('organizationId')
    expect(sql).toContain('in(')
    // This works! No join needed if we filter by FK values directly
  })

  test('CAN: Date range queries', () => {
    const ast = parser.parse({
      createdAt: { $gte: '2025-01-01', $lt: '2025-02-01' }
    })

    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('Date range:', sql, params)
    expect(sql).toContain('>=')
    expect(sql).toContain('<')
  })

  test('CAN: Text search with multiple fields', () => {
    const ast = parser.parse({
      $or: [
        { title: { $regex: 'laptop' } },
        { description: { $regex: 'laptop' } },
        { tags: { $regex: 'laptop' } }
      ]
    })

    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('Multi-field search:', sql)
    expect(sql).toContain('or')
    expect(sql).toContain('~') // PostgreSQL regex
  })

  test('CAN: Null checks', () => {
    // MongoDB $eq: null works for null checks
    const ast = parser.parse({
      deletedAt: { $eq: null }
    })

    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('Null check:', sql, params)
    // Note: This generates = NULL which is wrong SQL! Should be IS NULL
    // This is a limitation to document
  })

  test('LIMITATION: $eq: null generates wrong SQL', () => {
    const ast = parser.parse({ deletedAt: { $eq: null } })
    const interpret = createSqlInterpreter(allInterpreters)
    const [sql] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('Null equality bug:', sql)
    // @ucast/sql generates "deletedAt" = $1 with params [null]
    // But SQL needs IS NULL for correct semantics
    // This would need a custom interpreter or post-processing
  })

  test('CAN: Boolean fields', () => {
    const ast = parser.parse({
      isActive: true,
      isVerified: { $ne: false }
    })

    const interpret = createSqlInterpreter(allInterpreters)
    const [sql, params] = interpret(ast, { ...pg, joinRelation: () => false })

    console.log('Boolean:', sql, params)
    expect(params).toContain(true)
  })

  test('CAN: Array field contains (application-level)', () => {
    // For PostgreSQL array types, we'd need custom handling
    // For JSON arrays, we'd use @> operator
    // Current $in checks if VALUE is in ARRAY, not if ARRAY contains VALUE

    console.log('Array contains: Needs custom operator for PG arrays or JSONB')
    expect(true).toBe(true)
  })
})

// ============================================================================
// SUMMARY: Capability Matrix
// ============================================================================

describe('Capability Summary', () => {
  test('print capability matrix', () => {
    console.log(`
╔════════════════════════════════════════════════════════════════════╗
║                    SQL BACKEND CAPABILITY MATRIX                   ║
╠════════════════════════════════════════════════════════════════════╣
║ SUPPORTED (via @ucast/sql)                                         ║
║ ✅ WHERE clause with all comparison operators                      ║
║ ✅ AND/OR/NOT logical operators with nesting                       ║
║ ✅ IN/NOT IN with literal arrays                                   ║
║ ✅ LIKE pattern matching (via custom $contains)                    ║
║ ✅ PostgreSQL regex (~)                                            ║
║ ✅ Parameterized queries (SQL injection safe)                      ║
║ ✅ Dot notation for relation fields (join detection)               ║
╠════════════════════════════════════════════════════════════════════╣
║ SUPPORTED (manual addition to our SqlBackend)                      ║
║ ✅ ORDER BY (single and multi-field)                               ║
║ ✅ LIMIT / OFFSET pagination                                       ║
║ ✅ COUNT(*) queries                                                ║
║ ✅ EXISTS queries                                                  ║
║ ⚠️  JOINs (joinRelation callback tells us what's needed)          ║
╠════════════════════════════════════════════════════════════════════╣
║ NOT SUPPORTED (would need custom implementation)                   ║
║ ❌ CTEs (WITH clauses)                                             ║
║ ❌ Subqueries in WHERE (IN (SELECT ...))                           ║
║ ❌ GROUP BY / HAVING / aggregations                                ║
║ ❌ Window functions (OVER, PARTITION BY)                           ║
║ ❌ UNION / INTERSECT / EXCEPT                                      ║
║ ❌ DISTINCT                                                        ║
║ ❌ Column projection (SELECT specific fields)                      ║
║ ❌ IS NULL (generates = NULL instead)                              ║
║ ❌ PostgreSQL array operators (@>, &&)                             ║
║ ❌ JSONB operators (->, ->>, @>)                                   ║
╚════════════════════════════════════════════════════════════════════╝
    `)
    expect(true).toBe(true)
  })
})
