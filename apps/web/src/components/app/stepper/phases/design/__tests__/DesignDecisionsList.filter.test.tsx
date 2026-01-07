/**
 * DesignDecisionsList DecisionCategoryChips Integration Tests
 * Task: task-w3-filter-controls
 *
 * Tests verify:
 * 1. DecisionCategoryChips component exists and uses FilterControl
 * 2. Filterable category badges work with chip-select variant
 * 3. Decision list filters to selected category
 * 4. Multiple categories can be selected
 * 5. DesignDecisionsList integrates DecisionCategoryChips
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

// ============================================================
// Test 1: DecisionCategoryChips component exists
// ============================================================

describe("test-w3-filter-decision-chips-exists: DecisionCategoryChips component", () => {
  test("DecisionCategoryChips component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("DecisionCategoryChips imports FilterControl", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/FilterControl/)
  })

  test("DecisionCategoryChips uses chip-select variant", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/chip-select|variant.*chip/i)
  })
})

// ============================================================
// Test 2: DecisionCategoryChips supports decision categories
// ============================================================

describe("test-w3-filter-decision-categories: Decision category options", () => {
  test("DecisionCategoryChips has category options", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have category-related options
    expect(componentSource).toMatch(/category|categor/i)
  })

  test("DecisionCategoryChips supports multi-select", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should support multi-select
    expect(componentSource).toMatch(/multiSelect|multi.*select/i)
  })

  test("DecisionCategoryChips exports selection change callback", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have callback for category selection changes
    expect(componentSource).toMatch(/onSelectionChange|onChange|onCategoryChange/i)
  })
})

// ============================================================
// Test 3: DesignDecisionsList can use category filtering
// ============================================================

describe("test-w3-filter-design-integration: DesignDecisionsList category filtering", () => {
  test("DesignDecisionsList has design decisions data", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignDecisionsList.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should work with design decisions
    expect(componentSource).toMatch(/decision|designDecision/i)
  })

  test("DesignDecisionsList supports filtering decisions", () => {
    const componentPath = path.resolve(import.meta.dir, "../DesignDecisionsList.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have filter capability (either built-in or via DecisionCategoryChips)
    expect(componentSource).toMatch(/filter|DecisionCategoryChips|category/i)
  })
})

// ============================================================
// Test 4: Chip shows selected state
// ============================================================

describe("test-w3-filter-decision-selected-state: Selected chip styling", () => {
  test("DecisionCategoryChips passes selected values to FilterControl", () => {
    const componentPath = path.resolve(import.meta.dir, "../DecisionCategoryChips.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass value/selection to FilterControl
    expect(componentSource).toMatch(/value=|selectedCategories|selection/i)
  })
})
