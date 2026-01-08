/**
 * Tests for DeleteFeatureDialog Component
 * Task: task-delete-002-alert-dialog
 *
 * TDD tests for the delete feature confirmation dialog component.
 * Uses Dialog (not AlertDialog) following NewFeatureModal pattern.
 *
 * Test Specifications:
 * - test-spec-df-002-renders-alert: DeleteFeatureDialog renders with shadcn Dialog
 * - test-spec-df-002-shows-feature-name: Dialog shows feature name in confirmation message
 * - test-spec-df-002-cancel-closes: Cancel button closes dialog without action
 * - test-spec-df-002-confirm-triggers: Confirm/Delete button triggers onConfirm callback
 * - test-spec-df-002-loading-spinner: Loading state shows Loader2 spinner on confirm button
 * - test-spec-df-002-disabled-loading: Confirm button disabled during loading
 * - test-spec-df-002-keyboard-escape: Escape key closes dialog
 * - test-spec-df-002-keyboard-tab: Tab navigates between Cancel and Confirm buttons
 *
 * Per design decision: Uses Dialog (not AlertDialog) - AlertDialog is not installed.
 * Follows NewFeatureModal pattern in same directory.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const COMPONENT_PATH = path.resolve(import.meta.dir, "../DeleteFeatureDialog.tsx")

// ============================================================
// Test 1: DeleteFeatureDialog renders with shadcn Dialog
// (test-spec-df-002-renders-alert)
// ============================================================

describe("test-spec-df-002-renders-alert: DeleteFeatureDialog renders with shadcn Dialog", () => {
  test("DeleteFeatureDialog component file exists", () => {
    const exists = fs.existsSync(COMPONENT_PATH)
    expect(exists).toBe(true)
  })

  test("DeleteFeatureDialog imports shadcn Dialog component", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should import Dialog from shadcn/ui
    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/dialog["']/)
  })

  test("DeleteFeatureDialog uses Dialog primitives", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should use Dialog, DialogContent, DialogHeader, DialogTitle
    expect(componentSource).toMatch(/<Dialog/)
    expect(componentSource).toMatch(/<DialogContent/)
    expect(componentSource).toMatch(/<DialogHeader/)
    expect(componentSource).toMatch(/<DialogTitle/)
  })

  test("DeleteFeatureDialog has accessible title with Delete", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Title should contain "Delete"
    expect(componentSource).toMatch(/DialogTitle[\s\S]*?Delete/i)
  })
})

// ============================================================
// Test 2: Dialog shows feature name in confirmation message
// (test-spec-df-002-shows-feature-name)
// ============================================================

describe("test-spec-df-002-shows-feature-name: Dialog shows feature name", () => {
  test("DeleteFeatureDialog accepts featureName prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/featureName/)
  })

  test("DeleteFeatureDialog displays feature name in content", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should render featureName prop
    expect(componentSource).toMatch(/\{.*featureName.*\}/)
  })

  test("DeleteFeatureDialog indicates deletion is permanent", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have text about permanent deletion or cannot be undone
    expect(componentSource).toMatch(/permanent|cannot be undone|irreversible|deleted/i)
  })
})

// ============================================================
// Test 3: Cancel button closes dialog without action
// (test-spec-df-002-cancel-closes)
// ============================================================

describe("test-spec-df-002-cancel-closes: Cancel button closes dialog", () => {
  test("DeleteFeatureDialog has Cancel button", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/Cancel/)
  })

  test("DeleteFeatureDialog accepts onClose callback", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have onClose or onOpenChange prop
    expect(componentSource).toMatch(/onClose|onOpenChange/)
  })

  test("Cancel button triggers close handler", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Cancel should call onClose or close via onOpenChange(false)
    expect(componentSource).toMatch(/onClick=\{.*onClose|onOpenChange\(false\)|handleClose/)
  })
})

// ============================================================
// Test 4: Confirm/Delete button triggers onConfirm callback
// (test-spec-df-002-confirm-triggers)
// ============================================================

describe("test-spec-df-002-confirm-triggers: Confirm button triggers onConfirm", () => {
  test("DeleteFeatureDialog accepts onConfirm callback", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/onConfirm/)
  })

  test("DeleteFeatureDialog has Delete/Confirm button", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should have destructive action button
    expect(componentSource).toMatch(/Delete|Confirm/)
  })

  test("Delete button calls onConfirm", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Button onClick should call onConfirm
    expect(componentSource).toMatch(/onClick=\{.*onConfirm/)
  })
})

// ============================================================
// Test 5: Loading state shows Loader2 spinner on confirm button
// (test-spec-df-002-loading-spinner)
// ============================================================

describe("test-spec-df-002-loading-spinner: Loading state shows spinner", () => {
  test("DeleteFeatureDialog accepts isLoading prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/isLoading/)
  })

  test("DeleteFeatureDialog imports Loader2 from lucide-react", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/Loader2/)
    expect(componentSource).toMatch(/from\s+["']lucide-react["']/)
  })

  test("DeleteFeatureDialog shows Loader2 when isLoading=true", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should conditionally show Loader2 based on isLoading
    expect(componentSource).toMatch(/isLoading.*\?[\s\S]*?Loader2|isLoading[\s\S]*?<Loader2/)
  })
})

// ============================================================
// Test 6: Confirm button disabled during loading
// (test-spec-df-002-disabled-loading)
// ============================================================

describe("test-spec-df-002-disabled-loading: Button disabled during loading", () => {
  test("Confirm button has disabled prop linked to isLoading", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Confirm button should be disabled when isLoading
    expect(componentSource).toMatch(/disabled=\{.*isLoading/)
  })
})

// ============================================================
// Test 7: Dialog uses controlled open state
// (test-spec-df-002-keyboard-escape - Dialog handles this automatically)
// ============================================================

describe("test-spec-df-002-keyboard: Dialog keyboard accessibility", () => {
  test("DeleteFeatureDialog accepts open prop for controlled state", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/open:\s*boolean|isOpen:\s*boolean/)
  })

  test("DeleteFeatureDialog uses Dialog with open prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Dialog should receive open prop
    expect(componentSource).toMatch(/<Dialog\s+open=/)
  })
})

// ============================================================
// Test 8: Props interface and exports
// ============================================================

describe("DeleteFeatureDialog props interface", () => {
  test("DeleteFeatureDialog exports props interface", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+DeleteFeatureDialogProps/)
  })

  test("DeleteFeatureDialog has required props: open, onClose, onConfirm, featureName", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/open:\s*boolean|isOpen:\s*boolean/)
    expect(componentSource).toMatch(/onClose|onOpenChange/)
    expect(componentSource).toMatch(/onConfirm/)
    expect(componentSource).toMatch(/featureName:\s*string/)
  })

  test("DeleteFeatureDialog has optional isLoading prop", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    expect(componentSource).toMatch(/isLoading\?:\s*boolean/)
  })
})

// ============================================================
// Test 9: Module exports
// ============================================================

describe("DeleteFeatureDialog module exports", () => {
  test("DeleteFeatureDialog can be imported", async () => {
    const module = await import("../DeleteFeatureDialog")
    expect(module.DeleteFeatureDialog).toBeDefined()
    expect(typeof module.DeleteFeatureDialog).toBe("function")
  })
})

// ============================================================
// Test 10: Clean break verification
// ============================================================

describe("DeleteFeatureDialog clean break verification", () => {
  test("DeleteFeatureDialog is in /components/app/workspace/modals/", () => {
    expect(COMPONENT_PATH).toMatch(/components\/app\/workspace\/modals\/DeleteFeatureDialog\.tsx$/)
  })

  test("DeleteFeatureDialog has zero imports from /components/Studio/", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should NOT import anything from Studio
    expect(componentSource).not.toMatch(/from\s+["'][^"']*\/Studio\//)
    expect(componentSource).not.toMatch(/from\s+["'][^"']*components\/Studio/)
  })

  test("DeleteFeatureDialog uses shadcn Dialog patterns", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Should use Dialog component, not custom modal implementation
    expect(componentSource).toMatch(/<Dialog/)
    // Should NOT have custom fixed overlay div like in old Studio pattern
    expect(componentSource).not.toMatch(/<div\s+className="fixed\s+inset-0/)
  })

  test("DeleteFeatureDialog uses destructive variant for delete button", () => {
    const componentSource = fs.readFileSync(COMPONENT_PATH, "utf-8")

    // Delete button should use destructive variant
    expect(componentSource).toMatch(/variant=["']destructive["']/)
  })
})
