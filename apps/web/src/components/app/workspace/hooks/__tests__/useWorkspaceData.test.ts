/**
 * Tests for useWorkspaceData Hook - 8 Phase Grouping
 *
 * RED Phase: These tests verify that useWorkspaceData groups features
 * by their actual status (8 phases) instead of consolidated phases (4).
 *
 * Expected to FAIL until Phase 2 GREEN implementation.
 */

import { describe, test, expect } from "bun:test"
import { PHASES } from "../useWorkspaceData"

// ============================================================
// Test 1: PHASES constant includes all 8 statuses
// ============================================================

describe("useWorkspaceData - PHASES constant", () => {
  test("PHASES includes all 8 feature statuses", () => {
    // Given: PHASES is exported from useWorkspaceData
    // Then: Should include all 8 phases matching FeatureSession status values
    expect(PHASES).toEqual([
      "discovery",
      "analysis",
      "classification",
      "design",
      "spec",
      "testing",
      "implementation",
      "complete",
    ])
  })

  test("PHASES has exactly 8 items", () => {
    expect(PHASES).toHaveLength(8)
  })

  test("PHASES does not include consolidated phase names", () => {
    // Should NOT have 'build' or 'deploy' (these were the old consolidated phases)
    expect(PHASES).not.toContain("build")
    expect(PHASES).not.toContain("deploy")
  })
})

// ============================================================
// Test 2: Phase type includes all 8 statuses
// ============================================================

describe("useWorkspaceData - Phase type alignment", () => {
  test("Phase type allows all 8 status values", () => {
    // This test verifies the type exported matches expected phases
    // TypeScript would catch this at compile time, but we verify runtime too
    const allPhases = [
      "discovery",
      "analysis",
      "classification",
      "design",
      "spec",
      "testing",
      "implementation",
      "complete",
    ]

    for (const phase of allPhases) {
      expect(PHASES).toContain(phase)
    }
  })
})
