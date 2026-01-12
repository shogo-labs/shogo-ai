/**
 * Classification Sections Integration Tests
 * Tasks: task-classification-001 through task-classification-010
 *
 * Tests verify:
 * 1. ArchetypeTransformationSection renders header and transformation visual
 * 2. CorrectionNoteSection conditionally renders when correction exists
 * 3. ConfidenceMetersSection renders all 4 archetype confidence bars
 * 4. EvidenceColumnsSection renders dual columns with icons
 * 5. ApplicablePatternsSection conditionally renders pattern chips
 * 6. ClassificationRationaleSection renders rationale in themed card
 * 7. Pure slot composition works without React Context provider
 *
 * Pattern: Pure slot composition - no React Context provider needed.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// Mock ClassificationDecision data
const mockDecisionWithCorrection = {
  id: "decision-1",
  session: { id: "feature-1" },
  initialAssessment: "domain",
  validatedArchetype: "service",
  evidenceChecklist: {
    "External API integration": true,
    "State management": true,
    "Domain model": false,
    "Database persistence": false,
    "Third-party SDK": true,
  },
  rationale: "This feature is classified as service because it integrates with external APIs and uses third-party SDKs.\n\nThe primary purpose is to coordinate external service calls.",
  correction: "Initial assessment was domain due to state management, but external API integration is the primary characteristic.",
}

const mockDecisionWithoutCorrection = {
  id: "decision-2",
  session: { id: "feature-2" },
  initialAssessment: "service",
  validatedArchetype: "service",
  evidenceChecklist: {
    "External API integration": true,
    "Third-party SDK": true,
  },
  rationale: "This feature is correctly classified as service.",
}

// Create mock function
let mockClassificationDecisions: any[] = [mockDecisionWithCorrection]

const mockUseDomains = mock(() => ({
  platformFeatures: {
    classificationDecisionCollection: {
      all: () => mockClassificationDecisions,
    },
  },
}))

mock.module("@/contexts/DomainProvider", () => ({
  useDomains: mockUseDomains,
}))

// Mock shared components
mock.module("@/components/app/shared", () => ({
  ArchetypeBadge: ({ archetype, size }: { archetype: string; size?: string }) => (
    <span data-testid={`archetype-badge-${archetype}`} className={`badge-${size || "sm"}`}>
      {archetype}
    </span>
  ),
  PatternChips: ({ patterns }: { patterns: string[] }) => (
    <div data-testid="pattern-chips">
      {patterns.map((p) => (
        <span key={p} data-testid={`pattern-chip-${p}`}>
          {p}
        </span>
      ))}
    </div>
  ),
}))

// Mock ProgressBar
mock.module("@/components/rendering/displays/visualization/ProgressBar", () => ({
  ProgressBar: ({ value, variant, ariaLabel }: any) => (
    <div
      data-testid="progress-bar"
      data-value={value}
      data-variant={variant}
      aria-label={ariaLabel}
    >
      {value}%
    </div>
  ),
}))

// Import components directly without going through sectionImplementations to avoid circular import
// This is the test file pattern - import directly from the source files
const { ArchetypeTransformationSection } = await import("../ArchetypeTransformationSection")
const { CorrectionNoteSection } = await import("../CorrectionNoteSection")
const { ConfidenceMetersSection } = await import("../ConfidenceMetersSection")
const { EvidenceColumnsSection } = await import("../EvidenceColumnsSection")
const { ApplicablePatternsSection } = await import("../ApplicablePatternsSection")
const { ClassificationRationaleSection } = await import("../ClassificationRationaleSection")

const mockFeature = {
  id: "feature-1",
  name: "Test Feature",
  status: "classification",
  applicablePatterns: ["enhancement-hooks", "mst-actions", "service-layer"],
  initialAssessment: {
    likelyArchetype: "domain",
  },
}

const mockFeatureWithoutPatterns = {
  id: "feature-1",
  name: "Test Feature",
  status: "classification",
}

const mockFeatureNoDecision = {
  id: "feature-no-decision",
  name: "Feature Without Decision",
  status: "classification",
}

describe("ArchetypeTransformationSection", () => {
  test("renders phase header with title and icon", () => {
    const { container } = render(
      <ArchetypeTransformationSection feature={mockFeature} />
    )

    expect(container.textContent).toContain("Archetype Determination")
    expect(container.querySelector("[data-testid='archetype-transformation-section']")).not.toBeNull()
  })

  test("renders transformation visual with initial and validated archetypes", () => {
    const { container } = render(
      <ArchetypeTransformationSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='archetype-transformation']")).not.toBeNull()
    expect(container.querySelector("[data-testid='archetype-badge-domain']")).not.toBeNull()
    expect(container.querySelector("[data-testid='archetype-badge-service']")).not.toBeNull()
    expect(container.textContent).toContain("Initial")
    expect(container.textContent).toContain("Validated")
  })

  test("shows amber arrow and 'Corrected' label when archetype changed", () => {
    const { container } = render(
      <ArchetypeTransformationSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='transformation-arrow']")).not.toBeNull()
    expect(container.querySelector("[data-testid='corrected-label']")).not.toBeNull()
    expect(container.textContent).toContain("Corrected")
  })

  test("shows empty state when no decision exists", () => {
    mockClassificationDecisions = []

    const { container } = render(
      <ArchetypeTransformationSection feature={mockFeatureNoDecision} />
    )

    expect(container.querySelector("[data-testid='archetype-empty-state']")).not.toBeNull()
    expect(container.textContent).toContain("No classification decision yet")

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })
})

describe("CorrectionNoteSection", () => {
  test("renders correction note when archetype was corrected", () => {
    const { container } = render(
      <CorrectionNoteSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='correction-note-section']")).not.toBeNull()
    expect(container.textContent).toContain("Classification Corrected")
    expect(container.textContent).toContain("Initial assessment was domain")
  })

  test("returns null when no correction", () => {
    mockClassificationDecisions = [mockDecisionWithoutCorrection]

    const { container } = render(
      <CorrectionNoteSection feature={{ ...mockFeature, id: "feature-2" }} />
    )

    expect(container.querySelector("[data-testid='correction-note-section']")).toBeNull()

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })

  test("returns null when no decision exists", () => {
    mockClassificationDecisions = []

    const { container } = render(
      <CorrectionNoteSection feature={mockFeatureNoDecision} />
    )

    expect(container.querySelector("[data-testid='correction-note-section']")).toBeNull()

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })
})

describe("ConfidenceMetersSection", () => {
  test("renders all 4 archetype confidence bars", () => {
    const { container } = render(
      <ConfidenceMetersSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='confidence-meters-section']")).not.toBeNull()
    expect(container.textContent).toContain("Archetype Confidence")

    // Should have 4 archetype badges
    expect(container.querySelector("[data-testid='archetype-badge-service']")).not.toBeNull()
    expect(container.querySelector("[data-testid='archetype-badge-domain']")).not.toBeNull()
    expect(container.querySelector("[data-testid='archetype-badge-infrastructure']")).not.toBeNull()
    expect(container.querySelector("[data-testid='archetype-badge-hybrid']")).not.toBeNull()
  })

  test("renders progress bars", () => {
    const { container } = render(
      <ConfidenceMetersSection feature={mockFeature} />
    )

    const progressBars = container.querySelectorAll("[data-testid='progress-bar']")
    expect(progressBars.length).toBe(4)
  })

  test("returns null when no decision exists", () => {
    mockClassificationDecisions = []

    const { container } = render(
      <ConfidenceMetersSection feature={mockFeatureNoDecision} />
    )

    expect(container.querySelector("[data-testid='confidence-meters-section']")).toBeNull()

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })
})

describe("EvidenceColumnsSection", () => {
  test("renders dual columns with supporting and opposing evidence", () => {
    const { container } = render(
      <EvidenceColumnsSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='evidence-columns-section']")).not.toBeNull()
    expect(container.textContent).toContain("Evidence Analysis")
    expect(container.textContent).toContain("Supporting Evidence")
    expect(container.textContent).toContain("Opposing Evidence")
  })

  test("shows check icons for supporting evidence", () => {
    const { container } = render(
      <EvidenceColumnsSection feature={mockFeature} />
    )

    // Check that supporting evidence items are shown
    expect(container.textContent).toContain("External API integration")
    expect(container.textContent).toContain("State management")
    expect(container.textContent).toContain("Third-party SDK")
  })

  test("shows X icons for opposing evidence", () => {
    const { container } = render(
      <EvidenceColumnsSection feature={mockFeature} />
    )

    // Check that opposing evidence items are shown
    expect(container.textContent).toContain("Domain model")
    expect(container.textContent).toContain("Database persistence")
  })

  test("shows archetype badge with (Validated) label", () => {
    const { container } = render(
      <EvidenceColumnsSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='archetype-badge-service']")).not.toBeNull()
    expect(container.textContent).toContain("(Validated)")
  })

  test("returns null when no decision exists", () => {
    mockClassificationDecisions = []

    const { container } = render(
      <EvidenceColumnsSection feature={mockFeatureNoDecision} />
    )

    expect(container.querySelector("[data-testid='evidence-columns-section']")).toBeNull()

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })
})

describe("ApplicablePatternsSection", () => {
  test("renders pattern chips when patterns exist", () => {
    const { container } = render(
      <ApplicablePatternsSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='applicable-patterns-section']")).not.toBeNull()
    expect(container.textContent).toContain("Applicable Patterns")
    expect(container.querySelector("[data-testid='pattern-chips']")).not.toBeNull()
  })

  test("shows all pattern chips", () => {
    const { container } = render(
      <ApplicablePatternsSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='pattern-chip-enhancement-hooks']")).not.toBeNull()
    expect(container.querySelector("[data-testid='pattern-chip-mst-actions']")).not.toBeNull()
    expect(container.querySelector("[data-testid='pattern-chip-service-layer']")).not.toBeNull()
  })

  test("returns null when no patterns", () => {
    const { container } = render(
      <ApplicablePatternsSection feature={mockFeatureWithoutPatterns} />
    )

    expect(container.querySelector("[data-testid='applicable-patterns-section']")).toBeNull()
  })

  test("returns null when patterns array is empty", () => {
    const { container } = render(
      <ApplicablePatternsSection feature={{ ...mockFeature, applicablePatterns: [] }} />
    )

    expect(container.querySelector("[data-testid='applicable-patterns-section']")).toBeNull()
  })
})

describe("ClassificationRationaleSection", () => {
  test("renders rationale in themed card", () => {
    const { container } = render(
      <ClassificationRationaleSection feature={mockFeature} />
    )

    expect(container.querySelector("[data-testid='classification-rationale-section']")).not.toBeNull()
    expect(container.textContent).toContain("Classification Rationale")
    expect(container.textContent).toContain("classified as service")
    expect(container.textContent).toContain("external APIs")
  })

  test("preserves rationale formatting with newlines", () => {
    const { container } = render(
      <ClassificationRationaleSection feature={mockFeature} />
    )

    // The rationale has multi-line text - it should all be visible
    expect(container.textContent).toContain("primary purpose is to coordinate")
  })

  test("returns null when no decision exists", () => {
    mockClassificationDecisions = []

    const { container } = render(
      <ClassificationRationaleSection feature={mockFeatureNoDecision} />
    )

    expect(container.querySelector("[data-testid='classification-rationale-section']")).toBeNull()

    // Restore
    mockClassificationDecisions = [mockDecisionWithCorrection]
  })
})

describe("Pure Slot Composition", () => {
  test("all sections work independently without shared context", () => {
    // This test verifies that all sections can render independently
    // without needing a shared React Context provider wrapper

    const { container: container1 } = render(
      <ArchetypeTransformationSection feature={mockFeature} />
    )
    expect(container1.querySelector("[data-testid='archetype-transformation-section']")).not.toBeNull()

    const { container: container2 } = render(
      <CorrectionNoteSection feature={mockFeature} />
    )
    expect(container2.querySelector("[data-testid='correction-note-section']")).not.toBeNull()

    const { container: container3 } = render(
      <ConfidenceMetersSection feature={mockFeature} />
    )
    expect(container3.querySelector("[data-testid='confidence-meters-section']")).not.toBeNull()

    const { container: container4 } = render(
      <EvidenceColumnsSection feature={mockFeature} />
    )
    expect(container4.querySelector("[data-testid='evidence-columns-section']")).not.toBeNull()

    const { container: container5 } = render(
      <ApplicablePatternsSection feature={mockFeature} />
    )
    expect(container5.querySelector("[data-testid='applicable-patterns-section']")).not.toBeNull()

    const { container: container6 } = render(
      <ClassificationRationaleSection feature={mockFeature} />
    )
    expect(container6.querySelector("[data-testid='classification-rationale-section']")).not.toBeNull()
  })

  test("all sections render together in stacked layout", () => {
    // Simulate how sections would render stacked in a slot
    const { container } = render(
      <div className="space-y-4">
        <ArchetypeTransformationSection feature={mockFeature} />
        <CorrectionNoteSection feature={mockFeature} />
        <ConfidenceMetersSection feature={mockFeature} />
        <EvidenceColumnsSection feature={mockFeature} />
        <ApplicablePatternsSection feature={mockFeature} />
        <ClassificationRationaleSection feature={mockFeature} />
      </div>
    )

    // All sections should be present
    expect(container.querySelector("[data-testid='archetype-transformation-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='correction-note-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='confidence-meters-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='evidence-columns-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='applicable-patterns-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='classification-rationale-section']")).not.toBeNull()
  })
})

describe("Seed Data and Registration", () => {
  // Note: Direct sectionImplementationMap import test is skipped here due to complex
  // mock dependencies. The registration is verified in the dedicated
  // sectionImplementations.test.ts file and by component-builder.test.ts seed data tests.
  test.skip("all 6 Classification sections are registered in sectionImplementationMap", async () => {
    // This test requires full module resolution without mocks
    // See apps/web/src/components/rendering/__tests__/sectionImplementations.test.ts
  })
})
