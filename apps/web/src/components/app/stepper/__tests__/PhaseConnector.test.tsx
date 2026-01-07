/**
 * PhaseConnector Component Tests
 * Task: task-2-3a-004
 *
 * Tests for PhaseConnector component that renders connecting lines
 * between PhaseNodes in the stepper.
 *
 * Test Specifications:
 * - test-2-3a-004-01 through test-2-3a-004-05
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("PhaseConnector", () => {
  const componentPath = path.resolve(import.meta.dir, "../PhaseConnector.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-004-01: Renders horizontal line
  describe("test-2-3a-004-01: renders horizontal line", () => {
    test("has fixed width for consistent layout", () => {
      const source = getSource()
      // Has w-* class for fixed width
      expect(source).toMatch(/w-\d+|w-8/)
    })

    test("has fixed height for consistent layout", () => {
      const source = getSource()
      // Has h-* class for fixed height
      expect(source).toMatch(/h-\d+|h-0\.5/)
    })
  })

  // test-2-3a-004-02: Renders complete state with green line
  describe("test-2-3a-004-02: renders complete state with green line", () => {
    test("has bg-green-500 styling for complete state", () => {
      const source = getSource()
      expect(source).toContain("bg-green-500")
    })
  })

  // test-2-3a-004-03: Renders incomplete state with muted line
  describe("test-2-3a-004-03: renders incomplete state with muted line", () => {
    test("has bg-border styling for incomplete state", () => {
      const source = getSource()
      expect(source).toContain("bg-border")
    })
  })

  // test-2-3a-004-04: Is vertically centered
  describe("test-2-3a-004-04: is vertically centered", () => {
    test("has vertical centering styles", () => {
      const source = getSource()
      // Per design-3-1-001: uses mt-4 (16px) to position at center of 32px circles
      // Or self-center for flex vertical alignment
      expect(source).toMatch(/self-center|mt-4/)
    })
  })

  // test-2-3a-004-05: Has data-testid attribute
  describe("test-2-3a-004-05: has data-testid attribute", () => {
    test("follows pattern 'phase-connector-{index}'", () => {
      const source = getSource()
      expect(source).toMatch(/data-testid=\{`phase-connector-\$\{index\}`\}/)
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("accepts isComplete prop", () => {
      const source = getSource()
      expect(source).toContain("isComplete")
    })

    test("accepts index prop", () => {
      const source = getSource()
      expect(source).toContain("index")
    })

    test("uses cn utility for class merging", () => {
      const source = getSource()
      expect(source).toContain("import { cn }")
    })

    test("exports PhaseConnector function", () => {
      const source = getSource()
      expect(source).toMatch(/export function PhaseConnector/)
    })

    test("exports PhaseConnectorProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface PhaseConnectorProps/)
    })
  })
})
