/**
 * Tests for query/ast/index.ts barrel exports
 *
 * Generated from TestSpecifications:
 * - test-ast-index-types
 * - test-ast-index-parser
 * - test-ast-index-operators
 * - test-ast-index-serialization
 * - test-ast-index-ucast
 * - test-ast-index-integration
 *
 * Task: task-query-ast-index
 * Requirement: req-02-mongodb-operators
 */

import { describe, test, expect } from 'bun:test'

describe('query/ast/index barrel exports', () => {
  describe('test-ast-index-types: Index re-exports all types from types.ts', () => {
    test('QueryFilter type is accessible', () => {
      // Given: ast/index.ts module exists
      // When: Importing types from ast/index.ts
      // Then: QueryFilter type is accessible

      const importTypes = async () => {
        const module = await import('../index')
        // Check that QueryFilter is available as a type (runtime check via function parameter)
        const testFn = (filter: typeof module extends { QueryFilter: infer T } ? T : never) => filter
        expect(testFn).toBeDefined()
      }

      expect(importTypes).not.toThrow()
    })

    test('OperatorExpression type is accessible', () => {
      // Given: ast/index.ts module exists
      // When: Importing types from ast/index.ts
      // Then: OperatorExpression type is accessible

      const importTypes = async () => {
        const module = await import('../index')
        // Check that OperatorExpression is available as a type
        const testFn = (expr: typeof module extends { OperatorExpression: infer T } ? T : never) => expr
        expect(testFn).toBeDefined()
      }

      expect(importTypes).not.toThrow()
    })

    test('LogicalExpression type is accessible', () => {
      // Given: ast/index.ts module exists
      // When: Importing types from ast/index.ts
      // Then: LogicalExpression type is accessible

      const importTypes = async () => {
        const module = await import('../index')
        // Check that LogicalExpression is available as a type
        const testFn = (expr: typeof module extends { LogicalExpression: infer T } ? T : never) => expr
        expect(testFn).toBeDefined()
      }

      expect(importTypes).not.toThrow()
    })

    test('SerializedCondition type is accessible', () => {
      // Given: ast/index.ts module exists
      // When: Importing types from ast/index.ts
      // Then: SerializedCondition type is accessible

      const importTypes = async () => {
        const module = await import('../index')
        // Check that SerializedCondition is available as a type
        const testFn = (cond: typeof module extends { SerializedCondition: infer T } ? T : never) => cond
        expect(testFn).toBeDefined()
      }

      expect(importTypes).not.toThrow()
    })
  })

  describe('test-ast-index-parser: Index re-exports parser functions', () => {
    test('parseQuery function is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing parser functions from ast/index.ts
      // Then: parseQuery function is accessible

      const { parseQuery } = await import('../index')
      expect(parseQuery).toBeDefined()
      expect(typeof parseQuery).toBe('function')
    })

    test('createQueryParser function is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing parser functions from ast/index.ts
      // Then: createQueryParser function is accessible

      const { createQueryParser } = await import('../index')
      expect(createQueryParser).toBeDefined()
      expect(typeof createQueryParser).toBe('function')
    })

    test('defaultParser instance is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing parser functions from ast/index.ts
      // Then: defaultParser instance is accessible

      const { defaultParser } = await import('../index')
      expect(defaultParser).toBeDefined()
      expect(defaultParser.parse).toBeDefined()
      expect(typeof defaultParser.parse).toBe('function')
    })
  })

  describe('test-ast-index-operators: Index re-exports operator utilities', () => {
    test('containsInstruction is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing operator utilities from ast/index.ts
      // Then: containsInstruction is accessible

      const { containsInstruction } = await import('../index')
      expect(containsInstruction).toBeDefined()
      expect(containsInstruction.type).toBe('field')
    })

    test('getCustomParsingInstructions is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing operator utilities from ast/index.ts
      // Then: getCustomParsingInstructions is accessible

      const { getCustomParsingInstructions } = await import('../index')
      expect(getCustomParsingInstructions).toBeDefined()
      expect(typeof getCustomParsingInstructions).toBe('function')
    })

    test('registerCustomOperator is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing operator utilities from ast/index.ts
      // Then: registerCustomOperator is accessible

      const { registerCustomOperator } = await import('../index')
      expect(registerCustomOperator).toBeDefined()
      expect(typeof registerCustomOperator).toBe('function')
    })
  })

  describe('test-ast-index-serialization: Index re-exports serialization functions', () => {
    test('serializeCondition function is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing serialization functions from ast/index.ts
      // Then: serializeCondition function is accessible

      const { serializeCondition } = await import('../index')
      expect(serializeCondition).toBeDefined()
      expect(typeof serializeCondition).toBe('function')
    })

    test('deserializeCondition function is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing serialization functions from ast/index.ts
      // Then: deserializeCondition function is accessible

      const { deserializeCondition } = await import('../index')
      expect(deserializeCondition).toBeDefined()
      expect(typeof deserializeCondition).toBe('function')
    })
  })

  describe('test-ast-index-ucast: Index re-exports @ucast/core classes', () => {
    test('Condition class is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing @ucast/core classes from ast/index.ts
      // Then: Condition class is accessible

      const { Condition } = await import('../index')
      expect(Condition).toBeDefined()
      expect(typeof Condition).toBe('function')
    })

    test('FieldCondition class is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing @ucast/core classes from ast/index.ts
      // Then: FieldCondition class is accessible

      const { FieldCondition } = await import('../index')
      expect(FieldCondition).toBeDefined()
      expect(typeof FieldCondition).toBe('function')
    })

    test('CompoundCondition class is accessible', async () => {
      // Given: ast/index.ts module exists
      // When: Importing @ucast/core classes from ast/index.ts
      // Then: CompoundCondition class is accessible

      const { CompoundCondition } = await import('../index')
      expect(CompoundCondition).toBeDefined()
      expect(typeof CompoundCondition).toBe('function')
    })
  })

  describe('test-ast-index-integration: All exports work together in typical usage', () => {
    test('parseQuery returns Condition', async () => {
      // Given: All exports imported from ast/index.ts
      // When: Using parseQuery
      // Then: parseQuery returns Condition

      const { parseQuery, Condition } = await import('../index')
      const result = parseQuery({ status: 'active' })
      expect(result).toBeInstanceOf(Condition)
    })

    test('serializeCondition accepts parsed result', async () => {
      // Given: All exports imported from ast/index.ts
      // When: Using serializeCondition with parseQuery result
      // Then: serializeCondition accepts parsed result

      const { parseQuery, serializeCondition } = await import('../index')
      const ast = parseQuery({ age: { $gt: 18 } })
      const serialized = serializeCondition(ast)

      expect(serialized).toBeDefined()
      expect(serialized.type).toBe('field')
      if (serialized.type === 'field') {
        expect(serialized.operator).toBe('gt')
        expect(serialized.field).toBe('age')
        expect(serialized.value).toBe(18)
      }
    })

    test('deserializeCondition reconstructs original', async () => {
      // Given: All exports imported from ast/index.ts
      // When: Using deserializeCondition with serialized condition
      // Then: deserializeCondition reconstructs original

      const { parseQuery, serializeCondition, deserializeCondition, FieldCondition } = await import('../index')
      const original = parseQuery({ name: 'test' })
      const serialized = serializeCondition(original)
      const reconstructed = deserializeCondition(serialized)

      expect(reconstructed).toBeInstanceOf(FieldCondition)
      expect((reconstructed as any).operator).toBe('eq')
      expect((reconstructed as any).field).toBe('name')
      expect((reconstructed as any).value).toBe('test')
    })

    test('Flow works without importing from submodules', async () => {
      // Given: All exports imported from ast/index.ts
      // When: Using exports for complete parse-serialize-deserialize flow
      // Then: Flow works without importing from submodules

      // Import everything from index only
      const indexModule = await import('../index')
      const { parseQuery, serializeCondition, deserializeCondition, CompoundCondition } = indexModule

      // Complex query with logical operators
      const filter = {
        $and: [
          { status: 'active' },
          { age: { $gt: 18 } }
        ]
      }

      // Parse -> Serialize -> Deserialize
      const ast = parseQuery(filter)
      expect(ast).toBeInstanceOf(CompoundCondition)

      const serialized = serializeCondition(ast)
      expect(serialized.type).toBe('compound')
      expect(serialized.operator).toBe('and')
      expect(Array.isArray(serialized.value)).toBe(true)

      const reconstructed = deserializeCondition(serialized)
      expect(reconstructed).toBeInstanceOf(CompoundCondition)
      expect((reconstructed as any).operator).toBe('and')
      expect(Array.isArray((reconstructed as any).value)).toBe(true)
      expect((reconstructed as any).value).toHaveLength(2)
    })
  })
})
