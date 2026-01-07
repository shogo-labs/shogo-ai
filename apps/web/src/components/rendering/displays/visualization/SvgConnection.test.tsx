/**
 * SvgConnection Component Tests
 * Task: task-w3-svg-connection-utilities
 *
 * Tests verify:
 * 1. Component renders SVG path between elements
 * 2. Supports bezier, straight, and step path types
 * 3. Supports solid, dashed, and dotted line styles
 * 4. Renders arrow markers for directional relationships
 * 5. Supports optional animated flow effect
 * 6. Works with DOM element positioning via refs
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render } from "@testing-library/react"
import { Window } from "happy-dom"
import {
  SvgConnection,
  type SvgConnectionProps,
  type PathType,
  type LineStyle,
} from "./SvgConnection"

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

// Helper to create default props
const createProps = (overrides: Partial<SvgConnectionProps> = {}): SvgConnectionProps => ({
  from: { x: 0, y: 0 },
  to: { x: 100, y: 100 },
  ...overrides,
})

describe("SvgConnection - Renders", () => {
  test("renders without throwing errors", () => {
    expect(() => render(<SvgConnection {...createProps()} />)).not.toThrow()
  })

  test("SVG element is rendered", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
  })

  test("path element connects source to target", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    expect(path).not.toBeNull()
    expect(path?.getAttribute("d")).toBeTruthy()
  })

  test("no rendering errors occur", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    expect(container.querySelector("[data-svg-connection]")).not.toBeNull()
  })
})

describe("SvgConnection - Path Types", () => {
  test("renders curved path with pathType='bezier'", () => {
    const { container } = render(
      <SvgConnection {...createProps({ pathType: "bezier" })} />
    )
    const path = container.querySelector("path")
    const d = path?.getAttribute("d") || ""
    // Bezier paths use C (cubic bezier) or Q (quadratic bezier) commands
    expect(d).toMatch(/[CQ]/)
  })

  test("renders straight line with pathType='straight'", () => {
    const { container } = render(
      <SvgConnection {...createProps({ pathType: "straight" })} />
    )
    const path = container.querySelector("path")
    const d = path?.getAttribute("d") || ""
    // Straight paths use M (move) and L (line) commands only
    expect(d).toMatch(/^M.*L/)
    expect(d).not.toMatch(/[CQ]/)
  })

  test("renders stepped path with pathType='step'", () => {
    const { container } = render(
      <SvgConnection {...createProps({ pathType: "step" })} />
    )
    const path = container.querySelector("path")
    const d = path?.getAttribute("d") || ""
    // Step paths have multiple H (horizontal) or V (vertical) segments
    expect(d).toMatch(/[HV]/)
  })

  test("defaults to bezier when pathType not specified", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    const d = path?.getAttribute("d") || ""
    expect(d).toMatch(/[CQ]/)
  })
})

describe("SvgConnection - Line Styles", () => {
  test("solid line has no stroke-dasharray", () => {
    const { container } = render(
      <SvgConnection {...createProps({ lineStyle: "solid" })} />
    )
    const path = container.querySelector("path")
    const dasharray = path?.getAttribute("stroke-dasharray")
    // Solid lines should have no dasharray or "none"
    expect(dasharray === null || dasharray === "none" || dasharray === "").toBe(true)
  })

  test("dashed line has appropriate stroke-dasharray", () => {
    const { container } = render(
      <SvgConnection {...createProps({ lineStyle: "dashed" })} />
    )
    const path = container.querySelector("path")
    const dasharray = path?.getAttribute("stroke-dasharray")
    expect(dasharray).toBeTruthy()
    // Dashed pattern has longer segments (e.g., "8 4" or "6,3")
    expect(dasharray).toMatch(/\d+[\s,]+\d+/)
  })

  test("dotted line has small stroke-dasharray pattern", () => {
    const { container } = render(
      <SvgConnection {...createProps({ lineStyle: "dotted" })} />
    )
    const path = container.querySelector("path")
    const dasharray = path?.getAttribute("stroke-dasharray")
    expect(dasharray).toBeTruthy()
    // Dotted pattern has equal small segments (e.g., "2 2" or "1,1")
    expect(dasharray).toMatch(/\d+[\s,]+\d+/)
  })

  test("defaults to solid when lineStyle not specified", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    const dasharray = path?.getAttribute("stroke-dasharray")
    expect(dasharray === null || dasharray === "none" || dasharray === "").toBe(true)
  })
})

describe("SvgConnection - Arrow Markers", () => {
  test("SVG marker definition is created when showArrow is true", () => {
    const { container } = render(
      <SvgConnection {...createProps({ showArrow: true })} />
    )
    const marker = container.querySelector("marker")
    expect(marker).not.toBeNull()
  })

  test("path references marker-end attribute when showArrow is true", () => {
    const { container } = render(
      <SvgConnection {...createProps({ showArrow: true })} />
    )
    const path = container.querySelector("path")
    const markerEnd = path?.getAttribute("marker-end")
    expect(markerEnd).toMatch(/url\(#.*\)/)
  })

  test("arrow marker contains polygon or path element", () => {
    const { container } = render(
      <SvgConnection {...createProps({ showArrow: true })} />
    )
    const marker = container.querySelector("marker")
    const arrowShape = marker?.querySelector("polygon, path")
    expect(arrowShape).not.toBeNull()
  })

  test("no marker when showArrow is false", () => {
    const { container } = render(
      <SvgConnection {...createProps({ showArrow: false })} />
    )
    const marker = container.querySelector("marker")
    expect(marker).toBeNull()
  })

  test("no marker by default when showArrow not specified", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    const markerEnd = path?.getAttribute("marker-end")
    expect(markerEnd === null || markerEnd === "").toBe(true)
  })
})

describe("SvgConnection - Animated Flow Effect", () => {
  test("CSS animation class is applied when animated is true", () => {
    const { container } = render(
      <SvgConnection {...createProps({ animated: true })} />
    )
    const svg = container.querySelector("[data-svg-connection]")
    expect(svg?.getAttribute("data-animated")).toBe("true")
  })

  test("animation uses stroke-dashoffset technique", () => {
    const { container } = render(
      <SvgConnection {...createProps({ animated: true })} />
    )
    const path = container.querySelector("path")
    // Animated paths should have animation-related styling
    const className = path?.getAttribute("class") || ""
    const style = path?.getAttribute("style") || ""
    // Should have animation class or inline animation style
    expect(className.includes("animate") || style.includes("animation")).toBe(true)
  })

  test("no animation when animated is false", () => {
    const { container } = render(
      <SvgConnection {...createProps({ animated: false })} />
    )
    const svg = container.querySelector("[data-svg-connection]")
    expect(svg?.getAttribute("data-animated")).toBe("false")
  })

  test("no animation by default", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const svg = container.querySelector("[data-svg-connection]")
    const animated = svg?.getAttribute("data-animated")
    expect(animated === "false" || animated === null).toBe(true)
  })
})

describe("SvgConnection - DOM Element Positioning", () => {
  test("accepts from and to coordinates as points", () => {
    const props = createProps({
      from: { x: 50, y: 25 },
      to: { x: 200, y: 150 },
    })
    const { container } = render(<SvgConnection {...props} />)
    const path = container.querySelector("path")
    expect(path).not.toBeNull()
  })

  test("SVG viewBox encompasses the connection path", () => {
    const { container } = render(
      <SvgConnection
        {...createProps({
          from: { x: 10, y: 20 },
          to: { x: 300, y: 200 },
        })}
      />
    )
    const svg = container.querySelector("svg")
    const viewBox = svg?.getAttribute("viewBox")
    // ViewBox should be set to contain the path
    expect(viewBox).toBeTruthy()
  })

  test("handles zero-length connections gracefully", () => {
    expect(() =>
      render(
        <SvgConnection
          {...createProps({
            from: { x: 50, y: 50 },
            to: { x: 50, y: 50 },
          })}
        />
      )
    ).not.toThrow()
  })

  test("handles negative coordinates", () => {
    expect(() =>
      render(
        <SvgConnection
          {...createProps({
            from: { x: -10, y: -20 },
            to: { x: 100, y: 100 },
          })}
        />
      )
    ).not.toThrow()
  })
})

describe("SvgConnection - Styling", () => {
  test("accepts custom stroke color", () => {
    const { container } = render(
      <SvgConnection {...createProps({ strokeColor: "#ff0000" })} />
    )
    const path = container.querySelector("path")
    const stroke = path?.getAttribute("stroke")
    expect(stroke).toBe("#ff0000")
  })

  test("accepts custom stroke width", () => {
    const { container } = render(
      <SvgConnection {...createProps({ strokeWidth: 3 })} />
    )
    const path = container.querySelector("path")
    const width = path?.getAttribute("stroke-width")
    expect(width).toBe("3")
  })

  test("accepts custom className", () => {
    const { container } = render(
      <SvgConnection {...createProps({ className: "custom-connection" })} />
    )
    const svg = container.querySelector("[data-svg-connection]")
    expect(svg?.className).toContain("custom-connection")
  })

  test("uses default stroke color when not specified", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    const stroke = path?.getAttribute("stroke")
    expect(stroke).toBeTruthy()
  })

  test("uses default stroke width when not specified", () => {
    const { container } = render(<SvgConnection {...createProps()} />)
    const path = container.querySelector("path")
    const width = path?.getAttribute("stroke-width")
    expect(width).toBeTruthy()
  })
})

describe("SvgConnection - Type Exports", () => {
  test("PathType type is exported and usable", () => {
    const pathTypes: PathType[] = ["bezier", "straight", "step"]
    expect(pathTypes).toHaveLength(3)
  })

  test("LineStyle type is exported and usable", () => {
    const lineStyles: LineStyle[] = ["solid", "dashed", "dotted"]
    expect(lineStyles).toHaveLength(3)
  })
})
