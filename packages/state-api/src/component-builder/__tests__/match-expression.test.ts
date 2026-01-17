/**
 * Match Expression Module Tests
 *
 * Tests for the match expression module that wraps ucast for evaluating
 * MongoDB-style match expressions against PropertyMetadata objects.
 *
 * Task: task-dcb-002
 */

import { describe, test, expect } from "bun:test"
import {
  createMatcherFromExpression,
  createJsInterpreter,
  type PropertyMetadata
} from "../"

// ============================================================================
// AC-1: createMatcherFromExpression returns a function (meta: PropertyMetadata) => boolean
// ============================================================================

describe("AC-1: createMatcherFromExpression returns a matcher function", () => {
  test("returns a function", () => {
    const matcher = createMatcherFromExpression({ type: "string" })
    expect(typeof matcher).toBe("function")
  })

  test("matcher returns boolean true for match", () => {
    const matcher = createMatcherFromExpression({ type: "string" })
    const meta: PropertyMetadata = { name: "test", type: "string" }
    const result = matcher(meta)
    expect(result).toBe(true)
  })

  test("matcher returns boolean false for non-match", () => {
    const matcher = createMatcherFromExpression({ type: "number" })
    const meta: PropertyMetadata = { name: "test", type: "string" }
    const result = matcher(meta)
    expect(result).toBe(false)
  })
})

// ============================================================================
// AC-2: Matcher correctly evaluates simple expressions like {type: 'string'}
// ============================================================================

describe("AC-2: Simple expression matching", () => {
  test("matches single field equality: {type: 'string'}", () => {
    const matcher = createMatcherFromExpression({ type: "string" })

    expect(matcher({ name: "title", type: "string" })).toBe(true)
    expect(matcher({ name: "count", type: "number" })).toBe(false)
  })

  test("matches single field equality: {type: 'number'}", () => {
    const matcher = createMatcherFromExpression({ type: "number" })

    expect(matcher({ name: "count", type: "number" })).toBe(true)
    expect(matcher({ name: "title", type: "string" })).toBe(false)
  })

  test("matches single field equality: {type: 'boolean'}", () => {
    const matcher = createMatcherFromExpression({ type: "boolean" })

    expect(matcher({ name: "active", type: "boolean" })).toBe(true)
    expect(matcher({ name: "count", type: "number" })).toBe(false)
  })

  test("matches format field: {format: 'email'}", () => {
    const matcher = createMatcherFromExpression({ format: "email" })

    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(true)
    expect(matcher({ name: "name", type: "string" })).toBe(false)
  })

  test("matches format field: {format: 'uri'}", () => {
    const matcher = createMatcherFromExpression({ format: "uri" })

    expect(matcher({ name: "website", type: "string", format: "uri" })).toBe(true)
    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(false)
  })

  test("matches format field: {format: 'date-time'}", () => {
    const matcher = createMatcherFromExpression({ format: "date-time" })

    expect(matcher({ name: "createdAt", type: "string", format: "date-time" })).toBe(true)
    expect(matcher({ name: "name", type: "string" })).toBe(false)
  })

  test("matches xReferenceType: {xReferenceType: 'single'}", () => {
    const matcher = createMatcherFromExpression({ xReferenceType: "single" })

    expect(matcher({ name: "author", xReferenceType: "single", xReferenceTarget: "User" })).toBe(true)
    expect(matcher({ name: "tags", xReferenceType: "array" })).toBe(false)
    expect(matcher({ name: "title", type: "string" })).toBe(false)
  })

  test("matches xComputed: {xComputed: true}", () => {
    const matcher = createMatcherFromExpression({ xComputed: true })

    expect(matcher({ name: "fullName", xComputed: true })).toBe(true)
    expect(matcher({ name: "firstName", type: "string" })).toBe(false)
    expect(matcher({ name: "lastName", xComputed: false })).toBe(false)
  })

  test("matches xRenderer: {xRenderer: 'badge'}", () => {
    const matcher = createMatcherFromExpression({ xRenderer: "badge" })

    expect(matcher({ name: "status", xRenderer: "badge" })).toBe(true)
    expect(matcher({ name: "status", xRenderer: "tag" })).toBe(false)
    expect(matcher({ name: "status", type: "string" })).toBe(false)
  })

  test("matches multiple fields: {type: 'string', format: 'email'}", () => {
    const matcher = createMatcherFromExpression({ type: "string", format: "email" })

    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(true)
    expect(matcher({ name: "email", type: "string", format: "uri" })).toBe(false)
    expect(matcher({ name: "email", type: "number", format: "email" })).toBe(false)
  })
})

