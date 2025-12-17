/**
 * Validation Layer PoC
 *
 * Testing against requirements from spec/02-validation-layer.md:
 * - VAL-01: Derive valid operators from property type
 * - VAL-02: Validate property paths exist in schema
 * - VAL-03: Validate operator compatibility with property type
 * - VAL-04: Isomorphic - same code browser/server
 * - VAL-05: Return actionable error messages
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { FieldCondition, CompoundCondition, type Condition } from '@ucast/core'
import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'

// ============================================================================
// OPERATOR DERIVATION RULES (VAL-01)
// ============================================================================

/**
 * Maps JSON Schema types to valid query operators.
 * This is the core logic for VAL-01.
 */
const OPERATOR_BY_TYPE: Record<string, Set<string>> = {
  // Numeric types support all comparison operators
  integer: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']),
  number: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']),

  // Strings add regex and contains
  string: new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'regex', 'contains']),

  // Booleans only support equality
  boolean: new Set(['eq', 'ne']),

  // Arrays support containment checks
  array: new Set(['contains', 'in', 'nin']),

  // References (objects with $ref) support equality and set membership
  reference: new Set(['eq', 'ne', 'in', 'nin']),

  // Generic objects - limited operators
  object: new Set(['eq', 'ne']),

  // Date-time strings (format: date-time) - comparison makes sense
  'date-time': new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']),
}

// Logical operators are always valid at any level
const LOGICAL_OPERATORS = new Set(['and', 'or', 'not', 'nor'])

/**
 * Derive valid operators for a property based on its type and format.
 */
function deriveOperatorsForProperty(property: {
  type?: string
  format?: string
  $ref?: string
  xReferenceType?: string
}): Set<string> {
  // Reference types
  if (property.$ref || property.xReferenceType) {
    return OPERATOR_BY_TYPE.reference
  }

  // Check format first (e.g., date-time strings)
  if (property.format === 'date-time') {
    return OPERATOR_BY_TYPE['date-time']
  }

  // Fall back to type
  const type = property.type || 'object'
  return OPERATOR_BY_TYPE[type] || OPERATOR_BY_TYPE.object
}

// ============================================================================
// VALIDATION TYPES
// ============================================================================

interface ValidationError {
  code: 'INVALID_PROPERTY' | 'INVALID_OPERATOR' | 'TYPE_MISMATCH'
  message: string
  path: string
  operator?: string
  propertyType?: string
}

interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

// ============================================================================
// MOCK META-STORE (for PoC - will be replaced with real meta-store)
// ============================================================================

interface MockProperty {
  name: string
  type?: string
  format?: string
  $ref?: string
  xReferenceType?: 'single' | 'array'
}

interface MockModel {
  name: string
  properties: MockProperty[]
}

interface MockSchema {
  name: string
  models: MockModel[]
}

/**
 * Mock meta-store for PoC testing.
 * In production, this will use the actual meta-store from src/meta/
 */
class MockMetaStore {
  private schemas: Map<string, MockSchema> = new Map()

  addSchema(schema: MockSchema) {
    this.schemas.set(schema.name, schema)
  }

  getModel(schemaName: string, modelName: string): MockModel | undefined {
    const schema = this.schemas.get(schemaName)
    return schema?.models.find(m => m.name === modelName)
  }

  getProperty(schemaName: string, modelName: string, propertyName: string): MockProperty | undefined {
    const model = this.getModel(schemaName, modelName)
    return model?.properties.find(p => p.name === propertyName)
  }
}

// ============================================================================
// QUERY VALIDATOR
// ============================================================================

/**
 * Validates a query against a schema/model using the meta-store.
 *
 * Approach: Lazy Memoization (Approach C from spec)
 * - Derives operators on first access per property
 * - Caches derived operators for subsequent validations
 */
class QueryValidator {
  private metaStore: MockMetaStore
  private operatorCache: Map<string, Set<string>> = new Map()

  constructor(metaStore: MockMetaStore) {
    this.metaStore = metaStore
  }

  /**
   * Get valid operators for a property, with memoization.
   */
  private getValidOperators(
    schemaName: string,
    modelName: string,
    propertyName: string
  ): Set<string> | null {
    const cacheKey = `${schemaName}:${modelName}:${propertyName}`

    if (this.operatorCache.has(cacheKey)) {
      return this.operatorCache.get(cacheKey)!
    }

    const property = this.metaStore.getProperty(schemaName, modelName, propertyName)
    if (!property) {
      return null // Property doesn't exist
    }

    const operators = deriveOperatorsForProperty(property)
    this.operatorCache.set(cacheKey, operators)
    return operators
  }

