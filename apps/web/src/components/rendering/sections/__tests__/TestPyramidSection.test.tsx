/**
 * Tests for TestPyramidSection Component
 * Task: task-testing-002
 * Test Spec: test-testing-002-pyramid
 *
 * TestPyramidSection renders SVG pyramid with test type counts
 *
 * Given: TestPyramidSection with feature prop
 *        Feature has 10 unit, 5 integration, 2 acceptance specs
 * When: Section renders
 * Then: SVG with viewBox='0 0 200 160' rendered
 *       Three polygon tiers present for unit/integration/acceptance
 *       Text labels show counts inside each tier
 *       Percentages displayed at bottom
 *
 * Acceptance Criteria:
 * 1. Component exports TestPyramidSection following SectionRendererProps interface
 * 2. Fetches tasks and specs from platformFeatures domain using feature.id
 * 3. Computes distribution counts: unitCount, integrationCount, acceptanceCount from specs
 * 4. Renders SVG viewBox='0 0 200 160' with three polygon tiers
 * 5. Unit tier (bottom): points='20,140 180,140 150,100 50,100' with fill-cyan-500/20 stroke-cyan-500
 * 6. Integration tier (middle): points='50,100 150,100 130,60 70,60' with fill-cyan-500/30 stroke-cyan-500
 * 7. Acceptance tier (top): points='70,60 130,60 115,30 85,30' with fill-cyan-500/40 stroke-cyan-500
 * 8. Text labels inside each tier showing type name and count in parentheses
 * 9. Percentages overlay at bottom showing distribution ratios
 * 10. Uses usePhaseColor('testing') for cyan theme tokens
 * 11. Card wrapper with p-4 rounded-lg border bg-card phaseColors.border
 * 12. Header shows CheckCircle2 icon with 'Test Pyramid' title
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(
  import.meta.dir,
  "../testing/TestPyramidSection.tsx"
)
const sectionImplPath = path.resolve(
  import.meta.dir,
  "../../sectionImplementations.tsx"
)

// ============================================================
// Test 1: Component exports TestPyramidSection following SectionRendererProps interface
// ============================================================

describe("task-testing-002-ac1: Component exports TestPyramidSection following SectionRendererProps", () => {
  test("TestPyramidSection component file exists", () => {
    const exists = fs.existsSync(componentPath)
    expect(exists).toBe(true)
  })

  test("Component accepts feature prop from SectionRendererProps", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/feature/)
  })

  test("Component imports SectionRendererProps type", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/SectionRendererProps/)
  })

  test("TestPyramidSection is exported", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/export.*TestPyramidSection/)
  })
})

// ============================================================
// Test 2: Fetches tasks and specs from platformFeatures domain
// ============================================================

describe("task-testing-002-ac2: Fetches tasks and specs from platformFeatures domain", () => {
  test("Component imports useDomains hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*useDomains/)
  })

  test("Component calls useDomains() hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/useDomains\(\)/)
  })

  test("Component accesses platformFeatures from useDomains", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/platformFeatures/)
  })

  test("Component accesses implementationTaskCollection", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/implementationTaskCollection/)
  })

  test("Component accesses testSpecificationCollection", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/testSpecificationCollection/)
  })
})

// ============================================================
// Test 3: Computes distribution counts from specs
// ============================================================

describe("task-testing-002-ac3: Computes distribution counts from specs", () => {
  test("Component computes unitCount", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/unitCount|unit.*count/i)
  })

  test("Component computes integrationCount", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/integrationCount|integration.*count/i)
  })

  test("Component computes acceptanceCount", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/acceptanceCount|acceptance.*count/i)
  })

  test("Component filters specs by testType", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/testType/)
  })
})

// ============================================================
// Test 4: Renders SVG viewBox='0 0 200 160' with three polygon tiers
// ============================================================

describe("task-testing-002-ac4: Renders SVG with viewBox and polygon tiers", () => {
  test("Component renders SVG with correct viewBox", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/viewBox=['"]0 0 200 160['"]/)
  })

  test("Component renders polygon elements", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<polygon/)
  })

  test("Component has three polygon tiers", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should have at least 3 polygons (could be in a map or explicit)
    const polygonMatches = componentSource.match(/<polygon/g) || []
    expect(polygonMatches.length).toBeGreaterThanOrEqual(3)
  })
})

// ============================================================
// Test 5: Unit tier (bottom) with correct points and styling
// ============================================================

describe("task-testing-002-ac5: Unit tier with correct points and styling", () => {
  test("Unit tier has correct points", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/points=['"]20,140\s+180,140\s+150,100\s+50,100['"]/)
  })

  test("Unit tier has fill-cyan-500/20 styling", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/fill-cyan-500\/20/)
  })

  test("Unit tier has stroke-cyan-500 styling", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/stroke-cyan-500/)
  })
})

// ============================================================
// Test 6: Integration tier (middle) with correct points and styling
// ============================================================

describe("task-testing-002-ac6: Integration tier with correct points and styling", () => {
  test("Integration tier has correct points", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/points=['"]50,100\s+150,100\s+130,60\s+70,60['"]/)
  })

  test("Integration tier has fill-cyan-500/30 styling", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/fill-cyan-500\/30/)
  })
})

// ============================================================
// Test 7: Acceptance tier (top) with correct points and styling
// ============================================================

describe("task-testing-002-ac7: Acceptance tier with correct points and styling", () => {
  test("Acceptance tier has correct points", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/points=['"]70,60\s+130,60\s+115,30\s+85,30['"]/)
  })

  test("Acceptance tier has fill-cyan-500/40 styling", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/fill-cyan-500\/40/)
  })
})

// ============================================================
// Test 8: Text labels inside each tier showing type name and count
// ============================================================

describe("task-testing-002-ac8: Text labels inside each tier", () => {
  test("Component renders text elements in SVG", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<text/)
  })

  test("Unit label shows count in parentheses", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/Unit.*\(.*unitCount|{unitCount}/)
  })

  test("Integration label shows count in parentheses", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/Integration.*\(.*integrationCount|{integrationCount}/)
  })

  test("Acceptance label shows count in parentheses", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/Acceptance.*\(.*acceptanceCount|{acceptanceCount}/)
  })
})

// ============================================================
// Test 9: Percentages overlay at bottom showing distribution ratios
// ============================================================

describe("task-testing-002-ac9: Percentages overlay at bottom", () => {
  test("Component calculates percentages", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should calculate percentages from counts
    expect(componentSource).toMatch(/percent|Percent|%/)
  })

  test("Component displays percentage values", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    // Should format percentages with toFixed or similar
    expect(componentSource).toMatch(/toFixed|\.toFixed\(0\)/)
  })
})

// ============================================================
// Test 10: Uses usePhaseColor('testing') for cyan theme tokens
// ============================================================

describe("task-testing-002-ac10: Uses usePhaseColor('testing')", () => {
  test("Component imports usePhaseColor hook", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*usePhaseColor/)
  })

  test("Component calls usePhaseColor with 'testing'", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/usePhaseColor\(['"]testing['"]\)/)
  })
})

// ============================================================
// Test 11: Card wrapper with correct styling
// ============================================================

describe("task-testing-002-ac11: Card wrapper with correct styling", () => {
  test("Component has p-4 padding class", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/p-4/)
  })

  test("Component has rounded-lg class", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/rounded-lg/)
  })

  test("Component has border class", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/\bborder\b/)
  })

  test("Component has bg-card class", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/bg-card/)
  })

  test("Component uses phaseColors.border", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/phaseColors\.border/)
  })
})

// ============================================================
// Test 12: Header shows CheckCircle2 icon with 'Test Pyramid' title
// ============================================================

describe("task-testing-002-ac12: Header with CheckCircle2 icon and title", () => {
  test("Component imports CheckCircle2 icon", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*CheckCircle2.*from ['"]lucide-react['"]/)
  })

  test("Component renders CheckCircle2 icon", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/<CheckCircle2/)
  })

  test("Component has 'Test Pyramid' title text", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/Test Pyramid/)
  })
})

// ============================================================
// Test 13: Component uses observer for MobX reactivity
// ============================================================

describe("task-testing-002-ac13: Uses observer for MobX reactivity", () => {
  test("Component imports observer from mobx-react-lite", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/import.*observer.*from ['"]mobx-react-lite['"]/)
  })

  test("Component is wrapped with observer", () => {
    const componentSource = fs.readFileSync(componentPath, "utf-8")
    expect(componentSource).toMatch(/observer\(/)
  })
})

// ============================================================
// Test 14: Registered in sectionImplementationMap
// ============================================================

describe("task-testing-002-ac14: Registered in sectionImplementationMap", () => {
  test("sectionImplementationMap imports TestPyramidSection", () => {
    const implSource = fs.readFileSync(sectionImplPath, "utf-8")
    expect(implSource).toMatch(/import.*TestPyramidSection/)
  })

  test("sectionImplementationMap registers TestPyramidSection", () => {
    const implSource = fs.readFileSync(sectionImplPath, "utf-8")
    expect(implSource).toMatch(
      /\[\s*["']TestPyramidSection["']\s*,\s*TestPyramidSection\s*\]/
    )
  })
})
