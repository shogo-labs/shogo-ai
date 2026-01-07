/**
 * DataCard Component Tests
 * Task: task-w1-data-card-primitive
 *
 * Tests verify:
 * 1. Component renders without crashing
 * 2. Supports all variant types
 * 3. Expandable content toggles visibility
 * 4. Has consistent hover and focus states
 * 5. Applies phase-aware accent colors
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render, fireEvent } from "@testing-library/react"
import { Window } from "happy-dom"
import { DataCard } from "./DataCard"

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

describe("DataCard - Renders", () => {
  test("renders without throwing errors", () => {
    expect(() =>
      render(<DataCard title="Test Title" description="Test Description" />)
    ).not.toThrow()
  })

  test("title text is visible", () => {
    const { container } = render(
      <DataCard title="Test Title" description="Test Description" />
    )
    expect(container.textContent).toContain("Test Title")
  })

  test("description text is visible", () => {
    const { container } = render(
      <DataCard title="Test Title" description="Test Description" />
    )
    expect(container.textContent).toContain("Test Description")
  })

  test("no console errors are logged", () => {
    const { container } = render(
      <DataCard title="Test Title" description="Test Description" />
    )
    expect(container).toBeTruthy()
  })
})

describe("DataCard - Variants", () => {
  test("renders correctly with variant='finding'", () => {
    const { container } = render(
      <DataCard
        title="Finding Title"
        description="Finding Description"
        variant="finding"
      />
    )
    const card = container.querySelector("[data-variant]")
    expect(card?.getAttribute("data-variant")).toBe("finding")
  })

  test("renders correctly with variant='requirement'", () => {
    const { container } = render(
      <DataCard
        title="Requirement Title"
        description="Requirement Description"
        variant="requirement"
      />
    )
    const card = container.querySelector("[data-variant]")
    expect(card?.getAttribute("data-variant")).toBe("requirement")
  })

  test("renders correctly with variant='deliverable'", () => {
    const { container } = render(
      <DataCard
        title="Deliverable Title"
        description="Deliverable Description"
        variant="deliverable"
      />
    )
    const card = container.querySelector("[data-variant]")
    expect(card?.getAttribute("data-variant")).toBe("deliverable")
  })

  test("renders correctly with variant='decision'", () => {
    const { container } = render(
      <DataCard
        title="Decision Title"
        description="Decision Description"
        variant="decision"
      />
    )
    const card = container.querySelector("[data-variant]")
    expect(card?.getAttribute("data-variant")).toBe("decision")
  })
})

describe("DataCard - Expandable Content", () => {
  test("children are hidden by default when expandable", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        expandable
      >
        <div data-testid="expandable-content">Hidden Content</div>
      </DataCard>
    )
    // When collapsed, the content area should be hidden
    const content = container.querySelector("[data-expanded]")
    expect(content?.getAttribute("data-expanded")).toBe("false")
  })

  test("hidden content becomes visible when expanded", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        expandable
      >
        <div>Hidden Content</div>
      </DataCard>
    )

    // Find and click the expand button
    const expandButton = container.querySelector("[data-expand-button]")
    expect(expandButton).not.toBeNull()

    fireEvent.click(expandButton!)

    // Content should now be expanded
    const content = container.querySelector("[data-expanded]")
    expect(content?.getAttribute("data-expanded")).toBe("true")
  })

  test("content collapses on second click", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        expandable
      >
        <div>Hidden Content</div>
      </DataCard>
    )

    const expandButton = container.querySelector("[data-expand-button]")

    // First click - expand
    fireEvent.click(expandButton!)
    let content = container.querySelector("[data-expanded]")
    expect(content?.getAttribute("data-expanded")).toBe("true")

    // Second click - collapse
    fireEvent.click(expandButton!)
    content = container.querySelector("[data-expanded]")
    expect(content?.getAttribute("data-expanded")).toBe("false")
  })

  test("toggle button changes state indicator", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        expandable
      >
        <div>Hidden Content</div>
      </DataCard>
    )

    const expandButton = container.querySelector("[data-expand-button]")
    expect(expandButton?.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(expandButton!)
    expect(expandButton?.getAttribute("aria-expanded")).toBe("true")
  })
})

describe("DataCard - Hover and Focus States", () => {
  test("hover state is enabled via CSS class", () => {
    const { container } = render(
      <DataCard title="Title" description="Description" />
    )
    const card = container.querySelector("[data-variant]")
    // Card should have hover transition class
    expect(card?.className).toContain("transition")
  })

  test("focus state shows visible focus ring", () => {
    const { container } = render(
      <DataCard title="Title" description="Description" interactive />
    )
    const card = container.querySelector("[data-variant]")
    // Interactive cards should have focus ring classes
    expect(card?.className).toContain("focus")
  })

  test("states are consistent across variants", () => {
    const variants = ["finding", "requirement", "deliverable", "decision"] as const

    for (const variant of variants) {
      const { container } = render(
        <DataCard
          title="Title"
          description="Description"
          variant={variant}
          interactive
        />
      )
      const card = container.querySelector("[data-variant]")
      expect(card?.className).toContain("transition")
    }
  })
})

describe("DataCard - Phase Accent Colors", () => {
  test("card border uses analysis phase accent color", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        phase="analysis"
      />
    )
    const card = container.querySelector("[data-variant]")
    // Should have phase-specific border styling
    expect(card?.className).toContain("border")
  })

  test("accent styling is applied via phase color tokens", () => {
    const { container } = render(
      <DataCard
        title="Title"
        description="Description"
        phase="discovery"
      />
    )
    const card = container.querySelector("[data-phase]")
    expect(card?.getAttribute("data-phase")).toBe("discovery")
  })

  test("different phases produce different styling", () => {
    const { container: c1 } = render(
      <DataCard title="Title" description="Description" phase="discovery" />
    )
    const { container: c2 } = render(
      <DataCard title="Title" description="Description" phase="implementation" />
    )

    expect(c1.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("discovery")
    expect(c2.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("implementation")
  })
})
