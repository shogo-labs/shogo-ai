/**
 * Generated from TestSpecifications: test-operators-contains, test-operators-get-custom,
 * test-operators-register
 *
 * Task: task-query-ast-core
 * Requirement: req-02-mongodb-operators
 *
 * Test Scenarios:
 * 1. containsInstruction defines $contains as field-type operator
 * 2. getCustomParsingInstructions returns all custom operators
 * 3. registerCustomOperator enables runtime extensibility
 */

import { describe, test, expect } from 'bun:test'
import { MongoQueryParser } from '@ucast/mongo'
import { FieldCondition } from '@ucast/core'

// Import the functions/constants we're testing (not yet implemented)
import {
  containsInstruction,
  getCustomParsingInstructions,
  registerCustomOperator
} from '../operators'

describe('operators.test.ts - Custom Operator Definitions', () => {
  describe('test-operators-contains: containsInstruction defines $contains as field-type operator', () => {
    test('Given: containsInstruction is exported from operators.ts | When: Inspecting containsInstruction structure | Then: Has type: "field"', () => {
      // Given: containsInstruction is exported (see import statement)

      // When: Inspecting containsInstruction structure
      // Then: Has type: 'field'
      expect(containsInstruction).toBeDefined()
      expect(containsInstruction.type).toBe('field')
    })

    test('operator name is "contains"', () => {
      // The instruction is keyed by $contains in the registry
      // We verify it works with MongoQueryParser below
      expect(containsInstruction).toBeDefined()
    })

    test('can be passed to MongoQueryParser', () => {
      // Import allParsingInstructions to merge with custom
      const { allParsingInstructions } = require('@ucast/mongo')

      const instructions = {
        ...allParsingInstructions,
        $contains: containsInstruction
      }

      const parser = new MongoQueryParser(instructions)
      const ast = parser.parse({ tags: { $contains: 'urgent' } })

      expect(ast).toBeInstanceOf(FieldCondition)
      expect((ast as FieldCondition<string>).operator).toBe('contains')
      expect((ast as FieldCondition<string>).field).toBe('tags')
      expect((ast as FieldCondition<string>).value).toBe('urgent')
    })
  })

  describe('test-operators-get-custom: getCustomParsingInstructions returns all custom operators', () => {
    test('Given: getCustomParsingInstructions function is imported | When: Calling getCustomParsingInstructions() | Then: Returns object with $contains instruction', () => {
      // Given: getCustomParsingInstructions function is imported (see import statement)

      // When: Calling getCustomParsingInstructions()
      const instructions = getCustomParsingInstructions()

      // Then: Returns object with $contains instruction
      expect(instructions).toBeDefined()
      expect(instructions.$contains).toBeDefined()
      expect(instructions.$contains.type).toBe('field')
    })

    test('all instructions have correct structure', () => {
      const instructions = getCustomParsingInstructions()

      // Each instruction should have at least a 'type' property
      for (const [key, instruction] of Object.entries(instructions)) {
        expect(instruction).toHaveProperty('type')
        expect(typeof instruction.type).toBe('string')
        // Operator keys should start with $
        expect(key.startsWith('$')).toBe(true)
      }
    })

    test('can be spread into MongoQueryParser config', () => {
      const { allParsingInstructions } = require('@ucast/mongo')
      const customInstructions = getCustomParsingInstructions()

      // Spread custom instructions with standard ones
      const instructions = {
        ...allParsingInstructions,
        ...customInstructions
      }

      const parser = new MongoQueryParser(instructions)

      // Test that it works
      const ast = parser.parse({ name: { $contains: 'test' } })
      expect((ast as FieldCondition<string>).operator).toBe('contains')
    })
  })

  describe('test-operators-register: registerCustomOperator enables runtime extensibility', () => {
    test('Given: registerCustomOperator function is imported, New operator instruction defined | When: Registering custom operator at runtime | Then: Operator is added to custom instructions', () => {
      // Given: New operator instruction defined
      const newOperatorInstruction = {
        type: 'field' as const,
      }

      // When: Registering custom operator at runtime
      registerCustomOperator('$myNewOp', newOperatorInstruction)

      // Then: Operator is added to custom instructions
      const instructions = getCustomParsingInstructions()
      expect(instructions.$myNewOp).toBeDefined()
      expect(instructions.$myNewOp.type).toBe('field')
    })

    test('subsequent getCustomParsingInstructions includes new operator', () => {
      // Register a unique operator for this test
      const uniqueOpInstruction = {
        type: 'field' as const,
      }
      registerCustomOperator('$uniqueTestOp', uniqueOpInstruction)

      // Get instructions
      const instructions = getCustomParsingInstructions()

      expect(instructions.$uniqueTestOp).toBeDefined()
      expect(instructions.$uniqueTestOp.type).toBe('field')
    })

    test('new parser instances recognize the operator', () => {
      const { allParsingInstructions } = require('@ucast/mongo')

      // Register another unique operator
      const runtimeOpInstruction = {
        type: 'field' as const,
      }
      registerCustomOperator('$runtimeOp', runtimeOpInstruction)

      // Create new parser with updated instructions
      const instructions = {
        ...allParsingInstructions,
        ...getCustomParsingInstructions()
      }
      const parser = new MongoQueryParser(instructions)

      // Parse query using the runtime-registered operator
      const ast = parser.parse({ field: { $runtimeOp: 'value' } })

      expect(ast).toBeInstanceOf(FieldCondition)
      expect((ast as FieldCondition<string>).operator).toBe('runtimeOp')
      expect((ast as FieldCondition<string>).value).toBe('value')
    })
  })
})
