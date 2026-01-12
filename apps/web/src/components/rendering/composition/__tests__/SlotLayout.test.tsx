/**
 * SlotLayout Component Tests
 * Task: task-cpv-011
 *
 * Tests verify:
 * 1. SlotLayout accepts layout: LayoutTemplate and children as Record<string, ReactNode>
 * 2. Generates CSS Grid template from slots array
 * 3. Position 'top' maps to header row, 'left' to main column, 'right' to aside column, 'bottom' to footer row
 * 4. Applies proper grid-area to each slot container
 * 5. Responsive: stacks on mobile, side-by-side on desktop
 * 6. Handles missing slot content gracefully (renders empty area)
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render } from "@testing-library/react"
import { Window } from "happy-dom"
import { SlotLayout, type SlotLayoutProps } from "../SlotLayout"

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
const createTestLayout = (slots: Array<{ name: string; position: string; required?: boolean }>) => ({
  slots,
})

const standardLayout = createTestLayout([
  { name: "header", position: "top", required: true },
  { name: "main", position: "left", required: true },
  { name: "sidebar", position: "right" },
  { name: "footer", position: "bottom" },
])

describe("SlotLayout - Basic Rendering", () => {
  test("renders without throwing errors", () => {
    expect(() =>
      render(
        <SlotLayout layout={standardLayout}>
          {{ header: <div>Header</div> }}
        </SlotLayout>
      )
    ).not.toThrow()
  })

  test("renders as a grid container", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )
    const grid = container.querySelector("[data-slot-layout]")
    expect(grid).not.toBeNull()
    expect(grid?.className).toContain("grid")
  })

  test("renders slot content when provided", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{
          header: <div>Header Content</div>,
          main: <div>Main Content</div>,
        }}
      </SlotLayout>
    )
    expect(container.textContent).toContain("Header Content")
    expect(container.textContent).toContain("Main Content")
  })
})

describe("SlotLayout - Slot Position Mapping", () => {
  test("maps 'top' position to header grid area", () => {
    const { container } = render(
      <SlotLayout layout={createTestLayout([{ name: "header", position: "top" }])}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )
    const slot = container.querySelector("[data-slot='header']")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("style")).toContain("grid-area")
    expect(slot?.getAttribute("style")).toContain("header")
  })

  test("maps 'left' position to main grid area", () => {
    const { container } = render(
      <SlotLayout layout={createTestLayout([{ name: "content", position: "left" }])}>
        {{ content: <div>Content</div> }}
      </SlotLayout>
    )
    const slot = container.querySelector("[data-slot='content']")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("style")).toContain("grid-area")
    expect(slot?.getAttribute("style")).toContain("main")
  })

  test("maps 'right' position to sidebar grid area", () => {
    const { container } = render(
      <SlotLayout layout={createTestLayout([{ name: "aside", position: "right" }])}>
        {{ aside: <div>Aside</div> }}
      </SlotLayout>
    )
    const slot = container.querySelector("[data-slot='aside']")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("style")).toContain("grid-area")
    expect(slot?.getAttribute("style")).toContain("sidebar")
  })

  test("maps 'bottom' position to actions grid area", () => {
    const { container } = render(
      <SlotLayout layout={createTestLayout([{ name: "actions", position: "bottom" }])}>
        {{ actions: <div>Actions</div> }}
      </SlotLayout>
    )
    const slot = container.querySelector("[data-slot='actions']")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("style")).toContain("grid-area")
    expect(slot?.getAttribute("style")).toContain("actions")
  })

  test("handles all four positions in standard layout", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{
          header: <div>Header</div>,
          main: <div>Main</div>,
          sidebar: <div>Sidebar</div>,
          footer: <div>Footer</div>,
        }}
      </SlotLayout>
    )

    expect(container.querySelector("[data-slot='header']")).not.toBeNull()
    expect(container.querySelector("[data-slot='main']")).not.toBeNull()
    expect(container.querySelector("[data-slot='sidebar']")).not.toBeNull()
    expect(container.querySelector("[data-slot='footer']")).not.toBeNull()
  })
})

describe("SlotLayout - Missing Content Handling", () => {
  test("renders empty slot container when content is missing", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{ header: <div>Header Only</div> }}
      </SlotLayout>
    )
    // Should still render slot containers for defined slots
    const mainSlot = container.querySelector("[data-slot='main']")
    expect(mainSlot).not.toBeNull()
    // But it should be empty (or contain nothing visible)
    expect(mainSlot?.children.length).toBe(0)
  })

  test("does not throw when children is empty object", () => {
    expect(() =>
      render(<SlotLayout layout={standardLayout}>{{}}</SlotLayout>)
    ).not.toThrow()
  })

  test("optional slots render gracefully when empty", () => {
    const layoutWithOptional = createTestLayout([
      { name: "header", position: "top", required: true },
      { name: "sidebar", position: "right", required: false },
    ])

    const { container } = render(
      <SlotLayout layout={layoutWithOptional}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const sidebarSlot = container.querySelector("[data-slot='sidebar']")
    expect(sidebarSlot).not.toBeNull()
    // Sidebar slot exists but has no content
    expect(sidebarSlot?.children.length).toBe(0)
  })
})

describe("SlotLayout - Grid Template Generation", () => {
  test("generates correct grid-template-areas for standard layout", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{
          header: <div>Header</div>,
          main: <div>Main</div>,
          sidebar: <div>Sidebar</div>,
          footer: <div>Footer</div>,
        }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    const style = grid?.getAttribute("style") || ""

    // Should contain grid-template-areas
    expect(style).toContain("grid-template-areas")
  })

  test("includes header area spanning full width when top position present", () => {
    const layoutWithTop = createTestLayout([
      { name: "header", position: "top" },
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={layoutWithTop}>
        {{
          header: <div>Header</div>,
          main: <div>Main</div>,
        }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    const style = grid?.getAttribute("style") || ""

    // Header should span both columns
    expect(style).toContain("header header")
  })
})

describe("SlotLayout - Responsive Layout", () => {
  test("has responsive grid classes for mobile stacking", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    // Should have Tailwind responsive classes
    expect(grid?.className).toMatch(/grid-cols-1|md:grid-cols/)
  })

  test("provides data attribute for responsive detection", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid?.getAttribute("data-slot-layout")).toBe("true")
  })
})

describe("SlotLayout - Custom Styling", () => {
  test("accepts className prop for additional styling", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout} className="custom-class">
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid?.className).toContain("custom-class")
  })

  test("accepts gap prop for grid spacing", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout} gap={8}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid?.className).toContain("gap-8")
  })

  test("defaults to gap-4 when no gap specified", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{ header: <div>Header</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid?.className).toContain("gap-4")
  })
})

describe("SlotLayout - Slot Stacking", () => {
  test("renders multiple components when slot receives ReactNode array", () => {
    const layout = createTestLayout([
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={layout}>
        {{
          main: [
            <div key="1">Component 1</div>,
            <div key="2">Component 2</div>,
          ],
        }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Component 1")
    expect(container.textContent).toContain("Component 2")
  })

  test("stacked components render in array order", () => {
    const layout = createTestLayout([
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={layout}>
        {{
          main: [
            <div key="first" data-testid="first">First</div>,
            <div key="second" data-testid="second">Second</div>,
            <div key="third" data-testid="third">Third</div>,
          ],
        }}
      </SlotLayout>
    )

    const slot = container.querySelector("[data-slot='main']")
    expect(slot).not.toBeNull()

    // Check order by getting all child divs
    const children = slot?.querySelectorAll("[data-testid]")
    expect(children?.length).toBe(3)
    expect(children?.[0].getAttribute("data-testid")).toBe("first")
    expect(children?.[1].getAttribute("data-testid")).toBe("second")
    expect(children?.[2].getAttribute("data-testid")).toBe("third")
  })

  test("stacked components wrap in flex column container with gap", () => {
    const layout = createTestLayout([
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={layout}>
        {{
          main: [
            <div key="1">Component 1</div>,
            <div key="2">Component 2</div>,
          ],
        }}
      </SlotLayout>
    )

    const slot = container.querySelector("[data-slot='main']")
    // The wrapper should have flex and flex-col classes
    const stackWrapper = slot?.querySelector(".flex.flex-col")
    expect(stackWrapper).not.toBeNull()
    expect(stackWrapper?.className).toContain("gap-4")
  })

  test("single component slots work unchanged (backward compatible)", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{
          header: <div>Single Header</div>,
          main: <div>Single Main</div>,
        }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Single Header")
    expect(container.textContent).toContain("Single Main")

    // Single components should NOT be wrapped in flex container
    const headerSlot = container.querySelector("[data-slot='header']")
    expect(headerSlot?.querySelector(".flex.flex-col.gap-4")).toBeNull()
  })

  test("handles mixed single and array slots in same layout", () => {
    const layout = createTestLayout([
      { name: "header", position: "top" },
      { name: "main", position: "left" },
      { name: "sidebar", position: "right" },
    ])

    const { container } = render(
      <SlotLayout layout={layout}>
        {{
          header: <div>Single Header</div>,
          main: [
            <div key="1">Stacked 1</div>,
            <div key="2">Stacked 2</div>,
          ],
          sidebar: <div>Single Sidebar</div>,
        }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Single Header")
    expect(container.textContent).toContain("Stacked 1")
    expect(container.textContent).toContain("Stacked 2")
    expect(container.textContent).toContain("Single Sidebar")
  })

  test("empty array slot renders nothing", () => {
    const layout = createTestLayout([
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={layout}>
        {{
          main: [],
        }}
      </SlotLayout>
    )

    const slot = container.querySelector("[data-slot='main']")
    expect(slot).not.toBeNull()
    expect(slot?.children.length).toBe(0)
  })
})

describe("SlotLayout - Edge Cases", () => {
  test("handles layout with single slot", () => {
    const singleSlotLayout = createTestLayout([
      { name: "main", position: "left" },
    ])

    const { container } = render(
      <SlotLayout layout={singleSlotLayout}>
        {{ main: <div>Only Main</div> }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Only Main")
  })

  test("handles layout with no slots gracefully", () => {
    const emptyLayout = createTestLayout([])

    expect(() =>
      render(<SlotLayout layout={emptyLayout}>{{}}</SlotLayout>)
    ).not.toThrow()
  })

  test("handles unknown position by using slot name as grid area", () => {
    const customPositionLayout = createTestLayout([
      { name: "custom", position: "center" },
    ])

    const { container } = render(
      <SlotLayout layout={customPositionLayout}>
        {{ custom: <div>Custom</div> }}
      </SlotLayout>
    )

    const slot = container.querySelector("[data-slot='custom']")
    expect(slot).not.toBeNull()
    // Unknown position should fall back to using slot name
    expect(slot?.getAttribute("style")).toContain("grid-area")
  })

  test("complex ReactNode children render correctly", () => {
    const { container } = render(
      <SlotLayout layout={standardLayout}>
        {{
          header: (
            <div>
              <h1>Title</h1>
              <p>Subtitle</p>
            </div>
          ),
          main: (
            <>
              <div>Part 1</div>
              <div>Part 2</div>
            </>
          ),
        }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Title")
    expect(container.textContent).toContain("Subtitle")
    expect(container.textContent).toContain("Part 1")
    expect(container.textContent).toContain("Part 2")
  })
})

// =============================================================================
// test-prephase-005: Single-Column Layout Tests (layout-single-column)
// =============================================================================
describe("SlotLayout - Single-Column Layout", () => {
  // Single-column layout fixture: single main slot at center position
  const singleColumnLayout = createTestLayout([
    { name: "main", position: "center", required: true },
  ])

  test("renders full-width main slot without multi-column grid", () => {
    const { container } = render(
      <SlotLayout layout={singleColumnLayout}>
        {{ main: <div data-testid="container-section">Full Width Content</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid).not.toBeNull()
    // Should use single column grid, not multi-column
    expect(grid?.className).toContain("grid-cols-1")
    // Should NOT have md:grid-cols-[...] for two-column layouts
    expect(grid?.className).not.toContain("md:grid-cols-[1fr_300px]")
    expect(grid?.className).not.toContain("md:grid-cols-[minmax")
  })

  test("maps 'center' position to main grid area", () => {
    const { container } = render(
      <SlotLayout layout={singleColumnLayout}>
        {{ main: <div>Center Content</div> }}
      </SlotLayout>
    )

    const slot = container.querySelector("[data-slot='main']")
    expect(slot).not.toBeNull()
    expect(slot?.getAttribute("style")).toContain("grid-area")
    expect(slot?.getAttribute("style")).toContain("main")
  })

  test("generates single area grid-template-areas for center position", () => {
    const { container } = render(
      <SlotLayout layout={singleColumnLayout}>
        {{ main: <div>Content</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    const style = grid?.getAttribute("style") || ""

    // Should contain grid-template-areas with only "main"
    expect(style).toContain("grid-template-areas")
    // The template should be simple - just "main" without multi-column structure
    expect(style).toMatch(/grid-template-areas:\s*"main"/)
  })

  test("renders container section content at full width", () => {
    const { container } = render(
      <SlotLayout layout={singleColumnLayout}>
        {{ main: <div className="w-full">Full Width Section</div> }}
      </SlotLayout>
    )

    expect(container.textContent).toContain("Full Width Section")
    const mainSlot = container.querySelector("[data-slot='main']")
    expect(mainSlot).not.toBeNull()
  })

  test("single-slot layout with left position also uses grid-cols-1", () => {
    const leftOnlyLayout = createTestLayout([
      { name: "main", position: "left", required: true },
    ])

    const { container } = render(
      <SlotLayout layout={leftOnlyLayout}>
        {{ main: <div>Left Only Content</div> }}
      </SlotLayout>
    )

    const grid = container.querySelector("[data-slot-layout]")
    expect(grid).not.toBeNull()
    // Single slot (even at left position) should use single column
    // No right slot means no need for two-column grid
    expect(grid?.className).toContain("grid-cols-1")
    // Verify the className does not include a two-column responsive class
    expect(grid?.className).not.toMatch(/md:grid-cols-\[1fr.*300px\]/)
  })
})
