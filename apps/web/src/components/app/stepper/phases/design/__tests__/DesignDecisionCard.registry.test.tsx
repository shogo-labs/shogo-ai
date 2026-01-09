/**
 * Tests for DesignDecisionCard PropertyRenderer Integration
 * Task: task-cbe-006 (convert-design-decision-card)
 *
 * TDD tests validating that DesignDecisionCard uses PropertyRenderer for all text fields:
 * - name property rendered via PropertyRenderer with string metadata
 * - question property rendered via PropertyRenderer with xRenderer: 'long-text'
 * - decision property rendered via PropertyRenderer with xRenderer: 'long-text'
 * - rationale property rendered via PropertyRenderer with xRenderer: 'long-text'
 *
 * Test Specifications:
 * - test-cbe-006-01: DesignDecisionCard imports PropertyRenderer and PropertyMetadata
 * - test-cbe-006-02: DesignDecisionCard defines nameMeta PropertyMetadata
 * - test-cbe-006-03: DesignDecisionCard defines questionMeta with xRenderer: 'long-text'
 * - test-cbe-006-04: DesignDecisionCard defines decisionMeta with xRenderer: 'long-text'
 * - test-cbe-006-05: DesignDecisionCard defines rationaleMeta with xRenderer: 'long-text'
 * - test-cbe-006-06: DesignDecisionCard uses PropertyRenderer for all text fields
 * - test-cbe-006-07: DesignDecisionCard PropertyRenderer configs include expandable: true
 * - test-cbe-006-08: DesignDecisionCard maintains existing layout structure
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../DesignDecisionCard.tsx")

// ============================================================
// Test 1: DesignDecisionCard imports PropertyRenderer and PropertyMetadata
// (test-cbe-006-01)
// ============================================================

describe("test-cbe-006-01: DesignDecisionCard imports PropertyRenderer and PropertyMetadata", () => {
  test("Component imports PropertyRenderer from @/components/rendering", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*PropertyRenderer.*from.*@\/components\/rendering/)
  })

  test("Component imports PropertyMetadata type from @/components/rendering", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*PropertyMetadata.*from.*@\/components\/rendering/)
  })
})

// ============================================================
// Test 2: DesignDecisionCard defines nameMeta PropertyMetadata
// (test-cbe-006-02)
// ============================================================

describe("test-cbe-006-02: DesignDecisionCard defines nameMeta PropertyMetadata", () => {
  test("nameMeta constant is defined with PropertyMetadata type", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/nameMeta.*:.*PropertyMetadata/)
  })

  test("nameMeta has name: 'name' and type: 'string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check nameMeta object contains name: "name"
    expect(componentSource).toMatch(/nameMeta[\s\S]*?name:\s*["']name["']/)
    // Check nameMeta object contains type: "string"
    expect(componentSource).toMatch(/nameMeta[\s\S]*?type:\s*["']string["']/)
  })

  test("nameMeta is used for title field rendering", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{nameMeta\}/)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{decision\.name\}/)
  })
})

// ============================================================
// Test 3: DesignDecisionCard defines questionMeta with xRenderer: 'long-text'
// (test-cbe-006-03)
// ============================================================

describe("test-cbe-006-03: DesignDecisionCard defines questionMeta with xRenderer: 'long-text'", () => {
  test("questionMeta constant is defined", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/questionMeta.*:.*PropertyMetadata/)
  })

  test("questionMeta has xRenderer: 'long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/questionMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })

  test("questionMeta has name: 'question' and type: 'string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/questionMeta[\s\S]*?name:\s*["']question["']/)
    expect(componentSource).toMatch(/questionMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// ============================================================
// Test 4: DesignDecisionCard defines decisionMeta with xRenderer: 'long-text'
// (test-cbe-006-04)
// ============================================================

describe("test-cbe-006-04: DesignDecisionCard defines decisionMeta with xRenderer: 'long-text'", () => {
  test("decisionMeta constant is defined", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decisionMeta.*:.*PropertyMetadata/)
  })

  test("decisionMeta has xRenderer: 'long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decisionMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })

  test("decisionMeta has name: 'decision' and type: 'string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/decisionMeta[\s\S]*?name:\s*["']decision["']/)
    expect(componentSource).toMatch(/decisionMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// ============================================================
// Test 5: DesignDecisionCard defines rationaleMeta with xRenderer: 'long-text'
// (test-cbe-006-05)
// ============================================================

describe("test-cbe-006-05: DesignDecisionCard defines rationaleMeta with xRenderer: 'long-text'", () => {
  test("rationaleMeta constant is defined", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/rationaleMeta.*:.*PropertyMetadata/)
  })

  test("rationaleMeta has xRenderer: 'long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/rationaleMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })

  test("rationaleMeta has name: 'rationale' and type: 'string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/rationaleMeta[\s\S]*?name:\s*["']rationale["']/)
    expect(componentSource).toMatch(/rationaleMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// ============================================================
// Test 6: DesignDecisionCard uses PropertyRenderer for all text fields
// (test-cbe-006-06)
// ============================================================

describe("test-cbe-006-06: DesignDecisionCard uses PropertyRenderer for all text fields", () => {
  test("Four PropertyRenderer instances exist", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    const propertyRendererMatches = componentSource.match(/<PropertyRenderer/g)
    expect(propertyRendererMatches).not.toBeNull()
    expect(propertyRendererMatches!.length).toBe(4)
  })

  test("decision.name rendered via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{decision\.name\}/)
  })

  test("decision.question rendered via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{decision\.question\}/)
  })

  test("decision.decision rendered via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{decision\.decision\}/)
  })

  test("decision.rationale rendered via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{decision\.rationale\}/)
  })
})

// ============================================================
// Test 7: DesignDecisionCard PropertyRenderer configs include expandable: true
// (test-cbe-006-07)
// ============================================================

describe("test-cbe-006-07: DesignDecisionCard PropertyRenderer configs include expandable: true", () => {
  test("questionMeta PropertyRenderer has config with expandable: true", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Match PropertyRenderer with questionMeta and config containing expandable: true
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{questionMeta\}[\s\S]*?config=\{[\s\S]*?expandable:\s*true/)
  })

  test("decisionMeta PropertyRenderer has config with expandable: true", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{decisionMeta\}[\s\S]*?config=\{[\s\S]*?expandable:\s*true/)
  })

  test("rationaleMeta PropertyRenderer has config with expandable: true", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{rationaleMeta\}[\s\S]*?config=\{[\s\S]*?expandable:\s*true/)
  })
})

// ============================================================
// Test 8: DesignDecisionCard maintains existing layout structure
// (test-cbe-006-08)
// ============================================================

describe("test-cbe-006-08: DesignDecisionCard maintains existing layout structure", () => {
  test("Card container with data-testid exists", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/data-testid.*design-decision-card/)
  })

  test("Uses shadcn Card components", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*Card.*from.*@\/components\/ui\/card/)
    expect(componentSource).toMatch(/<Card/)
    expect(componentSource).toMatch(/<CardHeader/)
    expect(componentSource).toMatch(/<CardContent/)
  })

  test("CardContent has space-y-3 for section spacing", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<CardContent.*space-y-3/)
  })

  test("Component exports are available", async () => {
    const module = await import("../DesignDecisionCard")
    expect(module.DesignDecisionCard).toBeDefined()
    expect(typeof module.DesignDecisionCard).toBe("function")
  })
})
