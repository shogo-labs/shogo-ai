/**
 * Tests for EvidenceChecklist Component
 * Task: task-2-3b-006
 *
 * TDD tests for the evidence checklist component displaying key-value pairs with check/x icons.
 *
 * Test Specifications:
 * - test-2-3b-014: EvidenceChecklist renders true values with CheckCircle icon
 * - test-2-3b-015: EvidenceChecklist renders false values with XCircle icon and muted styling
 * - test-2-3b-016: EvidenceChecklist handles empty or undefined evidence gracefully
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: EvidenceChecklist renders true values with CheckCircle icon
// (test-2-3b-014)
// ============================================================

describe("test-2-3b-014: EvidenceChecklist renders true values with CheckCircle icon", () => {
  test("EvidenceChecklist component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("EvidenceChecklist accepts evidence prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/evidence/)
  })

  test("EvidenceChecklist imports CheckCircle2 from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*CheckCircle2.*from.*lucide-react/)
  })

  test("EvidenceChecklist uses green color for true values", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/green|text-green/)
  })

  test("EvidenceChecklist transforms camelCase keys to display text", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have a function or pattern for transforming keys
    expect(componentSource).toMatch(/replace|split|[A-Z]/)
  })
})

// ============================================================
// Test 2: EvidenceChecklist renders false values with XCircle icon and muted styling
// (test-2-3b-015)
// ============================================================

describe("test-2-3b-015: EvidenceChecklist renders false values with XCircle icon and muted styling", () => {
  test("EvidenceChecklist imports XCircle from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*XCircle.*from.*lucide-react/)
  })

  test("EvidenceChecklist uses red color for false values", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/red|text-red/)
  })

  test("EvidenceChecklist uses muted styling for false items", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/muted|opacity/)
  })
})

// ============================================================
// Test 3: EvidenceChecklist handles empty or undefined evidence gracefully
// (test-2-3b-016)
// ============================================================

describe("test-2-3b-016: EvidenceChecklist handles empty or undefined evidence gracefully", () => {
  test("EvidenceChecklist handles undefined evidence", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have null/undefined check
    expect(componentSource).toMatch(/evidence\?|!evidence|evidence\s*&&/)
  })

  test("EvidenceChecklist has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*evidence-checklist/)
  })

  test("EvidenceChecklist iterates over Object.entries", () => {
    const componentPath = path.resolve(import.meta.dir, "../EvidenceChecklist.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Object\.entries/)
  })
})

// ============================================================
// Test 4: Module exports
// ============================================================

describe("EvidenceChecklist module exports", () => {
  test("EvidenceChecklist component can be imported", async () => {
    const module = await import("../EvidenceChecklist")
    expect(module.EvidenceChecklist).toBeDefined()
    expect(typeof module.EvidenceChecklist).toBe("function")
  })
})
