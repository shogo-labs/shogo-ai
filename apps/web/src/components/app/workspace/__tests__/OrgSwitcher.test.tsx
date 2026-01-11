/**
 * Tests for OrgSwitcher Component
 * Task: task-2-2-003
 *
 * TDD tests for the organization switcher component.
 *
 * Test Specifications:
 * - test-2-2-003-001: OrgSwitcher renders with shadcn Select component
 * - test-2-2-003-002: OrgSwitcher calls onOrgChange when selection changes
 * - test-2-2-003-007: Selectors show loading state while data fetches
 * - test-2-2-003-008: Clean break - selectors in /components/app/workspace/
 *
 * Note: Radix UI Select component has DOM requirements not fully supported by
 * happy-dom, so we use source analysis tests for component structure and
 * integration tests will verify behavior via browser testing.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: OrgSwitcher renders with shadcn Select component
// (test-2-2-003-001)
// ============================================================

describe("test-2-2-003-001: OrgSwitcher renders with shadcn Select component", () => {
  test("OrgSwitcher component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("OrgSwitcher imports shadcn Select components", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Select components from @/components/ui/select
    expect(componentSource).toMatch(/@\/components\/ui\/select/)
    expect(componentSource).toMatch(/Select/)
    expect(componentSource).toMatch(/SelectTrigger/)
    expect(componentSource).toMatch(/SelectContent/)
    expect(componentSource).toMatch(/SelectItem/)
    expect(componentSource).toMatch(/SelectValue/)
  })

  test("OrgSwitcher uses SelectTrigger for displaying current org", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use SelectTrigger with SelectValue
    expect(componentSource).toMatch(/<SelectTrigger/)
    expect(componentSource).toMatch(/<SelectValue/)
  })

  test("OrgSwitcher shows placeholder when no org selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have placeholder prop on SelectValue
    expect(componentSource).toMatch(/placeholder=/)
  })

  test("OrgSwitcher maps orgs to SelectItem components", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should map orgs to SelectItem
    expect(componentSource).toMatch(/orgs\.map/)
    expect(componentSource).toMatch(/<SelectItem/)
  })
})

// ============================================================
// Test 2: OrgSwitcher calls onOrgChange when selection changes
// (test-2-2-003-002)
// ============================================================

describe("test-2-2-003-002: OrgSwitcher calls onOrgChange when selection changes", () => {
  test("OrgSwitcher accepts onOrgChange prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include onOrgChange
    expect(componentSource).toMatch(/onOrgChange/)
    expect(componentSource).toMatch(/\(slug:\s*string\)\s*=>/)
  })

  test("OrgSwitcher accepts orgs prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include orgs array
    expect(componentSource).toMatch(/orgs:\s*Organization\[\]/)
  })

  test("OrgSwitcher accepts currentOrg prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include currentOrg
    expect(componentSource).toMatch(/currentOrg:\s*Organization\s*\|\s*null/)
  })

  test("OrgSwitcher uses onValueChange to handle selection", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use onValueChange on Select component
    expect(componentSource).toMatch(/onValueChange/)
  })

  test("OrgSwitcher calls onOrgChange with slug value", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // SelectItem should use org.slug as value
    expect(componentSource).toMatch(/value=\{org\.slug\}/)
  })
})

// ============================================================
// Test 3: Selectors show loading state while data fetches
// (test-2-2-003-007)
// ============================================================

describe("test-2-2-003-007: Selectors show loading state while data fetches", () => {
  test("OrgSwitcher accepts isLoading prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should accept isLoading prop
    expect(componentSource).toMatch(/isLoading/)
  })

  test("OrgSwitcher imports Skeleton component", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Skeleton from ui
    expect(componentSource).toMatch(/@\/components\/ui\/skeleton/)
    expect(componentSource).toMatch(/Skeleton/)
  })

  test("OrgSwitcher renders Skeleton when isLoading is true", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally render Skeleton
    expect(componentSource).toMatch(/if\s*\(\s*isLoading\s*\)/)
    expect(componentSource).toMatch(/<Skeleton/)
  })

  test("OrgSwitcher has disabled prop on Select when loading", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass disabled prop to Select
    expect(componentSource).toMatch(/disabled=\{isLoading\}/)
  })
})

// ============================================================
// Test 4: Clean break verification
// (test-2-2-003-008)
// ============================================================

describe("test-2-2-003-008: Clean break - OrgSwitcher in /components/app/workspace/", () => {
  test("OrgSwitcher.tsx exists at /components/app/workspace/", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)

    // Verify it's in the correct directory
    expect(componentPath).toMatch(/\/components\/app\/workspace\/OrgSwitcher\.tsx$/)
  })

  test("OrgSwitcher uses shadcn patterns (Select from @/components/ui)", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Must import from @/components/ui/select
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/select["']/)
  })

  test("OrgSwitcher has zero imports from /components/Studio/", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT import from /components/Studio/
    expect(componentSource).not.toMatch(/from\s+['"].*\/components\/Studio\//)
    expect(componentSource).not.toMatch(/from\s+['"].*\/Studio\//)
  })

  test("OrgSwitcher defines Organization interface locally", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should define Organization type/interface
    expect(componentSource).toMatch(/interface\s+Organization/)
    expect(componentSource).toMatch(/id:\s*string/)
    expect(componentSource).toMatch(/name:\s*string/)
    expect(componentSource).toMatch(/slug:\s*string/)
  })

  test("OrgSwitcher exports component and props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should export OrgSwitcher and OrgSwitcherProps
    expect(componentSource).toMatch(/export\s+function\s+OrgSwitcher/)
    expect(componentSource).toMatch(/export\s+interface\s+OrgSwitcherProps/)
  })
})

// ============================================================
// Test 5: Create Organization button
// (test-org-004)
// ============================================================

describe("test-org-004: OrgSwitcher includes Create Organization button", () => {
  test("OrgSwitcher includes Create Organization option at bottom of dropdown", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have "Create Organization" text somewhere in the component
    expect(componentSource).toMatch(/Create Organization|Create Org/)
  })

  test("OrgSwitcher imports Button from shadcn", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Button for Create Organization action
    expect(componentSource).toMatch(/@\/components\/ui\/button/)
    expect(componentSource).toMatch(/Button/)
  })

  test("OrgSwitcher has visual separator between org list and create button", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have some kind of separator (div, SelectSeparator, border, etc.)
    expect(componentSource).toMatch(/Separator|separator|border-t|divider|<hr/)
  })

  test("OrgSwitcher manages modal state for CreateOrgModal", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have state for modal open/close
    expect(componentSource).toMatch(/useState.*boolean|showCreateModal|isCreateModalOpen|createModalOpen/)
  })

  test("OrgSwitcher imports CreateOrgModal component", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and render CreateOrgModal
    expect(componentSource).toMatch(/import.*CreateOrgModal|from.*CreateOrgModal/)
    expect(componentSource).toMatch(/<CreateOrgModal/)
  })

  test("OrgSwitcher passes open and onOpenChange to CreateOrgModal", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass controlled props to CreateOrgModal
    expect(componentSource).toMatch(/<CreateOrgModal[^>]*open=/)
    expect(componentSource).toMatch(/<CreateOrgModal[^>]*onOpenChange=/)
  })

  test("OrgSwitcher uses Plus icon for create button", () => {
    const componentPath = path.resolve(import.meta.dir, "../OrgSwitcher.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Plus icon from lucide-react
    expect(componentSource).toMatch(/Plus|plus|PlusCircle/)
  })
})

// ============================================================
// Test: OrgSwitcher module can be imported
// ============================================================

describe("OrgSwitcher module exports", () => {
  test("OrgSwitcher can be imported", async () => {
    const module = await import("../OrgSwitcher")
    expect(module.OrgSwitcher).toBeDefined()
    expect(typeof module.OrgSwitcher).toBe("function")
  })
})
