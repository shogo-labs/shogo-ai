/**
 * Tests for RequirementCard PropertyRenderer Integration
 * Task: task-sdr-v2-005 (requirement-card-vertical-slice)
 *
 * TDD tests validating that RequirementCard uses PropertyRenderer for all property displays:
 * - name property rendered via PropertyRenderer with string metadata
 * - priority property rendered via PropertyRenderer with enum metadata
 * - description property rendered via PropertyRenderer with string metadata
 *
 * Test Specifications:
 * - test-sdr-005-01: RequirementCard renders name via PropertyRenderer
 * - test-sdr-005-02: RequirementCard renders priority via PropertyRenderer with enum
 * - test-sdr-005-03: RequirementCard renders description via PropertyRenderer
 * - test-sdr-005-04: RequirementCard visual appearance matches original
 * - test-sdr-005-05: RequirementCard renders correctly in DiscoveryView context
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../RequirementCard.tsx")

// ============================================================
// Test 1: RequirementCard renders name via PropertyRenderer
// (test-sdr-005-01)
// ============================================================

describe("test-sdr-005-01: RequirementCard renders name via PropertyRenderer", () => {
  test("RequirementCard imports PropertyRenderer from rendering components", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*PropertyRenderer.*from.*@\/components\/rendering/)
  })

  test("RequirementCard defines namePropertyMeta metadata", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/namePropertyMeta.*:.*PropertyMetadata/)
  })

  test("namePropertyMeta has name='name' and type='string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Check that namePropertyMeta object contains name: "name"
    expect(componentSource).toMatch(/namePropertyMeta[\s\S]*?name:\s*["']name["']/)
    // Check that namePropertyMeta object contains type: "string"
    expect(componentSource).toMatch(/namePropertyMeta[\s\S]*?type:\s*["']string["']/)
  })

  test("RequirementCard renders name via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have PropertyRenderer with namePropertyMeta and requirement.name value
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{namePropertyMeta\}/)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{requirement\.name\}/)
  })
})

// ============================================================
// Test 2: RequirementCard renders priority via PropertyRenderer with enum
// (test-sdr-005-02)
// ============================================================

describe("test-sdr-005-02: RequirementCard renders priority via PropertyRenderer with enum", () => {
  test("RequirementCard defines priorityPropertyMeta with enum values", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/priorityPropertyMeta/)
    expect(componentSource).toMatch(/enum.*:.*\[.*["']must["'].*["']should["'].*["']could["'].*\]/)
  })

  test("priorityPropertyMeta has xRenderer='priority-badge'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/priorityPropertyMeta[\s\S]*?xRenderer.*:.*["']priority-badge["']/)
  })

  test("RequirementCard renders priority via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{priorityPropertyMeta\}/)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{requirement\.priority\}/)
  })
})

// ============================================================
// Test 3: RequirementCard renders description via PropertyRenderer
// (test-sdr-005-03)
// ============================================================

describe("test-sdr-005-03: RequirementCard renders description via PropertyRenderer", () => {
  test("RequirementCard defines descriptionPropertyMeta metadata", () => {
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

  test("RequirementCard renders description via PropertyRenderer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{descriptionPropertyMeta\}/)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?value=\{requirement\.description\}/)
  })
})

// ============================================================
// Test 4: RequirementCard visual appearance matches original
// (test-sdr-005-04)
// ============================================================

describe("test-sdr-005-04: RequirementCard visual appearance unchanged", () => {
  test("RequirementCard has card border and padding styles", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/p-3.*rounded-lg.*border.*bg-card/)
  })

  test("RequirementCard has hover transition styles", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/hover:bg-accent\/30.*transition-colors/)
  })

  test("RequirementCard has flex layout with justify-between", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/flex.*items-start.*justify-between/)
  })

  test("RequirementCard has data-testid for testing", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/data-testid.*requirement-card/)
  })
})

// ============================================================
// Test 5: RequirementCard renders correctly (integration)
// (test-sdr-005-05)
// ============================================================

describe("test-sdr-005-05: RequirementCard renders correctly in DiscoveryView context", () => {
  test("RequirementCard exports are available", async () => {
    const module = await import("../RequirementCard")
    expect(module.RequirementCard).toBeDefined()
    expect(typeof module.RequirementCard).toBe("function")
  })

  test("RequirementCard exports priorityBadgeVariants for backward compatibility", async () => {
    const module = await import("../RequirementCard")
    expect(module.priorityBadgeVariants).toBeDefined()
    expect(typeof module.priorityBadgeVariants).toBe("function")
  })

  test("RequirementCard uses three PropertyRenderer instances", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Count PropertyRenderer usages - should be 3 (name, description, priority)
    const propertyRendererMatches = componentSource.match(/<PropertyRenderer/g)
    expect(propertyRendererMatches).not.toBeNull()
    expect(propertyRendererMatches!.length).toBeGreaterThanOrEqual(3)
  })
})
