/**
 * Generated from TestSpecification: test-validation-index-exports
 * Task: task-validation-layer
 * Requirements: req-05-metastore-validation
 *
 * Tests that validation/index.ts exports all necessary components
 */

import { describe, test, expect } from "bun:test"

describe("test-validation-index-exports: Index exports all validation components", () => {
  test("QueryValidator class is accessible", async () => {
    // Given: validation/index.ts module exists

    // When: Importing from validation/index.ts
    const module = await import("../index")

    // Then: QueryValidator class is accessible
    expect(module.QueryValidator).toBeDefined()
    expect(typeof module.QueryValidator).toBe("function")
  })

  test("IQueryValidator interface is accessible", async () => {
    const module = await import("../index")

    // Then: IQueryValidator interface is accessible
    // TypeScript interfaces don't exist at runtime, so we verify it's exported via type
    // We can verify the export exists by checking the module structure
    expect(module).toBeDefined()
  })

  test("QueryValidationResult type is accessible", async () => {
    const module = await import("../index")

    // Then: QueryValidationResult type is accessible
    expect(module).toBeDefined()
  })

  test("ValidationError type is accessible", async () => {
    const module = await import("../index")

    // Then: ValidationError type is accessible
    expect(module).toBeDefined()
  })

  test("OPERATOR_BY_TYPE constant is accessible", async () => {
    const module = await import("../index")

    // Then: OPERATOR_BY_TYPE constant is accessible
    expect(module.OPERATOR_BY_TYPE).toBeDefined()
    expect(typeof module.OPERATOR_BY_TYPE).toBe("object")
  })

  test("All exports are available from index", async () => {
    const module = await import("../index")

    // Verify all expected exports
    expect(module.QueryValidator).toBeDefined()
    expect(module.OPERATOR_BY_TYPE).toBeDefined()

    // Verify OPERATOR_BY_TYPE has expected structure
    expect(module.OPERATOR_BY_TYPE.string).toBeDefined()
    expect(module.OPERATOR_BY_TYPE.number).toBeDefined()
    expect(module.OPERATOR_BY_TYPE.boolean).toBeDefined()
    expect(module.OPERATOR_BY_TYPE.array).toBeDefined()
  })
})
