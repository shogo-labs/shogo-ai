/**
 * Generated from TestSpecifications: test-serialize-condition, test-deserialize-condition,
 * test-serialize-regex
 *
 * Task: task-query-ast-core
 * Requirement: req-02-mongodb-operators
 *
 * Test Scenarios:
 * 1. serializeCondition converts AST to JSON-safe format
 * 2. deserializeCondition reconstructs AST from JSON
 * 3. RegExp serialized via $regex/$options format
 */

import { describe, test, expect } from 'bun:test'
import { FieldCondition, CompoundCondition } from '@ucast/core'
import type { Condition } from '@ucast/core'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'

// Import the functions we're testing (not yet implemented)
import { serializeCondition, deserializeCondition } from '../serialization'

// Helper parser for creating test ASTs
const parser = new MongoQueryParser(allParsingInstructions)

describe('serialization.test.ts - AST Serialization', () => {
  describe('test-serialize-condition: serializeCondition converts AST to JSON-safe format', () => {
    test('Given: serializeCondition function is imported, Condition AST from parser | When: Calling serializeCondition(ast) | Then: Returns plain object (no class instances)', () => {
      // Given: Condition AST from parser
      const ast = parser.parse({ status: 'active' })

      // When: Calling serializeCondition(ast)
      const serialized = serializeCondition(ast)

      // Then: Returns plain object (no class instances)
      expect(serialized).toBeDefined()
      expect(typeof serialized).toBe('object')
      // Should not be a class instance (no constructor name like FieldCondition)
      expect(serialized.constructor.name).toBe('Object')
    })

    test('result passes JSON.stringify without error', () => {
      const ast = parser.parse({ status: 'active' })
      const serialized = serializeCondition(ast)

      // Should stringify without error
      expect(() => JSON.stringify(serialized)).not.toThrow()

      // Should roundtrip through JSON
      const jsonString = JSON.stringify(serialized)
      const parsed = JSON.parse(jsonString)
      expect(parsed).toEqual(serialized)
    })

    test('preserves operator, field, and value information', () => {
      const ast = parser.parse({ age: { $gt: 18 } })
      const serialized = serializeCondition(ast)

      expect(serialized).toHaveProperty('type')
      expect(serialized).toHaveProperty('operator')
      expect(serialized).toHaveProperty('field')
      expect(serialized).toHaveProperty('value')

      expect((serialized as any).operator).toBe('gt')
      expect((serialized as any).field).toBe('age')
      expect((serialized as any).value).toBe(18)
    })

    test('handles compound conditions', () => {
      const ast = parser.parse({
        $or: [
          { status: 'active' },
          { featured: true }
        ]
      })
      const serialized = serializeCondition(ast)

      expect((serialized as any).type).toBe('compound')
      expect((serialized as any).operator).toBe('or')
      expect(Array.isArray((serialized as any).value)).toBe(true)
      expect((serialized as any).value).toHaveLength(2)
    })
  })

  describe('test-deserialize-condition: deserializeCondition reconstructs AST from JSON', () => {
    test('Given: deserializeCondition function is imported, Serialized condition JSON | When: Calling deserializeCondition(json) | Then: Returns Condition instance (FieldCondition or CompoundCondition)', () => {
      // Given: Serialized condition JSON
      const serializedJson = {
        type: 'field',
        operator: 'eq',
        field: 'status',
        value: 'active'
      }

      // When: Calling deserializeCondition(json)
      const condition = deserializeCondition(serializedJson)

      // Then: Returns Condition instance (FieldCondition or CompoundCondition)
      expect(condition).toBeInstanceOf(FieldCondition)
      expect((condition as FieldCondition<string>).operator).toBe('eq')
      expect((condition as FieldCondition<string>).field).toBe('status')
      expect((condition as FieldCondition<string>).value).toBe('active')
    })

    test('roundtrip serialize→deserialize preserves semantics', () => {
      // Start with a complex AST
      const originalAst = parser.parse({
        $and: [
          { category: 'electronics' },
          {
            $or: [
              { price: { $lt: 100 } },
              { onSale: true }
            ]
          }
        ]
      })

      // Serialize → JSON → Deserialize
      const serialized = serializeCondition(originalAst)
      const jsonString = JSON.stringify(serialized)
      const parsed = JSON.parse(jsonString)
      const restored = deserializeCondition(parsed)

      // Verify structure matches
      expect(restored).toBeInstanceOf(CompoundCondition)
      const compound = restored as CompoundCondition
      expect(compound.operator).toBe('and')
      expect(compound.value).toHaveLength(2)

      // First condition
      expect(compound.value[0]).toBeInstanceOf(FieldCondition)
      const firstField = compound.value[0] as FieldCondition<string>
      expect(firstField.field).toBe('category')
      expect(firstField.value).toBe('electronics')

      // Second condition (nested $or)
      expect(compound.value[1]).toBeInstanceOf(CompoundCondition)
      const nestedOr = compound.value[1] as CompoundCondition
      expect(nestedOr.operator).toBe('or')
      expect(nestedOr.value).toHaveLength(2)
    })

    test('deserialized AST works with interpreters', () => {
      // This test verifies the deserialized AST has the correct structure
      // for use with @ucast/js interpreters
      const serializedJson = {
        type: 'field',
        operator: 'gt',
        field: 'age',
        value: 18
      }

      const condition = deserializeCondition(serializedJson)

      // Should be a FieldCondition with correct properties
      expect(condition).toBeInstanceOf(FieldCondition)
      const fieldCondition = condition as FieldCondition<number>
      expect(fieldCondition.operator).toBe('gt')
      expect(fieldCondition.field).toBe('age')
      expect(fieldCondition.value).toBe(18)
    })
  })

  describe('test-serialize-regex: RegExp serialized via $regex/$options format', () => {
    test('Given: Condition with RegExp value: { name: { $regex: /test/i } } | When: Serializing and deserializing the condition | Then: Serialized form uses { $regex: "test", $options: "i" } format', () => {
      // Given: Condition with RegExp value
      const ast = parser.parse({ email: { $regex: '@example\\.com$' } })

      // When: Serializing the condition
      const serialized = serializeCondition(ast)

      // Then: Serialized form uses { $regex: string, $options: string } format
      expect((serialized as any).value).toHaveProperty('$regex')
      expect((serialized as any).value).toHaveProperty('$options')
      expect(typeof (serialized as any).value.$regex).toBe('string')
      expect(typeof (serialized as any).value.$options).toBe('string')
    })

    test('no native RegExp in serialized output', () => {
      const ast = parser.parse({ email: { $regex: '@example\\.com$' } })
      const serialized = serializeCondition(ast)

      // Stringify should work without custom replacer
      const jsonString = JSON.stringify(serialized)
      expect(jsonString).toBeDefined()

      // Verify the serialized value is not a RegExp
      expect((serialized as any).value instanceof RegExp).toBe(false)
    })

    test('deserialized condition reconstructs equivalent RegExp', () => {
      // Create an AST with a regex
      const ast = parser.parse({ email: { $regex: '@example\\.com$' } })

      // Serialize → Deserialize
      const serialized = serializeCondition(ast)
      const jsonString = JSON.stringify(serialized)
      const parsed = JSON.parse(jsonString)
      const restored = deserializeCondition(parsed)

      // Should reconstruct as FieldCondition with RegExp value
      expect(restored).toBeInstanceOf(FieldCondition)
      const fieldCondition = restored as FieldCondition<RegExp>
      expect(fieldCondition.operator).toBe('regex')
      expect(fieldCondition.value).toBeInstanceOf(RegExp)
      expect(fieldCondition.value.source).toBe('@example\\.com$')
    })

    test('preserves regex flags', () => {
      // Parse with regex string (flags are in the string for MongoDB-style regex)
      // Note: @ucast/mongo may parse regex differently, but we'll test the serialization
      const regexWithFlags = new RegExp('test', 'gi')
      const ast = new FieldCondition('regex', 'name', regexWithFlags)

      // Serialize
      const serialized = serializeCondition(ast)

      // Check that flags are preserved
      expect((serialized as any).value.$regex).toBe('test')
      expect((serialized as any).value.$options).toContain('g')
      expect((serialized as any).value.$options).toContain('i')

      // Deserialize
      const restored = deserializeCondition(serialized)
      const restoredField = restored as FieldCondition<RegExp>
      expect(restoredField.value.flags).toContain('g')
      expect(restoredField.value.flags).toContain('i')
    })
  })
})
