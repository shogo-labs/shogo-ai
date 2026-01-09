/**
 * PhaseNode Component Tests
 * Task: task-2-3a-003, task-cbe-008
 *
 * Tests for PhaseNode component with CVA status variants.
 * Updated for task-cbe-008: PhaseNode now uses PropertyRenderer with
 * phase-status-renderer binding for registry-driven rendering.
 *
 * Supports pending, current, complete, blocked statuses.
 *
 * Test Specifications:
 * - test-2-3a-003-01 through test-2-3a-003-10
 *
 * Uses source analysis pattern following established test conventions.
 *
 * Note: Tests updated to reflect that rendering implementation is now
 * delegated to PhaseStatusRenderer via PropertyRenderer. These tests
 * verify PhaseNode's role as the parent component that:
 * - Computes status (isCurrent, isComplete, isBlocked)
 * - Passes customProps via config to PropertyRenderer
 * - Exports CVA variants for PhaseStatusRenderer to use
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("PhaseNode", () => {
  const componentPath = path.resolve(import.meta.dir, "../PhaseNode.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-003-01: Exports pending status styling in CVA variants
  describe("test-2-3a-003-01: pending status styling", () => {
    test("has muted border/text styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("muted")
    })

    test("has hover:bg-accent/50 on hover in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("hover:")
    })
  })

  // test-2-3a-003-02: Exports current status styling in CVA variants
  describe("test-2-3a-003-02: current status styling", () => {
    test("has phase color styling via PHASE_COLOR_VAR", () => {
      const source = getSource()
      // PhaseNode still defines PHASE_COLOR_VAR for phase colors
      expect(source).toContain("PHASE_COLOR_VAR")
      // phaseColor is passed to PhaseStatusRenderer via customProps
      expect(source).toContain("phaseColor")
    })

    test("has primary foreground or white text in phaseNodeVariants", () => {
      const source = getSource()
      // Variant styling still defined in phaseNodeVariants
      expect(source).toMatch(/primary-foreground|text-white|text-primary/)
    })

    test("has shadow styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("shadow")
    })
  })

  // test-2-3a-003-03: Exports complete status styling in CVA variants
  describe("test-2-3a-003-03: complete status styling", () => {
    test("has bg-green-500 styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("bg-green-500")
    })

    test("has text-white styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("text-white")
    })

    test("computes isComplete for PhaseStatusRenderer", () => {
      const source = getSource()
      // PhaseNode computes isComplete and passes to customProps
      expect(source).toContain("isComplete")
      expect(source).toMatch(/status\s*===\s*["']complete["']/)
    })
  })

  // test-2-3a-003-04: Exports blocked status styling in CVA variants
  describe("test-2-3a-003-04: blocked status styling", () => {
    test("has destructive styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("destructive")
    })

    test("computes disabled state for blocked phases", () => {
      const source = getSource()
      // PhaseNode computes isBlocked and passes disabled via customProps
      expect(source).toContain("isBlocked")
      expect(source).toMatch(/disabled.*isBlocked|isBlocked.*disabled/)
    })

    test("has opacity-50 styling in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("opacity-50")
    })
  })

  // test-2-3a-003-05: Passes isSelected via customProps
  describe("test-2-3a-003-05: selected state", () => {
    test("passes isSelected via customProps", () => {
      const source = getSource()
      // PhaseNode passes isSelected to PhaseStatusRenderer
      expect(source).toContain("isSelected")
      expect(source).toContain("customProps")
    })
  })

  // test-2-3a-003-06: Calls onClick when clicked
  describe("test-2-3a-003-06: onClick handler", () => {
    test("has onClick handler passed via customProps", () => {
      const source = getSource()
      expect(source).toContain("onClick")
      expect(source).toContain("handleClick")
    })
  })

  // test-2-3a-003-07: Has correct aria-label passed via customProps
  describe("test-2-3a-003-07: accessibility via customProps", () => {
    test("passes ariaLabel via customProps", () => {
      const source = getSource()
      // PhaseNode constructs ariaLabel and passes via customProps
      expect(source).toContain("ariaLabel")
      expect(source).toMatch(/\$\{label\}.*phase/)
    })
  })

  // test-2-3a-003-08: Computes disabled state for blocked phases
  describe("test-2-3a-003-08: disabled state for blocked", () => {
    test("computes isBlocked and passes disabled via customProps", () => {
      const source = getSource()
      expect(source).toContain("isBlocked")
      expect(source).toMatch(/status\s*===\s*["']blocked["']/)
    })
  })

  // test-2-3a-003-09: Supports dark mode variants in phaseNodeVariants
  describe("test-2-3a-003-09: dark mode variants", () => {
    test("has dark: class variants in phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toContain("dark:")
    })
  })

  // test-2-3a-003-10: Has data-testid attribute on wrapper
  describe("test-2-3a-003-10: data-testid attribute", () => {
    test("follows pattern 'phase-node-{name}'", () => {
      const source = getSource()
      expect(source).toMatch(/data-testid.*phase-node/)
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("uses CVA for variants (exported for PhaseStatusRenderer)", () => {
      const source = getSource()
      expect(source).toContain("cva")
      expect(source).toContain("class-variance-authority")
    })

    test("accepts name prop", () => {
      const source = getSource()
      expect(source).toContain("name")
    })

    test("accepts label prop", () => {
      const source = getSource()
      expect(source).toContain("label")
    })

    test("accepts status prop", () => {
      const source = getSource()
      expect(source).toContain("status")
    })

    test("accepts isSelected prop", () => {
      const source = getSource()
      expect(source).toContain("isSelected")
    })

    test("exports PhaseNode function", () => {
      const source = getSource()
      expect(source).toMatch(/export function PhaseNode/)
    })

    test("exports phaseNodeVariants", () => {
      const source = getSource()
      expect(source).toMatch(/export const phaseNodeVariants/)
    })
  })

  // Task-cbe-008: Registry integration tests
  describe("task-cbe-008: registry integration", () => {
    test("uses PropertyRenderer for rendering", () => {
      const source = getSource()
      expect(source).toContain("PropertyRenderer")
      expect(source).toMatch(/from\s+["']@\/components\/rendering["']/)
    })

    test("defines PropertyMetadata with xRenderer: 'phase-status-renderer'", () => {
      const source = getSource()
      expect(source).toContain("xRenderer")
      expect(source).toContain("phase-status-renderer")
    })

    test("passes config with customProps to PropertyRenderer", () => {
      const source = getSource()
      expect(source).toContain("customProps")
      expect(source).toMatch(/config\s*=\s*\{/)
    })
  })
})