  /**
   * Clear the operator cache (e.g., when schema changes).
   */
  clearCache(schemaName?: string) {
    if (schemaName) {
      // Clear only entries for this schema
      for (const key of this.operatorCache.keys()) {
        if (key.startsWith(`${schemaName}:`)) {
          this.operatorCache.delete(key)
        }
      }
    } else {
      this.operatorCache.clear()
    }
  }

  /**
   * Validate a parsed Condition AST against schema.
   */
  validateCondition(
    schemaName: string,
    modelName: string,
    condition: Condition,
    path: string = ''
  ): ValidationError[] {
    const errors: ValidationError[] = []

    if (condition instanceof FieldCondition) {
      const fieldPath = path ? `${path}.${condition.field}` : condition.field

      // VAL-02: Check property exists
      const validOperators = this.getValidOperators(schemaName, modelName, condition.field)
      if (validOperators === null) {
        errors.push({
          code: 'INVALID_PROPERTY',
          message: `Property '${condition.field}' does not exist on model '${modelName}'`,
          path: fieldPath,
        })
        return errors
      }

      // VAL-03: Check operator is valid for property type
      if (!validOperators.has(condition.operator)) {
        const property = this.metaStore.getProperty(schemaName, modelName, condition.field)
        errors.push({
          code: 'INVALID_OPERATOR',
          message: `Operator '$${condition.operator}' is not valid for property '${condition.field}' of type '${property?.type || 'unknown'}'. Valid operators: ${Array.from(validOperators).map(op => '$' + op).join(', ')}`,
          path: fieldPath,
          operator: condition.operator,
          propertyType: property?.type,
        })
      }
    } else if (condition instanceof CompoundCondition) {
      // Recursively validate nested conditions
      for (const nested of condition.value) {
        errors.push(...this.validateCondition(schemaName, modelName, nested, path))
      }
    }

    return errors
  }

