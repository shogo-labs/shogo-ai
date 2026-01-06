/**
 * Tests for FeatureGroup Component
 * Task: task-2-2-005
 *
 * TDD tests for the feature group component that shows a phase header with count badge and feature items.
 *
 * Test Specifications:
 * - test-2-2-005-003: FeatureGroup renders phase header with count badge and items
 * - test-2-2-005-004: FeatureGroup shows all 8 phases
 *
 * Note: Uses source analysis tests for component structure verification.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: FeatureGroup renders phase header with count badge and items
// (test-2-2-005-003)
// ============================================================

describe("test-2-2-005-003: FeatureGroup renders phase header with count badge and items", () => {
  test("FeatureGroup component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("FeatureGroup accepts phase prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/phase:\s*string/)
  })

  test("FeatureGroup accepts features prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/features:\s*Feature\[\]/)
  })

  test("FeatureGroup renders phase name in header", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display the phase prop
    expect(componentSource).toMatch(/\{phase\}|\{.*phase.*\}/)
  })

  test("FeatureGroup shows count badge with features length", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show features.length in a badge
    expect(componentSource).toMatch(/features\.length/)
  })

  test("FeatureGroup imports FeatureItem component", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*FeatureItem.*from/)
    expect(componentSource).toMatch(/<FeatureItem/)
  })

  test("FeatureGroup maps features to FeatureItem components", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should map features to FeatureItem
    expect(componentSource).toMatch(/features\.map/)
  })
})

// ============================================================
// Test 2: FeatureGroup props interface
// ============================================================

describe("FeatureGroup props interface", () => {
  test("FeatureGroup accepts currentFeatureId prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/currentFeatureId/)
  })

  test("FeatureGroup accepts onFeatureSelect prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onFeatureSelect/)
  })

  test("FeatureGroup exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+FeatureGroupProps/)
  })
})

// ============================================================
// Test 3: FeatureGroup shows all 8 phases constant
// (test-2-2-005-004)
// ============================================================

describe("test-2-2-005-004: FeatureGroup shows all 8 phases", () => {
  test("FEATURE_PHASES constant includes Discovery", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Discovery|discovery/)
  })

  test("FEATURE_PHASES constant includes Analysis", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Analysis|analysis/)
  })

  test("FEATURE_PHASES constant includes Classification", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Classification|classification/)
  })

  test("FEATURE_PHASES constant includes Design", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Design|design/)
  })

  test("FEATURE_PHASES constant includes Spec", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Spec|spec/)
  })

  test("FEATURE_PHASES constant includes Testing", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Testing|testing/)
  })

  test("FEATURE_PHASES constant includes Implementation", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Implementation|implementation/)
  })

  test("FEATURE_PHASES constant includes Complete", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Complete|complete/)
  })

  test("FEATURE_PHASES is exported", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+(const|type).*FEATURE_PHASES/)
  })
})

// ============================================================
// Test 4: Module exports
// ============================================================

describe("FeatureGroup module exports", () => {
  test("FeatureGroup can be imported", async () => {
    const module = await import("../FeatureGroup")
    expect(module.FeatureGroup).toBeDefined()
    expect(typeof module.FeatureGroup).toBe("function")
  })

  test("FEATURE_PHASES can be imported", async () => {
    const module = await import("../FeatureGroup")
    expect(module.FEATURE_PHASES).toBeDefined()
    expect(Array.isArray(module.FEATURE_PHASES)).toBe(true)
    expect(module.FEATURE_PHASES.length).toBe(8)
  })
})
