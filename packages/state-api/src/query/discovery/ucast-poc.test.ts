/**
 * @ucast/core PoC Evaluation
 *
 * Testing against requirements from spec/01-query-ast-format.md:
 * - AST-01: All comparison operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $regex, $contains)
 * - AST-02: Logical operators ($and, $or, $not) with arbitrary nesting
 * - AST-03: JSON-serializable for MCP transport
 * - AST-04: TypeScript types for static analysis
 * - AST-05: Extensible for future operators
 *
 * Test queries from Vision §4.2
 */

import { describe, test, expect } from 'bun:test'
import {
  FieldCondition,
  CompoundCondition,
  type Condition,
} from '@ucast/core'
import {
  MongoQueryParser,
  allParsingInstructions,
} from '@ucast/mongo'
import { createJsInterpreter, allInterpreters } from '@ucast/js'

// Initialize parser and interpreter
const parser = new MongoQueryParser(allParsingInstructions)
const interpret = createJsInterpreter(allInterpreters)

describe('@ucast/core PoC - Query AST Format Evaluation', () => {
  describe('AST-01: Comparison Operators', () => {
    test('$eq - equality', () => {
      const ast = parser.parse({ status: 'active' })
      expect(ast).toBeInstanceOf(FieldCondition)
      expect((ast as FieldCondition<string>).operator).toBe('eq')
      expect((ast as FieldCondition<string>).field).toBe('status')
      expect((ast as FieldCondition<string>).value).toBe('active')
    })

    test('$eq - explicit operator', () => {
      const ast = parser.parse({ status: { $eq: 'active' } })
      expect(ast).toBeInstanceOf(FieldCondition)
      expect((ast as FieldCondition<string>).operator).toBe('eq')
    })

    test('$ne - not equal', () => {
      const ast = parser.parse({ status: { $ne: 'inactive' } })
      expect((ast as FieldCondition<string>).operator).toBe('ne')
    })

    test('$gt - greater than', () => {
      const ast = parser.parse({ age: { $gt: 18 } })
      expect((ast as FieldCondition<number>).operator).toBe('gt')
      expect((ast as FieldCondition<number>).value).toBe(18)
    })

    test('$gte - greater than or equal', () => {
      const ast = parser.parse({ age: { $gte: 18 } })
      expect((ast as FieldCondition<number>).operator).toBe('gte')
    })

    test('$lt - less than', () => {
      const ast = parser.parse({ price: { $lt: 100 } })
      expect((ast as FieldCondition<number>).operator).toBe('lt')
    })

    test('$lte - less than or equal', () => {
      const ast = parser.parse({ price: { $lte: 100 } })
      expect((ast as FieldCondition<number>).operator).toBe('lte')
    })

    test('$in - in array', () => {
      const ast = parser.parse({ status: { $in: ['active', 'pending'] } })
      expect((ast as FieldCondition<string[]>).operator).toBe('in')
      expect((ast as FieldCondition<string[]>).value).toEqual(['active', 'pending'])
    })

    test('$nin - not in array', () => {
      const ast = parser.parse({ status: { $nin: ['deleted', 'archived'] } })
      expect((ast as FieldCondition<string[]>).operator).toBe('nin')
    })

    test('$regex - regular expression', () => {
      const ast = parser.parse({ email: { $regex: '@example\\.com$' } })
      expect((ast as FieldCondition<RegExp>).operator).toBe('regex')
    })

    // NOTE: $contains is NOT a standard MongoDB operator
    // We would need to add custom parsing instruction
    test.skip('$contains - string/array containment (requires custom)', () => {
      // This operator doesn't exist in MongoDB - would need custom implementation
    })
  })

  describe('AST-02: Logical Operators with Nesting', () => {
    test('implicit $and - multiple conditions', () => {
      const ast = parser.parse({ status: 'active', role: 'admin' })
      expect(ast).toBeInstanceOf(CompoundCondition)
      expect((ast as CompoundCondition).operator).toBe('and')
      expect((ast as CompoundCondition).value).toHaveLength(2)
    })

    test('explicit $and', () => {
      const ast = parser.parse({
        $and: [
          { status: 'active' },
          { role: 'admin' }
        ]
      })
      expect(ast).toBeInstanceOf(CompoundCondition)
      expect((ast as CompoundCondition).operator).toBe('and')
    })

    test('$or - disjunction', () => {
      const ast = parser.parse({
        $or: [
          { status: 'active' },
          { featured: true }
        ]
      })
      expect(ast).toBeInstanceOf(CompoundCondition)
      expect((ast as CompoundCondition).operator).toBe('or')
      expect((ast as CompoundCondition).value).toHaveLength(2)
    })

    test('$not - negation', () => {
      const ast = parser.parse({
        status: { $not: { $eq: 'deleted' } }
      })
      // @ucast/mongo handles $not as a field-level operator
      expect((ast as FieldCondition<any>).operator).toBe('not')
    })

    test('nested logical operators (from Vision §4.2)', () => {
      const ast = parser.parse({
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

      expect(ast).toBeInstanceOf(CompoundCondition)
      const compound = ast as CompoundCondition
      expect(compound.operator).toBe('and')
      expect(compound.value).toHaveLength(2)

      // First condition is field condition
      expect(compound.value[0]).toBeInstanceOf(FieldCondition)

      // Second condition is nested $or
      expect(compound.value[1]).toBeInstanceOf(CompoundCondition)
      const nestedOr = compound.value[1] as CompoundCondition
      expect(nestedOr.operator).toBe('or')
      expect(nestedOr.value).toHaveLength(2)
    })
  })

  describe('AST-03: JSON Serialization for MCP Transport', () => {
    // Custom serializer for Condition AST
    function serializeCondition(condition: Condition): object {
      if (condition instanceof FieldCondition) {
        return {
          type: 'field',
          operator: condition.operator,
          field: condition.field,
          value: condition.value instanceof RegExp
            ? { $regex: condition.value.source, $options: condition.value.flags }
            : condition.value
        }
      } else if (condition instanceof CompoundCondition) {
        return {
          type: 'compound',
          operator: condition.operator,
          value: condition.value.map(serializeCondition)
        }
      }
      throw new Error(`Unknown condition type: ${condition}`)
    }

    function deserializeCondition(json: any): Condition {
      if (json.type === 'field') {
        const value = json.value?.$regex
          ? new RegExp(json.value.$regex, json.value.$options || '')
          : json.value
        return new FieldCondition(json.operator, json.field, value)
      } else if (json.type === 'compound') {
        return new CompoundCondition(
          json.operator,
          json.value.map(deserializeCondition)
        )
      }
      throw new Error(`Unknown condition type: ${json.type}`)
    }

    test('serialize simple condition', () => {
      const ast = parser.parse({ status: 'active' })
      const json = serializeCondition(ast)

      expect(json).toEqual({
        type: 'field',
        operator: 'eq',
        field: 'status',
        value: 'active'
      })

      // Verify JSON roundtrip
      const jsonString = JSON.stringify(json)
      const parsed = JSON.parse(jsonString)
      expect(parsed).toEqual(json)
    })

    test('serialize compound condition', () => {
      const ast = parser.parse({
        $or: [
          { status: 'active' },
          { featured: true }
        ]
      })
      const json = serializeCondition(ast)

      expect(json).toEqual({
        type: 'compound',
        operator: 'or',
        value: [
          { type: 'field', operator: 'eq', field: 'status', value: 'active' },
          { type: 'field', operator: 'eq', field: 'featured', value: true }
        ]
      })
    })

    test('serialize/deserialize roundtrip', () => {
      const original = parser.parse({
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

      const json = serializeCondition(original)
      const jsonString = JSON.stringify(json)
      const parsed = JSON.parse(jsonString)
      const restored = deserializeCondition(parsed)

      // Verify structure matches
      expect(restored).toBeInstanceOf(CompoundCondition)
      const compound = restored as CompoundCondition
      expect(compound.operator).toBe('and')
      expect(compound.value).toHaveLength(2)
    })

    test('serialize regex condition', () => {
      const ast = parser.parse({ email: { $regex: '@example\\.com$' } })
      const json = serializeCondition(ast)

      expect(json).toEqual({
        type: 'field',
        operator: 'regex',
        field: 'email',
        value: { $regex: '@example\\.com$', $options: '' }
      })

      // Roundtrip
      const restored = deserializeCondition(JSON.parse(JSON.stringify(json)))
      expect((restored as FieldCondition<RegExp>).value).toBeInstanceOf(RegExp)
    })
  })

  describe('AST-04: TypeScript Types', () => {
    test('FieldCondition is properly typed', () => {
      const condition: FieldCondition<string> = new FieldCondition('eq', 'status', 'active')

      // Type assertions - these would fail at compile time if types were wrong
      const operator: string = condition.operator
      const field: string = condition.field
      const value: string = condition.value

      expect(operator).toBe('eq')
      expect(field).toBe('status')
      expect(value).toBe('active')
    })

    test('CompoundCondition is properly typed', () => {
      const condition: CompoundCondition = new CompoundCondition('and', [
        new FieldCondition('eq', 'a', 1),
        new FieldCondition('eq', 'b', 2)
      ])

      const operator: string = condition.operator
      const value: Condition[] = condition.value

      expect(operator).toBe('and')
      expect(value).toHaveLength(2)
    })

    test('parser returns Condition type', () => {
      // Parser returns Condition type which can be narrowed
      const ast: Condition = parser.parse({ status: 'active' })

      if (ast instanceof FieldCondition) {
        // TypeScript knows this is FieldCondition
        const field: string = ast.field
        expect(field).toBe('status')
      }
    })
  })

  describe('AST-05: Extensibility', () => {
    test('can add custom parsing instruction for $contains', () => {
      // Create custom parser with $contains operator
      // Note: @ucast/mongo field instructions receive (field, operator, value, parse)
      const customInstructions = {
        ...allParsingInstructions,
        $contains: {
          type: 'field' as const,
        }
      }

      const customParser = new MongoQueryParser(customInstructions)
      const ast = customParser.parse({ tags: { $contains: 'urgent' } })

      // @ucast creates FieldCondition with operator name (minus $)
      expect(ast).toBeInstanceOf(FieldCondition)
      expect((ast as FieldCondition<string>).operator).toBe('contains')
      expect((ast as FieldCondition<string>).field).toBe('tags')
      expect((ast as FieldCondition<string>).value).toBe('urgent')
    })

    test('can define custom DocumentCondition', () => {
      // For document-level operators like $where
      // This demonstrates full extensibility
      const customInstructions = {
        ...allParsingInstructions,
        $customCheck: {
          type: 'document' as const,
        }
      }

      const customParser = new MongoQueryParser(customInstructions)
      // Document-level operators don't need a field
      const ast = customParser.parse({ $customCheck: { someValue: true } })

      expect(ast.operator).toBe('customCheck')
    })
  })

  describe('Execution Test - @ucast/js Integration', () => {
    const testData = [
      { id: '1', status: 'active', role: 'admin', age: 30, price: 50 },
      { id: '2', status: 'active', role: 'user', age: 25, price: 150 },
      { id: '3', status: 'inactive', role: 'admin', age: 40, price: 75 },
      { id: '4', status: 'active', role: 'user', age: 17, price: 200 },
    ]

    test('filter by equality', () => {
      const ast = parser.parse({ status: 'active' })
      const results = testData.filter(item => interpret(ast, item))
      expect(results).toHaveLength(3)
      expect(results.map(r => r.id)).toEqual(['1', '2', '4'])
    })

    test('filter by comparison', () => {
      const ast = parser.parse({ age: { $gte: 18 } })
      const results = testData.filter(item => interpret(ast, item))
      expect(results).toHaveLength(3)
      expect(results.map(r => r.id)).toEqual(['1', '2', '3'])
    })

    test('filter by compound condition', () => {
      const ast = parser.parse({
        status: 'active',
        age: { $gte: 18 }
      })
      const results = testData.filter(item => interpret(ast, item))
      expect(results).toHaveLength(2)
      expect(results.map(r => r.id)).toEqual(['1', '2'])
    })

    test('filter by $or', () => {
      const ast = parser.parse({
        $or: [
          { role: 'admin' },
          { price: { $lt: 100 } }
        ]
      })
      const results = testData.filter(item => interpret(ast, item))
      // Item 1: admin=YES or price=50<100=YES -> MATCH
      // Item 2: admin=NO and price=150>=100 -> NO MATCH
      // Item 3: admin=YES -> MATCH
      // Item 4: admin=NO and price=200>=100 -> NO MATCH
      expect(results).toHaveLength(2)
      expect(results.map(r => r.id)).toEqual(['1', '3'])
    })
  })
})

describe('Alternative: Custom MongoDB-Style Types (Option B)', () => {
  // Define our own types matching Vision §4.2
  type OperatorExpression = {
    $eq?: any
    $ne?: any
    $gt?: any
    $gte?: any
    $lt?: any
    $lte?: any
    $in?: any[]
    $nin?: any[]
    $regex?: string
    $contains?: any
  }

  type LogicalExpression =
    | { $and: QueryFilter[] }
    | { $or: QueryFilter[] }
    | { $not: QueryFilter }

  type QueryFilter =
    | { [field: string]: any | OperatorExpression }
    | LogicalExpression

  test('custom types are JSON-serializable by nature', () => {
    const query: QueryFilter = {
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

    // Direct JSON roundtrip - no conversion needed
    const json = JSON.stringify(query)
    const parsed: QueryFilter = JSON.parse(json)

    expect(parsed).toEqual(query)
  })

  test('custom types support $contains (our custom operator)', () => {
    const query: QueryFilter = {
      tags: { $contains: 'urgent' }
    }

    expect(query).toBeDefined()
    expect(JSON.stringify(query)).toBe('{"tags":{"$contains":"urgent"}}')
  })
})
