/**
 * Tests for NewFeatureButton Component
 * Task: task-2-2-005
 *
 * TDD tests for the new feature button component in the sidebar footer.
 *
 * Test Specifications:
 * - test-2-2-005-011: NewFeatureButton uses shadcn Button with plus icon
 * - test-2-2-005-012: NewFeatureButton disabled when no project selected
 *
 * Note: Uses source analysis tests for component structure verification.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: NewFeatureButton uses shadcn Button with plus icon
// (test-2-2-005-011)
// ============================================================

describe("test-2-2-005-011: NewFeatureButton uses shadcn Button with plus icon", () => {
  test("NewFeatureButton component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("NewFeatureButton imports shadcn Button component", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/button["']/)
    expect(componentSource).toMatch(/Button/)
  })

  test("NewFeatureButton uses Button component", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<Button/)
  })

  test("NewFeatureButton imports Plus icon from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']lucide-react["']/)
    expect(componentSource).toMatch(/Plus/)
  })

  test("NewFeatureButton renders Plus icon", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<Plus/)
  })

  test("NewFeatureButton has button text", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have text like "New Feature" or similar
    expect(componentSource).toMatch(/New Feature|Add Feature|Create Feature/i)
  })
})

// ============================================================
// Test 2: NewFeatureButton props interface
// ============================================================

describe("NewFeatureButton props interface", () => {
  test("NewFeatureButton accepts onClick prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onClick/)
  })

  test("NewFeatureButton passes onClick to Button", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Button component should have onClick prop (multi-line JSX)
    expect(componentSource).toMatch(/<Button/)
    expect(componentSource).toMatch(/onClick=\{onClick\}/)
  })

  test("NewFeatureButton exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+NewFeatureButtonProps/)
  })
})

// ============================================================
// Test 3: NewFeatureButton disabled when no project selected
// (test-2-2-005-012)
// ============================================================

describe("test-2-2-005-012: NewFeatureButton disabled when no project selected", () => {
  test("NewFeatureButton accepts disabled prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/disabled/)
  })

  test("NewFeatureButton passes disabled to Button", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Button component should have disabled prop (multi-line JSX)
    expect(componentSource).toMatch(/<Button/)
    expect(componentSource).toMatch(/disabled=\{disabled\}/)
  })

  test("NewFeatureButton has title or tooltip for disabled state", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have title attribute or aria-label explaining why disabled
    expect(componentSource).toMatch(/title=|aria-label=/)
  })
})

// ============================================================
// Test 4: NewFeatureButton styling
// ============================================================

describe("NewFeatureButton styling", () => {
  test("NewFeatureButton uses full width", () => {
    const componentPath = path.resolve(import.meta.dir, "../NewFeatureButton.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have w-full class
    expect(componentSource).toMatch(/w-full/)
  })
})

// ============================================================
// Test 5: Module exports
// ============================================================

describe("NewFeatureButton module exports", () => {
  test("NewFeatureButton can be imported", async () => {
    const module = await import("../NewFeatureButton")
    expect(module.NewFeatureButton).toBeDefined()
    expect(typeof module.NewFeatureButton).toBe("function")
  })
})
