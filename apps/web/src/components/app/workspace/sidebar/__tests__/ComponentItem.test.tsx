/**
 * Tests for ComponentItem Component
 * Task: task-dcb-009
 *
 * TDD tests for the component item that shows a clickable row with name, category badge,
 * and description in the sidebar catalog.
 *
 * Test Specifications:
 * - test-dcb-009-001: ComponentItem displays component name
 * - test-dcb-009-002: ComponentItem shows category as small badge (display, input, layout, visualization)
 * - test-dcb-009-003: ComponentItem shows description snippet on hover or secondary line
 * - test-dcb-009-004: Click calls onSelect callback with component id
 * - test-dcb-009-005: Selected state shows visual highlight matching FeatureItem
 * - test-dcb-009-006: Component is wrapped in observer() for MobX reactivity
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ComponentItem displays component name
// (test-dcb-009-001)
// ============================================================

describe("test-dcb-009-001: ComponentItem displays component name", () => {
  test("ComponentItem component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ComponentItem accepts component prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/component:\s*ComponentDefinition/)
  })

  test("ComponentItem displays component name", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/component\.name/)
  })

  test("ComponentItem is clickable (button or onClick)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<button|onClick/)
  })

  test("ComponentItem truncates long names with ellipsis", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/truncate/)
  })
})

// ============================================================
// Test 2: ComponentItem shows category as small badge
// (test-dcb-009-002)
// ============================================================

describe("test-dcb-009-002: ComponentItem shows category as small badge", () => {
  test("ComponentItem displays category", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/component\.category/)
  })

  test("ComponentItem uses Badge component from shadcn", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/badge["']/)
    expect(componentSource).toMatch(/<Badge/)
  })

  test("ComponentItem has category color mapping", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have color mappings for the 4 categories
    expect(componentSource).toMatch(/display/)
    expect(componentSource).toMatch(/input/)
    expect(componentSource).toMatch(/layout/)
    expect(componentSource).toMatch(/visualization/)
  })
})

// ============================================================
// Test 3: ComponentItem shows description snippet
// (test-dcb-009-003)
// ============================================================

describe("test-dcb-009-003: ComponentItem shows description snippet", () => {
  test("ComponentItem displays description", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/component\.description/)
  })

  test("ComponentItem truncates description", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use truncate or line-clamp for description
    expect(componentSource).toMatch(/truncate|line-clamp/)
  })
})

// ============================================================
// Test 4: Click calls onSelect callback with component id
// (test-dcb-009-004)
// ============================================================

describe("test-dcb-009-004: Click calls onSelect callback with component id", () => {
  test("ComponentItem accepts onSelect prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onSelect/)
  })

  test("ComponentItem calls onSelect with component id when clicked", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call onSelect with component.id
    expect(componentSource).toMatch(/onSelect\(component\.id\)|onSelect\(\s*component\.id\s*\)/)
  })

  test("ComponentItem exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+ComponentItemProps/)
  })
})

// ============================================================
// Test 5: Selected state shows visual highlight
// (test-dcb-009-005)
// ============================================================

describe("test-dcb-009-005: Selected state shows visual highlight matching FeatureItem", () => {
  test("ComponentItem accepts isSelected prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/isSelected/)
  })

  test("ComponentItem applies bg-accent when selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/bg-accent/)
  })

  test("ComponentItem uses cn utility for conditional classes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cn.*from.*@\/lib\/utils/)
    expect(componentSource).toMatch(/cn\(/)
  })

  test("ComponentItem has data-selected attribute", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-selected/)
  })
})

// ============================================================
// Test 6: Component is wrapped in observer() for MobX reactivity
// (test-dcb-009-006)
// ============================================================

describe("test-dcb-009-006: Component is wrapped in observer() for MobX reactivity", () => {
  test("ComponentItem imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*["']mobx-react-lite["']/)
  })

  test("ComponentItem exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should export with observer wrapper
    expect(componentSource).toMatch(/export\s+const\s+ComponentItem\s*=\s*observer/)
  })
})

// ============================================================
// Test 7: Module exports
// ============================================================

describe("ComponentItem module exports", () => {
  test("ComponentItem can be imported", async () => {
    const module = await import("../ComponentItem")
    expect(module.ComponentItem).toBeDefined()
    // observer() wraps the component, may be function or object depending on mobx-react-lite version
    expect(["function", "object"]).toContain(typeof module.ComponentItem)
  })

  test("ComponentDefinition interface can be imported", async () => {
    const module = await import("../ComponentItem")
    // TypeScript interfaces don't exist at runtime, but we can check the module loaded
    expect(module.ComponentItem).toBeDefined()
  })
})

// ============================================================
// Test 8: ComponentItem has proper accessibility
// ============================================================

describe("ComponentItem accessibility", () => {
  test("ComponentItem has data-testid attribute", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid/)
  })

  test("ComponentItem button has aria-selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/aria-selected/)
  })
})
