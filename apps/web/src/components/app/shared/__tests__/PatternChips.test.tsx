/**
 * Tests for PatternChips Component
 * Task: task-2-3b-005
 *
 * TDD tests for the pattern chips component displaying applicable patterns as flex-wrap list.
 *
 * Test Specifications:
 * - test-2-3b-012: PatternChips renders list of pattern chips
 * - test-2-3b-013: PatternChips handles empty patterns array gracefully
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: PatternChips renders list of pattern chips
// (test-2-3b-012)
// ============================================================

describe("test-2-3b-012: PatternChips renders list of pattern chips", () => {
  test("PatternChips component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("PatternChips accepts patterns prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/patterns/)
  })

  test("PatternChips uses flex-wrap layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/flex.*flex-wrap|flex-wrap/)
  })

  test("PatternChips maps over patterns array", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/patterns\.map/)
  })

  test("PatternChips has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*pattern-chips/)
  })

  test("PatternChips renders chips with muted/subtle styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have subtle/muted chip styling
    expect(componentSource).toMatch(/border|muted|secondary/)
  })
})

// ============================================================
// Test 2: PatternChips handles empty patterns array gracefully
// (test-2-3b-013)
// ============================================================

describe("test-2-3b-013: PatternChips handles empty patterns array gracefully", () => {
  test("PatternChips handles empty array", () => {
    const componentPath = path.resolve(import.meta.dir, "../PatternChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should handle empty/undefined case
    expect(componentSource).toMatch(/patterns\?|patterns\.length|!patterns/)
  })
})

// ============================================================
// Test 3: Module exports
// ============================================================

describe("PatternChips module exports", () => {
  test("PatternChips component can be imported", async () => {
    const module = await import("../PatternChips")
    expect(module.PatternChips).toBeDefined()
    expect(typeof module.PatternChips).toBe("function")
  })
})
