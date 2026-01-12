/**
 * PhaseContentPanel ComposablePhaseView Integration Tests
 * Task: task-cpv-013
 *
 * TDD tests verifying PhaseContentPanel uses ComposablePhaseView for discovery phase
 * while maintaining backward compatibility with other phases.
 *
 * Acceptance Criteria:
 * 1. PhaseContentPanel imports ComposablePhaseView
 * 2. Discovery phase case uses `<ComposablePhaseView phaseName='discovery' feature={feature} />`
 * 3. Other phases remain unchanged (analysis, design, spec, etc.)
 * 4. Backward compatible: existing pages still render correctly
 * 5. Discovery phase renders via data-driven composition
 * 6. If Composition 'discovery' not found, fallback renders gracefully
 *
 * Uses source analysis pattern following established test conventions.
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

describe("task-cpv-013: PhaseContentPanel ComposablePhaseView Integration", () => {
  const componentPath = path.resolve(import.meta.dir, "../PhaseContentPanel.tsx")

  // Verify file exists
  test("PhaseContentPanel file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // ============================================================
  // Criterion 1: PhaseContentPanel imports ComposablePhaseView
  // ============================================================
  describe("criterion-1: imports ComposablePhaseView", () => {
    test("imports ComposablePhaseView from rendering/composition", () => {
      const source = getSource()
      expect(source).toMatch(/import.*ComposablePhaseView.*from/)
    })

    test("import path includes composition directory", () => {
      const source = getSource()
      expect(source).toMatch(/from.*['"@\/].*composition.*ComposablePhaseView/)
    })
  })

  // ============================================================
  // Criterion 2: Discovery phase uses ComposablePhaseView
  // ============================================================
  describe("criterion-2: discovery phase uses ComposablePhaseView", () => {
    test("discovery case returns ComposablePhaseView component", () => {
      const source = getSource()
      // The switch case for discovery should render ComposablePhaseView
      expect(source).toMatch(/<ComposablePhaseView/)
    })

    test("passes phaseName='discovery' to ComposablePhaseView", () => {
      const source = getSource()
      // Should pass phaseName with value "discovery"
      expect(source).toMatch(/phaseName=["']discovery["']/)
    })

    test("passes feature prop to ComposablePhaseView", () => {
      const source = getSource()
      // Should pass the feature prop
      expect(source).toMatch(/<ComposablePhaseView[^>]*feature=\{feature\}/)
    })
  })

  // ============================================================
  // Criterion 3: Other phases remain unchanged
  // ============================================================
  describe("criterion-3: other phases remain unchanged", () => {
    test("analysis phase still uses AnalysisView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']analysis["']/)
      expect(source).toMatch(/<AnalysisView.*feature=\{feature\}/)
    })

    test("classification phase still uses ClassificationView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']classification["']/)
      expect(source).toMatch(/<ClassificationView.*feature=\{feature\}/)
    })

    test("design phase still uses DesignView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']design["']/)
      expect(source).toMatch(/<DesignView.*feature=\{feature\}/)
    })

    test("spec phase still uses SpecView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']spec["']/)
      expect(source).toMatch(/<SpecView.*feature=\{feature\}/)
    })

    test("testing phase still uses TestingView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']testing["']/)
      expect(source).toMatch(/<TestingView.*feature=\{feature\}/)
    })

    test("implementation phase still uses ImplementationView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']implementation["']/)
      expect(source).toMatch(/<ImplementationView.*feature=\{feature\}/)
    })

    test("complete phase still uses CompleteView", () => {
      const source = getSource()
      expect(source).toMatch(/case\s+["']complete["']/)
      expect(source).toMatch(/<CompleteView.*feature=\{feature\}/)
    })
  })

  // ============================================================
  // Criterion 4: Backward compatibility preserved
  // ============================================================
  describe("criterion-4: backward compatibility", () => {
    test("still imports original phase view components", () => {
      const source = getSource()
      // All original imports should still be present for other phases
      expect(source).toMatch(/import.*AnalysisView/)
      expect(source).toMatch(/import.*ClassificationView/)
      expect(source).toMatch(/import.*DesignView/)
    })

    test("still uses SkillStepper component", () => {
      const source = getSource()
      expect(source).toMatch(/<SkillStepper/)
    })

    test("still uses usePhaseNavigation hook", () => {
      const source = getSource()
      expect(source).toMatch(/usePhaseNavigation/)
    })

    test("still uses LoadingOverlay", () => {
      const source = getSource()
      expect(source).toMatch(/<LoadingOverlay/)
    })

    test("still handles blocked/pending phases", () => {
      const source = getSource()
      expect(source).toMatch(/BlockedPhaseIndicator/)
    })

    test("default case still uses EmptyPhaseContent", () => {
      const source = getSource()
      expect(source).toMatch(/default:/)
      expect(source).toMatch(/<EmptyPhaseContent/)
    })
  })

  // ============================================================
  // Criterion 5: Discovery rendered via data-driven composition
  // ============================================================
  describe("criterion-5: discovery uses data-driven composition", () => {
    test("discovery case does NOT use hardcoded DiscoveryView", () => {
      const source = getSource()
      // The discovery case should NOT render the old DiscoveryView
      // We need to check the case block specifically
      const discoveryCase = source.match(/case\s+["']discovery["']:\s*\n\s*return\s+[^;]+/s)
      if (discoveryCase) {
        // The return statement in discovery case should NOT contain DiscoveryView
        expect(discoveryCase[0]).not.toMatch(/<DiscoveryView/)
        // But SHOULD contain ComposablePhaseView
        expect(discoveryCase[0]).toMatch(/<ComposablePhaseView/)
      } else {
        // If we can't find the case, fail the test
        expect(true).toBe(false)
      }
    })
  })

  // ============================================================
  // Criterion 6: Fallback handled by ComposablePhaseView
  // ============================================================
  describe("criterion-6: fallback handling", () => {
    test("ComposablePhaseView provides its own fallback when composition not found", () => {
      // This is verified by ComposablePhaseView tests
      // Here we just verify the component is used correctly
      const source = getSource()
      // ComposablePhaseView handles fallback internally
      // We verify the integration point is correct
      expect(source).toMatch(/phaseName=["']discovery["']/)
    })
  })

  // ============================================================
  // Component interface preserved
  // ============================================================
  describe("component interface preserved", () => {
    test("exports PhaseContentPanel function", () => {
      const source = getSource()
      expect(source).toMatch(/export function PhaseContentPanel/)
    })

    test("exports PhaseContentPanelProps interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface PhaseContentPanelProps/)
    })

    test("exports FeatureForPanel interface", () => {
      const source = getSource()
      expect(source).toMatch(/export interface FeatureForPanel/)
    })
  })
})
