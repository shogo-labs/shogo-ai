/**
 * PhaseActionsSection Component Tests
 * Task: task-cpv-010
 *
 * Tests verify:
 * 1. Component accepts SectionRendererProps (feature, config)
 * 2. Shows primary action button for phase advancement
 * 3. Determines next phase from feature.status
 * 4. Handles disabled state when phase cannot advance
 * 5. Actions area flexible for phase-specific buttons via config
 * 6. Component is registered in sectionImplementationMap
 *
 * @jest-environment happy-dom
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  mock,
} from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
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

afterEach(() => {
  cleanup()
})

// Import the component under test - will fail until implemented (RED phase)
import { PhaseActionsSection } from "../PhaseActionsSection"
import type { SectionRendererProps } from "../../sectionImplementations"

// Helper to create minimal feature props
const createFeature = (status: string) => ({
  id: "test-feature-1",
  name: "Test Feature",
  status,
})

// Helper to create section props
const createProps = (
  status: string,
  config?: Record<string, unknown>
): SectionRendererProps => ({
  feature: createFeature(status),
  config,
})

describe("PhaseActionsSection - File Structure", () => {
  test("PhaseActionsSection is exported from the module", () => {
    expect(PhaseActionsSection).toBeDefined()
    expect(typeof PhaseActionsSection).toBe("function")
  })
})

describe("PhaseActionsSection - Props Interface", () => {
  test("accepts SectionRendererProps with feature", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )
    expect(container).toBeTruthy()
  })

  test("accepts optional config prop", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", { additionalActions: [] })}
      />
    )
    expect(container).toBeTruthy()
  })

  test("renders without config prop", () => {
    const { container } = render(
      <PhaseActionsSection feature={createFeature("discovery")} />
    )
    expect(container).toBeTruthy()
  })
})

describe("PhaseActionsSection - Primary Action Button", () => {
  test("shows primary action button", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const button = container.querySelector("button")
    expect(button).not.toBeNull()
  })

  test("button shows 'Continue' text when phase can advance", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const button = container.querySelector("button")
    expect(button?.textContent?.toLowerCase()).toContain("continue")
  })

  test("button shows arrow icon when phase can advance", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    // Should have ArrowRight icon (svg)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
  })

  test("button shows 'Done' text when phase is complete", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("complete")} />
    )

    const button = container.querySelector("button")
    expect(button?.textContent?.toLowerCase()).toContain("done")
  })
})

describe("PhaseActionsSection - Phase Progression", () => {
  const PHASE_ORDER = [
    "discovery",
    "analysis",
    "classification",
    "design",
    "spec",
    "testing",
    "implementation",
    "complete",
  ]

  test("shows next phase indicator for discovery -> analysis", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("analysis")
  })

  test("shows next phase indicator for analysis -> classification", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("analysis")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("classification")
  })

  test("shows next phase indicator for classification -> design", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("classification")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("design")
  })

  test("shows next phase indicator for design -> spec", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("design")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("spec")
  })

  test("shows next phase indicator for spec -> testing", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("spec")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("testing")
  })

  test("shows next phase indicator for testing -> implementation", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("testing")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("implementation")
  })

  test("shows next phase indicator for implementation -> complete", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("implementation")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("complete")
  })

  test("shows 'Feature complete' message when at complete phase", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("complete")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("feature complete")
  })

  test("handles unknown phase status gracefully", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("unknown-phase")} />
    )

    expect(container).toBeTruthy()
  })
})

describe("PhaseActionsSection - Disabled State", () => {
  test("button is enabled when phase can advance", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const button = container.querySelector("button")
    expect(button?.disabled).toBe(false)
  })

  test("button is disabled when phase is complete", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("complete")} />
    )

    const button = container.querySelector("button")
    expect(button?.disabled).toBe(true)
  })

  test("button is disabled when phase is unknown", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("unknown-phase")} />
    )

    const button = container.querySelector("button")
    expect(button?.disabled).toBe(true)
  })
})

describe("PhaseActionsSection - Additional Actions via Config", () => {
  test("renders additional action buttons from config", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", {
          additionalActions: [
            { label: "Save Draft", variant: "outline", action: "save-draft" },
            { label: "Cancel", variant: "ghost", action: "cancel" },
          ],
        })}
      />
    )

    const buttons = container.querySelectorAll("button")
    // Primary button + 2 additional
    expect(buttons.length).toBeGreaterThanOrEqual(3)
  })

  test("additional buttons have correct labels", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", {
          additionalActions: [
            { label: "Save Draft", variant: "outline", action: "save-draft" },
          ],
        })}
      />
    )

    expect(container.textContent).toContain("Save Draft")
  })

  test("additional buttons have correct variant styling", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", {
          additionalActions: [
            { label: "Outline Button", variant: "outline", action: "outline" },
          ],
        })}
      />
    )

    // Outline variant has border-border class from button variants
    const buttons = container.querySelectorAll("button")
    const outlineButton = Array.from(buttons).find((b) =>
      b.textContent?.includes("Outline Button")
    )
    expect(outlineButton?.className).toContain("border")
  })

  test("renders without additional actions when none provided", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const buttons = container.querySelectorAll("button")
    // Just the primary button
    expect(buttons.length).toBe(1)
  })

  test("handles empty additionalActions array", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", { additionalActions: [] })}
      />
    )

    const buttons = container.querySelectorAll("button")
    expect(buttons.length).toBe(1)
  })

  test("additional buttons have data-action attribute with action identifier", () => {
    const { container } = render(
      <PhaseActionsSection
        {...createProps("discovery", {
          additionalActions: [
            { label: "Save Draft", variant: "outline", action: "save-draft" },
          ],
        })}
      />
    )

    const actionButton = container.querySelector('[data-action="save-draft"]')
    expect(actionButton).not.toBeNull()
  })
})

describe("PhaseActionsSection - Layout", () => {
  test("has border-t for top border separation", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain("border-t")
  })

  test("has flex layout for action buttons", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain("flex")
  })

  test("has justify-between for spacing", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain("justify-between")
  })

  test("has padding applied", () => {
    const { container } = render(
      <PhaseActionsSection {...createProps("discovery")} />
    )

    const wrapper = container.firstElementChild
    expect(wrapper?.className).toContain("p-4")
  })
})

describe("PhaseActionsSection - Registration", () => {
  test("component is registered in sectionImplementationMap", async () => {
    const { sectionImplementationMap } = await import(
      "../../sectionImplementations"
    )

    expect(sectionImplementationMap.has("PhaseActionsSection")).toBe(true)
  })

  test("registered component matches PhaseActionsSection", async () => {
    const { sectionImplementationMap } = await import(
      "../../sectionImplementations"
    )

    expect(sectionImplementationMap.get("PhaseActionsSection")).toBe(
      PhaseActionsSection
    )
  })
})
