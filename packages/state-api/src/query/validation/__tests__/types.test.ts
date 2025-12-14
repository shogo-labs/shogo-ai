/**
 * Generated from TestSpecifications
 * Task: task-validation-layer
 * Requirements: req-05-metastore-validation
 *
 * Tests validation type definitions:
 * - IQueryValidator interface
 * - ValidationResult type
 * - ValidationError type
 * - OPERATOR_BY_TYPE constant
 */

import { describe, test, expect } from "bun:test"
import type { IQueryValidator, ValidationResult, ValidationError } from "../types"
import { OPERATOR_BY_TYPE } from "../types"
import type { Condition } from "../../ast/types"

describe("test-validation-interface: IQueryValidator interface defines validateQuery method", () => {
  test("IQueryValidator has validateQuery signature", () => {
    // Given: IQueryValidator interface is imported

    // When: Implementing IQueryValidator
    // Then: validateQuery(ast, schemaName, modelName) signature required
    const mockValidator: IQueryValidator = {
      validateQuery: (ast: Condition, schemaName: string, modelName: string): ValidationResult => {
        return { valid: true, errors: [] }
      }
    }

    // Then: Returns ValidationResult type
    const result = mockValidator.validateQuery({} as Condition, "test-schema", "TestModel")
    expect(result).toHaveProperty("valid")
    expect(result).toHaveProperty("errors")

    // Then: Can be used for dependency injection
    const acceptsInterface = (validator: IQueryValidator) => {
      return validator.validateQuery({} as Condition, "test", "Test")
    }
    expect(acceptsInterface(mockValidator).valid).toBe(true)
  })
})

describe("test-validation-result-type: ValidationResult contains valid flag and errors array", () => {
  test("valid: true with empty errors array is valid", () => {
    // Given: ValidationResult type is imported

    // When: Creating ValidationResult objects
    const result: ValidationResult = {
      valid: true,
      errors: []
    }

    // Then: valid: true with empty errors array is valid
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("valid: false with populated errors array is valid", () => {
    const result: ValidationResult = {
      valid: false,
      errors: [
        {
          code: "INVALID_PROPERTY",
          message: "Test error",
          path: "field"
        }
      ]
    }

    // Then: valid: false with populated errors array is valid
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test("Structure matches { valid: boolean, errors: ValidationError[] }", () => {
    const result: ValidationResult = {
      valid: false,
      errors: []
    }

    // Then: Structure matches { valid: boolean, errors: ValidationError[] }
    expect(typeof result.valid).toBe("boolean")
    expect(Array.isArray(result.errors)).toBe(true)
  })
})

describe("test-validation-error-type: ValidationError has code, message, and path", () => {
  test("code field accepts INVALID_PROPERTY or INVALID_OPERATOR", () => {
    // Given: ValidationError type is imported

    // When: Creating ValidationError objects
    // Then: code field accepts INVALID_PROPERTY or INVALID_OPERATOR
    const error1: ValidationError = {
      code: "INVALID_PROPERTY",
      message: "Property does not exist",
      path: "field"
    }

    const error2: ValidationError = {
      code: "INVALID_OPERATOR",
      message: "Operator not valid",
      path: "field"
    }

    expect(error1.code).toBe("INVALID_PROPERTY")
    expect(error2.code).toBe("INVALID_OPERATOR")
  })

  test("message field contains human-readable description", () => {
    const error: ValidationError = {
      code: "INVALID_PROPERTY",
      message: "Property 'foo' does not exist on model 'User'",
      path: "foo"
    }

    // Then: message field contains human-readable description
    expect(typeof error.message).toBe("string")
    expect(error.message.length).toBeGreaterThan(0)
  })

  test("path field identifies the problematic query location", () => {
    const error: ValidationError = {
      code: "INVALID_PROPERTY",
      message: "Invalid field",
      path: "user.profile.age"
    }

    // Then: path field identifies the problematic query location
    expect(typeof error.path).toBe("string")
    expect(error.path).toBe("user.profile.age")
  })
})

describe("test-validation-operator-map: OPERATOR_BY_TYPE maps JSON Schema types to valid operators", () => {
  test("string type includes $eq, $ne, $in, $regex, $contains", () => {
    // Given: OPERATOR_BY_TYPE constant is imported

    // When: Inspecting operator mappings
    // Then: string type includes $eq, $ne, $in, $regex, $contains
    expect(OPERATOR_BY_TYPE.string).toBeDefined()
    expect(OPERATOR_BY_TYPE.string).toContain("eq")
    expect(OPERATOR_BY_TYPE.string).toContain("ne")
    expect(OPERATOR_BY_TYPE.string).toContain("in")
    expect(OPERATOR_BY_TYPE.string).toContain("regex")
    expect(OPERATOR_BY_TYPE.string).toContain("contains")
  })

  test("number type includes $eq, $ne, $gt, $gte, $lt, $lte, $in", () => {
    // Then: number type includes $eq, $ne, $gt, $gte, $lt, $lte, $in
    expect(OPERATOR_BY_TYPE.number).toBeDefined()
    expect(OPERATOR_BY_TYPE.number).toContain("eq")
    expect(OPERATOR_BY_TYPE.number).toContain("ne")
    expect(OPERATOR_BY_TYPE.number).toContain("gt")
    expect(OPERATOR_BY_TYPE.number).toContain("gte")
    expect(OPERATOR_BY_TYPE.number).toContain("lt")
    expect(OPERATOR_BY_TYPE.number).toContain("lte")
    expect(OPERATOR_BY_TYPE.number).toContain("in")
  })

  test("boolean type includes only $eq, $ne", () => {
    // Then: boolean type includes only $eq, $ne
    expect(OPERATOR_BY_TYPE.boolean).toBeDefined()
    expect(OPERATOR_BY_TYPE.boolean).toContain("eq")
    expect(OPERATOR_BY_TYPE.boolean).toContain("ne")
    expect(OPERATOR_BY_TYPE.boolean.length).toBe(2)
  })

  test("array type includes $in, $nin, $contains", () => {
    // Then: array type includes $in, $nin, $contains
    expect(OPERATOR_BY_TYPE.array).toBeDefined()
    expect(OPERATOR_BY_TYPE.array).toContain("in")
    expect(OPERATOR_BY_TYPE.array).toContain("nin")
    expect(OPERATOR_BY_TYPE.array).toContain("contains")
  })
})
