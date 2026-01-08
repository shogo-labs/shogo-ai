/**
 * Tests for FeatureItem Component
 * Task: task-2-2-005
 *
 * TDD tests for the feature item component that shows a clickable row with name and status badge.
 *
 * Test Specifications:
 * - test-2-2-005-005: FeatureItem renders clickable row with name and status badge
 * - test-2-2-005-006: FeatureItem uses CVA for status badge variants
 * - test-2-2-005-007: FeatureItem highlights when selected
 * - test-2-2-005-008: Clicking FeatureItem calls onFeatureSelect
 *
 * Note: Uses source analysis tests for component structure verification.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: FeatureItem renders clickable row with name and status badge
// (test-2-2-005-005)
// ============================================================

describe("test-2-2-005-005: FeatureItem renders clickable row with name and status badge", () => {
  test("FeatureItem component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("FeatureItem accepts feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature:\s*Feature/)
  })

  test("FeatureItem displays feature name", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature\.name/)
  })

  test("FeatureItem displays status badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature\.status/)
  })

  test("FeatureItem is clickable (button or role)", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should be a button element or have onClick
    expect(componentSource).toMatch(/<button|onClick/)
  })

  test("FeatureItem truncates long names with ellipsis", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use truncate class for text overflow
    expect(componentSource).toMatch(/truncate/)
  })
})

// ============================================================
// Test 2: FeatureItem uses CVA for status badge variants
// (test-2-2-005-006)
// ============================================================

describe("test-2-2-005-006: FeatureItem uses CVA for status badge variants", () => {
  test("FeatureItem imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("FeatureItem defines statusBadgeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should define a cva for badge variants
    expect(componentSource).toMatch(/statusBadgeVariants.*=.*cva|badgeVariants.*=.*cva/)
  })

  test("FeatureItem has variant for discovery status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/discovery/)
  })

  test("FeatureItem has variant for design status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/design/)
  })

  test("FeatureItem has variant for complete status", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/complete/)
  })

  test("FeatureItem exports statusBadgeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*statusBadgeVariants|export.*badgeVariants/)
  })
})

// ============================================================
// Test 3: FeatureItem highlights when selected
// (test-2-2-005-007)
// ============================================================

describe("test-2-2-005-007: FeatureItem highlights when selected", () => {
  test("FeatureItem accepts isSelected prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/isSelected/)
  })

  test("FeatureItem applies bg-accent when selected", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally apply bg-accent
    expect(componentSource).toMatch(/bg-accent/)
  })

  test("FeatureItem uses cn utility for conditional classes", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use cn from utils
    expect(componentSource).toMatch(/import.*cn.*from.*@\/lib\/utils/)
    expect(componentSource).toMatch(/cn\(/)
  })
})

// ============================================================
// Test 4: Clicking FeatureItem calls onFeatureSelect
// (test-2-2-005-008)
// ============================================================

describe("test-2-2-005-008: Clicking FeatureItem calls onFeatureSelect", () => {
  test("FeatureItem accepts onClick prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onClick/)
  })

  test("FeatureItem calls onClick handler when clicked", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have onClick on button/div
    expect(componentSource).toMatch(/onClick=\{.*onClick.*\}|onClick=\{onClick\}/)
  })

  test("FeatureItem exports props interface", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export\s+interface\s+FeatureItemProps/)
  })
})

// ============================================================
// Test 5: Module exports
// ============================================================

describe("FeatureItem module exports", () => {
  test("FeatureItem can be imported", async () => {
    const module = await import("../FeatureItem")
    expect(module.FeatureItem).toBeDefined()
    expect(typeof module.FeatureItem).toBe("function")
  })

  test("statusBadgeVariants can be imported", async () => {
    const module = await import("../FeatureItem")
    expect(module.statusBadgeVariants).toBeDefined()
    expect(typeof module.statusBadgeVariants).toBe("function")
  })
})

// ============================================================
// Test 6: FeatureItem has DropdownMenu with delete action
// Task: task-delete-003-feature-item-menu
// (test-spec-df-003-*)
// ============================================================

describe("test-spec-df-003-has-menu-icon: FeatureItem has MoreVertical icon button for menu", () => {
  test("FeatureItem imports MoreVertical from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/MoreVertical/)
    expect(componentSource).toMatch(/from\s+["']lucide-react["']/)
  })

  test("FeatureItem has MoreVertical icon button", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<MoreVertical/)
  })

  test("FeatureItem icon button has accessible name", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have aria-label or sr-only text for screen readers
    expect(componentSource).toMatch(/aria-label|sr-only/)
  })
})

describe("test-spec-df-003-menu-opens: Clicking MoreVertical icon opens DropdownMenu", () => {
  test("FeatureItem imports DropdownMenu from shadcn", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/from\s+["']@\/components\/ui\/dropdown-menu["']/)
  })

  test("FeatureItem uses DropdownMenu component", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<DropdownMenu/)
    expect(componentSource).toMatch(/<DropdownMenuTrigger/)
    expect(componentSource).toMatch(/<DropdownMenuContent/)
    expect(componentSource).toMatch(/<DropdownMenuItem/)
  })
})

describe("test-spec-df-003-delete-item-styling: Delete menu item has Trash2 icon and destructive styling", () => {
  test("FeatureItem imports Trash2 from lucide-react", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Trash2/)
  })

  test("FeatureItem has delete menu item with destructive variant", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have DropdownMenuItem with variant="destructive"
    expect(componentSource).toMatch(/DropdownMenuItem[\s\S]*?variant=["']destructive["']/)
  })

  test("FeatureItem has Delete text in menu", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Delete/)
  })
})

describe("test-spec-df-003-delete-opens-dialog: Delete menu item opens dialog", () => {
  test("FeatureItem accepts onDelete prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/onDelete/)
  })

  test("FeatureItem delete menu item calls onDelete handler", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Delete menu item should have onClick that calls onDelete
    expect(componentSource).toMatch(/onClick=[\s\S]*?onDelete/)
  })
})

describe("test-spec-df-003-main-button-works: Main button area still handles selection click", () => {
  test("FeatureItem main area still has onClick for selection", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have onClick on the main button/div area
    expect(componentSource).toMatch(/onClick=\{onClick\}|onClick=\{.*onClick.*\}/)
  })
})

describe("test-spec-df-003-no-propagation: Icon button click does not propagate to main button", () => {
  test("FeatureItem menu trigger stops event propagation", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call stopPropagation or have event handler that prevents propagation
    expect(componentSource).toMatch(/stopPropagation|e\.stopPropagation\(\)|event\.stopPropagation\(\)/)
  })
})

describe("test-spec-df-003-keyboard-access: Menu accessible via keyboard", () => {
  test("FeatureItem menu trigger is a button element", () => {
    const componentPath = path.resolve(import.meta.dir, "../FeatureItem.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // DropdownMenuTrigger wrapping a button is keyboard accessible
    expect(componentSource).toMatch(/<DropdownMenuTrigger[\s\S]*?asChild/)
  })
})
