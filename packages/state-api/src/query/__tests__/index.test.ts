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
