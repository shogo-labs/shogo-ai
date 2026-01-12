/**
 * Tests for Section Shared Utilities
 * Task: task-prephase-004
 *
 * TDD tests for shared section component utilities:
 * - SectionCard: wrapper with phaseColors border styling
 * - SectionHeader: icon + title + optional count badge
 * - EmptySectionState: configurable empty state display
 * - usePhaseColorFromContext: reads phase from CompositionContext
 *
 * Acceptance Criteria:
 * 1. SectionCard wrapper component with phaseColors border, rounded-lg, bg-card, p-4 styling
 * 2. SectionHeader sub-component with icon + title + optional count badge pattern
 * 3. EmptySectionState component with configurable icon and message
 * 4. usePhaseColorFromContext hook that reads phase from nearest Composition dataContext
 * 5. All utilities exported from apps/web/src/components/rendering/sections/shared.tsx
 * 6. Unit tests for each utility component
 */

import { describe, test, expect, beforeEach } from "bun:test"
import fs from "fs"
import path from "path"

const sharedPath = path.resolve(import.meta.dir, "../shared.tsx")

// ============================================================
// Test 1: SectionCard wrapper component
// ============================================================

describe("task-prephase-004-ac1: SectionCard applies consistent phase-colored styling", () => {
  test("shared.tsx file exists", () => {
    const exists = fs.existsSync(sharedPath)
    expect(exists).toBe(true)
  })

  test("SectionCard component is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SectionCard/)
  })

  test("SectionCard accepts phaseColors prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should have a prop type or interface with phaseColors
    expect(source).toMatch(/phaseColors/)
  })

  test("SectionCard uses rounded-lg class", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/rounded-lg/)
  })

  test("SectionCard uses bg-card class", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/bg-card/)
  })

  test("SectionCard uses p-4 padding class", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/p-4/)
  })

  test("SectionCard uses border class with phaseColors.border", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should use phaseColors.border for border color
    expect(source).toMatch(/phaseColors\.border|border.*phaseColors/)
  })
})

// ============================================================
// Test 2: SectionHeader sub-component
// ============================================================

describe("task-prephase-004-ac2: SectionHeader renders icon, title, and optional count badge", () => {
  test("SectionHeader component is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SectionHeader/)
  })

  test("SectionHeader accepts icon prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should have icon in props interface or destructured
    expect(source).toMatch(/icon\s*[:\?]|icon\s*,/)
  })

  test("SectionHeader accepts title prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/title\s*[:\?]|title\s*,/)
  })

  test("SectionHeader accepts count prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should have count in props, likely optional
    expect(source).toMatch(/count\s*\??\s*:|count\s*,/)
  })

  test("SectionHeader renders badge conditionally based on count", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should conditionally render badge when count exists
    expect(source).toMatch(/count\s*[>&!]|count\s*!==|count\s*>/)
  })
})

// ============================================================
// Test 3: EmptySectionState component
// ============================================================

describe("task-prephase-004-ac3: EmptySectionState displays configurable empty message", () => {
  test("EmptySectionState component is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+EmptySectionState/)
  })

  test("EmptySectionState accepts icon prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Check for Icon prop type (Lucide icon component type)
    expect(source).toMatch(/EmptySectionState[\s\S]*?icon\s*[:\?]/)
  })

  test("EmptySectionState accepts message prop", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/EmptySectionState[\s\S]*?message\s*[:\?]/)
  })

  test("EmptySectionState uses muted color styling", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should use muted colors for empty state
    expect(source).toMatch(/text-muted|muted-foreground/)
  })
})

// ============================================================
// Test 4: usePhaseColorFromContext hook
// ============================================================

describe("task-prephase-004-ac4: usePhaseColorFromContext reads phase from Composition dataContext", () => {
  test("usePhaseColorFromContext hook is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+usePhaseColorFromContext/)
  })

  test("usePhaseColorFromContext imports usePhaseColor", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/import.*usePhaseColor/)
  })

  test("usePhaseColorFromContext returns PhaseColors type", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should return PhaseColors
    expect(source).toMatch(/PhaseColors/)
  })

  test("usePhaseColorFromContext has fallback for missing context", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should have a fallback when context is missing
    expect(source).toMatch(/fallback|default|discovery|\?\?/)
  })
})

// ============================================================
// Test 5: Module exports
// ============================================================

describe("task-prephase-004-ac5: All utilities exported from shared.tsx module", () => {
  test("SectionCard is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SectionCard/)
  })

  test("SectionHeader is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+SectionHeader/)
  })

  test("EmptySectionState is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+EmptySectionState/)
  })

  test("usePhaseColorFromContext is exported", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/export\s+(const|function)\s+usePhaseColorFromContext/)
  })
})

// ============================================================
// Test 6: CompositionContext infrastructure
// ============================================================

describe("task-prephase-004-ac6: CompositionContext provides phase to descendants", () => {
  test("CompositionContext or CompositionProvider is defined", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should have either context or provider for composition data
    expect(source).toMatch(/Composition(Context|Provider)|createContext/)
  })

  test("Context provides phase value from dataContext", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should read phase from somewhere
    expect(source).toMatch(/phase/)
  })
})

// ============================================================
// Test 7: Props types are properly defined
// ============================================================

describe("task-prephase-004: Props interfaces are defined", () => {
  test("SectionCardProps interface is defined", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/SectionCardProps|interface\s+\w*SectionCard\w*Props/)
  })

  test("SectionHeaderProps interface is defined", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/SectionHeaderProps|interface\s+\w*SectionHeader\w*Props/)
  })

  test("EmptySectionStateProps interface is defined", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/EmptySectionStateProps|interface\s+\w*EmptySection\w*Props/)
  })
})

// ============================================================
// Test 8: Uses cn utility for class merging
// ============================================================

describe("task-prephase-004: Uses cn utility for class merging", () => {
  test("imports cn from @/lib/utils", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    expect(source).toMatch(/import.*cn.*from.*@\/lib\/utils/)
  })

  test("SectionCard uses cn for className merging", () => {
    const source = fs.readFileSync(sharedPath, "utf-8")
    // Should use cn() to merge classes
    expect(source).toMatch(/cn\([\s\S]*?rounded-lg|cn\([\s\S]*?bg-card|cn\([\s\S]*?p-4/)
  })
})
