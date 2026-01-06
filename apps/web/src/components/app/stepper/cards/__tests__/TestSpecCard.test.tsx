/**
 * Tests for TestSpecCard Component
 * Task: task-2-3d-test-spec-card
 *
 * TDD tests for the test specification card with Given/When/Then display.
 *
 * Test Specifications from task acceptance criteria:
 * - TestSpecCard.tsx created in stepper/cards/ directory
 * - Component wrapped with observer() for MST reactivity
 * - Displays scenario name prominently as card header
 * - Shows testType badge using testTypeVariants CVA (unit=blue, integration=purple, acceptance=green)
 * - Renders targetFile path with monospace font when present
 * - Given[] rendered as bullet list
 * - When rendered as single line
 * - Then[] rendered as bullet list
 * - Uses muted background sections between Given/When/Then
 * - Uses shadcn Card component with hover effects
 * - Exports TestSpecCard and TestSpecCardProps
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

  test("TestSpecCard displays testType badge", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/spec\.testType/)
  })
})

// ============================================================
// Test 4: TestSpecCard uses testTypeVariants CVA
// ============================================================

describe("TestSpecCard uses testTypeVariants CVA", () => {
  test("TestSpecCard imports cva from class-variance-authority", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/import.*cva.*from.*class-variance-authority/)
  })

  test("TestSpecCard defines testTypeVariants with cva", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/testTypeVariants.*=.*cva/)
  })

  test("unit type has blue styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/unit.*bg-blue/)
  })

  test("integration type has purple styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/integration.*bg-purple/)
  })

  test("acceptance type has green styling", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/acceptance.*bg-green/)
  })
})

// ============================================================
// Test 5: TestSpecCard displays targetFile with monospace font
// ============================================================

describe("TestSpecCard displays targetFile", () => {
  test("TestSpecCard has targetFile section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/targetFile/)
  })

  test("targetFile uses monospace font", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/font-mono/)
  })
})

// ============================================================
// Test 6: TestSpecCard displays Given/When/Then sections
// ============================================================

describe("TestSpecCard displays Given/When/Then sections", () => {
  test("TestSpecCard displays Given section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Given/)
    expect(componentSource).toMatch(/spec\.given/)
  })

  test("TestSpecCard displays When section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/When/)
    expect(componentSource).toMatch(/spec\.when/)
  })

  test("TestSpecCard displays Then section", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/Then/)
    expect(componentSource).toMatch(/spec\.then/)
  })

  test("Given renders as list (maps array)", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/spec\.given.*map/)
  })

  test("Then renders as list (maps array)", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/spec\.then.*map/)
  })
})

// ============================================================
// Test 7: TestSpecCard uses shadcn Card
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
// Test 8: TestSpecCard exports
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

  test("TestSpecCard exports testTypeVariants", () => {
    const componentPath = path.resolve(import.meta.dir, "../TestSpecCard.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    expect(componentSource).toMatch(/export.*testTypeVariants/)
  })
})
