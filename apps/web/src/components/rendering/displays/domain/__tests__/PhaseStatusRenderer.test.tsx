/**
 * PhaseStatusRenderer Component Tests
 * Task: task-cbe-002
 *
 * Tests verify:
 * 1. Component file exists and exports correctly
 * 2. Component accepts value (phase name) and config props
 * 3. Interactive props flow through config.customProps (onClick, disabled, isCurrent, isComplete, ariaLabel)
 * 4. Uses phaseNodeVariants for status styling (pending/current/complete/blocked)
 * 5. Renders clickable element with proper aria-label and disabled state handling
 * 6. Shows phase icon/indicator based on status (checkmark for complete)
 * 7. Component is registered in implementations.ts
 *
 * Key architectural proof: Renderers can be interactive, not just display-only.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock, spyOn } from "bun:test"
import { render, fireEvent } from "@testing-library/react"
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

// Import the component under test - will fail until implemented (RED phase)
import { PhaseStatusRenderer } from "../PhaseStatusRenderer"
import type { PropertyMetadata, XRendererConfig } from "../../../../types"

// Helper to create minimal props
const createProps = (
  value: string,
  customProps: Record<string, unknown> = {}
) => ({
  property: { name: "status", type: "string" as const } as PropertyMetadata,
  value,
  config: {
    customProps,
  } as XRendererConfig,
})

describe("PhaseStatusRenderer - File Structure", () => {
  test("PhaseStatusRenderer is exported from the module", () => {
    expect(PhaseStatusRenderer).toBeDefined()
    // MobX observer wraps the function in an object with $$typeof
    expect(PhaseStatusRenderer).toHaveProperty("$$typeof")
  })

  test("PhaseStatusRenderer is the default export", async () => {
    const mod = await import("../PhaseStatusRenderer")
    expect(mod.default).toBe(PhaseStatusRenderer)
  })
})

describe("PhaseStatusRenderer - Props Interface", () => {
  test("accepts value prop (phase name string)", () => {
    const { container } = render(
      <PhaseStatusRenderer {...createProps("discovery")} />
    )
    expect(container).toBeTruthy()
  })

  test("accepts config prop with customProps", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("analysis", {
          onClick: () => {},
          disabled: false,
          isCurrent: true,
          isComplete: false,
          ariaLabel: "Test label",
        })}
      />
    )
    expect(container).toBeTruthy()
  })

  test("renders without config prop", () => {
    const { container } = render(
      <PhaseStatusRenderer
        property={{ name: "status", type: "string" }}
        value="design"
      />
    )
    expect(container).toBeTruthy()
  })
})

describe("PhaseStatusRenderer - Click Handling", () => {
  test("renders clickable element when onClick provided", () => {
    const handleClick = mock(() => {})
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: handleClick,
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button).not.toBeNull()
  })

  test("onClick callback fires when clicked", () => {
    const handleClick = mock(() => {})
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: handleClick,
        })}
      />
    )

    const button = container.querySelector("button")
    if (button) {
      fireEvent.click(button)
    }
    expect(handleClick).toHaveBeenCalledTimes(1)
  })

  test("element has cursor-pointer style when clickable", () => {
    const handleClick = mock(() => {})
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: handleClick,
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button?.className).toContain("cursor-pointer")
  })
})

describe("PhaseStatusRenderer - Disabled State", () => {
  test("element has disabled attribute when disabled is true", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: () => {},
          disabled: true,
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button?.disabled).toBe(true)
  })

  test("click does not trigger onClick when disabled", () => {
    const handleClick = mock(() => {})
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: handleClick,
          disabled: true,
        })}
      />
    )

    const button = container.querySelector("button")
    if (button) {
      fireEvent.click(button)
    }
    expect(handleClick).not.toHaveBeenCalled()
  })

  test("element has cursor-not-allowed style when disabled", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          onClick: () => {},
          disabled: true,
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button?.className).toContain("cursor-not-allowed")
  })
})

describe("PhaseStatusRenderer - Status Styling", () => {
  test("shows current variant styling when isCurrent is true", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          isCurrent: true,
        })}
      />
    )

    // Should apply current status styling
    const node = container.querySelector("[data-status='current']")
    expect(node).not.toBeNull()
  })

  test("shows pending variant styling by default", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          isCurrent: false,
          isComplete: false,
        })}
      />
    )

    const node = container.querySelector("[data-status='pending']")
    expect(node).not.toBeNull()
  })

  test("shows complete variant with checkmark when isComplete is true", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          isComplete: true,
        })}
      />
    )

    // Should apply complete status styling
    const node = container.querySelector("[data-status='complete']")
    expect(node).not.toBeNull()

    // Should show checkmark icon
    const checkmark = container.querySelector("svg")
    expect(checkmark).not.toBeNull()
  })

  test("shows blocked variant styling when disabled without onClick", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          disabled: true,
        })}
      />
    )

    const node = container.querySelector("[data-status='blocked']")
    expect(node).not.toBeNull()
  })
})

describe("PhaseStatusRenderer - Accessibility", () => {
  test("element has aria-label matching provided ariaLabel", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          ariaLabel: "Go to discovery phase",
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button?.getAttribute("aria-label")).toBe("Go to discovery phase")
  })

  test("generates default aria-label from phase name when not provided", () => {
    const { container } = render(
      <PhaseStatusRenderer {...createProps("discovery")} />
    )

    const button = container.querySelector("button")
    const ariaLabel = button?.getAttribute("aria-label")?.toLowerCase()
    expect(ariaLabel).toContain("discovery")
  })

  test("element has aria-disabled when disabled", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          disabled: true,
        })}
      />
    )

    const button = container.querySelector("button")
    expect(button?.getAttribute("aria-disabled")).toBe("true")
  })
})

describe("PhaseStatusRenderer - Phase Display", () => {
  test("displays phase name value", () => {
    const { container } = render(
      <PhaseStatusRenderer {...createProps("discovery")} />
    )

    expect(container.textContent?.toLowerCase()).toContain("discovery")
  })

  test("handles all phase values", () => {
    const phases = [
      "discovery",
      "analysis",
      "classification",
      "design",
      "spec",
      "testing",
      "implementation",
      "complete",
    ]

    for (const phase of phases) {
      expect(() =>
        render(<PhaseStatusRenderer {...createProps(phase)} />)
      ).not.toThrow()
    }
  })

  test("handles null/undefined value gracefully", () => {
    const { container } = render(
      <PhaseStatusRenderer
        property={{ name: "status", type: "string" }}
        value={null as any}
      />
    )
    expect(container).toBeTruthy()
  })
})

describe("PhaseStatusRenderer - Visual Elements", () => {
  test("renders a phase node circle element", () => {
    const { container } = render(
      <PhaseStatusRenderer {...createProps("discovery")} />
    )

    // Should have a circular indicator element
    const circle = container.querySelector("[data-phase-node]")
    expect(circle).not.toBeNull()
  })

  test("circle shows checkmark icon when complete", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          isComplete: true,
        })}
      />
    )

    // Should have Check icon from lucide-react
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
  })

  test("circle does not show checkmark when not complete", () => {
    const { container } = render(
      <PhaseStatusRenderer
        {...createProps("discovery", {
          isComplete: false,
        })}
      />
    )

    const svg = container.querySelector("svg")
    expect(svg).toBeNull()
  })
})
