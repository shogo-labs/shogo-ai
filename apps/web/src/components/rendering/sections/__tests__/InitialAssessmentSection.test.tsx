/**
 * InitialAssessmentSection Component Tests
 * Task: task-cpv-007
 *
 * Tests verify:
 * 1. Component accepts SectionRendererProps
 * 2. Renders feature.initialAssessment with archetype badge
 * 3. Shows likelyArchetype with color-coded badge
 * 4. Dual column layout: indicators (left) and uncertainties (right)
 * 5. Uses icons (CheckCircle, AlertCircle) matching existing pattern
 * 6. Handles missing initialAssessment gracefully
 * 7. Registered in sectionImplementationMap
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import { InitialAssessmentSection } from "../InitialAssessmentSection"
import {
  sectionImplementationMap,
  type SectionRendererProps,
} from "../../sectionImplementations"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

// Test fixtures
const createFeatureWithAssessment = (overrides?: Partial<{
  initialAssessment: {
    likelyArchetype?: "domain" | "service" | "hybrid" | "infrastructure"
    indicators?: string[]
    uncertainties?: string[]
  }
}>) => ({
  id: "test-feature-001",
  name: "Test Feature",
  status: "discovery",
  initialAssessment: {
    likelyArchetype: "domain" as const,
    indicators: ["Has clear data entities", "Requires validation logic"],
    uncertainties: ["Integration complexity unknown", "Performance requirements unclear"],
    ...overrides?.initialAssessment,
  },
})

const createFeatureWithoutAssessment = () => ({
  id: "test-feature-002",
  name: "Test Feature Without Assessment",
  status: "discovery",
})

describe("InitialAssessmentSection - Basic Rendering", () => {
  test("renders without throwing errors when initialAssessment exists", () => {
    const feature = createFeatureWithAssessment()
    expect(() =>
      render(<InitialAssessmentSection feature={feature} />)
    ).not.toThrow()
  })

  test("renders section with data-testid", () => {
    const feature = createFeatureWithAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    const section = container.querySelector("[data-testid='initial-assessment-section']")
    expect(section).not.toBeNull()
  })

  test("accepts SectionRendererProps interface", () => {
    const feature = createFeatureWithAssessment()
    const config = { showHeader: true }

    // Should compile and render without errors
    expect(() =>
      render(<InitialAssessmentSection feature={feature} config={config} />)
    ).not.toThrow()
  })
})

describe("InitialAssessmentSection - Archetype Badge", () => {
  test("renders archetype badge for likelyArchetype", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: { likelyArchetype: "domain" },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    const badge = container.querySelector("[data-testid='archetype-badge-domain']")
    expect(badge).not.toBeNull()
  })

  test("renders correct archetype badge for service type", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: { likelyArchetype: "service" },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    const badge = container.querySelector("[data-testid='archetype-badge-service']")
    expect(badge).not.toBeNull()
  })

  test("renders correct archetype badge for infrastructure type", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: { likelyArchetype: "infrastructure" },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    const badge = container.querySelector("[data-testid='archetype-badge-infrastructure']")
    expect(badge).not.toBeNull()
  })

  test("renders correct archetype badge for hybrid type", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: { likelyArchetype: "hybrid" },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    const badge = container.querySelector("[data-testid='archetype-badge-hybrid']")
    expect(badge).not.toBeNull()
  })

  test("archetype badge area contains 'Likely Archetype' label", () => {
    const feature = createFeatureWithAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    expect(container.textContent).toContain("Likely Archetype")
  })
})

describe("InitialAssessmentSection - Dual Column Layout", () => {
  test("renders indicators column", () => {
    const feature = createFeatureWithAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    expect(container.textContent).toContain("Indicators")
  })

  test("renders uncertainties column", () => {
    const feature = createFeatureWithAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    expect(container.textContent).toContain("Uncertainties")
  })

  test("renders all indicator items", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        indicators: ["Indicator 1", "Indicator 2", "Indicator 3"],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    expect(container.textContent).toContain("Indicator 1")
    expect(container.textContent).toContain("Indicator 2")
    expect(container.textContent).toContain("Indicator 3")
  })

  test("renders all uncertainty items", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        uncertainties: ["Uncertainty A", "Uncertainty B"],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    expect(container.textContent).toContain("Uncertainty A")
    expect(container.textContent).toContain("Uncertainty B")
  })

  test("uses grid layout for dual columns", () => {
    const feature = createFeatureWithAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Look for a grid container within the section
    const gridContainer = container.querySelector(".grid")
    expect(gridContainer).not.toBeNull()
  })
})

describe("InitialAssessmentSection - Icons", () => {
  test("renders CheckCircle icons for indicators", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        indicators: ["Test indicator"],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Check for lucide-react CheckCircle icon (has specific class or svg structure)
    const indicatorsColumn = container.querySelector("[data-testid='indicators-column']")
    expect(indicatorsColumn).not.toBeNull()

    // CheckCircle should have green color class
    const greenIcons = indicatorsColumn?.querySelectorAll(".text-green-500")
    expect(greenIcons?.length).toBeGreaterThan(0)
  })

  test("renders AlertCircle/HelpCircle icons for uncertainties", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        uncertainties: ["Test uncertainty"],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Check for uncertainties column with amber icons
    const uncertaintiesColumn = container.querySelector("[data-testid='uncertainties-column']")
    expect(uncertaintiesColumn).not.toBeNull()

    // HelpCircle/AlertCircle should have amber color class
    const amberIcons = uncertaintiesColumn?.querySelectorAll(".text-amber-500")
    expect(amberIcons?.length).toBeGreaterThan(0)
  })
})

describe("InitialAssessmentSection - Missing Data Handling", () => {
  test("handles missing initialAssessment gracefully", () => {
    const feature = createFeatureWithoutAssessment()

    expect(() =>
      render(<InitialAssessmentSection feature={feature} />)
    ).not.toThrow()
  })

  test("renders empty state when initialAssessment is undefined", () => {
    const feature = createFeatureWithoutAssessment()
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Should render minimal/empty state without error
    const section = container.querySelector("[data-testid='initial-assessment-section']")
    expect(section).not.toBeNull()
  })

  test("handles empty indicators array", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        likelyArchetype: "domain",
        indicators: [],
        uncertainties: ["Some uncertainty"],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Should show "None identified" or similar for empty indicators
    const indicatorsColumn = container.querySelector("[data-testid='indicators-column']")
    expect(indicatorsColumn?.textContent).toContain("None identified")
  })

  test("handles empty uncertainties array", () => {
    const feature = createFeatureWithAssessment({
      initialAssessment: {
        likelyArchetype: "domain",
        indicators: ["Some indicator"],
        uncertainties: [],
      },
    })
    const { container } = render(<InitialAssessmentSection feature={feature} />)

    // Should show "None identified" or similar for empty uncertainties
    const uncertaintiesColumn = container.querySelector("[data-testid='uncertainties-column']")
    expect(uncertaintiesColumn?.textContent).toContain("None identified")
  })

  test("handles missing likelyArchetype", () => {
    const feature = {
      ...createFeatureWithAssessment(),
      initialAssessment: {
        indicators: ["Some indicator"],
        uncertainties: ["Some uncertainty"],
        // No likelyArchetype
      },
    }

    expect(() =>
      render(<InitialAssessmentSection feature={feature} />)
    ).not.toThrow()
  })
})

describe("InitialAssessmentSection - Registration", () => {
  test("is registered in sectionImplementationMap", () => {
    const component = sectionImplementationMap.get("InitialAssessmentSection")
    expect(component).toBeDefined()
    expect(component).toBe(InitialAssessmentSection)
  })
})
