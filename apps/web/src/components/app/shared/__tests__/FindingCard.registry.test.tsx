/**
 * Tests for FindingCard PropertyRenderer Integration
 * Task: task-cbe-005 (convert-finding-card-fields)
 *
 * TDD tests validating that FindingCard uses PropertyRenderer for all property displays:
 * - description property rendered via PropertyRenderer with xRenderer: 'long-text'
 * - location property rendered via PropertyRenderer with xRenderer: 'code-path'
 * - recommendation property rendered via PropertyRenderer with xRenderer: 'long-text'
 *
 * Test Specifications:
 * - test-cbe-005-01: FindingCard defines descriptionPropertyMeta with xRenderer: 'long-text'
 * - test-cbe-005-02: FindingCard defines locationPropertyMeta with xRenderer: 'code-path'
 * - test-cbe-005-03: FindingCard defines recommendationPropertyMeta with xRenderer: 'long-text'
 * - test-cbe-005-04: FindingCard renders description via PropertyRenderer
 * - test-cbe-005-05: FindingCard renders location via PropertyRenderer with CodePathDisplay
 * - test-cbe-005-06: FindingCard existing type badge PropertyRenderer unchanged
 * - test-cbe-005-07: FindingCard long descriptions show expand/collapse
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../FindingCard.tsx")

// ============================================================
// Test 1: FindingCard defines descriptionPropertyMeta with xRenderer: 'long-text'
// (test-cbe-005-01)
// ============================================================

describe("test-cbe-005-01: FindingCard defines descriptionPropertyMeta with xRenderer: 'long-text'", () => {
  test("FindingCard imports PropertyMetadata type from rendering components", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*PropertyMetadata.*from.*@\/components\/rendering/)
  })

  test("FindingCard defines descriptionPropertyMeta metadata", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/descriptionPropertyMeta.*:.*PropertyMetadata/)
  })

  test("descriptionPropertyMeta has name='description' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check that descriptionPropertyMeta object contains name: "description"
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?name:\s*["']description["']/)
    // Check that descriptionPropertyMeta object contains type: "string"
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?type:\s*["']string["']/)
  })

  test("descriptionPropertyMeta has xRenderer='long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })
})

// ============================================================
// Test 2: FindingCard defines locationPropertyMeta with xRenderer: 'code-path'
// (test-cbe-005-02)
// ============================================================

describe("test-cbe-005-02: FindingCard defines locationPropertyMeta with xRenderer: 'code-path'", () => {
  test("FindingCard defines locationPropertyMeta metadata", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/locationPropertyMeta.*:.*PropertyMetadata/)
  })

  test("locationPropertyMeta has name='location' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check that locationPropertyMeta object contains name: "location"
    expect(componentSource).toMatch(/locationPropertyMeta[\s\S]*?name:\s*["']location["']/)
    // Check that locationPropertyMeta object contains type: "string"
    expect(componentSource).toMatch(/locationPropertyMeta[\s\S]*?type:\s*["']string["']/)
  })

  test("locationPropertyMeta has xRenderer='code-path'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/locationPropertyMeta[\s\S]*?xRenderer.*:.*["']code-path["']/)
  })
})

// ============================================================
// Test 3: FindingCard defines recommendationPropertyMeta with xRenderer: 'long-text'
// (test-cbe-005-03)
// ============================================================

describe("test-cbe-005-03: FindingCard defines recommendationPropertyMeta with xRenderer: 'long-text'", () => {
  test("FindingCard defines recommendationPropertyMeta metadata", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/recommendationPropertyMeta.*:.*PropertyMetadata/)
  })

  test("recommendationPropertyMeta has name='recommendation' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check that recommendationPropertyMeta object contains name: "recommendation"
    expect(componentSource).toMatch(/recommendationPropertyMeta[\s\S]*?name:\s*["']recommendation["']/)
    // Check that recommendationPropertyMeta object contains type: "string"
    expect(componentSource).toMatch(/recommendationPropertyMeta[\s\S]*?type:\s*["']string["']/)
  })

  test("recommendationPropertyMeta has xRenderer='long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/recommendationPropertyMeta[\s\S]*?xRenderer.*:.*["']long-text["']/)
  })
})

// ============================================================
// Test 4: FindingCard renders description via PropertyRenderer
// (test-cbe-005-04)
// ============================================================

describe("test-cbe-005-04: FindingCard renders description via PropertyRenderer", () => {
  test("FindingCard uses PropertyRenderer with descriptionPropertyMeta", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{descriptionPropertyMeta\}/)
  })

  test("FindingCard passes finding.description to PropertyRenderer value", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{finding\.description\}/)
  })

  test("Inline finding.description text is replaced (no direct {finding.description} in text)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should NOT have bare {finding.description} as text content (outside of PropertyRenderer value prop)
    // The pattern looks for finding.description NOT inside a value= attribute
    const bareDescriptionPattern = />\s*\{finding\.description\}\s*</
    expect(componentSource).not.toMatch(bareDescriptionPattern)
  })
})

// ============================================================
// Test 5: FindingCard renders location via PropertyRenderer with CodePathDisplay
// (test-cbe-005-05)
// ============================================================

describe("test-cbe-005-05: FindingCard renders location via PropertyRenderer with CodePathDisplay", () => {
  test("FindingCard uses PropertyRenderer with locationPropertyMeta", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{locationPropertyMeta\}/)
  })

  test("FindingCard passes finding.location to PropertyRenderer value", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{finding\.location\}/)
  })

  test("Inline finding.location text is replaced (no direct {finding.location} in text)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should NOT have bare {finding.location} as text content
    const bareLocationPattern = />\s*\{finding\.location\}\s*</
    expect(componentSource).not.toMatch(bareLocationPattern)
  })

  test("Location no longer uses inline font-mono class (handled by CodePathDisplay)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // The old inline location rendering had: <p className="text-xs font-mono...">{finding.location}</p>
    // Should NOT have this pattern anymore - CodePathDisplay handles monospace styling
    const inlineMonoLocationPattern = /font-mono[\s\S]*?\{finding\.location\}/
    expect(componentSource).not.toMatch(inlineMonoLocationPattern)
  })
})

// ============================================================
// Test 6: FindingCard existing type badge PropertyRenderer unchanged
// (test-cbe-005-06)
// ============================================================

describe("test-cbe-005-06: FindingCard existing type badge PropertyRenderer unchanged", () => {
  test("FindingCard still uses PropertyRenderer for finding.type", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{finding\.type\}/)
  })

  test("Type badge still uses xRenderer='finding-type-badge'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/xRenderer.*:.*["']finding-type-badge["']/)
  })

  test("findingTypeBadgeVariants export maintained for backward compatibility", async () => {
    const module = await import("../FindingCard")
    expect(module.findingTypeBadgeVariants).toBeDefined()
    expect(typeof module.findingTypeBadgeVariants).toBe("function")
  })
})

// ============================================================
// Test 7: FindingCard visual appearance and structure maintained
// (test-cbe-005-07)
// ============================================================

describe("test-cbe-005-07: FindingCard visual appearance and PropertyRenderer count", () => {
  test("FindingCard has card border and padding styles", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/p-3.*rounded-lg.*border.*bg-card/)
  })

  test("FindingCard has hover transition styles", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/hover:bg-accent\/30.*transition-colors/)
  })

  test("FindingCard has data-testid for testing", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/data-testid.*finding-card/)
  })

  test("FindingCard exports are available", async () => {
    const module = await import("../FindingCard")
    expect(module.FindingCard).toBeDefined()
    expect(typeof module.FindingCard).toBe("function")
  })

  test("FindingCard uses at least 4 PropertyRenderer instances (type, description, location, recommendation)", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Count PropertyRenderer usages - should be at least 4 (type, description, location, recommendation)
    const propertyRendererMatches = componentSource.match(/<PropertyRenderer/g)
    expect(propertyRendererMatches).not.toBeNull()
    expect(propertyRendererMatches!.length).toBeGreaterThanOrEqual(4)
  })
})