// ============================================================================
// AC-3: Matcher correctly evaluates $exists operator for optional fields
// ============================================================================

describe("AC-3: $exists operator for optional fields", () => {
  test("$exists: true matches when field is present", () => {
    const matcher = createMatcherFromExpression({ enum: { $exists: true } })

    expect(matcher({ name: "status", enum: ["active", "inactive"] })).toBe(true)
  })

  test("$exists: true does not match when field is absent", () => {
    const matcher = createMatcherFromExpression({ enum: { $exists: true } })

    expect(matcher({ name: "title", type: "string" })).toBe(false)
  })

  test("$exists: true matches when field is present with undefined value (key exists)", () => {
    // Note: In JavaScript, { enum: undefined } has the 'enum' key present,
    // even though its value is undefined. This matches MongoDB behavior.
    // In practice, PropertyMetadata objects won't have explicit undefined values;
    // the key simply won't exist.
    const matcher = createMatcherFromExpression({ enum: { $exists: true } })

    expect(matcher({ name: "title", type: "string", enum: undefined })).toBe(true)
  })

  test("$exists: false matches when field is absent", () => {
    const matcher = createMatcherFromExpression({ format: { $exists: false } })

    expect(matcher({ name: "title", type: "string" })).toBe(true)
  })

  test("$exists: false does not match when field is present", () => {
    const matcher = createMatcherFromExpression({ format: { $exists: false } })

    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(false)
  })

  test("$exists on xReferenceType for reference detection", () => {
    const matcher = createMatcherFromExpression({ xReferenceType: { $exists: true } })

    expect(matcher({ name: "author", xReferenceType: "single", xReferenceTarget: "User" })).toBe(true)
    expect(matcher({ name: "title", type: "string" })).toBe(false)
  })

  test("$exists on xComputed for computed detection", () => {
    const matcher = createMatcherFromExpression({ xComputed: { $exists: true } })

    expect(matcher({ name: "fullName", xComputed: true })).toBe(true)
    expect(matcher({ name: "fullName", xComputed: false })).toBe(true) // field exists, just false
    expect(matcher({ name: "firstName", type: "string" })).toBe(false)
  })
})

// ============================================================================
// AC-4: Matcher correctly evaluates $and/$or logical operators
// ============================================================================

describe("AC-4: Logical operators $and/$or", () => {
  test("$and matches when all conditions are true", () => {
    const matcher = createMatcherFromExpression({
      $and: [
        { type: "string" },
        { enum: { $exists: true } }
      ]
    })

    expect(matcher({ name: "status", type: "string", enum: ["a", "b"] })).toBe(true)
  })

  test("$and does not match when any condition is false", () => {
    const matcher = createMatcherFromExpression({
      $and: [
        { type: "string" },
        { enum: { $exists: true } }
      ]
    })

    expect(matcher({ name: "title", type: "string" })).toBe(false)
    expect(matcher({ name: "count", type: "number", enum: ["a", "b"] })).toBe(false)
  })

  test("$or matches when any condition is true", () => {
    const matcher = createMatcherFromExpression({
      $or: [
        { type: "string" },
        { type: "number" }
      ]
    })

    expect(matcher({ name: "title", type: "string" })).toBe(true)
    expect(matcher({ name: "count", type: "number" })).toBe(true)
  })

  test("$or does not match when no conditions are true", () => {
    const matcher = createMatcherFromExpression({
      $or: [
        { type: "string" },
        { type: "number" }
      ]
    })

    expect(matcher({ name: "active", type: "boolean" })).toBe(false)
  })

  test("nested $and/$or operators", () => {
    const matcher = createMatcherFromExpression({
      $and: [
        { type: "string" },
        {
          $or: [
            { format: "email" },
            { format: "uri" }
          ]
        }
      ]
    })

    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(true)
    expect(matcher({ name: "website", type: "string", format: "uri" })).toBe(true)
    expect(matcher({ name: "title", type: "string" })).toBe(false)
    expect(matcher({ name: "email", type: "number", format: "email" })).toBe(false)
  })

  test("$and with multiple conditions for priority 100 (computed or reference)", () => {
    const computedMatcher = createMatcherFromExpression({ xComputed: true })
    const referenceMatcher = createMatcherFromExpression({ xReferenceType: "single" })

    // Both are priority 100 use cases
    expect(computedMatcher({ name: "fullName", xComputed: true })).toBe(true)
    expect(referenceMatcher({ name: "author", xReferenceType: "single" })).toBe(true)
  })

  test("complex expression: string type with enum (priority 50 EnumBadge)", () => {
    const matcher = createMatcherFromExpression({
      $and: [
        { type: "string" },
        { enum: { $exists: true } }
      ]
    })

    expect(matcher({ name: "status", type: "string", enum: ["active", "pending"] })).toBe(true)
    expect(matcher({ name: "title", type: "string" })).toBe(false)
  })
})

