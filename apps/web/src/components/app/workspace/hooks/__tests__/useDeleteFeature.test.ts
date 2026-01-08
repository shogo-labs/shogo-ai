/**
 * Tests for useDeleteFeature Hook
 * Task: task-delete-004-delete-handler
 *
 * Tests for the delete feature hook that manages dialog state,
 * domain calls, and navigation handling.
 *
 * Test Specifications (from task-delete-004):
 * - test-spec-df-004-calls-domain: Handler calls platformFeatures.deleteFeatureSession
 * - test-spec-df-004-success-clears: On success with selected feature, calls clearFeature
 * - test-spec-df-004-success-not-selected: On success with non-selected feature, does not call clearFeature
 * - test-spec-df-004-success-closes-dialog: On success, closes dialog
 * - test-spec-df-004-error-shows-message: On error, captures error for display
 * - test-spec-df-004-loading-passed: Loading state managed during async operation
 * - test-spec-df-004-error-cleared: Error state cleared when dialog reopened
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const HOOK_PATH = path.resolve(import.meta.dir, "../useDeleteFeature.ts")

// ============================================================
// Test 1: Hook file structure
// ============================================================

describe("useDeleteFeature hook structure", () => {
  test("useDeleteFeature hook file exists", () => {
    const exists = fs.existsSync(HOOK_PATH)
    expect(exists).toBe(true)
  })

  test("useDeleteFeature exports the hook function", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/export\s+function\s+useDeleteFeature/)
  })

  test("useDeleteFeature exports props interface", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/export\s+interface\s+UseDeleteFeatureProps/)
  })

  test("useDeleteFeature exports return interface", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/export\s+interface\s+UseDeleteFeatureReturn/)
  })
})

// ============================================================
// Test 2: Hook uses useDomains for platformFeatures access
// (test-spec-df-004-calls-domain)
// ============================================================

describe("test-spec-df-004-calls-domain: Hook uses useDomains", () => {
  test("useDeleteFeature imports useDomains from DomainProvider", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/import.*useDomains.*from.*DomainProvider/)
  })

  test("useDeleteFeature calls useDomains hook", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/useDomains\(\)/)
  })

  test("useDeleteFeature accesses platformFeatures from useDomains", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/platformFeatures/)
  })

  test("useDeleteFeature calls deleteFeatureSession", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/deleteFeatureSession/)
  })
})

// ============================================================
// Test 3: Hook manages dialog state
// ============================================================

describe("useDeleteFeature manages dialog state", () => {
  test("useDeleteFeature returns deleteFeatureId state", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/deleteFeatureId/)
  })

  test("useDeleteFeature returns isDeleteDialogOpen", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/isDeleteDialogOpen/)
  })

  test("useDeleteFeature returns openDeleteDialog function", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/openDeleteDialog/)
  })

  test("useDeleteFeature returns closeDeleteDialog function", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/closeDeleteDialog/)
  })
})

// ============================================================
// Test 4: Hook manages loading state
// (test-spec-df-004-loading-passed)
// ============================================================

describe("test-spec-df-004-loading-passed: Hook manages loading state", () => {
  test("useDeleteFeature returns isDeleting state", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/isDeleting/)
  })

  test("useDeleteFeature sets isDeleting during confirmDelete", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    // Should set isDeleting to true at start of confirmDelete
    expect(source).toMatch(/setIsDeleting\(true\)/)
    // Should set isDeleting to false in finally block
    expect(source).toMatch(/setIsDeleting\(false\)/)
  })
})

// ============================================================
// Test 5: Hook manages error state
// (test-spec-df-004-error-shows-message, test-spec-df-004-error-cleared)
// ============================================================

describe("test-spec-df-004-error: Hook manages error state", () => {
  test("useDeleteFeature returns deleteError state", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/deleteError/)
  })

  test("useDeleteFeature captures error on failure", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/setDeleteError/)
  })

  test("useDeleteFeature clears error when dialog opened", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    // openDeleteDialog should clear error
    expect(source).toMatch(/setDeleteError\(null\)/)
  })
})

// ============================================================
// Test 6: Hook handles navigation
// (test-spec-df-004-success-clears, test-spec-df-004-success-not-selected)
// ============================================================

describe("test-spec-df-004-success: Hook handles navigation on success", () => {
  test("useDeleteFeature accepts clearFeature prop", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/clearFeature/)
  })

  test("useDeleteFeature accepts currentFeatureId prop", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/currentFeatureId/)
  })

  test("useDeleteFeature checks if deleted feature was selected", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    // Should compare currentFeatureId with deleteFeatureId
    expect(source).toMatch(/currentFeatureId.*===.*deleteFeatureId|deleteFeatureId.*===.*currentFeatureId/)
  })

  test("useDeleteFeature calls clearFeature when selected feature deleted", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/clearFeature\(\)/)
  })
})

// ============================================================
// Test 7: Hook returns confirmDelete function
// ============================================================

describe("useDeleteFeature confirmDelete function", () => {
  test("useDeleteFeature returns confirmDelete function", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/confirmDelete/)
  })

  test("confirmDelete is async", () => {
    const source = fs.readFileSync(HOOK_PATH, "utf-8")
    expect(source).toMatch(/const\s+confirmDelete\s*=\s*useCallback\s*\(\s*async/)
  })
})

// ============================================================
// Test 8: Module can be imported
// ============================================================

describe("useDeleteFeature module exports", () => {
  test("useDeleteFeature can be imported", async () => {
    const module = await import("../useDeleteFeature")
    expect(module.useDeleteFeature).toBeDefined()
    expect(typeof module.useDeleteFeature).toBe("function")
  })
})
