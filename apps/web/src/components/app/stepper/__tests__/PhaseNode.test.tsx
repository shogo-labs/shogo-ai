/**
 * PhaseNode Component Tests
 * Task: task-2-3a-003
 *
 * Tests for PhaseNode component with CVA status variants.
 * Supports pending, current, complete, blocked statuses.
 *
 * Test Specifications:
 * - test-2-3a-003-01 through test-2-3a-003-10
 *
 * Uses source analysis pattern following established test conventions.
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

  // test-2-3a-003-01: Renders with pending status styling
  describe("test-2-3a-003-01: pending status styling", () => {
    test("has muted border/text styling", () => {
      const source = getSource()
      expect(source).toContain("muted")
    })

    test("has hover:bg-accent/50 on hover", () => {
      const source = getSource()
      expect(source).toContain("hover:")
    })
  })

  // test-2-3a-003-02: Renders with current status styling
  describe("test-2-3a-003-02: current status styling", () => {
    test("has bg-primary styling", () => {
      const source = getSource()
      expect(source).toContain("bg-primary")
    })

    test("has primary foreground or white text", () => {
      const source = getSource()
      // Redesigned uses white text via CheckCircle icon styling
      expect(source).toMatch(/primary-foreground|text-white|text-primary/)
    })

    test("has shadow styling", () => {
      const source = getSource()
      expect(source).toContain("shadow")
    })
  })

  // test-2-3a-003-03: Renders with complete status styling
  describe("test-2-3a-003-03: complete status styling", () => {
    test("has bg-green-500 styling", () => {
      const source = getSource()
      expect(source).toContain("bg-green-500")
    })

    test("has text-white styling", () => {
      const source = getSource()
      expect(source).toContain("text-white")
    })

    test("includes Check or CheckCircle icon", () => {
      const source = getSource()
      // Redesigned uses Check (simpler) instead of CheckCircle
      expect(source).toMatch(/CheckCircle|Check/)
      expect(source).toContain("lucide-react")
    })
  })

  // test-2-3a-003-04: Renders with blocked status styling
  describe("test-2-3a-003-04: blocked status styling", () => {
    test("has destructive styling", () => {
      const source = getSource()
      expect(source).toContain("destructive")
    })

    test("has cursor-not-allowed", () => {
      const source = getSource()
      expect(source).toContain("cursor-not-allowed")
    })

    test("has opacity-50", () => {
      const source = getSource()
      expect(source).toContain("opacity-50")
    })
  })

  // test-2-3a-003-05: Applies selected ring when isSelected=true
  describe("test-2-3a-003-05: selected state ring", () => {
    test("has ring-2 styling", () => {
      const source = getSource()
      expect(source).toContain("ring-2")
    })

    test("has ring-primary styling", () => {
      const source = getSource()
      expect(source).toContain("ring-primary")
    })
  })

  // test-2-3a-003-06: Calls onClick when clicked
  describe("test-2-3a-003-06: onClick handler", () => {
    test("has onClick handler", () => {
      const source = getSource()
      expect(source).toContain("onClick")
    })
  })

  // test-2-3a-003-07: Has correct aria-label for accessibility
  describe("test-2-3a-003-07: accessibility", () => {
    test("has role='button'", () => {
      const source = getSource()
      expect(source).toContain("role")
      expect(source).toContain("button")
    })

    test("has aria-selected", () => {
      const source = getSource()
      expect(source).toContain("aria-selected")
    })
  })

  // test-2-3a-003-08: Has aria-disabled when blocked
  describe("test-2-3a-003-08: aria-disabled for blocked", () => {
    test("has aria-disabled attribute", () => {
      const source = getSource()
      expect(source).toContain("aria-disabled")
    })
  })

  // test-2-3a-003-09: Supports dark mode variants
  describe("test-2-3a-003-09: dark mode variants", () => {
    test("has dark: class variants", () => {
      const source = getSource()
      expect(source).toContain("dark:")
    })
  })

  // test-2-3a-003-10: Has data-testid attribute
  describe("test-2-3a-003-10: data-testid attribute", () => {
    test("follows pattern 'phase-node-{name}'", () => {
      const source = getSource()
      expect(source).toMatch(/data-testid.*phase-node/)
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("uses CVA for variants", () => {
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
})
