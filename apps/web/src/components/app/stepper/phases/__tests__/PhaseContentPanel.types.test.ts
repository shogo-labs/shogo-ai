/**
 * FeatureForPanel Type Tests
 * Task: task-2-3c-002
 *
 * Verifies that FeatureForPanel interface includes schemaName field
 * and is backward compatible with existing phase views.
 */

import { describe, test, expect } from "bun:test"
import type { FeatureForPanel } from "../../PhaseContentPanel"

describe("FeatureForPanel type extension (task-2-3c-002)", () => {
  test("schemaName?: string field exists on interface", () => {
    // Create a feature with schemaName - should compile
    const featureWithSchema: FeatureForPanel = {
      id: "test-id",
      name: "Test Feature",
      status: "design",
      schemaName: "test-schema",
    }
    expect(featureWithSchema.schemaName).toBe("test-schema")
  })

  test("field is optional (not required)", () => {
    // Create a feature WITHOUT schemaName - should compile
    const featureWithoutSchema: FeatureForPanel = {
      id: "test-id",
      name: "Test Feature",
      status: "design",
    }
    expect(featureWithoutSchema.schemaName).toBeUndefined()
  })

  describe("backward compatibility with existing phase views", () => {
    test("existing features without schemaName still valid", () => {
      // Feature used in 2.3B DiscoveryView
      const discoveryFeature: FeatureForPanel = {
        id: "session-001",
        name: "Test Feature",
        status: "discovery",
        intent: "Build a test feature",
        initialAssessment: {
          likelyArchetype: "domain",
          indicators: ["Pure local data"],
          uncertainties: ["Schema design"],
        },
      }
      expect(discoveryFeature.schemaName).toBeUndefined()
      expect(discoveryFeature.intent).toBe("Build a test feature")
    })

    test("existing features with applicablePatterns still valid", () => {
      // Feature used in 2.3B ClassificationView
      const classificationFeature: FeatureForPanel = {
        id: "session-002",
        name: "Another Feature",
        status: "classification",
        applicablePatterns: ["enhancement-hooks", "service-interface"],
      }
      expect(classificationFeature.applicablePatterns).toHaveLength(2)
      expect(classificationFeature.schemaName).toBeUndefined()
    })

    test("full feature with all fields compiles", () => {
      // Full feature with all 2.3B and 2.3C properties
      const fullFeature: FeatureForPanel = {
        id: "session-003",
        name: "Full Feature",
        status: "design",
        intent: "Complete implementation",
        initialAssessment: {
          likelyArchetype: "hybrid",
          indicators: ["External API calls"],
          uncertainties: [],
        },
        applicablePatterns: ["provider-sync"],
        schemaName: "my-schema",
      }
      expect(fullFeature.schemaName).toBe("my-schema")
      expect(fullFeature.applicablePatterns).toContain("provider-sync")
    })
  })
})
