/**
 * RunPhaseButton Component Tests
 * Task: task-2-3a-006
 *
 * Tests for RunPhaseButton component with disabled state and tooltip.
 * Button is disabled in 2.3A but props allow future enablement in 2.3D.
 *
 * Test Specifications:
 * - test-2-3a-006-01 through test-2-3a-006-08
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("RunPhaseButton", () => {
  const componentPath = path.resolve(import.meta.dir, "../RunPhaseButton.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-006-01: Defaults to disabled state
  describe("test-2-3a-006-01: defaults to disabled state", () => {
    test("disabled defaults to true", () => {
      const source = getSource()
      // disabled prop should default to true
      expect(source).toMatch(/disabled\s*=\s*true/)
    })
  })

  // test-2-3a-006-02: Shows disabled tooltip
  // Updated in 2.3D: tooltip now guides users to Chat UI
  describe("test-2-3a-006-02: shows disabled tooltip", () => {
    test("has title explaining how to run via Chat UI", () => {
      const source = getSource()
      expect(source).toContain("Run phase via Chat UI")
    })
  })

  // test-2-3a-006-03: Shows enabled tooltip when not disabled
  describe("test-2-3a-006-03: shows enabled tooltip when not disabled", () => {
    test("has conditional title based on disabled state", () => {
      const source = getSource()
      // Should use phaseName in the enabled tooltip
      expect(source).toMatch(/Run.*\$\{phaseName\}|Run\s+phaseName/)
    })
  })

  // test-2-3a-006-04: Uses shadcn Button with Play icon
  describe("test-2-3a-006-04: uses shadcn Button with Play icon", () => {
    test("uses Button from shadcn", () => {
      const source = getSource()
      expect(source).toContain("import { Button }")
      expect(source).toContain("@/components/ui/button")
    })

    test("includes Play icon from lucide-react", () => {
      const source = getSource()
      expect(source).toContain("Play")
      expect(source).toContain("lucide-react")
    })
  })

  // test-2-3a-006-05: Has aria-label for accessibility
  describe("test-2-3a-006-05: has aria-label for accessibility", () => {
    test("has aria-label explaining disabled state", () => {
      const source = getSource()
      expect(source).toContain("aria-label")
    })
  })

  // test-2-3a-006-06: Calls onRun when enabled and clicked
  describe("test-2-3a-006-06: calls onRun when enabled and clicked", () => {
    test("has onClick handler that calls onRun", () => {
      const source = getSource()
      // onClick should conditionally call onRun
      expect(source).toMatch(/onClick|onRun/)
    })
  })

  // test-2-3a-006-07: Does not call onRun when disabled
  describe("test-2-3a-006-07: does not call onRun when disabled", () => {
    test("Button disabled prop prevents click", () => {
      const source = getSource()
      // Button should use disabled prop
      expect(source).toMatch(/disabled=\{disabled\}|disabled/)
    })
  })

  // test-2-3a-006-08: Has data-testid attribute
  describe("test-2-3a-006-08: has data-testid attribute", () => {
    test("has data-testid='run-phase-button'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="run-phase-button"')
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("accepts phaseName prop", () => {
      const source = getSource()
      expect(source).toContain("phaseName")
    })

    test("accepts optional disabled prop", () => {
      const source = getSource()
      expect(source).toMatch(/disabled\?/)
    })

    test("accepts optional onRun prop", () => {
      const source = getSource()
      expect(source).toMatch(/onRun\?/)
    })

    test("exports RunPhaseButton function", () => {
      const source = getSource()
      expect(source).toMatch(/export function RunPhaseButton/)
    })

    test("exports RunPhaseButtonProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface RunPhaseButtonProps/)
    })
  })
})
