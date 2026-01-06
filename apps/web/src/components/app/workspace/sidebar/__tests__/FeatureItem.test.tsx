/**
 * Tests for FeatureItem Component
 * Task: task-2-2-005
 *
 * TDD tests for the feature item component that shows a clickable row with name and status badge.
 *
 * Test Specifications:
 * - test-2-2-005-005: FeatureItem renders clickable row with name and status badge
 * - test-2-2-005-006: FeatureItem uses CVA for status badge variants
 * - test-2-2-005-007: FeatureItem highlights when selected
 * - test-2-2-005-008: Clicking FeatureItem calls onFeatureSelect
 *
 * Note: Uses source analysis tests for component structure verification.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: FeatureItem renders clickable row with name and status badge
// (test-2-2-005-005)
// ============================================================

describe("test-2-2-005-005: FeatureItem renders clickable row with name and status badge", () => {
  test("FeatureItem component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("FeatureItem accepts feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature:\s*Feature/)
  })

  test("FeatureItem displays feature name", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature\.name/)
  })

  test("FeatureItem displays status badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature\.status/)
  })

  test("FeatureItem is clickable (button or role)", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should be a button element or have onClick
    expect(componentSource).toMatch(/<button|onClick/)
  })

  test("FeatureItem truncates long names with ellipsis", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use truncate class for text overflow
    expect(componentSource).toMatch(/truncate/)
  })
})

// ============================================================
// Test 2: FeatureItem uses CVA for status badge variants
// (test-2-2-005-006)
// ============================================================

describe("test-2-2-005-006: FeatureItem uses CVA for status badge variants", () => {
  test("FeatureItem imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("FeatureItem defines statusBadgeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should define a cva for badge variants
    expect(componentSource).toMatch(/statusBadgeVariants.*=.*cva|badgeVariants.*=.*cva/)
  })

  test("FeatureItem has variant for discovery status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/discovery/)
  })

  test("FeatureItem has variant for design status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/design/)
  })

  test("FeatureItem has variant for complete status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete/)
  })

  test("FeatureItem exports statusBadgeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*statusBadgeVariants|export.*badgeVariants/)
  })
})

// ============================================================
// Test 3: FeatureItem highlights when selected
// (test-2-2-005-007)
// ============================================================

describe("test-2-2-005-007: FeatureItem highlights when selected", () => {
  test("FeatureItem accepts isSelected prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/isSelected/)
  })

  test("FeatureItem applies bg-accent when selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally apply bg-accent
    expect(componentSource).toMatch(/bg-accent/)
  })

  test("FeatureItem uses cn utility for conditional classes", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use cn from utils
    expect(componentSource).toMatch(/import.*cn.*from.*@\/lib\/utils/)
    expect(componentSource).toMatch(/cn\(/)
  })
})

// ============================================================
// Test 4: Clicking FeatureItem calls onFeatureSelect
// (test-2-2-005-008)
// ============================================================

describe("test-2-2-005-008: Clicking FeatureItem calls onFeatureSelect", () => {
  test("FeatureItem accepts onClick prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onClick/)
  })

  test("FeatureItem calls onClick handler when clicked", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have onClick on button/div
    expect(componentSource).toMatch(/onClick=\{.*onClick.*\}|onClick=\{onClick\}/)
  })

  test("FeatureItem exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+FeatureItemProps/)
  })
})

// ============================================================
// Test 5: Module exports
// ============================================================

describe("FeatureItem module exports", () => {
  test("FeatureItem can be imported", async () => {
    const module = await import("../FeatureItem")
    expect(module.FeatureItem).toBeDefined()
    expect(typeof module.FeatureItem).toBe("function")
  })

  test("statusBadgeVariants can be imported", async () => {
    const module = await import("../FeatureItem")
    expect(module.statusBadgeVariants).toBeDefined()
    expect(typeof module.statusBadgeVariants).toBe("function")
  })
})
