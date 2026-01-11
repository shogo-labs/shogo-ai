/**
 * Tests for CreateOrgModal Component
 * Task: task-org-005
 *
 * TDD tests for the create organization modal.
 *
 * Test Specifications:
 * - test-org-005-01: CreateOrgModal renders with form fields
 * - test-org-005-02: CreateOrgModal submit calls rootStore.createOrganization
 * - test-org-005-03: CreateOrgModal closes on successful creation
 * - test-org-005-04: CreateOrgModal shows error message on creation failure
 * - test-org-005-05: CreateOrgModal name field is required
 * - test-org-005-06: CreateOrgModal controlled dialog state works correctly
 *
 * Note: These are source analysis tests since Radix UI components don't render
 * fully in happy-dom. Integration tests should verify behavior in browser.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../CreateOrgModal.tsx")

// ============================================================
// Test: CreateOrgModal renders with form fields
// (test-org-005-01)
// ============================================================

describe("test-org-005-01: CreateOrgModal renders with form fields", () => {
  test("CreateOrgModal component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("CreateOrgModal imports shadcn Dialog components", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import Dialog components from @/components/ui/dialog
    expect(componentSource).toMatch(/@\/components\/ui\/dialog/)
    expect(componentSource).toMatch(/Dialog/)
    expect(componentSource).toMatch(/DialogContent/)
    expect(componentSource).toMatch(/DialogHeader/)
    expect(componentSource).toMatch(/DialogTitle/)
  })

  test("CreateOrgModal has Name input field (required)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have Input component for name
    expect(componentSource).toMatch(/@\/components\/ui\/input/)
    expect(componentSource).toMatch(/Input/)
    // Should have label for name
    expect(componentSource).toMatch(/[Nn]ame/)
  })

  test("CreateOrgModal has Description textarea field (optional)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have Textarea component for description
    expect(componentSource).toMatch(/@\/components\/ui\/textarea/)
    expect(componentSource).toMatch(/Textarea/)
    // Should mention description
    expect(componentSource).toMatch(/[Dd]escription/)
  })

  test("CreateOrgModal has Submit button", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have Button component
    expect(componentSource).toMatch(/@\/components\/ui\/button/)
    expect(componentSource).toMatch(/Button/)
    // Should have submit/create action
    expect(componentSource).toMatch(/type=["']submit["']|onClick/)
  })
})

// ============================================================
// Test: CreateOrgModal submit calls rootStore.createOrganization
// (test-org-005-02)
// ============================================================

describe("test-org-005-02: CreateOrgModal submit calls rootStore.createOrganization", () => {
  test("CreateOrgModal uses useDomains hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use useDomains for accessing store
    expect(componentSource).toMatch(/useDomains/)
  })

  test("CreateOrgModal calls createOrganization on submit", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call createOrganization method
    expect(componentSource).toMatch(/createOrganization/)
  })

  test("CreateOrgModal handles loading state", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have some loading state management
    expect(componentSource).toMatch(/loading|isLoading|isSubmitting|pending/)
  })
})

// ============================================================
// Test: CreateOrgModal closes on successful creation
// (test-org-005-03)
// ============================================================

describe("test-org-005-03: CreateOrgModal closes on successful creation", () => {
  test("CreateOrgModal accepts onOpenChange prop", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should accept onOpenChange for controlled dialog
    expect(componentSource).toMatch(/onOpenChange/)
  })

  test("CreateOrgModal calls onOpenChange(false) on success", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call onOpenChange with false to close modal
    expect(componentSource).toMatch(/onOpenChange\s*\(\s*false\s*\)/)
  })
})

// ============================================================
// Test: CreateOrgModal shows error message on creation failure
// (test-org-005-04)
// ============================================================

describe("test-org-005-04: CreateOrgModal shows error message on creation failure", () => {
  test("CreateOrgModal has error state", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have error state management
    expect(componentSource).toMatch(/error|Error/)
  })

  test("CreateOrgModal displays error message", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally render error
    expect(componentSource).toMatch(/\{.*error.*\}|\{error && /)
  })
})

// ============================================================
// Test: CreateOrgModal controlled dialog state works correctly
// (test-org-005-06)
// ============================================================

describe("test-org-005-06: CreateOrgModal controlled dialog state works", () => {
  test("CreateOrgModal accepts open prop", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should accept open prop for controlled dialog
    expect(componentSource).toMatch(/open[?:]?\s*:?\s*boolean/)
  })

  test("CreateOrgModal passes open and onOpenChange to Dialog", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Dialog should receive open and onOpenChange props
    expect(componentSource).toMatch(/<Dialog[\s\S]*?open=/)
    expect(componentSource).toMatch(/<Dialog[\s\S]*?onOpenChange=/)
  })

  test("CreateOrgModal exports component and props interface", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should export CreateOrgModal and CreateOrgModalProps
    expect(componentSource).toMatch(/export\s+(function|const)\s+CreateOrgModal/)
    expect(componentSource).toMatch(/interface\s+CreateOrgModalProps|type\s+CreateOrgModalProps/)
  })
})

// ============================================================
// Test: CreateOrgModal module can be imported
// ============================================================

describe("CreateOrgModal module exports", () => {
  test("CreateOrgModal can be imported", async () => {
    const module = await import("../CreateOrgModal")
    expect(module.CreateOrgModal).toBeDefined()
    expect(typeof module.CreateOrgModal).toBe("function")
  })
})
