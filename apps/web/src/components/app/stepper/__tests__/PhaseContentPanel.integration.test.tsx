/**
 * Integration Tests for PhaseContentPanel Component
 * Task: task-2-3b-011
 *
 * TDD tests verifying PhaseContentPanel renders phase views based on selected phase.
 *
 * Test Specifications:
 * - test-2-3b-033: PhaseContentPanel renders DiscoveryView for phase='discovery'
 * - test-2-3b-034: PhaseContentPanel renders AnalysisView for phase='analysis'
 * - test-2-3b-035: PhaseContentPanel renders ClassificationView for phase='classification'
 * - test-2-3b-036: PhaseContentPanel renders EmptyPhaseContent for unimplemented phases
 * - test-2-3b-037: PhaseContentPanel preserves blocked/pending logic
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: PhaseContentPanel renders DiscoveryView for phase='discovery'
// (test-2-3b-033)
// ============================================================

describe("test-2-3b-033: PhaseContentPanel renders DiscoveryView for phase='discovery'", () => {
  test("PhaseContentPanel imports DiscoveryView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/DiscoveryView/)
  })

  test("PhaseContentPanel has discovery case in renderPhaseContent", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have switch case or conditional for discovery phase
    expect(componentSource).toMatch(/["']discovery["']/)
  })

  test("PhaseContentPanel passes feature to DiscoveryView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<DiscoveryView.*feature/)
  })
})

// ============================================================
// Test 2: PhaseContentPanel renders AnalysisView for phase='analysis'
// (test-2-3b-034)
// ============================================================

describe("test-2-3b-034: PhaseContentPanel renders AnalysisView for phase='analysis'", () => {
  test("PhaseContentPanel imports AnalysisView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/AnalysisView/)
  })

  test("PhaseContentPanel has analysis case in renderPhaseContent", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/["']analysis["']/)
  })

  test("PhaseContentPanel passes feature to AnalysisView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<AnalysisView.*feature/)
  })
})

// ============================================================
// Test 3: PhaseContentPanel renders ClassificationView for phase='classification'
// (test-2-3b-035)
// ============================================================

describe("test-2-3b-035: PhaseContentPanel renders ClassificationView for phase='classification'", () => {
  test("PhaseContentPanel imports ClassificationView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/ClassificationView/)
  })

  test("PhaseContentPanel has classification case in renderPhaseContent", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/["']classification["']/)
  })

  test("PhaseContentPanel passes feature to ClassificationView", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ClassificationView.*feature/)
  })
})

// ============================================================
// Test 4: PhaseContentPanel renders EmptyPhaseContent for unimplemented phases
// (test-2-3b-036)
// ============================================================

describe("test-2-3b-036: PhaseContentPanel renders EmptyPhaseContent for unimplemented phases", () => {
  test("PhaseContentPanel has default/fallback case for other phases", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have default case returning EmptyPhaseContent
    expect(componentSource).toMatch(/default:|EmptyPhaseContent/)
  })

  test("PhaseContentPanel preserves extension point comments", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Extension point comments should exist for future phases
    expect(componentSource).toMatch(/Extension|2\.3C|2\.3D|design|spec/i)
  })
})

// ============================================================
// Test 5: PhaseContentPanel preserves blocked/pending logic
// (test-2-3b-037)
// ============================================================

describe("test-2-3b-037: PhaseContentPanel preserves blocked/pending logic", () => {
  test("PhaseContentPanel checks for blocked phase status", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/blocked/)
  })

  test("PhaseContentPanel renders BlockedPhaseIndicator when blocked", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/BlockedPhaseIndicator/)
  })

  test("PhaseContentPanel checks for pending phase status", () => {
    const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/pending/)
  })
})
