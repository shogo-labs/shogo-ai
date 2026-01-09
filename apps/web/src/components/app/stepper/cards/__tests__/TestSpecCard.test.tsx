/**
 * Tests for TestSpecCard Component
 * Task: task-2-3d-test-spec-card (original), task-cbe-010 (audit)
 *
 * Tests for the test specification card with Given/When/Then display.
 * Updated to reflect PropertyRenderer integration (Phase 2 component-builder-expansion).
 *
 * PropertyRenderer Integration:
 * - testType: Uses PropertyRenderer with xRenderer: "test-type-badge"
 * - targetFile: Uses PropertyRenderer with xRenderer: "code-path"
 * - given[]: Uses PropertyRenderer with xRenderer: "string-array"
 * - then[]: Uses PropertyRenderer with xRenderer: "string-array"
 * - when: Renders inline (single string, no PropertyRenderer needed)
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: TestSpecCard component file exists
// ============================================================

describe("TestSpecCard component file exists", () => {
  test("TestSpecCard.tsx file exists in stepper/cards/", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })
})

// ============================================================
// Test 2: TestSpecCard is wrapped with observer()
// ============================================================

describe("TestSpecCard is wrapped with observer()", () => {
  test("TestSpecCard imports observer from mobx-react-lite", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*observer.*from.*mobx-react-lite/)
  })

  test("TestSpecCard exports observer-wrapped component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/observer\(function TestSpecCard/)
  })
})

// ============================================================
// Test 3: TestSpecCard displays scenario and testType
// ============================================================

describe("TestSpecCard displays scenario and testType", () => {
  test("TestSpecCard displays scenario", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/spec\.scenario/)
  })

  test("TestSpecCard displays testType via PropertyRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/spec\.testType/)
    expect(componentSource).toMatch(/PropertyRenderer/)
  })
})

// ============================================================
// Test 4: TestSpecCard uses PropertyRenderer for testType (Phase 2 migration)
// ============================================================

describe("TestSpecCard uses PropertyRenderer for testType", () => {
  test("TestSpecCard imports PropertyRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*PropertyRenderer.*from.*@\/components\/rendering/)
  })

  test("TestSpecCard defines testTypePropertyMeta with xRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/testTypePropertyMeta/)
    expect(componentSource).toMatch(/xRenderer:\s*["']test-type-badge["']/)
  })

  test("TestSpecCard uses PropertyRenderer for testType field", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // PropertyRenderer is used with testTypePropertyMeta
    expect(componentSource).toMatch(/PropertyRenderer[\s\S]*?property=\{testTypePropertyMeta\}/)
  })
})

// ============================================================
// Test 5: TestSpecCard uses PropertyRenderer for targetFile (code-path)
// ============================================================

describe("TestSpecCard uses PropertyRenderer for targetFile", () => {
  test("TestSpecCard defines targetFilePropertyMeta with code-path xRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/targetFilePropertyMeta/)
    expect(componentSource).toMatch(/xRenderer:\s*["']code-path["']/)
  })

  test("TestSpecCard uses PropertyRenderer for targetFile field", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // PropertyRenderer is used with targetFilePropertyMeta
    expect(componentSource).toMatch(/PropertyRenderer[\s\S]*?property=\{targetFilePropertyMeta\}/)
  })
})

// ============================================================
// Test 6: TestSpecCard uses PropertyRenderer for given[] (string-array)
// ============================================================

describe("TestSpecCard uses PropertyRenderer for given array", () => {
  test("TestSpecCard defines givenPropertyMeta with string-array xRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/givenPropertyMeta/)
    expect(componentSource).toMatch(/xRenderer:\s*["']string-array["']/)
  })

  test("TestSpecCard uses PropertyRenderer for given field with config", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // PropertyRenderer with givenPropertyMeta and config
    expect(componentSource).toMatch(/PropertyRenderer[\s\S]*?property=\{givenPropertyMeta\}/)
    expect(componentSource).toMatch(/config=\{[\s\S]*?size:\s*["']xs["']/)
  })
})

// ============================================================
// Test 7: TestSpecCard uses PropertyRenderer for then[] (string-array)
// ============================================================

describe("TestSpecCard uses PropertyRenderer for then array", () => {
  test("TestSpecCard defines thenPropertyMeta with string-array xRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/thenPropertyMeta/)
    expect(componentSource).toMatch(/xRenderer:\s*["']string-array["']/)
  })

  test("TestSpecCard uses PropertyRenderer for then field with config", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // PropertyRenderer with thenPropertyMeta and config
    expect(componentSource).toMatch(/PropertyRenderer[\s\S]*?property=\{thenPropertyMeta\}/)
  })
})

// ============================================================
// Test 8: TestSpecCard displays when field inline (single string)
// ============================================================

describe("TestSpecCard displays when field appropriately", () => {
  test("TestSpecCard displays When section label", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/When:/)
  })

  test("TestSpecCard renders when as single line without PropertyRenderer", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // When section uses direct rendering, not PropertyRenderer
    expect(componentSource).toMatch(/\{spec\.when\}/)
  })
})

// ============================================================
// Test 9: TestSpecCard displays Given/When/Then sections
// ============================================================

describe("TestSpecCard displays Given/When/Then sections", () => {
  test("TestSpecCard displays Given section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Given:/)
    expect(componentSource).toMatch(/spec\.given/)
  })

  test("TestSpecCard displays When section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/When:/)
    expect(componentSource).toMatch(/spec\.when/)
  })

  test("TestSpecCard displays Then section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Then:/)
    expect(componentSource).toMatch(/spec\.then/)
  })
})

// ============================================================
// Test 10: TestSpecCard uses shadcn Card
// ============================================================

describe("TestSpecCard uses shadcn Card", () => {
  test("TestSpecCard imports Card from ui", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*Card.*from.*@\/components\/ui\/card/)
  })

  test("TestSpecCard has hover effects", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/hover:/)
  })
})

// ============================================================
// Test 11: TestSpecCard exports
// ============================================================

describe("TestSpecCard exports", () => {
  test("TestSpecCard exports TestSpecCard component", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TestSpecCard/)
  })

  test("TestSpecCard exports TestSpecCardProps type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*TestSpecCardProps/)
  })

  test("TestSpecCard exports TestType type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*type.*TestType/)
  })
})

// ============================================================
// Test 12: TestSpecCard uses PropertyMetadata types
// ============================================================

describe("TestSpecCard uses PropertyMetadata types", () => {
  test("TestSpecCard imports PropertyMetadata type", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*PropertyMetadata.*from.*@\/components\/rendering/)
  })

  test("All PropertyMetadata definitions have required fields", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Each metadata should have name, type, and xRenderer (multiline objects)
    expect(componentSource).toMatch(/testTypePropertyMeta[\s\S]*?name:\s*["']testType["']/)
    expect(componentSource).toMatch(/targetFilePropertyMeta[\s\S]*?name:\s*["']targetFile["']/)
    expect(componentSource).toMatch(/givenPropertyMeta[\s\S]*?name:\s*["']given["']/)
    expect(componentSource).toMatch(/thenPropertyMeta[\s\S]*?name:\s*["']then["']/)
  })
})
