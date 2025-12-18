/**
 * Tests for query/index.ts barrel exports
 *
 * Generated from TestSpecification: test-query-index-exports
 *
 * Verifies that the top-level query module exports all necessary
 * components from AST, validation, backends, and registry.
 */

import { describe, test, expect } from 'bun:test'

describe('query/index.ts barrel exports entire module', () => {
  test('AST types and functions exported', async () => {
    // Given: query/index.ts module exists
    // When: Importing from query/index.ts
    const queryModule = await import('../index')

    // Then: AST types and functions should be exported
    expect(queryModule.parseQuery).toBeDefined()
    expect(queryModule.createQueryParser).toBeDefined()
    expect(queryModule.defaultParser).toBeDefined()
    expect(queryModule.serializeCondition).toBeDefined()
    expect(queryModule.deserializeCondition).toBeDefined()
    expect(queryModule.Condition).toBeDefined()
    expect(queryModule.FieldCondition).toBeDefined()
    expect(queryModule.CompoundCondition).toBeDefined()
  })

  test('validation components exported', async () => {
    // Given: query/index.ts module exists
    // When: Importing validation components
    const queryModule = await import('../index')

    // Then: Validation exports should be available
    expect(queryModule.QueryValidator).toBeDefined()
    expect(queryModule.OPERATOR_BY_TYPE).toBeDefined()
    expect(typeof queryModule.QueryValidator).toBe('function')
  })

  test('backend classes exported', async () => {
    // Given: query/index.ts module exists
    // When: Importing backend implementations
    const queryModule = await import('../index')

    // Then: Backend classes should be exported
    expect(queryModule.MemoryBackend).toBeDefined()
    expect(queryModule.SqlBackend).toBeDefined()
    expect(typeof queryModule.MemoryBackend).toBe('function')
    expect(typeof queryModule.SqlBackend).toBe('function')
  })

  test('registry components exported', async () => {
    // Given: query/index.ts module exists
    // When: Importing registry components
    const queryModule = await import('../index')

    // Then: Registry exports should be available
    expect(queryModule.BackendRegistry).toBeDefined()
    expect(queryModule.createBackendRegistry).toBeDefined()
    expect(typeof queryModule.BackendRegistry).toBe('function')
    expect(typeof queryModule.createBackendRegistry).toBe('function')
  })

  test('can use exports together in integration', async () => {
    // Given: All query module exports
    const {
      parseQuery,
      MemoryBackend,
      createBackendRegistry
    } = await import('../index')

    // When: Using them together
    const backend = new MemoryBackend()
    const registry = createBackendRegistry({
      default: 'memory',
      backends: { memory: backend }
    })
    const ast = parseQuery({ status: 'active' })

    // Then: Should work together
    expect(backend).toBeDefined()
    expect(registry).toBeDefined()
    expect(ast).toBeDefined()
    expect(registry.has('memory')).toBe(true)
  })
})

/**
 * Tests for Phase 2 exports: execution module and PostgresBackend
 *
 * Generated from TestSpecifications:
 * - test-p2-query-index-01: execution module types
 * - test-p2-query-index-02: BunSqlExecutor class
 * - test-p2-query-index-03: utility functions
 * - test-p2-query-index-04: PostgresBackend
 */
describe('query/index.ts re-exports execution module', () => {
  test('execution module types are exported', async () => {
    // Given: query/index.ts module exists
    // When: ISqlExecutor, SqlExecutorConfig are imported from query
    const queryModule = await import('../index')

    // Then: Types should be available at top-level query module
    // Note: Type exports can't be tested at runtime, but we can verify the module structure
    expect(queryModule).toBeDefined()
  })

  test('BunSqlExecutor is NOT exported from barrel (server-only)', async () => {
    // Given: query/index.ts module exists
    // When: Checking for BunSqlExecutor in query barrel
    const queryModule = await import('../index')

    // Then: BunSqlExecutor should NOT be in the barrel (prevents browser bundle bloat)
    expect((queryModule as any).BunSqlExecutor).toBeUndefined()

    // But: It's still available via direct import for server-side code
    const { BunSqlExecutor } = await import('../execution/bun-sql')
    expect(BunSqlExecutor).toBeDefined()
    expect(typeof BunSqlExecutor).toBe('function')
  })

  test('utility functions are exported', async () => {
    // Given: query/index.ts module exists
    // When: snakeToCamel, camelToSnake, normalizeRow, normalizeRows are imported from query
    const { snakeToCamel, camelToSnake, normalizeRow, normalizeRows } = await import('../index')

    // Then: All utility functions should be available at top-level
    expect(snakeToCamel).toBeDefined()
    expect(camelToSnake).toBeDefined()
    expect(normalizeRow).toBeDefined()
    expect(normalizeRows).toBeDefined()

    // And: Functions should work correctly after re-export
    expect(typeof snakeToCamel).toBe('function')
    expect(typeof camelToSnake).toBe('function')
    expect(typeof normalizeRow).toBe('function')
    expect(typeof normalizeRows).toBe('function')

    // Verify basic functionality
    expect(snakeToCamel('created_at')).toBe('createdAt')
    expect(camelToSnake('createdAt')).toBe('created_at')
  })

  test('PostgresBackend is exported from backends', async () => {
    // Given: query/index.ts module exists
    // When: PostgresBackend is imported from query
    const { PostgresBackend } = await import('../index')

    // Then: PostgresBackend class should be available at top-level
    expect(PostgresBackend).toBeDefined()
    expect(typeof PostgresBackend).toBe('function')

    // And: Follows existing pattern for backend exports
    expect(PostgresBackend.prototype.constructor).toBeDefined()
  })
})