// ============================================================================
// AC-5: AST is cached per unique matchExpression object (WeakMap)
// ============================================================================

describe("AC-5: AST caching with WeakMap", () => {
  test("same expression object returns same matcher behavior", () => {
    const expr = { type: "string" }
    const matcher1 = createMatcherFromExpression(expr)
    const matcher2 = createMatcherFromExpression(expr)

    const meta: PropertyMetadata = { name: "test", type: "string" }

    // Both should work correctly
    expect(matcher1(meta)).toBe(true)
    expect(matcher2(meta)).toBe(true)
  })

  test("caching does not affect correctness with different expressions", () => {
    const expr1 = { type: "string" }
    const expr2 = { type: "number" }

    const matcher1 = createMatcherFromExpression(expr1)
    const matcher2 = createMatcherFromExpression(expr2)

    const stringMeta: PropertyMetadata = { name: "test", type: "string" }
    const numberMeta: PropertyMetadata = { name: "count", type: "number" }

    expect(matcher1(stringMeta)).toBe(true)
    expect(matcher1(numberMeta)).toBe(false)
    expect(matcher2(stringMeta)).toBe(false)
    expect(matcher2(numberMeta)).toBe(true)
  })

  test("identical but different objects create separate matchers", () => {
    const expr1 = { type: "string" }
    const expr2 = { type: "string" } // Same content, different object

    const matcher1 = createMatcherFromExpression(expr1)
    const matcher2 = createMatcherFromExpression(expr2)

    const meta: PropertyMetadata = { name: "test", type: "string" }

    // Both should work correctly (WeakMap uses object identity)
    expect(matcher1(meta)).toBe(true)
    expect(matcher2(meta)).toBe(true)
  })
})

// ============================================================================
// AC-6: Exports createJsInterpreter from @ucast/js for custom interpreter creation
// ============================================================================

describe("AC-6: Exports createJsInterpreter for custom interpreter creation", () => {
  test("createJsInterpreter is exported", () => {
    expect(createJsInterpreter).toBeDefined()
    expect(typeof createJsInterpreter).toBe("function")
  })

  test("createJsInterpreter can create custom interpreters", () => {
    // This verifies the re-export works correctly
    const customInterpreter = createJsInterpreter({})
    expect(typeof customInterpreter).toBe("function")
  })
})

// ============================================================================
// Integration Tests: Real-world match expression patterns
// ============================================================================

