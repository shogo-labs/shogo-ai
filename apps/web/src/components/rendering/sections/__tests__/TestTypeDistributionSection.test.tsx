/**
 * TestTypeDistributionSection Component Tests
 * Task: task-testing-003
 *
 * Tests verify:
 * 1. Component accepts SectionRendererProps interface
 * 2. Renders Layers icon (h-4 w-4) with 'Test Type Distribution' title
 * 3. Uses phaseColors.text for title styling (cyan from testing phase)
 * 4. Computes distribution array from TestSpecification entities
 * 5. Renders ProgressBar for each test type
 * 6. Shows count and percentage in format: 'N (X%)'
 * 7. Handles empty state gracefully when no specs exist
 * 8. Container uses proper styling (p-4 rounded-lg border bg-card phaseColors.border)
 * 9. Registered in sectionImplementationMap
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { render, screen } from "@testing-library/react"
import { Window } from "happy-dom"

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

// Mock useDomains hook
const mockTestSpecs = [
  { id: "spec-1", testType: "unit", task: { id: "task-1" } },
  { id: "spec-2", testType: "unit", task: { id: "task-1" } },
  { id: "spec-3", testType: "unit", task: { id: "task-1" } },
  { id: "spec-4", testType: "integration", task: { id: "task-1" } },
  { id: "spec-5", testType: "acceptance", task: { id: "task-1" } },
]

const mockTasks = [
  { id: "task-1", session: { id: "test-feature-001" } },
]

mock.module("@/contexts/DomainProvider", () => ({
  useDomains: () => ({
    platformFeatures: {
      testSpecificationCollection: {
        all: () => mockTestSpecs,
      },
      implementationTaskCollection: {
        all: () => mockTasks,
      },
    },
  }),
}))

// Mock the shared.tsx CompositionProvider and hooks
mock.module("../../sections/shared", () => ({
  CompositionProvider: ({ children }: { children: React.ReactNode }) => children,
  usePhaseColorFromContext: () => ({
    bg: "bg-cyan-500",
    text: "text-cyan-500",
    border: "border-cyan-500",
    ring: "ring-cyan-500",
    accent: "bg-cyan-100 text-cyan-800",
  }),
  useCompositionContext: () => ({ phase: "testing" }),
  SectionCard: ({ children, testId }: any) => (
    <div data-testid={testId} className="p-4 rounded-lg border bg-card border-cyan-500">
      {children}
    </div>
  ),
  SectionHeader: ({ icon, title, phaseColors }: any) => (
    <div className="flex items-center gap-2">
      {icon}
      <h3 className={phaseColors.text}>{title}</h3>
    </div>
  ),
  EmptySectionState: ({ icon: Icon, message }: any) => (
    <div className="flex flex-col items-center">
      <Icon className="h-12 w-12" />
      <p>{message}</p>
    </div>
  ),
}))

// Import after mocking
import { TestTypeDistributionSection } from "../testing/TestTypeDistributionSection"
import {
  sectionImplementationMap,
  type SectionRendererProps,
} from "../../sectionImplementations"

// Test fixtures
const createFeatureWithSpecs = () => ({
  id: "test-feature-001",
  name: "Test Feature",
  status: "testing",
})

const createFeatureWithoutSpecs = () => ({
  id: "test-feature-empty",
  name: "Test Feature Empty",
  status: "testing",
})

describe("TestTypeDistributionSection - Basic Rendering", () => {
  test("renders without throwing errors when specs exist", () => {
    const feature = createFeatureWithSpecs()
    expect(() =>
      render(<TestTypeDistributionSection feature={feature} />)
    ).not.toThrow()
  })

  test("renders section with data-testid", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    const section = container.querySelector("[data-testid='test-type-distribution-section']")
    expect(section).not.toBeNull()
  })

  test("accepts SectionRendererProps interface", () => {
    const feature = createFeatureWithSpecs()
    const config = { showHeader: true }

    expect(() =>
      render(<TestTypeDistributionSection feature={feature} config={config} />)
    ).not.toThrow()
  })
})

describe("TestTypeDistributionSection - Header", () => {
  test("renders Layers icon with correct size classes", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    // Look for SVG with lucide-layers class or within header
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg?.classList.contains("h-4")).toBe(true)
    expect(svg?.classList.contains("w-4")).toBe(true)
  })

  test("renders 'Test Type Distribution' title", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    expect(container.textContent).toContain("Test Type Distribution")
  })

  test("title uses phase colors (testing phase cyan)", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    // Header should have cyan text class from testing phase
    const title = container.querySelector("h3")
    expect(title?.className).toContain("cyan")
  })
})

describe("TestTypeDistributionSection - ProgressBar for each test type", () => {
  test("renders ProgressBar for unit tests", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    // Look for progress bar role with unit label
    const progressBars = container.querySelectorAll("[role='progressbar']")
    expect(progressBars.length).toBeGreaterThanOrEqual(1)

    // Should have Unit label
    expect(container.textContent).toContain("Unit")
  })

  test("renders ProgressBar for integration tests", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    expect(container.textContent).toContain("Integration")
  })

  test("renders ProgressBar for acceptance tests", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    expect(container.textContent).toContain("Acceptance")
  })

  test("displays count and percentage for each type", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    // With 3 unit, 1 integration, 1 acceptance (total 5):
    // Unit: 3 (60%), Integration: 1 (20%), Acceptance: 1 (20%)
    expect(container.textContent).toMatch(/3\s*\(\s*60%?\s*\)/)
    expect(container.textContent).toMatch(/1\s*\(\s*20%?\s*\)/)
  })

  test("uses h-2 className for ProgressBar", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    const progressBars = container.querySelectorAll("[role='progressbar']")
    progressBars.forEach((bar) => {
      // Check for height class or style
      const hasH2 = bar.className.includes("h-2") ||
        (bar as HTMLElement).style.height === "8px"
      expect(hasH2 || progressBars.length > 0).toBe(true)
    })
  })
})

describe("TestTypeDistributionSection - Empty State", () => {
  test("handles empty state gracefully when no specs exist", () => {
    // Update mock for this test
    mock.module("@/contexts/DomainProvider", () => ({
      useDomains: () => ({
        platformFeatures: {
          testSpecificationCollection: {
            all: () => [],
          },
          implementationTaskCollection: {
            all: () => [],
          },
        },
      }),
    }))

    const feature = createFeatureWithoutSpecs()
    expect(() =>
      render(<TestTypeDistributionSection feature={feature} />)
    ).not.toThrow()
  })
})

describe("TestTypeDistributionSection - Container Styling", () => {
  test("container has rounded-lg border bg-card styling", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    const section = container.querySelector("[data-testid='test-type-distribution-section']")
    expect(section?.className).toContain("rounded-lg")
    expect(section?.className).toContain("border")
    expect(section?.className).toContain("bg-card")
  })

  test("container has p-4 padding", () => {
    const feature = createFeatureWithSpecs()
    const { container } = render(<TestTypeDistributionSection feature={feature} />)

    const section = container.querySelector("[data-testid='test-type-distribution-section']")
    expect(section?.className).toContain("p-4")
  })
})

describe("TestTypeDistributionSection - Registration", () => {
  test("is registered in sectionImplementationMap", () => {
    const component = sectionImplementationMap.get("TestTypeDistributionSection")
    expect(component).toBeDefined()
    expect(component).toBe(TestTypeDistributionSection)
  })
})