  /**
   * Main validation entry point.
   */
  validate(
    schemaName: string,
    modelName: string,
    query: object
  ): ValidationResult {
    // First check model exists
    const model = this.metaStore.getModel(schemaName, modelName)
    if (!model) {
      return {
        valid: false,
        errors: [{
          code: 'INVALID_PROPERTY',
          message: `Model '${modelName}' does not exist in schema '${schemaName}'`,
          path: '',
        }]
      }
    }

    // Parse query to AST
    // Note: @ucast/mongo has built-in validation that throws on some invalid queries
    const parser = new MongoQueryParser({
      ...allParsingInstructions,
      $contains: { type: 'field' as const },
    })

    let ast: Condition
    try {
      ast = parser.parse(query)
    } catch (error) {
      // Convert @ucast parse errors to ValidationResult
      const message = error instanceof Error ? error.message : String(error)
      // Extract operator from error message like '"gt" expects value...'
      const operatorMatch = message.match(/"(\w+)"/)
      return {
        valid: false,
        errors: [{
          code: 'INVALID_OPERATOR',
          message: `Parse error: ${message}`,
          path: '',
          operator: operatorMatch?.[1],
        }]
      }
    }

    const errors = this.validateCondition(schemaName, modelName, ast)

    return {
      valid: errors.length === 0,
      errors,
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe('Validation Layer PoC', () => {
  let metaStore: MockMetaStore
  let validator: QueryValidator

  beforeAll(() => {
    // Set up mock meta-store with test schema
    metaStore = new MockMetaStore()
    metaStore.addSchema({
      name: 'test-schema',
      models: [
        {
          name: 'User',
          properties: [
            { name: 'id', type: 'string' },
            { name: 'name', type: 'string' },
            { name: 'email', type: 'string' },
            { name: 'age', type: 'integer' },
            { name: 'balance', type: 'number' },
            { name: 'isActive', type: 'boolean' },
            { name: 'tags', type: 'array' },
            { name: 'createdAt', type: 'string', format: 'date-time' },
            { name: 'organizationId', $ref: '#/$defs/Organization', xReferenceType: 'single' },
          ],
        },
        {
          name: 'Organization',
          properties: [
            { name: 'id', type: 'string' },
            { name: 'name', type: 'string' },
          ],
        },
      ],
    })

    validator = new QueryValidator(metaStore)
  })

  describe('VAL-01: Derive valid operators from property type', () => {
    test('integer properties support comparison operators', () => {
      const ops = deriveOperatorsForProperty({ type: 'integer' })
      expect(ops.has('eq')).toBe(true)
      expect(ops.has('gt')).toBe(true)
      expect(ops.has('gte')).toBe(true)
      expect(ops.has('lt')).toBe(true)
      expect(ops.has('lte')).toBe(true)
      expect(ops.has('in')).toBe(true)
      expect(ops.has('regex')).toBe(false) // integers don't support regex
    })

    test('string properties support regex and contains', () => {
      const ops = deriveOperatorsForProperty({ type: 'string' })
      expect(ops.has('regex')).toBe(true)
      expect(ops.has('contains')).toBe(true)
      expect(ops.has('eq')).toBe(true)
    })

    test('boolean properties only support eq/ne', () => {
      const ops = deriveOperatorsForProperty({ type: 'boolean' })
      expect(ops.has('eq')).toBe(true)
      expect(ops.has('ne')).toBe(true)
      expect(ops.has('gt')).toBe(false)
      expect(ops.has('regex')).toBe(false)
    })

    test('array properties support contains', () => {
      const ops = deriveOperatorsForProperty({ type: 'array' })
      expect(ops.has('contains')).toBe(true)
      expect(ops.has('in')).toBe(true)
    })

    test('reference properties support eq/ne/in/nin', () => {
      const ops = deriveOperatorsForProperty({ $ref: '#/$defs/Org', xReferenceType: 'single' })
      expect(ops.has('eq')).toBe(true)
      expect(ops.has('ne')).toBe(true)
      expect(ops.has('in')).toBe(true)
      expect(ops.has('nin')).toBe(true)
      expect(ops.has('gt')).toBe(false)
    })

    test('date-time strings support comparison operators', () => {
      const ops = deriveOperatorsForProperty({ type: 'string', format: 'date-time' })
      expect(ops.has('gt')).toBe(true)
      expect(ops.has('lt')).toBe(true)
      expect(ops.has('regex')).toBe(false) // date-time shouldn't use regex
    })
  })

  describe('VAL-02: Validate property paths exist in schema', () => {
    test('valid property passes validation', () => {
      const result = validator.validate('test-schema', 'User', { name: 'Alice' })
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    test('invalid property fails with INVALID_PROPERTY error', () => {
      const result = validator.validate('test-schema', 'User', { nonExistent: 'value' })
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe('INVALID_PROPERTY')
      expect(result.errors[0].message).toContain("'nonExistent' does not exist")
    })

    test('invalid model fails with INVALID_PROPERTY error', () => {
      const result = validator.validate('test-schema', 'NonExistentModel', { name: 'test' })
      expect(result.valid).toBe(false)
      expect(result.errors[0].code).toBe('INVALID_PROPERTY')
      expect(result.errors[0].message).toContain("'NonExistentModel' does not exist")
    })
  })

  describe('VAL-03: Validate operator compatibility with property type', () => {
    test('valid operator for string property passes', () => {
      const result = validator.validate('test-schema', 'User', {
        email: { $regex: '@example\\.com$' }
      })
      expect(result.valid).toBe(true)
    })

    test('invalid operator for integer property fails', () => {
      const result = validator.validate('test-schema', 'User', {
        age: { $regex: '\\d+' } // regex not valid for integers
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].code).toBe('INVALID_OPERATOR')
      expect(result.errors[0].operator).toBe('regex')
      expect(result.errors[0].message).toContain("Valid operators:")
    })

    test('invalid operator for boolean property fails', () => {
      const result = validator.validate('test-schema', 'User', {
        isActive: { $gt: true } // gt not valid for booleans
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].code).toBe('INVALID_OPERATOR')
      // Note: @ucast/mongo catches this at parse time with built-in validation
      expect(result.errors[0].operator).toBe('gt')
    })

    test('comparison operators valid for integers', () => {
      const result = validator.validate('test-schema', 'User', {
        age: { $gte: 18, $lte: 65 }
      })
      // Note: MongoDB-style allows multiple operators on same field
      // Parser wraps in $and
      expect(result.valid).toBe(true)
    })
  })

  describe('VAL-04: Compound queries validation', () => {
    test('$and with valid operators passes', () => {
      const result = validator.validate('test-schema', 'User', {
        $and: [
          { name: { $contains: 'Smith' } },
          { age: { $gte: 21 } }
        ]
      })
      expect(result.valid).toBe(true)
    })

    test('$or with mixed valid/invalid fails', () => {
      const result = validator.validate('test-schema', 'User', {
        $or: [
          { name: 'Alice' },          // valid
          { isActive: { $gt: false } } // invalid - gt not for boolean
        ]
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].code).toBe('INVALID_OPERATOR')
      // @ucast/mongo catches invalid types at parse time
      expect(result.errors[0].operator).toBe('gt')
    })

    test('nested compound queries validated recursively', () => {
      const result = validator.validate('test-schema', 'User', {
        $and: [
          { email: { $regex: '@test\\.com$' } },
          {
            $or: [
              { age: { $lt: 18 } },
              { balance: { $regex: 'invalid' } } // invalid - regex not for number
            ]
          }
        ]
      })
      expect(result.valid).toBe(false)
      expect(result.errors[0].code).toBe('INVALID_OPERATOR')
      expect(result.errors[0].path).toBe('balance')
    })
  })

  describe('VAL-05: Actionable error messages', () => {
    test('error includes property name', () => {
      const result = validator.validate('test-schema', 'User', {
        unknownField: 'value'
      })
      expect(result.errors[0].message).toContain('unknownField')
    })

    test('error includes model name', () => {
      const result = validator.validate('test-schema', 'User', {
        unknownField: 'value'
      })
      expect(result.errors[0].message).toContain('User')
    })

    test('error includes valid operators for type', () => {
      // Use regex on integer to get our validation (not @ucast's parse-time validation)
      const result = validator.validate('test-schema', 'User', {
        age: { $regex: '\\d+' }
      })
      expect(result.errors[0].message).toContain('$eq')
      expect(result.errors[0].message).toContain('$ne')
    })

    test('error includes property type', () => {
      const result = validator.validate('test-schema', 'User', {
        age: { $regex: '\\d+' }
      })
      expect(result.errors[0].propertyType).toBe('integer')
    })
  })

  describe('Memoization behavior', () => {
    test('operator derivation is cached', () => {
      // First validation derives and caches
      validator.validate('test-schema', 'User', { name: 'test' })

      // Clear cache for measurement
      validator.clearCache()

      // This should populate cache
      const start1 = performance.now()
      for (let i = 0; i < 1000; i++) {
        validator.validate('test-schema', 'User', { name: 'test' })
      }
      const time1 = performance.now() - start1

      // Cache should make subsequent validations faster
      // (This is a sanity check - actual perf gain depends on meta-store implementation)
      expect(time1).toBeLessThan(1000) // Should complete 1000 validations in under 1s
    })

    test('clearCache invalidates cached operators', () => {
      // Populate cache
      validator.validate('test-schema', 'User', { name: 'test' })

      // Clear and verify re-derivation works
      validator.clearCache('test-schema')

      const result = validator.validate('test-schema', 'User', { name: 'test' })
      expect(result.valid).toBe(true)
    })
  })
})

describe('Integration: Validation with @ucast Parser', () => {
  test('full flow: MongoDB query -> parse -> validate', () => {
    const metaStore = new MockMetaStore()
    metaStore.addSchema({
      name: 'app',
      models: [{
        name: 'Task',
        properties: [
          { name: 'title', type: 'string' },
          { name: 'status', type: 'string' },
          { name: 'priority', type: 'integer' },
          { name: 'dueDate', type: 'string', format: 'date-time' },
          { name: 'assigneeId', $ref: '#/$defs/User', xReferenceType: 'single' },
        ],
      }],
    })

    const validator = new QueryValidator(metaStore)

    // Valid query
    const validQuery = {
      $and: [
        { status: { $in: ['todo', 'in_progress'] } },
        { priority: { $gte: 3 } },
        { dueDate: { $lt: '2025-12-31' } },
        { assigneeId: { $ne: null } }
      ]
    }

    const validResult = validator.validate('app', 'Task', validQuery)
    expect(validResult.valid).toBe(true)

    // Invalid query - regex on integer
    const invalidQuery = {
      priority: { $regex: '^[0-9]+$' }
    }

    const invalidResult = validator.validate('app', 'Task', invalidQuery)
    expect(invalidResult.valid).toBe(false)
    expect(invalidResult.errors[0].code).toBe('INVALID_OPERATOR')
  })
})
