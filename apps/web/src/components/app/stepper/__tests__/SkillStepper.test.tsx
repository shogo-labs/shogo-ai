/**
 * SkillStepper Component Tests
 * Task: task-2-3a-007
 *
 * Tests for SkillStepper component that composes PhaseNode + PhaseConnector
 * for all 8 phases in a horizontal stepper layout.
 *
 * Test Specifications:
 * - test-2-3a-007-01 through test-2-3a-007-10
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("SkillStepper", () => {
  const componentPath = path.resolve(import.meta.dir, "../SkillStepper.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // test-2-3a-007-01: Renders 8 PhaseNodes
  describe("test-2-3a-007-01: renders 8 PhaseNodes", () => {
    test("imports and uses PhaseNode component", () => {
      const source = getSource()
      expect(source).toContain("PhaseNode")
      expect(source).toContain("<PhaseNode")
    })

    test("maps over phases array", () => {
      const source = getSource()
      expect(source).toMatch(/phases\.map/)
    })
  })

  // test-2-3a-007-02: Renders 7 PhaseConnectors between nodes
  describe("test-2-3a-007-02: renders 7 PhaseConnectors", () => {
    test("imports and uses PhaseConnector component", () => {
      const source = getSource()
      expect(source).toContain("PhaseConnector")
      expect(source).toContain("<PhaseConnector")
    })

    test("renders connector conditionally (not after last node)", () => {
      const source = getSource()
      // Should check index to skip last connector
      expect(source).toMatch(/index\s*<|index\s*!==|\.length\s*-\s*1/)
    })
  })

  // test-2-3a-007-03: Uses flex layout for horizontal alignment
  describe("test-2-3a-007-03: uses flex layout", () => {
    test("has flex display styling", () => {
      const source = getSource()
      expect(source).toContain("flex")
    })

    test("has items alignment for vertical positioning", () => {
      const source = getSource()
      // Per design-3-1-001, uses items-start for variable-height stacks
      expect(source).toMatch(/items-center|items-start/)
    })
  })

  // test-2-3a-007-04: Passes isSelected to correct PhaseNode
  describe("test-2-3a-007-04: passes isSelected prop", () => {
    test("compares phase name to selectedPhase", () => {
      const source = getSource()
      expect(source).toContain("selectedPhase")
      expect(source).toMatch(/isSelected.*selectedPhase|selectedPhase.*===.*name/)
    })
  })

  // test-2-3a-007-05: Calls onPhaseClick when node clicked
  describe("test-2-3a-007-05: calls onPhaseClick", () => {
    test("passes onClick handler to PhaseNode", () => {
      const source = getSource()
      expect(source).toContain("onPhaseClick")
      expect(source).toMatch(/onClick.*onPhaseClick/)
    })
  })

  // test-2-3a-007-06: Sets PhaseConnector isComplete based on preceding phase
  describe("test-2-3a-007-06: sets connector isComplete", () => {
    test("checks preceding phase status for connector", () => {
      const source = getSource()
      expect(source).toContain("isComplete")
      expect(source).toMatch(/status.*complete|complete.*status/)
    })
  })

  // test-2-3a-007-07: Has responsive horizontal scroll
  describe("test-2-3a-007-07: has responsive scroll", () => {
    test("has overflow-x-auto styling", () => {
      const source = getSource()
      expect(source).toContain("overflow-x-auto")
    })
  })

  // test-2-3a-007-08: Has data-testid attribute
  describe("test-2-3a-007-08: has data-testid", () => {
    test("has data-testid='skill-stepper'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="skill-stepper"')
    })
  })

  // test-2-3a-007-09: Alternates nodes and connectors
  describe("test-2-3a-007-09: alternates nodes and connectors", () => {
    test("renders in correct order", () => {
      const source = getSource()
      // Should use Fragment or array with key to render node + connector pairs
      expect(source).toMatch(/PhaseNode.*PhaseConnector|React\.Fragment/)
    })
  })

  // Component interface tests
  describe("component interface", () => {
    test("accepts phases prop", () => {
      const source = getSource()
      expect(source).toContain("phases")
    })

    test("accepts selectedPhase prop", () => {
      const source = getSource()
      expect(source).toContain("selectedPhase")
    })

    test("accepts onPhaseClick prop", () => {
      const source = getSource()
      expect(source).toContain("onPhaseClick")
    })

    test("exports SkillStepper function", () => {
      const source = getSource()
      expect(source).toMatch(/export function SkillStepper/)
    })

    test("exports SkillStepperProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface SkillStepperProps/)
    })
  })
})
