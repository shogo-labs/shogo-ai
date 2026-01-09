/**
 * Tests for ComponentGroup Component
 * Task: task-dcb-010
 *
 * TDD tests for the component group that shows a category header with collapse/expand
 * chevron, component count badge, and list of ComponentItems.
 *
 * Test Specifications:
 * - test-dcb-010-001: ComponentGroup renders category header with expand/collapse chevron
 * - test-dcb-010-002: Collapse state persisted to localStorage keyed by category
 * - test-dcb-010-003: Shows component count in header
 * - test-dcb-010-004: Renders ComponentItem for each component in category
 * - test-dcb-010-005: Matches FeatureGroup styling and animation
 * - test-dcb-010-006: Empty categories show 'No components' message
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ComponentGroup renders category header with expand/collapse chevron
// (test-dcb-010-001)
// ============================================================

describe("test-dcb-010-001: ComponentGroup renders category header with expand/collapse chevron", () => {
  test("ComponentGroup component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ComponentGroup accepts category prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/category:\s*string/)
  })

  test("ComponentGroup renders category name in header", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should display the category prop
    expect(componentSource).toMatch(/\{category\}|\{.*category.*\}/)
  })

  test("ComponentGroup uses ChevronDown and ChevronRight icons", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/ChevronDown/)
    expect(componentSource).toMatch(/ChevronRight/)
  })

  test("ComponentGroup has clickable header for toggle", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have a button or onClick handler on header area
    expect(componentSource).toMatch(/<button|onClick/)
  })

  test("ComponentGroup has isExpanded state", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/isExpanded|setIsExpanded/)
  })
})

// ============================================================
// Test 2: Collapse state persisted to localStorage keyed by category
// (test-dcb-010-002)
// ============================================================

describe("test-dcb-010-002: Collapse state persisted to localStorage keyed by category", () => {
  test("ComponentGroup uses localStorage for persistence", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/localStorage/)
  })

  test("ComponentGroup has storage key based on category", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should include category in the storage key
    expect(componentSource).toMatch(/component-group.*category|category.*collapsed|STORAGE_KEY/)
  })

  test("ComponentGroup saves state on toggle", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call localStorage.setItem when toggling
    expect(componentSource).toMatch(/localStorage\.setItem/)
  })

  test("ComponentGroup reads initial state from localStorage", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call localStorage.getItem on mount/initialization
    expect(componentSource).toMatch(/localStorage\.getItem/)
  })
})

// ============================================================
// Test 3: Shows component count in header
// (test-dcb-010-003)
// ============================================================

describe("test-dcb-010-003: Shows component count in header", () => {
  test("ComponentGroup accepts components prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/components:\s*ComponentDefinition(Entity)?\[\]/)
  })

  test("ComponentGroup shows components length in badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show components.length
    expect(componentSource).toMatch(/components\.length/)
  })

  test("ComponentGroup uses Badge component from shadcn", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/badge["']/)
    expect(componentSource).toMatch(/<Badge/)
  })
})

// ============================================================
// Test 4: Renders ComponentItem for each component in category
// (test-dcb-010-004)
// ============================================================

describe("test-dcb-010-004: Renders ComponentItem for each component in category", () => {
  test("ComponentGroup imports ComponentItem component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*ComponentItem.*from/)
    expect(componentSource).toMatch(/<ComponentItem/)
  })

  test("ComponentGroup maps components to ComponentItem components", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should map components to ComponentItem
    expect(componentSource).toMatch(/components\.map/)
  })

  test("ComponentGroup passes onSelect to ComponentItem", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // FeatureGroup passes onFeatureSelect -> onSelect in ComponentItem
    expect(componentSource).toMatch(/<ComponentItem[\s\S]*?onSelect=/)
  })

  test("ComponentGroup passes isSelected to ComponentItem", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ComponentItem[\s\S]*?isSelected=/)
  })
})

// ============================================================
// Test 5: Matches FeatureGroup styling and animation
// (test-dcb-010-005)
// ============================================================

describe("test-dcb-010-005: Matches FeatureGroup styling and animation", () => {
  test("ComponentGroup has similar header styling to FeatureGroup", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have text-xs, uppercase, tracking-wider like FeatureGroup
    expect(componentSource).toMatch(/text-xs/)
    expect(componentSource).toMatch(/uppercase/)
    expect(componentSource).toMatch(/tracking-wider/)
  })

  test("ComponentGroup uses cn utility for conditional classes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cn.*from.*@\/lib\/utils/)
    expect(componentSource).toMatch(/cn\(/)
  })

  test("ComponentGroup has animation classes for collapse transition", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have transition classes
    expect(componentSource).toMatch(/transition/)
  })

  test("ComponentGroup has data-testid attribute", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid/)
  })
})

// ============================================================
// Test 6: Empty categories show 'No components' message
// (test-dcb-010-006)
// ============================================================

describe("test-dcb-010-006: Empty categories show 'No components' message", () => {
  test("ComponentGroup handles empty components array", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for empty components and show message
    expect(componentSource).toMatch(/components\.length\s*===\s*0|components\.length\s*<\s*1|!components\.length/)
  })

  test("ComponentGroup shows 'No components' message when empty", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have a "No components" message
    expect(componentSource).toMatch(/No components|no components/i)
  })
})

// ============================================================
// Test 7: ComponentGroup props interface
// ============================================================

describe("ComponentGroup props interface", () => {
  test("ComponentGroup accepts selectedId prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/selectedId/)
  })

  test("ComponentGroup accepts onSelect prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onSelect/)
  })

  test("ComponentGroup exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+ComponentGroupProps/)
  })
})

// ============================================================
// Test 8: Module exports
// ============================================================

describe("ComponentGroup module exports", () => {
  test("ComponentGroup can be imported", async () => {
    const module = await import("../ComponentGroup")
    expect(module.ComponentGroup).toBeDefined()
    // observer() wraps the component, may be function or object depending on mobx-react-lite version
    expect(["function", "object"]).toContain(typeof module.ComponentGroup)
  })

  test("COMPONENT_CATEGORIES constant can be imported", async () => {
    const module = await import("../ComponentGroup")
    expect(module.COMPONENT_CATEGORIES).toBeDefined()
    expect(Array.isArray(module.COMPONENT_CATEGORIES)).toBe(true)
    expect(module.COMPONENT_CATEGORIES.length).toBe(4)
  })
})

// ============================================================
// Test 9: ComponentGroup is wrapped in observer() for MobX reactivity
// ============================================================

describe("ComponentGroup is wrapped in observer() for MobX reactivity", () => {
  test("ComponentGroup imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*["']mobx-react-lite["']/)
  })

  test("ComponentGroup exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentGroup.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should export with observer wrapper
    expect(componentSource).toMatch(/export\s+const\s+ComponentGroup\s*=\s*observer/)
  })
})
