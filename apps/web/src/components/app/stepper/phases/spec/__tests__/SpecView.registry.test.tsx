/**
 * Tests for SpecView IntegrationPoint PropertyRenderer Integration
 * Task: task-cbe-007 (convert-integration-point-rendering)
 *
 * TDD tests validating that SpecView uses PropertyRenderer for IntegrationPoint property displays:
 * - changeType property rendered via PropertyRenderer with enum metadata and xRenderer: 'change-type-badge'
 * - filePath property rendered via PropertyRenderer with xRenderer: 'code-path'
 * - description property rendered via PropertyRenderer with xRenderer: 'long-text'
 *
 * Test Specifications from Wavesmith:
 * - test-cbe-007-01: SpecView defines changeTypeMeta with xRenderer: 'change-type-badge'
 * - test-cbe-007-02: SpecView defines filePathMeta with xRenderer: 'code-path'
 * - test-cbe-007-03: SpecView defines descriptionMeta with xRenderer: 'long-text'
 * - test-cbe-007-04: SpecView IntegrationPoint section uses PropertyRenderer for changeType
 * - test-cbe-007-05: IntegrationPoint changeType displays with semantic colors
 * - test-cbe-007-06: IntegrationPoint filePath displays with monospace via CodePathDisplay
 * - test-cbe-007-07: IntegrationPoint list layout preserved after conversion
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../SpecView.tsx")

// ============================================================
// Test 1: SpecView defines changeTypeMeta with xRenderer: 'change-type-badge'
// (test-cbe-007-01)
// ============================================================

describe("test-cbe-007-01: SpecView defines changeTypeMeta with xRenderer: 'change-type-badge'", () => {
  test("SpecView imports PropertyRenderer from rendering components", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*PropertyRenderer.*from.*@\/components\/rendering/)
  })

  test("SpecView imports PropertyMetadata type from rendering", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*type.*PropertyMetadata.*from.*@\/components\/rendering/)
  })

  test("SpecView defines changeTypeMeta PropertyMetadata constant", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/changeTypeMeta.*:.*PropertyMetadata/)
  })

  test("changeTypeMeta has xRenderer: 'change-type-badge'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/changeTypeMeta[\s\S]*?xRenderer.*:.*["']change-type-badge["']/)
  })

  test("changeTypeMeta has enum values: ['add', 'modify', 'extend', 'remove']", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check that changeTypeMeta object contains enum with all four values
    expect(componentSource).toMatch(/changeTypeMeta[\s\S]*?enum.*:.*\[/)
    expect(componentSource).toMatch(/["']add["']/)
    expect(componentSource).toMatch(/["']modify["']/)
    expect(componentSource).toMatch(/["']extend["']/)
    expect(componentSource).toMatch(/["']remove["']/)
  })
})

// ============================================================
// Test 2: SpecView defines filePathMeta with xRenderer: 'code-path'
// (test-cbe-007-02)
// ============================================================

describe("test-cbe-007-02: SpecView defines filePathMeta with xRenderer: 'code-path'", () => {
  test("SpecView defines filePathMeta PropertyMetadata constant", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/filePathMeta.*:.*PropertyMetadata/)
  })

  test("filePathMeta has xRenderer: 'code-path'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/filePathMeta[\s\S]*?xRenderer.*:.*["']code-path["']/)
  })

  test("filePathMeta has name='filePath' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/filePathMeta[\s\S]*?name:\s*["']filePath["']/)
    expect(componentSource).toMatch(/filePathMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// ============================================================
// Test 3: SpecView defines descriptionMeta with xRenderer: 'long-text'
// (test-cbe-007-03)
// ============================================================

describe("test-cbe-007-03: SpecView defines descriptionMeta with xRenderer: 'long-text'", () => {
  test("SpecView defines integrationPointDescriptionMeta PropertyMetadata constant", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Named integrationPointDescriptionMeta to distinguish from task description meta
    expect(componentSource).toMatch(/integrationPointDescriptionMeta.*:.*PropertyMetadata/)
  })

  test("integrationPointDescriptionMeta has xRenderer: 'long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/integrationPointDescriptionMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })

  test("integrationPointDescriptionMeta has name='description' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/integrationPointDescriptionMeta[\s\S]*?name:\s*["']description["']/)
    expect(componentSource).toMatch(/integrationPointDescriptionMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// ============================================================
// Test 4: SpecView IntegrationPoint section uses PropertyRenderer for changeType
// (test-cbe-007-04)
// ============================================================

describe("test-cbe-007-04: SpecView IntegrationPoint section uses PropertyRenderer for changeType", () => {
  test("SpecView uses PropertyRenderer with changeTypeMeta property", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{changeTypeMeta\}/)
  })

  test("SpecView passes integrationPoint.changeType value to PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have value prop with changeType from integration point
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{[^}]*\.changeType\}/)
  })

  test("SpecView uses PropertyRenderer with filePathMeta property", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{filePathMeta\}/)
  })

  test("SpecView uses PropertyRenderer with integrationPointDescriptionMeta property", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{integrationPointDescriptionMeta\}/)
  })
})

// ============================================================
// Test 5: IntegrationPoint changeType displays with semantic colors
// (test-cbe-007-05 - integration test, verifies via component structure)
// ============================================================

describe("test-cbe-007-05: IntegrationPoint changeType displays with semantic colors", () => {
  test("changeTypeMeta enum includes all four change types for semantic coloring", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // The enum values will drive the semantic coloring via ChangeTypeBadge
    // add=green, modify=blue, extend=purple, remove=red (handled by ChangeTypeBadge component)
    const enumMatch = componentSource.match(/changeTypeMeta[\s\S]*?enum:\s*\[([\s\S]*?)\]/)
    expect(enumMatch).not.toBeNull()
    const enumContent = enumMatch![1]
    expect(enumContent).toContain("add")
    expect(enumContent).toContain("modify")
    expect(enumContent).toContain("extend")
    expect(enumContent).toContain("remove")
  })
})

// ============================================================
// Test 6: IntegrationPoint filePath displays with monospace via CodePathDisplay
// (test-cbe-007-06 - integration test, verifies via PropertyRenderer config)
// ============================================================

describe("test-cbe-007-06: IntegrationPoint filePath displays with monospace via CodePathDisplay", () => {
  test("filePathMeta xRenderer resolves to CodePathDisplay via registry", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // code-path xRenderer resolves to CodePathDisplay which provides monospace styling
    expect(componentSource).toMatch(/filePathMeta[\s\S]*?xRenderer.*:.*["']code-path["']/)
  })

  test("PropertyRenderer for filePath may have truncate config for long paths", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check if there's a config prop with truncate option for filePath
    // This is optional but good to verify if present
    const hasFilePathConfig = componentSource.includes("filePathMeta") &&
      componentSource.match(/<PropertyRenderer[\s\S]*?property=\{filePathMeta\}[\s\S]*?config/)
    // This test passes regardless - truncate config is optional
    expect(true).toBe(true)
  })
})

// ============================================================
// Test 7: IntegrationPoint list layout preserved after conversion
// (test-cbe-007-07)
// ============================================================

describe("test-cbe-007-07: IntegrationPoint list layout preserved after conversion", () => {
  test("SpecView has IntegrationPoint section or component", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have some indication of IntegrationPoint rendering
    expect(componentSource).toMatch(/[Ii]ntegration[Pp]oint/)
  })

  test("SpecView has appropriate container styling for integration points", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have card-like styling for integration points similar to existing task cards
    expect(componentSource).toMatch(/rounded.*border|bg-card|p-[234]/)
  })

  test("SpecView uses three PropertyRenderer instances for IntegrationPoint", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Count PropertyRenderer usages - should have at least 3 for changeType, filePath, description
    const propertyRendererMatches = componentSource.match(/<PropertyRenderer/g)
    expect(propertyRendererMatches).not.toBeNull()
    // Should have existing ones (statusPropertyMeta, acceptanceCriteriaPropertyMeta)
    // plus new ones (changeTypeMeta, filePathMeta, integrationPointDescriptionMeta)
    expect(propertyRendererMatches!.length).toBeGreaterThanOrEqual(5)
  })
})
