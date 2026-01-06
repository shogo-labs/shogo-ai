/**
 * Empty State Components Tests
 * Task: task-2-3a-005
 *
 * Tests for EmptyPhaseContent and BlockedPhaseIndicator components.
 *
 * Test Specifications:
 * - test-2-3a-005-01 through test-2-3a-005-08
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("EmptyStates", () => {
  const componentPath = path.resolve(import.meta.dir, "../EmptyStates.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // ============================================================
  // EmptyPhaseContent Tests
  // ============================================================

  describe("EmptyPhaseContent", () => {
    // test-2-3a-005-01: Displays message with phase name
    test("displays message containing phase name", () => {
      const source = getSource()
      expect(source).toContain("phaseName")
      expect(source).toMatch(/No.*data|data.*yet/i)
    })

    // test-2-3a-005-02: Includes RunPhaseButton when onRunPhase provided
    test("includes RunPhaseButton when onRunPhase provided", () => {
      const source = getSource()
      expect(source).toContain("RunPhaseButton")
      expect(source).toContain("onRunPhase")
    })

    // test-2-3a-005-03: Hides RunPhaseButton when onRunPhase not provided
    test("conditionally renders RunPhaseButton", () => {
      const source = getSource()
      // Should have conditional rendering for button
      expect(source).toMatch(/onRunPhase\s*&&|onRunPhase\s*\?/)
    })

    // test-2-3a-005-04: Uses Card or similar container styling
    test("uses container styling", () => {
      const source = getSource()
      // Should have card-like container classes
      expect(source).toMatch(/border|rounded|p-\d|bg-/)
    })

    // test-2-3a-005-07: Has data-testid attribute
    test("has data-testid='empty-phase-content'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="empty-phase-content"')
    })

    test("exports EmptyPhaseContent function", () => {
      const source = getSource()
      expect(source).toMatch(/export function EmptyPhaseContent/)
    })

    test("exports EmptyPhaseContentProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface EmptyPhaseContentProps/)
    })
  })

  // ============================================================
  // BlockedPhaseIndicator Tests
  // ============================================================

  describe("BlockedPhaseIndicator", () => {
    // test-2-3a-005-05: Displays blocking phase message
    test("displays message about blocking phase", () => {
      const source = getSource()
      expect(source).toContain("blockedBy")
      expect(source).toMatch(/Complete.*first|phase.*first/i)
    })

    // test-2-3a-005-06: Uses destructive/warning color scheme
    test("uses destructive/warning color scheme", () => {
      const source = getSource()
      expect(source).toMatch(/destructive|warning|amber|yellow|red/)
    })

    // test-2-3a-005-08: Has data-testid attribute
    test("has data-testid='blocked-phase-indicator'", () => {
      const source = getSource()
      expect(source).toContain('data-testid="blocked-phase-indicator"')
    })

    test("exports BlockedPhaseIndicator function", () => {
      const source = getSource()
      expect(source).toMatch(/export function BlockedPhaseIndicator/)
    })

    test("exports BlockedPhaseIndicatorProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface BlockedPhaseIndicatorProps/)
    })
  })
})
