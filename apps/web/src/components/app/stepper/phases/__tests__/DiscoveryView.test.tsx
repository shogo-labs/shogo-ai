/**
 * Tests for DiscoveryView Component
 * Task: task-2-3b-007
 *
 * TDD tests for the discovery phase view component.
 *
 * Test Specifications:
 * - test-2-3b-017: DiscoveryView renders feature intent as primary content
 * - test-2-3b-018: DiscoveryView displays initialAssessment section conditionally
 * - test-2-3b-019: DiscoveryView renders requirements grouped by priority
 * - test-2-3b-020: DiscoveryView handles empty requirements state
 * - test-2-3b-021: DiscoveryView hides initialAssessment when not present
 * - test-2-3b-041: DiscoveryView is wrapped with observer() for MobX reactivity
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: DiscoveryView renders feature intent as primary content
// (test-2-3b-017)
// ============================================================

describe("test-2-3b-017: DiscoveryView renders feature intent as primary content", () => {
  test("DiscoveryView component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("DiscoveryView accepts feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("DiscoveryView displays feature.intent", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature\.intent/)
  })

  test("DiscoveryView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*discovery-view/)
  })
})

// ============================================================
// Test 2: DiscoveryView displays initialAssessment section conditionally
// (test-2-3b-018)
// ============================================================

describe("test-2-3b-018: DiscoveryView displays initialAssessment section conditionally", () => {
  test("DiscoveryView accesses feature.initialAssessment", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // May be accessed via destructuring
    expect(componentSource).toMatch(/initialAssessment/)
  })

  test("DiscoveryView displays likelyArchetype using ArchetypeBadge", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/ArchetypeBadge/)
    expect(componentSource).toMatch(/likelyArchetype/)
  })

  test("DiscoveryView renders indicators as bullet list", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/indicators/)
    expect(componentSource).toMatch(/\.map/)
  })

  test("DiscoveryView renders uncertainties as bullet list", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/uncertainties/)
  })
})

// ============================================================
// Test 3: DiscoveryView renders requirements grouped by priority
// (test-2-3b-019)
// ============================================================

describe("test-2-3b-019: DiscoveryView renders requirements grouped by priority", () => {
  test("DiscoveryView uses useDomains hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("DiscoveryView accesses platformFeatures.requirementCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/requirementCollection/)
  })

  test("DiscoveryView uses RequirementCard components", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/RequirementCard/)
  })

  test("DiscoveryView groups requirements by must/should/could", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/must/)
    expect(componentSource).toMatch(/should/)
    expect(componentSource).toMatch(/could/)
  })
})

// ============================================================
// Test 4: DiscoveryView handles empty requirements state
// (test-2-3b-020)
// ============================================================

describe("test-2-3b-020: DiscoveryView handles empty requirements state", () => {
  test("DiscoveryView handles empty requirements array", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for empty/length
    expect(componentSource).toMatch(/requirements\.length|requirements\?|!requirements/)
  })
})

// ============================================================
// Test 5: DiscoveryView hides initialAssessment when not present
// (test-2-3b-021)
// ============================================================

describe("test-2-3b-021: DiscoveryView hides initialAssessment when not present", () => {
  test("InitialAssessment uses conditional rendering", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/initialAssessment\s*&&|initialAssessment\s*\?/)
  })
})

// ============================================================
// Test 6: DiscoveryView is wrapped with observer() for MobX reactivity
// (test-2-3b-041)
// ============================================================

describe("test-2-3b-041: DiscoveryView is wrapped with observer() for MobX reactivity", () => {
  test("DiscoveryView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("DiscoveryView is wrapped with observer", () => {
    const componentPath = path.resolve(import.meta.dir, "../DiscoveryView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(/)
  })
})

// ============================================================
// Test 7: Module exports
// ============================================================

describe("DiscoveryView module exports", () => {
  test("DiscoveryView component can be imported", async () => {
    const module = await import("../DiscoveryView")
    expect(module.DiscoveryView).toBeDefined()
    // MobX observer wraps component as object with render function
    expect(module.DiscoveryView).toBeTruthy()
  })
})
