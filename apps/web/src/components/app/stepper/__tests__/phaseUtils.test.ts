/**
 * Phase Utilities Tests
 * Task: task-2-3a-001
 *
 * Tests for getPhaseStatus function and PHASE_CONFIG constants.
 * Verifies phase status computation based on feature status.
 *
 * Test Specifications:
 * - test-2-3a-001-01 through test-2-3a-001-08
 */

import { describe, test, expect } from "bun:test"
import {
  getPhaseStatus,
  PHASE_CONFIG,
  type PhaseStatus,
} from "../phaseUtils"
import { StatusOrder } from "@shogo/state-api"

describe("phaseUtils", () => {
  describe("getPhaseStatus", () => {
    // test-2-3a-001-01: Returns 'complete' for phases before current
    test("returns 'complete' for phases before current", () => {
      // Given: Feature status is 'design' (index 3)
      // When: getPhaseStatus('design', 'discovery') is called
      const result = getPhaseStatus("design", "discovery")

      // Then: Returns 'complete' (Discovery is at index 0, design is at index 3)
      expect(result).toBe("complete")
    })

    // test-2-3a-001-02: Returns 'current' for phase matching currentStatus
    test("returns 'current' for phase matching currentStatus", () => {
      // Given: Feature status is 'analysis'
      // When: getPhaseStatus('analysis', 'analysis') is called
      const result = getPhaseStatus("analysis", "analysis")

      // Then: Returns 'current' (target phase equals current status)
      expect(result).toBe("current")
    })

    // test-2-3a-001-03: Returns 'pending' for phases after current
    test("returns 'pending' for phases after current", () => {
      // Given: Feature status is 'design' (index 3)
      // When: getPhaseStatus('design', 'implementation') is called
      const result = getPhaseStatus("design", "implementation")

      // Then: Returns 'pending' (Implementation is at index 5, design is at index 3)
      expect(result).toBe("pending")
    })

    // test-2-3a-001-04: Handles first phase (discovery) correctly
    test("handles first phase (discovery) correctly", () => {
      // Given: Feature status is 'discovery'
      // When: getPhaseStatus('discovery', 'discovery') is called
      const result = getPhaseStatus("discovery", "discovery")

      // Then: Returns 'current' (no phases before discovery can be complete)
      expect(result).toBe("current")
    })

    // test-2-3a-001-05: Handles last phase (complete) correctly
    test("handles last phase (complete) correctly", () => {
      // Given: Feature status is 'complete'
      // When: getPhaseStatus('complete', 'discovery') is called
      const result = getPhaseStatus("complete", "discovery")

      // Then: Returns 'complete' (all phases before 'complete' should be complete)
      expect(result).toBe("complete")
    })

    // Additional edge cases
    test("returns 'pending' for all phases after discovery when status is discovery", () => {
      const result = getPhaseStatus("discovery", "analysis")
      expect(result).toBe("pending")
    })

    test("returns 'complete' for phases before spec when status is spec", () => {
      // discovery, analysis, classification, design should all be complete
      expect(getPhaseStatus("spec", "discovery")).toBe("complete")
      expect(getPhaseStatus("spec", "analysis")).toBe("complete")
      expect(getPhaseStatus("spec", "classification")).toBe("complete")
      expect(getPhaseStatus("spec", "design")).toBe("complete")
    })

    test("returns 'current' for spec when status is spec", () => {
      expect(getPhaseStatus("spec", "spec")).toBe("current")
    })

    test("returns 'pending' for phases after spec when status is spec", () => {
      expect(getPhaseStatus("spec", "implementation")).toBe("pending")
      expect(getPhaseStatus("spec", "testing")).toBe("pending")
      expect(getPhaseStatus("spec", "complete")).toBe("pending")
    })
  })

  // test-2-3a-001-06: StatusOrder is imported from @shogo/state-api (not duplicated)
  describe("StatusOrder import", () => {
    test("StatusOrder is imported from @shogo/state-api (not duplicated)", () => {
      // Then: StatusOrder should have 8 phases matching expected order
      expect(StatusOrder).toEqual([
        "discovery",
        "analysis",
        "classification",
        "design",
        "spec",
        "implementation",
        "testing",
        "complete",
      ])
    })
  })

  // test-2-3a-001-07: PHASE_CONFIG exports labels for all 8 phases
  describe("PHASE_CONFIG", () => {
    test("has entries for all 8 phases", () => {
      // Given: PHASE_CONFIG is imported
      // When: PHASE_CONFIG keys are checked
      const phases = [
        "discovery",
        "analysis",
        "classification",
        "design",
        "spec",
        "implementation",
        "testing",
        "complete",
      ]

      // Then: Each phase has label and shortLabel properties
      for (const phase of phases) {
        expect(PHASE_CONFIG[phase]).toBeDefined()
        expect(PHASE_CONFIG[phase].label).toBeDefined()
        expect(PHASE_CONFIG[phase].shortLabel).toBeDefined()
        expect(typeof PHASE_CONFIG[phase].label).toBe("string")
        expect(typeof PHASE_CONFIG[phase].shortLabel).toBe("string")
      }
    })

    test("has correct labels for each phase", () => {
      expect(PHASE_CONFIG.discovery.label).toBe("Discovery")
      expect(PHASE_CONFIG.analysis.label).toBe("Analysis")
      expect(PHASE_CONFIG.classification.label).toBe("Classification")
      expect(PHASE_CONFIG.design.label).toBe("Design")
      expect(PHASE_CONFIG.spec.label).toBe("Spec")
      expect(PHASE_CONFIG.implementation.label).toBe("Implementation")
      expect(PHASE_CONFIG.testing.label).toBe("Testing")
      expect(PHASE_CONFIG.complete.label).toBe("Complete")
    })

    test("has short labels for compact display", () => {
      expect(PHASE_CONFIG.discovery.shortLabel).toBe("Disc")
      expect(PHASE_CONFIG.analysis.shortLabel).toBe("Ana")
      expect(PHASE_CONFIG.classification.shortLabel).toBe("Class")
      expect(PHASE_CONFIG.design.shortLabel).toBe("Des")
      expect(PHASE_CONFIG.spec.shortLabel).toBe("Spec")
      expect(PHASE_CONFIG.implementation.shortLabel).toBe("Impl")
      expect(PHASE_CONFIG.testing.shortLabel).toBe("Test")
      expect(PHASE_CONFIG.complete.shortLabel).toBe("Done")
    })
  })

  // test-2-3a-001-08: PhaseStatus type is exported
  describe("PhaseStatus type", () => {
    test("type accepts valid values", () => {
      // TypeScript compilation succeeds with valid values
      const pending: PhaseStatus = "pending"
      const current: PhaseStatus = "current"
      const complete: PhaseStatus = "complete"
      const blocked: PhaseStatus = "blocked"

      expect(pending).toBe("pending")
      expect(current).toBe("current")
      expect(complete).toBe("complete")
      expect(blocked).toBe("blocked")
    })
  })
})
