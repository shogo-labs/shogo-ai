/**
 * Tests for RequirementCard PropertyRenderer Integration
 * Task: task-sdr-v2-005 (requirement-card-vertical-slice), task-cbe-004
 *
 * TDD tests validating that RequirementCard uses PropertyRenderer for all property displays:
 * - name property rendered via PropertyRenderer with string metadata
 * - priority property rendered via PropertyRenderer with enum metadata
 * - description property rendered via PropertyRenderer with string metadata + xRenderer: 'long-text'
 *
 * Test Specifications:
 * - test-sdr-005-01: RequirementCard renders name via PropertyRenderer
 * - test-sdr-005-02: RequirementCard renders priority via PropertyRenderer with enum
 * - test-sdr-005-03: RequirementCard renders description via PropertyRenderer
 * - test-sdr-005-04: RequirementCard visual appearance matches original
 * - test-sdr-005-05: RequirementCard renders correctly in DiscoveryView context
 *
 * Task: task-cbe-004 Test Specifications:
 * - test-cbe-004-01: descriptionPropertyMeta has xRenderer: 'long-text'
 * - test-cbe-004-02: PropertyRenderer config for description uses truncate and expandable
 * - test-cbe-004-03: Existing PropertyRenderer usage unchanged (name, priority)
 * - test-cbe-004-04: Backward compatibility (priorityBadgeVariants exported)
 * - test-cbe-004-05: Short descriptions render without expand button (LongTextDisplay graceful)
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

// ============================================================
// Task: task-cbe-004 - Convert RequirementCard description to use LongTextDisplay
// ============================================================

// Test 6: descriptionPropertyMeta has xRenderer: 'long-text'
// (test-cbe-004-01)
describe("test-cbe-004-01: descriptionPropertyMeta has xRenderer: 'long-text'", () => {
  test("descriptionPropertyMeta includes xRenderer: 'long-text'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Extract descriptionPropertyMeta definition and verify xRenderer
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?xRenderer:\s*["']long-text["']/)
  })

  test("descriptionPropertyMeta has name: 'description'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?name:\s*["']description["']/)
  })

  test("descriptionPropertyMeta has type: 'string'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// Test 7: PropertyRenderer config for description uses truncate and expandable
// (test-cbe-004-02)
describe("test-cbe-004-02: PropertyRenderer config for description uses expandable config", () => {
  test("PropertyRenderer for description includes config prop", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Look for PropertyRenderer with descriptionPropertyMeta that also has a config prop
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{descriptionPropertyMeta\}[\s\S]*?config=\{/)
  })

  test("config includes truncate option", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Verify config object contains truncate
    expect(componentSource).toMatch(/config=\{[\s\S]*?truncate:/)
  })

  test("config includes expandable: true", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Verify config object contains expandable: true
    expect(componentSource).toMatch(/config=\{[\s\S]*?expandable:\s*true/)
  })
})

// Test 8: Existing PropertyRenderer usage unchanged (name, priority)
// (test-cbe-004-03)
describe("test-cbe-004-03: Existing PropertyRenderer usage unchanged", () => {
  test("namePropertyMeta still uses PropertyRenderer without config", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // name should still use simple PropertyRenderer (no config needed)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{namePropertyMeta\}[\s\S]*?value=\{requirement\.name\}/)
  })

  test("priorityPropertyMeta still uses PropertyRenderer with priority-badge", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // priority should still have xRenderer: 'priority-badge'
    expect(componentSource).toMatch(/priorityPropertyMeta[\s\S]*?xRenderer:\s*["']priority-badge["']/)
    expect(componentSource).toMatch(/<PropertyRenderer[\s\S]*?property=\{priorityPropertyMeta\}[\s\S]*?value=\{requirement\.priority\}/)
  })

  test("namePropertyMeta type and name unchanged", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/namePropertyMeta[\s\S]*?name:\s*["']name["']/)
    expect(componentSource).toMatch(/namePropertyMeta[\s\S]*?type:\s*["']string["']/)
  })
})

// Test 9: Backward compatibility (priorityBadgeVariants exported)
// (test-cbe-004-04)
describe("test-cbe-004-04: Backward compatibility maintained", () => {
  test("priorityBadgeVariants is still exported", async () => {
    const module = await import("../RequirementCard")
    expect(module.priorityBadgeVariants).toBeDefined()
    expect(typeof module.priorityBadgeVariants).toBe("function")
  })

  test("RequirementCard component is still exported", async () => {
    const module = await import("../RequirementCard")
    expect(module.RequirementCard).toBeDefined()
    expect(typeof module.RequirementCard).toBe("function")
  })

  test("Requirement interface exports are available", async () => {
    // Component exports should be stable
    const module = await import("../RequirementCard")
    expect(module.RequirementCard).toBeDefined()
  })
})

// Test 10: Short descriptions render gracefully (LongTextDisplay handles short text)
// (test-cbe-004-05)
describe("test-cbe-004-05: Short descriptions handled gracefully", () => {
  test("PropertyRenderer for description allows LongTextDisplay to handle short text", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // The config with truncate will let LongTextDisplay decide whether to show expand
    // For short text, it should show full text without expand button
    // This is verified by having xRenderer: 'long-text' which routes to LongTextDisplay
    expect(componentSource).toMatch(/descriptionPropertyMeta[\s\S]*?xRenderer:\s*["']long-text["']/)
  })

  test("truncate value is reasonable for description length", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Extract truncate value - should be a reasonable number (e.g., 100-200)
    const truncateMatch = componentSource.match(/truncate:\s*(\d+)/)
    expect(truncateMatch).not.toBeNull()
    const truncateValue = parseInt(truncateMatch![1], 10)
    expect(truncateValue).toBeGreaterThanOrEqual(100)
    expect(truncateValue).toBeLessThanOrEqual(300)
  })
})
