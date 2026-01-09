/**
 * Tests for ComponentCatalogSidebar Component
 * Task: task-dcb-011
 *
 * TDD tests for the main sidebar section that displays component catalog.
 * Groups components by category with search/filter functionality.
 *
 * Test Specifications:
 * - test-dcb-011-001: ComponentCatalogSidebar renders search input at top
 * - test-dcb-011-002: Groups components by category (display, input, layout, visualization)
 * - test-dcb-011-003: Search filters components by name and description
 * - test-dcb-011-004: Uses ComponentGroup for each category
 * - test-dcb-011-005: Shows total component count in header
 * - test-dcb-011-006: Matches FeatureSidebar layout and styling patterns
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ComponentCatalogSidebar renders search input at top
// (test-dcb-011-001)
// ============================================================

describe("test-dcb-011-001: ComponentCatalogSidebar renders search input at top", () => {
  test("ComponentCatalogSidebar component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ComponentCatalogSidebar imports SidebarSearch component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*SidebarSearch.*from/)
    expect(componentSource).toMatch(/<SidebarSearch/)
  })

  test("ComponentCatalogSidebar uses useState for searchQuery", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useState/)
    expect(componentSource).toMatch(/searchQuery|setSearchQuery/)
  })

  test("ComponentCatalogSidebar passes value and onChange to SidebarSearch", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<SidebarSearch/)
    expect(componentSource).toMatch(/value=\{searchQuery\}/)
    expect(componentSource).toMatch(/onChange=\{setSearchQuery\}/)
  })

  test("ComponentCatalogSidebar passes custom placeholder to SidebarSearch", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have a placeholder for components search
    expect(componentSource).toMatch(/placeholder=.*[Cc]omponent/)
  })
})

// ============================================================
// Test 2: Groups components by category
// (test-dcb-011-002)
// ============================================================

describe("test-dcb-011-002: Groups components by category (display, input, layout, visualization)", () => {
  test("ComponentCatalogSidebar imports COMPONENT_CATEGORIES constant", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*COMPONENT_CATEGORIES.*from/)
  })

  test("ComponentCatalogSidebar maps over COMPONENT_CATEGORIES", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/COMPONENT_CATEGORIES\.map/)
  })

  test("ComponentCatalogSidebar filters components by category", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should filter components where category matches
    expect(componentSource).toMatch(/\.filter|\.category\s*===/)
  })
})

// ============================================================
// Test 3: Search filters components by name and description
// (test-dcb-011-003)
// ============================================================

describe("test-dcb-011-003: Search filters components by name and description", () => {
  test("ComponentCatalogSidebar has filter function for search", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have filtering logic with useMemo or filter
    expect(componentSource).toMatch(/useMemo|filter/)
  })

  test("ComponentCatalogSidebar filters by name", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should search by component name
    expect(componentSource).toMatch(/\.name.*toLowerCase|toLowerCase.*\.name/)
  })

  test("ComponentCatalogSidebar filters by description", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should search by description
    expect(componentSource).toMatch(/\.description.*toLowerCase|toLowerCase.*\.description/)
  })

  test("ComponentCatalogSidebar shows no match message when search yields no results", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have empty state message for no matches
    expect(componentSource).toMatch(/[Nn]o\s+(components?|match)/)
  })
})

// ============================================================
// Test 4: Uses ComponentGroup for each category
// (test-dcb-011-004)
// ============================================================

describe("test-dcb-011-004: Uses ComponentGroup for each category", () => {
  test("ComponentCatalogSidebar imports ComponentGroup component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*ComponentGroup.*from/)
    expect(componentSource).toMatch(/<ComponentGroup/)
  })

  test("ComponentCatalogSidebar passes category prop to ComponentGroup", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ComponentGroup[\s\S]*?category=/)
  })

  test("ComponentCatalogSidebar passes components prop to ComponentGroup", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ComponentGroup[\s\S]*?components=/)
  })

  test("ComponentCatalogSidebar passes selectedId to ComponentGroup", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ComponentGroup[\s\S]*?selectedId=/)
  })

  test("ComponentCatalogSidebar passes onSelect to ComponentGroup", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ComponentGroup[\s\S]*?onSelect=/)
  })
})

// ============================================================
// Test 5: Shows total component count in header
// (test-dcb-011-005)
// ============================================================

describe("test-dcb-011-005: Shows total component count in header", () => {
  test("ComponentCatalogSidebar has header section", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have header element or heading
    expect(componentSource).toMatch(/<header|<h2|<h3/)
  })

  test("ComponentCatalogSidebar shows 'Components' text in header", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Components/)
  })

  test("ComponentCatalogSidebar displays total component count", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should show components.length or similar count
    expect(componentSource).toMatch(/components\.length|componentCount|totalCount/)
  })
})

// ============================================================
// Test 6: Matches FeatureSidebar layout and styling patterns
// (test-dcb-011-006)
// ============================================================

describe("test-dcb-011-006: Matches FeatureSidebar layout and styling patterns", () => {
  test("ComponentCatalogSidebar uses flex-col layout", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/flex.*flex-col|flex-col.*flex/)
  })

  test("ComponentCatalogSidebar has h-full for full height", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/h-full/)
  })

  test("ComponentCatalogSidebar has scrollable content area", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/overflow-auto|overflow-y-auto/)
  })

  test("ComponentCatalogSidebar has flex-1 for content area", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/flex-1/)
  })

  test("ComponentCatalogSidebar has data-testid attribute", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid=["']component-catalog-sidebar["']/)
  })

  test("ComponentCatalogSidebar uses border-b or border-border for section separators", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/border-b|border-border/)
  })
})

// ============================================================
// Test 7: ComponentCatalogSidebar props interface
// ============================================================

describe("ComponentCatalogSidebar props interface", () => {
  test("ComponentCatalogSidebar accepts components prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/components:\s*ComponentDefinition(Entity)?\[\]/)
  })

  test("ComponentCatalogSidebar accepts selectedId prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/selectedId/)
  })

  test("ComponentCatalogSidebar accepts onSelect prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onSelect:\s*\(id:\s*string\)\s*=>\s*void/)
  })

  test("ComponentCatalogSidebar exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+ComponentCatalogSidebarProps/)
  })
})

// ============================================================
// Test 8: Module exports
// ============================================================

describe("ComponentCatalogSidebar module exports", () => {
  test("ComponentCatalogSidebar can be imported", async () => {
    const module = await import("../ComponentCatalogSidebar")
    expect(module.ComponentCatalogSidebar).toBeDefined()
    // observer() wraps the component, may be function or object depending on mobx-react-lite version
    expect(["function", "object"]).toContain(typeof module.ComponentCatalogSidebar)
  })
})

// ============================================================
// Test 9: ComponentCatalogSidebar is wrapped in observer() for MobX reactivity
// ============================================================

describe("ComponentCatalogSidebar is wrapped in observer() for MobX reactivity", () => {
  test("ComponentCatalogSidebar imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*["']mobx-react-lite["']/)
  })

  test("ComponentCatalogSidebar exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ComponentCatalogSidebar.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+const\s+ComponentCatalogSidebar\s*=\s*observer/)
  })
})
