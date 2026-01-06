/**
 * Tests for ProjectSelector Component
 * Task: task-2-2-003
 *
 * TDD tests for the project selector component.
 *
 * Test Specifications:
 * - test-2-2-003-003: ProjectSelector renders with shadcn Select component
 * - test-2-2-003-004: ProjectSelector is disabled when no org selected
 * - test-2-2-003-005: ProjectSelector calls onProjectChange when selection changes
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
// Test 1: ProjectSelector renders with shadcn Select component
// (test-2-2-003-003)
// ============================================================

describe("test-2-2-003-003: ProjectSelector renders with shadcn Select component", () => {
  test("ProjectSelector component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ProjectSelector imports shadcn Select components", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Select components from @/components/ui/select
    expect(componentSource).toMatch(/@\/components\/ui\/select/)
    expect(componentSource).toMatch(/Select/)
    expect(componentSource).toMatch(/SelectTrigger/)
    expect(componentSource).toMatch(/SelectContent/)
    expect(componentSource).toMatch(/SelectItem/)
    expect(componentSource).toMatch(/SelectValue/)
  })

  test("ProjectSelector uses SelectTrigger for displaying current project", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use SelectTrigger with SelectValue
    expect(componentSource).toMatch(/<SelectTrigger/)
    expect(componentSource).toMatch(/<SelectValue/)
  })

  test("ProjectSelector shows placeholder when no project selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have placeholder prop on SelectValue
    expect(componentSource).toMatch(/placeholder=/)
  })

  test("ProjectSelector maps projects to SelectItem components", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should map projects to SelectItem
    expect(componentSource).toMatch(/projects\.map/)
    expect(componentSource).toMatch(/<SelectItem/)
  })
})

// ============================================================
// Test 2: ProjectSelector is disabled when no org selected
// (test-2-2-003-004)
// ============================================================

describe("test-2-2-003-004: ProjectSelector is disabled when no org selected", () => {
  test("ProjectSelector accepts disabled prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include disabled
    expect(componentSource).toMatch(/disabled\?:\s*boolean/)
  })

  test("ProjectSelector passes disabled prop to Select component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass disabled to Select
    expect(componentSource).toMatch(/disabled=/)
  })

  test("ProjectSelector shows placeholder text when disabled", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have placeholder for when no project is selected
    expect(componentSource).toMatch(/placeholder=/)
  })
})

// ============================================================
// Test 3: ProjectSelector calls onProjectChange when selection changes
// (test-2-2-003-005)
// ============================================================

describe("test-2-2-003-005: ProjectSelector calls onProjectChange when selection changes", () => {
  test("ProjectSelector accepts onProjectChange prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include onProjectChange
    expect(componentSource).toMatch(/onProjectChange/)
    expect(componentSource).toMatch(/\(id:\s*string\)\s*=>/)
  })

  test("ProjectSelector accepts projects prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include projects array
    expect(componentSource).toMatch(/projects:\s*Project\[\]/)
  })

  test("ProjectSelector accepts currentProject prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Props interface should include currentProject
    expect(componentSource).toMatch(/currentProject:\s*Project\s*\|\s*null/)
  })

  test("ProjectSelector uses onValueChange to handle selection", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use onValueChange on Select component
    expect(componentSource).toMatch(/onValueChange/)
  })

  test("ProjectSelector calls onProjectChange with project ID", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // SelectItem should use project.id as value
    expect(componentSource).toMatch(/value=\{project\.id\}/)
  })
})

// ============================================================
// Test 4: Selectors show loading state while data fetches
// (test-2-2-003-007 - ProjectSelector part)
// ============================================================

describe("test-2-2-003-007: ProjectSelector shows loading state while data fetches", () => {
  test("ProjectSelector accepts isLoading prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should accept isLoading prop
    expect(componentSource).toMatch(/isLoading/)
  })

  test("ProjectSelector imports Skeleton component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Skeleton from ui
    expect(componentSource).toMatch(/@\/components\/ui\/skeleton/)
    expect(componentSource).toMatch(/Skeleton/)
  })

  test("ProjectSelector renders Skeleton when isLoading is true", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally render Skeleton
    expect(componentSource).toMatch(/if\s*\(\s*isLoading\s*\)/)
    expect(componentSource).toMatch(/<Skeleton/)
  })
})

// ============================================================
// Test 5: Clean break verification
// (test-2-2-003-008 - ProjectSelector part)
// ============================================================

describe("test-2-2-003-008: Clean break - ProjectSelector in /components/app/workspace/", () => {
  test("ProjectSelector.tsx exists at /components/app/workspace/", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)

    // Verify it's in the correct directory
    expect(componentPath).toMatch(/\/components\/app\/workspace\/ProjectSelector\.tsx$/)
  })

  test("ProjectSelector uses shadcn patterns (Select from @/components/ui)", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Must import from @/components/ui/select
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/select["']/)
  })

  test("ProjectSelector has zero imports from /components/Studio/", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT import from /components/Studio/
    expect(componentSource).not.toMatch(/from\s+['"].*\/components\/Studio\//)
    expect(componentSource).not.toMatch(/from\s+['"].*\/Studio\//)
  })

  test("ProjectSelector defines Project interface locally", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should define Project type/interface
    expect(componentSource).toMatch(/interface\s+Project/)
    expect(componentSource).toMatch(/id:\s*string/)
    expect(componentSource).toMatch(/name:\s*string/)
  })

  test("ProjectSelector exports component and props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../ProjectSelector.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should export ProjectSelector and ProjectSelectorProps
    expect(componentSource).toMatch(/export\s+function\s+ProjectSelector/)
    expect(componentSource).toMatch(/export\s+interface\s+ProjectSelectorProps/)
  })
})

// ============================================================
// Test: ProjectSelector module can be imported
// ============================================================

describe("ProjectSelector module exports", () => {
  test("ProjectSelector can be imported", async () => {
    const module = await import("../ProjectSelector")
    expect(module.ProjectSelector).toBeDefined()
    expect(typeof module.ProjectSelector).toBe("function")
  })
})
