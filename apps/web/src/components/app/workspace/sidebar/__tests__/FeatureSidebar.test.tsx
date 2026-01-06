/**
 * Tests for FeatureSidebar Component
 * Task: task-2-2-005
 *
 * TDD tests for the main sidebar component that contains search, feature groups, and new feature button.
 *
 * Test Specifications:
 * - test-2-2-005-001: FeatureSidebar renders search, groups, and new feature button
 * - test-2-2-005-002: FeatureSidebar manages local searchQuery state for filtering
 *
 * Note: Uses source analysis tests for component structure verification.
 * Integration/browser tests will verify actual behavior.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: FeatureSidebar renders search, groups, and new feature button
// (test-2-2-005-001)
// ============================================================

describe("test-2-2-005-001: FeatureSidebar renders search, groups, and new feature button", () => {
  test("FeatureSidebar component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("FeatureSidebar imports SidebarSearch component", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*SidebarSearch.*from/)
    expect(componentSource).toMatch(/<SidebarSearch/)
  })

  test("FeatureSidebar imports FeatureGroup component", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*FeatureGroup.*from/)
    expect(componentSource).toMatch(/<FeatureGroup/)
  })

  test("FeatureSidebar imports NewFeatureButton component", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*NewFeatureButton.*from/)
    expect(componentSource).toMatch(/<NewFeatureButton/)
  })

  test("FeatureSidebar uses flex-col layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use flex flex-col for vertical layout
    expect(componentSource).toMatch(/flex.*flex-col|flex-col.*flex/)
  })

  test("FeatureSidebar has scrollable groups area", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have overflow-auto or overflow-y-auto for scrolling
    expect(componentSource).toMatch(/overflow-auto|overflow-y-auto/)
  })
})

// ============================================================
// Test 2: FeatureSidebar props interface
// ============================================================

describe("FeatureSidebar props interface", () => {
  test("FeatureSidebar accepts featuresByPhase prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/featuresByPhase/)
  })

  test("FeatureSidebar accepts currentFeatureId prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/currentFeatureId/)
  })

  test("FeatureSidebar accepts onFeatureSelect prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onFeatureSelect/)
  })

  test("FeatureSidebar accepts onNewFeature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onNewFeature/)
  })

  test("FeatureSidebar exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+FeatureSidebarProps/)
  })
})

// ============================================================
// Test 3: FeatureSidebar manages local searchQuery state
// (test-2-2-005-002)
// ============================================================

describe("test-2-2-005-002: FeatureSidebar manages local searchQuery state for filtering", () => {
  test("FeatureSidebar uses useState for searchQuery", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use useState hook for search state
    expect(componentSource).toMatch(/useState/)
    expect(componentSource).toMatch(/searchQuery|setSearchQuery/)
  })

  test("FeatureSidebar passes search value to SidebarSearch", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass value prop to SidebarSearch (multi-line JSX)
    expect(componentSource).toMatch(/<SidebarSearch/)
    expect(componentSource).toMatch(/value=\{searchQuery\}/)
  })

  test("FeatureSidebar passes onChange handler to SidebarSearch", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass onChange to SidebarSearch (multi-line JSX)
    expect(componentSource).toMatch(/<SidebarSearch/)
    expect(componentSource).toMatch(/onChange=\{setSearchQuery\}/)
  })

  test("FeatureSidebar filters features by search query", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should filter or use useMemo for filtered features
    expect(componentSource).toMatch(/filter|useMemo/)
  })
})

// ============================================================
// Test 4: Module exports
// ============================================================

describe("FeatureSidebar module exports", () => {
  test("FeatureSidebar can be imported", async () => {
    const module = await import("../FeatureSidebar")
    expect(module.FeatureSidebar).toBeDefined()
    expect(typeof module.FeatureSidebar).toBe("function")
  })
})
