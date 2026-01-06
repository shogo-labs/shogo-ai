/**
 * Tests for NewFeatureModal Component
 * Task: task-2-2-006
 *
 * TDD tests for the new feature modal component.
 *
 * Test Specifications:
 * - test-2-2-006-001: NewFeatureModal uses shadcn Dialog component
 * - test-2-2-006-002: NewFeatureModal has form with name and intent fields
 * - test-2-2-006-003: Form validates name is not empty before submit
 * - test-2-2-006-004: Submit calls insertOne with correct entity shape
 * - test-2-2-006-005: Modal closes and selects new feature on success
 * - test-2-2-006-006: Loading state shown during creation
 * - test-2-2-006-007: Error state shown if creation fails
 * - test-2-2-006-008: Clean break verification
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/modals/
 * - Zero imports from /components/Studio/
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const COMPONENT_PATH = path.resolve(import.meta.dir, "../NewFeatureModal.tsx")

// ============================================================
// Test 1: NewFeatureModal uses shadcn Dialog component
// (test-2-2-006-001)
// ============================================================

describe("test-2-2-006-001: NewFeatureModal uses shadcn Dialog component", () => {
  test("NewFeatureModal component file exists", () => {
    const exists = fs.existsSync(COMPONENT_PATH)
    expect(exists).toBe(true)
  })

  test("NewFeatureModal imports shadcn Dialog component", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Dialog from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/dialog["']/)
  })

  test("NewFeatureModal uses Dialog primitives", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should use Dialog, DialogContent, DialogHeader, DialogTitle
    expect(componentSource).toMatch(/<Dialog/)
    expect(componentSource).toMatch(/<DialogContent/)
    expect(componentSource).toMatch(/<DialogHeader/)
    expect(componentSource).toMatch(/<DialogTitle/)
  })
})

// ============================================================
// Test 2: NewFeatureModal has form with name and intent fields
// (test-2-2-006-002)
// ============================================================

describe("test-2-2-006-002: NewFeatureModal has form with name and intent fields", () => {
  test("NewFeatureModal has name field with Input component", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Input from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/input["']/)
    expect(componentSource).toMatch(/<Input/)
  })

  test("NewFeatureModal has intent field with Textarea component", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Textarea from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/textarea["']/)
    expect(componentSource).toMatch(/<Textarea/)
  })

  test("NewFeatureModal has submit button", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Button from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/button["']/)
    expect(componentSource).toMatch(/<Button/)
  })

  test("NewFeatureModal has Label components for form fields", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Label from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/label["']/)
    expect(componentSource).toMatch(/<Label/)
  })

  test("NewFeatureModal has name input with required attribute or validation", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Name field should be required (via attribute or validation)
    expect(componentSource).toMatch(/required|name.*required|isValid|nameError|name\.trim\(\)|name\s*===\s*["']/)
  })
})

// ============================================================
// Test 3: Form validates name is not empty before submit
// (test-2-2-006-003)
// ============================================================

describe("test-2-2-006-003: Form validates name is not empty before submit", () => {
  test("NewFeatureModal has form validation logic", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have validation for empty name
    expect(componentSource).toMatch(/name\.trim\(\)|name\s*===\s*["']|!name|name\.length/)
  })

  test("NewFeatureModal disables submit when name is empty", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Submit button should have disabled condition
    expect(componentSource).toMatch(/disabled=\{.*(!name|!isValid|name\.trim|isSubmitting)/)
  })
})

// ============================================================
// Test 4: Submit calls insertOne with correct entity shape
// (test-2-2-006-004)
// ============================================================

describe("test-2-2-006-004: Submit calls insertOne with correct entity shape", () => {
  test("NewFeatureModal uses useDomains hook", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import and use useDomains
    expect(componentSource).toMatch(/from\s+["']@\/contexts\/DomainProvider["']/)
    expect(componentSource).toMatch(/useDomains\(\)/)
  })

  test("NewFeatureModal accesses platformFeatures domain", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should destructure platformFeatures from useDomains
    expect(componentSource).toMatch(/platformFeatures/)
  })

  test("NewFeatureModal calls insertOne on featureSessionCollection", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should call insertOne
    expect(componentSource).toMatch(/featureSessionCollection\.insertOne/)
  })

  test("NewFeatureModal creates entity with correct shape", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Entity should have: id, name, intent, project, status, createdAt
    expect(componentSource).toMatch(/id:/)
    expect(componentSource).toMatch(/name:/)
    expect(componentSource).toMatch(/intent:/)
    expect(componentSource).toMatch(/project:/)
    expect(componentSource).toMatch(/status:\s*["']discovery["']/)
    expect(componentSource).toMatch(/createdAt:/)
  })
})

// ============================================================
// Test 5: Modal closes and selects new feature on success
// (test-2-2-006-005)
// ============================================================

describe("test-2-2-006-005: Modal closes and selects new feature on success", () => {
  test("NewFeatureModal uses useWorkspaceNavigation hook", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import and use useWorkspaceNavigation
    expect(componentSource).toMatch(/from\s+["']\.\.\/hooks\/useWorkspaceNavigation["']/)
    expect(componentSource).toMatch(/useWorkspaceNavigation\(\)/)
  })

  test("NewFeatureModal calls setFeatureId after creation", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should call setFeatureId with new feature ID
    expect(componentSource).toMatch(/setFeatureId/)
  })

  test("NewFeatureModal calls onOpenChange to close modal", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have onOpenChange prop and call it to close
    expect(componentSource).toMatch(/onOpenChange/)
  })
})

// ============================================================
// Test 6: Loading state shown during creation
// (test-2-2-006-006)
// ============================================================

describe("test-2-2-006-006: Loading state shown during creation", () => {
  test("NewFeatureModal has isSubmitting state", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have loading/submitting state
    expect(componentSource).toMatch(/isSubmitting|isLoading|submitting/)
    expect(componentSource).toMatch(/setIsSubmitting|setIsLoading|setSubmitting/)
  })

  test("NewFeatureModal disables submit button during submission", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Button should be disabled when submitting
    expect(componentSource).toMatch(/disabled=\{.*isSubmitting/)
  })

  test("NewFeatureModal shows loading indicator in button", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should show "Creating..." or spinner when submitting
    expect(componentSource).toMatch(/isSubmitting.*\?.*Creating|Loader|Spinner/)
  })

  test("NewFeatureModal disables form fields during submission", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Input and Textarea should be disabled when submitting
    // Use multiline pattern since JSX spans multiple lines
    expect(componentSource).toMatch(/<Input[\s\S]*?disabled=\{isSubmitting\}/)
    expect(componentSource).toMatch(/<Textarea[\s\S]*?disabled=\{isSubmitting\}/)
  })
})

// ============================================================
// Test 7: Error state shown if creation fails
// (test-2-2-006-007)
// ============================================================

describe("test-2-2-006-007: Error state shown if creation fails", () => {
  test("NewFeatureModal has error state", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have error state
    expect(componentSource).toMatch(/error|Error/)
    expect(componentSource).toMatch(/setError/)
  })

  test("NewFeatureModal displays error message", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should conditionally render error message
    expect(componentSource).toMatch(/\{error\s*&&|\{error\s*\?/)
  })

  test("NewFeatureModal catches errors from insertOne", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have try/catch around insertOne
    expect(componentSource).toMatch(/try\s*\{/)
    expect(componentSource).toMatch(/catch\s*\(/)
  })
})

// ============================================================
// Test 8: Clean break - correct location and no Studio imports
// (test-2-2-006-008)
// ============================================================

describe("test-2-2-006-008: Clean break verification", () => {
  test("NewFeatureModal is in /components/app/workspace/modals/", () => {
    const expectedPath = path.resolve(
      import.meta.dir,
      "../../../app/workspace/modals/NewFeatureModal.tsx"
    )
    // Normalize to check if our path is correct
    expect(COMPONENT_PATH).toMatch(/components\/app\/workspace\/modals\/NewFeatureModal\.tsx$/)
  })

  test("NewFeatureModal has zero imports from /components/Studio/", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should NOT import anything from Studio
    expect(componentSource).not.toMatch(/from\s+["'][^"']*\/Studio\//)
    expect(componentSource).not.toMatch(/from\s+["'][^"']*components\/Studio/)
  })

  test("NewFeatureModal uses shadcn Dialog patterns not custom modal", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should use Dialog component, not custom modal implementation
    expect(componentSource).toMatch(/<Dialog/)
    // Should NOT have custom fixed overlay div like in old Studio pattern
    expect(componentSource).not.toMatch(/<div\s+className="fixed\s+inset-0/)
  })
})

// ============================================================
// Test 9: Props interface
// ============================================================

describe("NewFeatureModal props interface", () => {
  test("NewFeatureModal exports props interface", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+NewFeatureModalProps/)
  })

  test("NewFeatureModal has open prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/open:\s*boolean/)
  })

  test("NewFeatureModal has onOpenChange prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/onOpenChange:\s*\(open:\s*boolean\)\s*=>\s*void/)
  })

  test("NewFeatureModal has projectId prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/projectId:\s*string/)
  })
})

// ============================================================
// Test 10: Module exports
// ============================================================

describe("NewFeatureModal module exports", () => {
  test("NewFeatureModal can be imported", async () => {
    const module = await import("../NewFeatureModal")
    expect(module.NewFeatureModal).toBeDefined()
    expect(typeof module.NewFeatureModal).toBe("function")
  })
})
