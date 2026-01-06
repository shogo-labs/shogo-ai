/**
 * Tests for SidebarSearch Component
 * Task: task-2-2-005
 *
 * TDD tests for the search input component in the sidebar.
 *
 * Test Specifications:
 * - test-2-2-005-009: SidebarSearch uses shadcn Input with search icon
 * - test-2-2-005-010: SidebarSearch shows clear button when value present
 *
 * Note: Uses source analysis tests for component structure verification.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: SidebarSearch uses shadcn Input with search icon
// (test-2-2-005-009)
// ============================================================

describe("test-2-2-005-009: SidebarSearch uses shadcn Input with search icon", () => {
  test("SidebarSearch component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("SidebarSearch imports shadcn Input component", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/input["']/)
    expect(componentSource).toMatch(/Input/)
  })

  test("SidebarSearch uses Input component", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<Input/)
  })

  test("SidebarSearch imports search icon from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']lucide-react["']/)
    expect(componentSource).toMatch(/Search/)
  })

  test("SidebarSearch renders search icon", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<Search/)
  })

  test("SidebarSearch has placeholder text", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/placeholder=/)
  })
})

// ============================================================
// Test 2: SidebarSearch props interface
// ============================================================

describe("SidebarSearch props interface", () => {
  test("SidebarSearch accepts value prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/value:\s*string/)
  })

  test("SidebarSearch accepts onChange prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onChange/)
  })

  test("SidebarSearch passes value to Input", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Input component should have value prop (multi-line JSX)
    expect(componentSource).toMatch(/<Input/)
    expect(componentSource).toMatch(/value=\{value\}/)
  })

  test("SidebarSearch exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+SidebarSearchProps/)
  })
})

// ============================================================
// Test 3: SidebarSearch shows clear button when value present
// (test-2-2-005-010)
// ============================================================

describe("test-2-2-005-010: SidebarSearch shows clear button when value present", () => {
  test("SidebarSearch imports X icon from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/X/)
  })

  test("SidebarSearch conditionally renders clear button", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check if value exists before showing clear button
    expect(componentSource).toMatch(/value.*&&|value\.length|value\s*\?/)
  })

  test("SidebarSearch clear button has onClick handler", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have onClick to clear the value
    expect(componentSource).toMatch(/onClick/)
  })

  test("SidebarSearch clear calls onChange with empty string", () => {
    const componentPath = path.resolve(import.meta.dir, "../SidebarSearch.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call onChange('') or onChange("") when clearing
    expect(componentSource).toMatch(/onChange\(["']/)
  })
})

// ============================================================
// Test 4: Module exports
// ============================================================

describe("SidebarSearch module exports", () => {
  test("SidebarSearch can be imported", async () => {
    const module = await import("../SidebarSearch")
    expect(module.SidebarSearch).toBeDefined()
    expect(typeof module.SidebarSearch).toBe("function")
  })
})
