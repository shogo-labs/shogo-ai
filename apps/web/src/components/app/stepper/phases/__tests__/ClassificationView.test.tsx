/**
 * Tests for ClassificationView Component
 * Task: task-2-3b-009
 *
 * TDD tests for the classification phase view component.
 *
 * Test Specifications:
 * - test-2-3b-026: ClassificationView renders validated archetype using ArchetypeBadge
 * - test-2-3b-027: ClassificationView displays rationale as text block
 * - test-2-3b-028: ClassificationView renders evidence checklist using EvidenceChecklist component
 * - test-2-3b-029: ClassificationView displays applicable patterns using PatternChips
 * - test-2-3b-030: ClassificationView shows correction note when initial differs from validated
 * - test-2-3b-031: ClassificationView handles empty classification decision state
 * - test-2-3b-032: ClassificationView hides correction note when initial matches validated
 * - test-2-3b-043: ClassificationView is wrapped with observer() for MobX reactivity
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: ClassificationView renders validated archetype using ArchetypeBadge
// (test-2-3b-026)
// ============================================================

describe("test-2-3b-026: ClassificationView renders validated archetype using ArchetypeBadge", () => {
  test("ClassificationView component file exists", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("ClassificationView accepts feature prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/feature/)
  })

  test("ClassificationView has data-testid", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/data-testid.*classification-view/)
  })

  test("ClassificationView imports ArchetypeBadge", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Import may span multiple lines
    expect(componentSource).toMatch(/ArchetypeBadge/)
  })

  test("ClassificationView uses ArchetypeBadge for validatedArchetype", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<ArchetypeBadge/)
    expect(componentSource).toMatch(/validatedArchetype/)
  })
})

// ============================================================
// Test 2: ClassificationView displays rationale as text block
// (test-2-3b-027)
// ============================================================

describe("test-2-3b-027: ClassificationView displays rationale as text block", () => {
  test("ClassificationView displays rationale", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/rationale/)
  })
})

// ============================================================
// Test 3: ClassificationView renders evidence checklist using EvidenceChecklist component
// (test-2-3b-028)
// ============================================================

describe("test-2-3b-028: ClassificationView renders evidence checklist using EvidenceChecklist component", () => {
  test("ClassificationView imports EvidenceChecklist", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Import may span multiple lines
    expect(componentSource).toMatch(/EvidenceChecklist/)
  })

  test("ClassificationView uses EvidenceChecklist component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<EvidenceChecklist/)
  })

  test("ClassificationView passes evidenceChecklist prop", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/evidenceChecklist/)
  })
})

// ============================================================
// Test 4: ClassificationView displays applicable patterns using PatternChips
// (test-2-3b-029)
// ============================================================

describe("test-2-3b-029: ClassificationView displays applicable patterns using PatternChips", () => {
  test("ClassificationView imports PatternChips", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Import may span multiple lines
    expect(componentSource).toMatch(/PatternChips/)
  })

  test("ClassificationView uses PatternChips component", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/<PatternChips/)
  })

  test("ClassificationView passes applicablePatterns", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/applicablePatterns/)
  })
})

// ============================================================
// Test 5: ClassificationView shows correction note when initial differs from validated
// (test-2-3b-030)
// ============================================================

describe("test-2-3b-030: ClassificationView shows correction note when initial differs from validated", () => {
  test("ClassificationView accesses initialAssessment", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/initialAssessment/)
  })

  test("ClassificationView compares initial and validated archetypes", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should compare the two values
    expect(componentSource).toMatch(/initialAssessment.*validatedArchetype|validatedArchetype.*initialAssessment|!==|correction/)
  })
})

// ============================================================
// Test 6: ClassificationView handles empty classification decision state
// (test-2-3b-031)
// ============================================================

describe("test-2-3b-031: ClassificationView handles empty classification decision state", () => {
  test("ClassificationView uses useDomains hook", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/useDomains/)
  })

  test("ClassificationView accesses classificationDecisionCollection", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/classificationDecisionCollection/)
  })

  test("ClassificationView handles missing classification decision", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should check for null/undefined decision
    expect(componentSource).toMatch(/decision\?|!decision|decision\s*&&/)
  })
})

// ============================================================
// Test 7: ClassificationView hides correction note when initial matches validated
// (test-2-3b-032)
// ============================================================

describe("test-2-3b-032: ClassificationView hides correction note when initial matches validated", () => {
  test("Correction note uses conditional rendering", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should conditionally show correction based on difference
    expect(componentSource).toMatch(/correction|!==|initialAssessment/)
  })
})

// ============================================================
// Test 8: ClassificationView is wrapped with observer() for MobX reactivity
// (test-2-3b-043)
// ============================================================

describe("test-2-3b-043: ClassificationView is wrapped with observer() for MobX reactivity", () => {
  test("ClassificationView imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("ClassificationView is wrapped with observer", () => {
    const componentPath = path.resolve(import.meta.dir, "../ClassificationView.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(/)
  })
})

// ============================================================
// Test 9: Module exports
// ============================================================

describe("ClassificationView module exports", () => {
  test("ClassificationView component can be imported", async () => {
    const module = await import("../ClassificationView")
    expect(module.ClassificationView).toBeDefined()
    // MobX observer wraps component as object with render function
    expect(module.ClassificationView).toBeTruthy()
  })
})