describe("Integration: Real-world match expression patterns", () => {
  test("xRenderer explicit binding (priority 200)", () => {
    const matcher = createMatcherFromExpression({ xRenderer: "badge" })

    expect(matcher({ name: "status", xRenderer: "badge" })).toBe(true)
  })

  test("computed property (priority 100)", () => {
    const matcher = createMatcherFromExpression({ xComputed: true })

    expect(matcher({ name: "fullName", xComputed: true })).toBe(true)
  })

  test("single reference (priority 100)", () => {
    const matcher = createMatcherFromExpression({ xReferenceType: "single" })

    expect(matcher({ name: "author", xReferenceType: "single", xReferenceTarget: "User" })).toBe(true)
  })

  test("array reference (priority 100)", () => {
    const matcher = createMatcherFromExpression({ xReferenceType: "array" })

    expect(matcher({ name: "tags", xReferenceType: "array", xReferenceTarget: "Tag" })).toBe(true)
  })

  test("enum type (priority 50)", () => {
    const matcher = createMatcherFromExpression({ enum: { $exists: true } })

    expect(matcher({ name: "status", type: "string", enum: ["active", "inactive"] })).toBe(true)
  })

  test("email format (priority 30)", () => {
    const matcher = createMatcherFromExpression({ format: "email" })

    expect(matcher({ name: "email", type: "string", format: "email" })).toBe(true)
  })

  test("uri format (priority 30)", () => {
    const matcher = createMatcherFromExpression({ format: "uri" })

    expect(matcher({ name: "website", type: "string", format: "uri" })).toBe(true)
  })

  test("date-time format (priority 30)", () => {
    const matcher = createMatcherFromExpression({ format: "date-time" })

    expect(matcher({ name: "createdAt", type: "string", format: "date-time" })).toBe(true)
  })

  test("string type (priority 10)", () => {
    const matcher = createMatcherFromExpression({ type: "string" })

    expect(matcher({ name: "title", type: "string" })).toBe(true)
  })

  test("number type (priority 10)", () => {
    const matcher = createMatcherFromExpression({ type: "number" })

    expect(matcher({ name: "count", type: "number" })).toBe(true)
  })

  test("boolean type (priority 10)", () => {
    const matcher = createMatcherFromExpression({ type: "boolean" })

    expect(matcher({ name: "active", type: "boolean" })).toBe(true)
  })

  test("array type (priority 10)", () => {
    const matcher = createMatcherFromExpression({ type: "array" })

    expect(matcher({ name: "items", type: "array" })).toBe(true)
  })

  test("object type (priority 10)", () => {
    const matcher = createMatcherFromExpression({ type: "object" })

    expect(matcher({ name: "config", type: "object" })).toBe(true)
  })
})

// ============================================================================
// Error Handling: Invalid expressions should not crash
// ============================================================================

describe("Error handling: Invalid expressions", () => {
  test("PCRE inline flags in $regex return never-matching function (graceful degradation)", () => {
    // This tests that Python/PCRE-style inline flags (like (?i)) are handled gracefully.
    // The @ucast/mongo parser creates RegExp directly, so invalid patterns
    // cause parse errors. Our error handling catches this and returns a
    // never-matching function instead of crashing.
    //
    // Note: The PCRE flag conversion happens in serialization.ts for deserialized
    // conditions, but parseQuery uses @ucast/mongo which creates RegExp directly.
    const matcher = createMatcherFromExpression({
      name: { $regex: "(?i)(image|photo)" } // PCRE inline flag - invalid in JS
    })

    // Should return a function (not throw)
    expect(typeof matcher).toBe("function")

    // Should not match anything (graceful degradation - parse failed)
    const meta: PropertyMetadata = { name: "image_url", type: "string" }
    expect(matcher(meta)).toBe(false)
  })

  test("invalid regex that cannot be fixed returns never-matching function", () => {
    // A regex with syntax that can't be converted (unbalanced parens after flag removal)
    const matcher = createMatcherFromExpression({
      name: { $regex: "(?i)(unbalanced" }
    })

    // Should return a function (not throw)
    expect(typeof matcher).toBe("function")

    // Should not match anything (graceful degradation)
    const meta: PropertyMetadata = { name: "anything", type: "string" }
    expect(matcher(meta)).toBe(false)
  })

  test("same invalid expression returns cached never-matching function", () => {
    const expr = { name: { $regex: "(invalid[" } }

    // First call
    const matcher1 = createMatcherFromExpression(expr)
    // Second call with same object
    const matcher2 = createMatcherFromExpression(expr)

    // Both should return functions
    expect(typeof matcher1).toBe("function")
    expect(typeof matcher2).toBe("function")

    // Both should not match
    const meta: PropertyMetadata = { name: "test", type: "string" }
    expect(matcher1(meta)).toBe(false)
    expect(matcher2(meta)).toBe(false)
  })
})
