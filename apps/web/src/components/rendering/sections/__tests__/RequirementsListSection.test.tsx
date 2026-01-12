/**
 * Tests for RequirementsListSection Component
 * Task: task-cpv-008
 *
 * TDD tests for requirements list section component that renders
 * requirements grouped by priority (must/should/could) with priority badges.
 *
 * Acceptance Criteria:
 * 1. Component accepts SectionRendererProps
 * 2. Calls useDomains() to get platformFeatures store
 * 3. Queries requirementCollection.findBySession(feature.id)
 * 4. Groups requirements by priority (must, should, could)
 * 5. Renders priority badges with color coding
 * 6. Shows requirement name and description
 * 7. Handles empty requirements list gracefully
 * 8. Registered in sectionImplementationMap
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../RequirementsListSection.tsx")
const sectionImplPath = path.resolve(
  import.meta.dir,
  "../../sectionImplementations.tsx"
)

// ============================================================
// Test 1: Component accepts SectionRendererProps
// ============================================================

describe("task-cpv-008-ac1: Component accepts SectionRendererProps", () => {
  test("RequirementsListSection component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("Component accepts feature prop from SectionRendererProps", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should destructure or access feature from props
    expect(componentSource).toMatch(/feature/)
  })

  test("Component imports SectionRendererProps type", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/SectionRendererProps/)
  })
})

// ============================================================
// Test 2: Calls useDomains() to get platformFeatures store
// ============================================================

describe("task-cpv-008-ac2: Calls useDomains() to get platformFeatures store", () => {
  test("Component imports useDomains hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*useDomains/)
  })

  test("Component calls useDomains() hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/useDomains\(\)/)
  })

  test("Component destructures platformFeatures from useDomains", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/platformFeatures/)
  })
})

// ============================================================
// Test 3: Queries requirementCollection.findBySession(feature.id)
// ============================================================

describe("task-cpv-008-ac3: Queries requirementCollection.findBySession", () => {
  test("Component accesses requirementCollection", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/requirementCollection/)
  })

  test("Component calls findBySession with feature.id", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/findBySession.*feature\.id/)
  })
})

// ============================================================
// Test 4: Groups requirements by priority (must, should, could)
// ============================================================

describe("task-cpv-008-ac4: Groups requirements by priority", () => {
  test("Component filters requirements for must priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/priority.*===.*["']must["']|["']must["']/)
  })

  test("Component filters requirements for should priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/priority.*===.*["']should["']|["']should["']/)
  })

  test("Component filters requirements for could priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/priority.*===.*["']could["']|["']could["']/)
  })
})

// ============================================================
// Test 5: Renders priority badges with color coding
// ============================================================

describe("task-cpv-008-ac5: Renders priority badges with color coding", () => {
  test("Component uses red color for must priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have red styling for must
    expect(componentSource).toMatch(/red.*must|must.*red|bg-red|text-red/)
  })

  test("Component uses amber/yellow color for should priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have amber/yellow styling for should
    expect(componentSource).toMatch(/amber.*should|should.*amber|bg-amber|text-amber|yellow/)
  })

  test("Component uses blue color for could priority", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have blue styling for could
    expect(componentSource).toMatch(/blue.*could|could.*blue|bg-blue|text-blue/)
  })
})

// ============================================================
// Test 6: Shows requirement name and description
// ============================================================

describe("task-cpv-008-ac6: Shows requirement name and description", () => {
  test("Component uses RequirementCard for rendering", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should use the existing RequirementCard component which handles name/description
    expect(componentSource).toMatch(/RequirementCard/)
  })

  test("Component imports RequirementCard from shared", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should import RequirementCard
    expect(componentSource).toMatch(/import.*RequirementCard/)
  })

  test("Component passes requirement to RequirementCard", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should pass requirement prop to RequirementCard
    expect(componentSource).toMatch(/requirement=\{req\}/)
  })
})

// ============================================================
// Test 7: Handles empty requirements list gracefully
// ============================================================

describe("task-cpv-008-ac7: Handles empty requirements list gracefully", () => {
  test("Component checks for empty requirements", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should check for length === 0 or !requirements
    expect(componentSource).toMatch(
      /requirements\.length\s*===\s*0|!requirements|requirements\s*\?\?|\.length\s*>\s*0/
    )
  })

  test("Component renders empty state message", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have some empty state UI
    expect(componentSource).toMatch(/[Nn]o\s*requirements|empty|captured/)
  })
})

// ============================================================
// Test 8: Registered in sectionImplementationMap
// ============================================================

describe("task-cpv-008-ac8: Registered in sectionImplementationMap", () => {
  test("sectionImplementationMap imports RequirementsListSection", () => {
    const implSource = fs.readFileSync(sectionImplPath, "utf-8")
    expect(implSource).toMatch(/import.*RequirementsListSection/)
  })

  test("sectionImplementationMap registers RequirementsListSection", () => {
    const implSource = fs.readFileSync(sectionImplPath, "utf-8")
    // Should have entry like ["RequirementsListSection", RequirementsListSection]
    expect(implSource).toMatch(
      /\[\s*["']RequirementsListSection["']\s*,\s*RequirementsListSection\s*\]/
    )
  })
})

// ============================================================
// Test 9: Component exports and module structure
// ============================================================

describe("task-cpv-008: Module exports", () => {
  test("RequirementsListSection is exported", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/export.*RequirementsListSection/)
  })

  test("Component uses observer for MobX reactivity", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/observer/)
  })
})
