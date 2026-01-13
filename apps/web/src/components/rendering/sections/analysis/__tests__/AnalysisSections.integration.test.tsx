/**
 * Analysis Sections Integration Tests
 * Task: task-analysis-002, task-analysis-003, task-analysis-004, task-analysis-005
 *
 * Tests verify:
 * 1. EvidenceBoardHeaderSection renders with finding count and view toggle
 * 2. LocationHeatBarSection renders stacked progress bar
 * 3. FindingMatrixSection renders type x location grid
 * 4. FindingListSection renders filtered/grouped findings
 * 5. Cross-section coordination via AnalysisPanelContext
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"
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

// Mock useDomains hook
const mockFindings = [
  { id: "f1", type: "pattern", name: "Pattern 1", description: "Desc 1", location: "packages/state-api/src/foo.ts" },
  { id: "f2", type: "pattern", name: "Pattern 2", description: "Desc 2", location: "packages/state-api/src/bar.ts" },
  { id: "f3", type: "gap", name: "Gap 1", description: "Desc 3", location: "apps/web/src/component.tsx" },
  { id: "f4", type: "risk", name: "Risk 1", description: "Desc 4", location: "apps/web/src/page.tsx" },
]

const mockUseDomains = mock(() => ({
  platformFeatures: {
    analysisFindingCollection: {
      findBySession: () => mockFindings,
    },
  },
}))

mock.module("@/contexts/DomainProvider", () => ({
  useDomains: mockUseDomains,
}))

// Mock ComponentRegistryContext to avoid PropertyRenderer errors
mock.module("@/components/rendering/ComponentRegistryContext", () => ({
  useComponentRegistry: () => ({
    resolve: () => ({ value }: any) => <span>{String(value)}</span>,
    getEntry: () => ({
      component: ({ value }: any) => <span>{String(value)}</span>,
      metadata: {},
    }),
  }),
  ComponentRegistryProvider: ({ children }: any) => children,
}))

// Mock the shared FindingCard to avoid PropertyRenderer dependency chain
mock.module("@/components/app/shared", () => ({
  findingTypeBadgeVariants: ({ type }: { type: string }) =>
    `finding-badge-${type}`,
  FindingCard: ({ finding }: { finding: any }) => (
    <div data-testid={`finding-card-${finding.id}`}>
      <span className={`finding-badge-${finding.type}`}>{finding.type}</span>
      <span>{finding.name}</span>
      <span>{finding.description}</span>
    </div>
  ),
}))

// Import after mocking
import { AnalysisPanelProvider, useAnalysisPanelContext } from "../AnalysisPanelContext"
import { EvidenceBoardHeaderSection } from "../EvidenceBoardHeaderSection"
import { LocationHeatBarSection } from "../LocationHeatBarSection"
import { FindingMatrixSection } from "../FindingMatrixSection"
import { FindingListSection } from "../FindingListSection"

const mockFeature = {
  id: "feature-1",
  name: "Test Feature",
  status: "analysis",
}

describe("EvidenceBoardHeaderSection", () => {
  test("renders with correct structure", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <EvidenceBoardHeaderSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='evidence-board-header']")).not.toBeNull()
    expect(container.textContent).toContain("Evidence Board")
    expect(container.textContent).toContain("4 findings") // mock has 4 findings
  })

  test("shows view mode toggle buttons", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <EvidenceBoardHeaderSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='view-mode-matrix']")).not.toBeNull()
    expect(container.querySelector("[data-testid='view-mode-list']")).not.toBeNull()
  })

  test("toggles view mode on button click", () => {
    function TestWrapper() {
      const { viewMode } = useAnalysisPanelContext()
      return (
        <div>
          <span data-testid="mode">{viewMode}</span>
          <EvidenceBoardHeaderSection feature={mockFeature} />
        </div>
      )
    }

    const { getByTestId } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <TestWrapper />
      </AnalysisPanelProvider>
    )

    expect(getByTestId("mode").textContent).toBe("matrix")

    act(() => {
      getByTestId("view-mode-list").click()
    })

    expect(getByTestId("mode").textContent).toBe("list")
  })
})

describe("LocationHeatBarSection", () => {
  test("renders stacked progress bar with legend", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <LocationHeatBarSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='location-heat-bar']")).not.toBeNull()
    expect(container.textContent).toContain("Location Distribution")
    // Should show package names in legend
    expect(container.textContent).toContain("state-api")
    expect(container.textContent).toContain("web")
  })

  test("returns null when no findings", () => {
    mockUseDomains.mockReturnValueOnce({
      platformFeatures: {
        analysisFindingCollection: {
          findBySession: () => [],
        },
      },
    })

    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <LocationHeatBarSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='location-heat-bar']")).toBeNull()
  })
})

describe("FindingMatrixSection", () => {
  test("renders matrix in matrix view mode", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <FindingMatrixSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='finding-matrix-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='finding-type-matrix']")).not.toBeNull()
    expect(container.textContent).toContain("Finding Matrix")
  })

  test("hides in list view mode", () => {
    function TestWrapper() {
      return (
        <>
          <EvidenceBoardHeaderSection feature={mockFeature} />
          <FindingMatrixSection feature={mockFeature} />
        </>
      )
    }

    const { container, getByTestId } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <TestWrapper />
      </AnalysisPanelProvider>
    )

    // Initially in matrix mode
    expect(container.querySelector("[data-testid='finding-matrix-section']")).not.toBeNull()

    // Switch to list mode
    act(() => {
      getByTestId("view-mode-list").click()
    })

    // Matrix should be hidden
    expect(container.querySelector("[data-testid='finding-matrix-section']")).toBeNull()
  })

  test("shows type badges in rows", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <FindingMatrixSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    // Should show type badges (PAT, GAP, RSK for our mock data)
    expect(container.textContent).toContain("PAT")
    expect(container.textContent).toContain("GAP")
    expect(container.textContent).toContain("RSK")
  })
})

describe("FindingListSection", () => {
  test("shows empty state when no findings", () => {
    mockUseDomains.mockReturnValueOnce({
      platformFeatures: {
        analysisFindingCollection: {
          findBySession: () => [],
        },
      },
    })

    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <FindingListSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    expect(container.querySelector("[data-testid='finding-list-empty']")).not.toBeNull()
    expect(container.textContent).toContain("No findings captured yet")
  })

  test("hides in matrix mode without filter", () => {
    const { container } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <FindingListSection feature={mockFeature} />
      </AnalysisPanelProvider>
    )

    // Default mode is matrix, list should be hidden
    expect(container.querySelector("[data-testid='finding-list-section']")).toBeNull()
  })

  test("shows list in list mode", () => {
    function TestWrapper() {
      return (
        <>
          <EvidenceBoardHeaderSection feature={mockFeature} />
          <FindingListSection feature={mockFeature} />
        </>
      )
    }

    const { container, getByTestId } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <TestWrapper />
      </AnalysisPanelProvider>
    )

    // Switch to list mode
    act(() => {
      getByTestId("view-mode-list").click()
    })

    // List should be visible
    expect(container.querySelector("[data-testid='finding-list-section']")).not.toBeNull()
    expect(container.textContent).toContain("All Findings")
  })
})

describe("Cross-Section Coordination", () => {
  test("header toggle updates matrix and list visibility", () => {
    function AllSections() {
      return (
        <>
          <EvidenceBoardHeaderSection feature={mockFeature} />
          <FindingMatrixSection feature={mockFeature} />
          <FindingListSection feature={mockFeature} />
        </>
      )
    }

    const { container, getByTestId } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <AllSections />
      </AnalysisPanelProvider>
    )

    // Initial state: matrix mode
    expect(container.querySelector("[data-testid='finding-matrix-section']")).not.toBeNull()
    expect(container.querySelector("[data-testid='finding-list-section']")).toBeNull()

    // Switch to list mode
    act(() => {
      getByTestId("view-mode-list").click()
    })

    // Matrix hidden, list shown
    expect(container.querySelector("[data-testid='finding-matrix-section']")).toBeNull()
    expect(container.querySelector("[data-testid='finding-list-section']")).not.toBeNull()
  })

  test("matrix filter shows filtered list", () => {
    function AllSections() {
      const { activeFilter, setActiveFilter } = useAnalysisPanelContext()
      return (
        <>
          <span data-testid="filter-status">
            {activeFilter.type || "none"}-{activeFilter.location || "none"}
          </span>
          <button
            data-testid="set-filter"
            onClick={() => setActiveFilter({ type: "pattern", location: "state-api" })}
          >
            Set Filter
          </button>
          <FindingMatrixSection feature={mockFeature} />
          <FindingListSection feature={mockFeature} />
        </>
      )
    }

    const { container, getByTestId } = render(
      <AnalysisPanelProvider feature={mockFeature}>
        <AllSections />
      </AnalysisPanelProvider>
    )

    // No filter initially
    expect(getByTestId("filter-status").textContent).toBe("none-none")
    expect(container.querySelector("[data-testid='finding-list-section']")).toBeNull()

    // Set filter
    act(() => {
      getByTestId("set-filter").click()
    })

    // Filter applied, list should appear with filtered findings
    expect(getByTestId("filter-status").textContent).toBe("pattern-state-api")
    expect(container.querySelector("[data-testid='finding-list-section']")).not.toBeNull()
    expect(container.textContent).toContain("Filtered by")
    expect(container.textContent).toContain("Patterns")
    expect(container.textContent).toContain("state-api")
  })
})
