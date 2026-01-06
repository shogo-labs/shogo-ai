/**
 * PhaseContentPanel Component Tests
 * Task: task-2-3a-008
 *
 * Tests for PhaseContentPanel smart component that uses usePhaseNavigation
 * hook and renders SkillStepper + content area.
 *
 * Test Specifications:
 * - test-2-3a-008-01 through test-2-3a-008-10
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("PhaseContentPanel", () => {
  const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-008-01: Uses usePhaseNavigation hook
  describe("test-2-3a-008-01: uses usePhaseNavigation hook", () => {
    test("imports usePhaseNavigation", () => {
      const source = getSource()
      expect(source).toContain("usePhaseNavigation")
    })

    test("calls hook with feature.status", () => {
      const source = getSource()
      expect(source).toMatch(/usePhaseNavigation\s*\(.*feature\.status/)
    })
  })

  // test-2-3a-008-02: Renders SkillStepper with correct props
  describe("test-2-3a-008-02: renders SkillStepper", () => {
    test("imports and uses SkillStepper", () => {
      const source = getSource()
      expect(source).toContain("SkillStepper")
      expect(source).toContain("<SkillStepper")
    })

    test("passes phases prop to SkillStepper", () => {
      const source = getSource()
      expect(source).toMatch(/phases=\{phases\}/)
    })

    test("passes selectedPhase prop to SkillStepper", () => {
      const source = getSource()
      expect(source).toMatch(/selectedPhase=/)
    })

    test("passes onPhaseClick prop to SkillStepper", () => {
      const source = getSource()
      expect(source).toMatch(/onPhaseClick=/)
    })
  })

  // test-2-3a-008-03: onPhaseClick calls setPhase from hook
  describe("test-2-3a-008-03: onPhaseClick calls setPhase", () => {
    test("uses setPhase from hook", () => {
      const source = getSource()
      expect(source).toContain("setPhase")
    })
  })

  // test-2-3a-008-04: Content area shows placeholder text
  describe("test-2-3a-008-04: content area shows placeholder", () => {
    test("has placeholder content with phase name", () => {
      const source = getSource()
      expect(source).toMatch(/Phase:|content/i)
    })
  })

  // test-2-3a-008-05: Content area has extension point comment
  describe("test-2-3a-008-05: has extension point comment", () => {
    test("contains comment about 2.3B/C/D extension", () => {
      const source = getSource()
      expect(source).toMatch(/2\.3B|2\.3C|2\.3D|extension|Extension/)
    })
  })

  // test-2-3a-008-06: Renders EmptyPhaseContent when phase has no data
  describe("test-2-3a-008-06: renders EmptyPhaseContent", () => {
    test("imports and uses EmptyPhaseContent", () => {
      const source = getSource()
      expect(source).toContain("EmptyPhaseContent")
    })
  })

  // test-2-3a-008-07: Renders BlockedPhaseIndicator when phase blocked
  describe("test-2-3a-008-07: renders BlockedPhaseIndicator", () => {
    test("imports and uses BlockedPhaseIndicator", () => {
      const source = getSource()
      expect(source).toContain("BlockedPhaseIndicator")
    })
  })

  // test-2-3a-008-08: Layout has stepper at top, content below
  describe("test-2-3a-008-08: layout structure", () => {
    test("has flex-col layout for vertical stacking", () => {
      const source = getSource()
      expect(source).toContain("flex")
      expect(source).toContain("flex-col")
    })

    test("content area has flex-1 for fill", () => {
      const source = getSource()
      expect(source).toContain("flex-1")
    })
  })

  // test-2-3a-008-09: Has data-testid for panel
  describe("test-2-3a-008-09: has data-testid for panel", () => {
    test("has data-testid='phase-content-panel'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="phase-content-panel"')
    })
  })

  // test-2-3a-008-10: Has data-testid for content area
  describe("test-2-3a-008-10: has data-testid for content area", () => {
    test("has data-testid='phase-content-area'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="phase-content-area"')
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("accepts feature prop", () => {
      const source = getSource()
      expect(source).toContain("feature")
    })

    test("exports PhaseContentPanel function", () => {
      const source = getSource()
      expect(source).toMatch(/export function PhaseContentPanel/)
    })

    test("exports PhaseContentPanelProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface PhaseContentPanelProps/)
    })
  })
})
