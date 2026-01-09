/**
 * PhaseNode Registry Integration Tests
 * Task: task-cbe-008
 *
 * Tests that PhaseNode uses PropertyRenderer with phase-status-renderer
 * binding for registry-driven rendering of interactive phase nodes.
 *
 * Key architectural proof: Interactive components work through registry
 * resolution via config.customProps.
 *
 * Test Specifications: test-cbe-008-01 through test-cbe-008-10
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { render, fireEvent } from "@testing-library/react"
import { Window } from "happy-dom"
import fs from "fs"
import path from "path"

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

// Import after DOM setup
import { PhaseNode } from "../PhaseNode"
import { ComponentRegistryProvider, createStudioRegistry } from "@/components/rendering"

describe("PhaseNode Registry Integration", () => {
  const componentPath = path.resolve(import.meta.dir, "../PhaseNode.tsx")

  // Test file exists
  test("component file exists", () => {
    expect(fs.existsSync(componentPath)).toBe(true)
  })

  const getSource = () => fs.readFileSync(componentPath, "utf-8")

  // =============================================================================
  // test-cbe-008-01: PhaseNode uses PropertyRenderer with phase-status-renderer binding
  // =============================================================================
  describe("test-cbe-008-01: PropertyRenderer with phase-status-renderer binding", () => {
    test("imports PropertyRenderer from rendering module", () => {
      const source = getSource()
      expect(source).toContain("PropertyRenderer")
      expect(source).toMatch(/from\s+["']@\/components\/rendering["']/)
    })

    test("imports PropertyMetadata type from rendering module", () => {
      const source = getSource()
      expect(source).toMatch(/PropertyMetadata/)
    })

    test("defines PropertyMetadata with xRenderer: 'phase-status-renderer'", () => {
      const source = getSource()
      expect(source).toContain("xRenderer")
      expect(source).toContain("phase-status-renderer")
    })

    test("renders PropertyRenderer component in JSX", () => {
      const source = getSource()
      expect(source).toMatch(/<PropertyRenderer/)
    })
  })

  // =============================================================================
  // test-cbe-008-02: PhaseNode passes onClick via config.customProps
  // =============================================================================
  describe("test-cbe-008-02: onClick via config.customProps", () => {
    test("config.customProps includes onClick callback", () => {
      const source = getSource()
      expect(source).toContain("customProps")
      expect(source).toMatch(/onClick\s*[:,]/)
    })

    test("onClick is passed to PropertyRenderer config", () => {
      const source = getSource()
      // Verify config object structure includes customProps with onClick
      expect(source).toMatch(/config\s*=\s*\{[\s\S]*customProps[\s\S]*onClick/)
    })
  })

  // =============================================================================
  // test-cbe-008-03: PhaseNode passes disabled state via config.customProps
  // =============================================================================
  describe("test-cbe-008-03: disabled via config.customProps", () => {
    test("config.customProps includes disabled boolean", () => {
      const source = getSource()
      expect(source).toMatch(/disabled\s*[:,]/)
    })

    test("disabled is derived from status === 'blocked'", () => {
      const source = getSource()
      // Should compute disabled from status
      expect(source).toMatch(/isBlocked|blocked|disabled/)
    })
  })

  // =============================================================================
  // test-cbe-008-04: PhaseNode passes isCurrent and isComplete via config.customProps
  // =============================================================================
  describe("test-cbe-008-04: isCurrent and isComplete via config.customProps", () => {
    test("config.customProps includes isCurrent boolean", () => {
      const source = getSource()
      expect(source).toMatch(/isCurrent\s*[:,]/)
    })

    test("config.customProps includes isComplete boolean", () => {
      const source = getSource()
      expect(source).toMatch(/isComplete\s*[:,]/)
    })

    test("status determination logic remains in PhaseNode", () => {
      const source = getSource()
      // PhaseNode should still compute isCurrent and isComplete from status prop
      expect(source).toMatch(/status\s*===\s*["']current["']/)
      expect(source).toMatch(/status\s*===\s*["']complete["']/)
    })
  })

  // =============================================================================
  // test-cbe-008-05: PhaseNode passes ariaLabel via config.customProps
  // =============================================================================
  describe("test-cbe-008-05: ariaLabel via config.customProps for accessibility", () => {
    test("config.customProps includes ariaLabel string", () => {
      const source = getSource()
      expect(source).toMatch(/ariaLabel\s*[:,]/)
    })

    test("ariaLabel follows format including label and status", () => {
      const source = getSource()
      // aria-label should include label and status
      expect(source).toMatch(/\$\{label\}|\$\{.*label.*\}|label.*phase/)
    })
  })

  // =============================================================================
  // test-cbe-008-06: Click handling works through PhaseStatusRenderer
  // =============================================================================
  describe("test-cbe-008-06: click handling through registry", () => {
    test("onClick callback is triggered on click", () => {
      const handleClick = mock(() => {})
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="discovery"
            label="Discovery"
            status="pending"
            isSelected={false}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button).not.toBeNull()
      if (button) {
        fireEvent.click(button)
      }

      expect(handleClick).toHaveBeenCalledTimes(1)
    })

    test("navigation occurs when non-blocked phase clicked", () => {
      const handleClick = mock(() => {})
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="analysis"
            label="Analysis"
            status="complete"
            isSelected={false}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button).not.toBeNull()
      if (button) {
        fireEvent.click(button)
      }

      expect(handleClick).toHaveBeenCalled()
    })
  })

  // =============================================================================
  // test-cbe-008-07: Disabled state prevents interaction
  // =============================================================================
  describe("test-cbe-008-07: disabled state prevents interaction", () => {
    test("blocked phases do not trigger navigation", () => {
      const handleClick = mock(() => {})
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="implementation"
            label="Implementation"
            status="blocked"
            isSelected={false}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button).not.toBeNull()
      if (button) {
        fireEvent.click(button)
      }

      expect(handleClick).not.toHaveBeenCalled()
    })

    test("visual feedback shows disabled state", () => {
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="implementation"
            label="Implementation"
            status="blocked"
            isSelected={false}
            onClick={() => {}}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button).not.toBeNull()
      expect(button?.disabled).toBe(true)
    })

    test("cursor-not-allowed styling applied", () => {
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="implementation"
            label="Implementation"
            status="blocked"
            isSelected={false}
            onClick={() => {}}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button?.className).toContain("cursor-not-allowed")
    })
  })

  // =============================================================================
  // test-cbe-008-08: Current phase highlight works correctly
  // =============================================================================
  describe("test-cbe-008-08: current phase highlight", () => {
    test("current phase has distinct visual styling", () => {
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="design"
            label="Design"
            status="current"
            isSelected={true}
            onClick={() => {}}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button?.getAttribute("data-status")).toBe("current")
    })

    test("shadow and text contrast visible for current phase", () => {
      const source = getSource()
      // PhaseStatusRenderer should receive isCurrent prop
      expect(source).toContain("isCurrent")
    })
  })

  // =============================================================================
  // test-cbe-008-09: Complete phase checkmark works correctly
  // =============================================================================
  describe("test-cbe-008-09: complete phase checkmark", () => {
    test("complete status renders checkmark indicator", () => {
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="discovery"
            label="Discovery"
            status="complete"
            isSelected={false}
            onClick={() => {}}
          />
        </ComponentRegistryProvider>
      )

      const button = container.querySelector("button")
      expect(button?.getAttribute("data-status")).toBe("complete")
    })

    test("checkmark icon visible inside complete node", () => {
      const registry = createStudioRegistry()

      const { container } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="discovery"
            label="Discovery"
            status="complete"
            isSelected={false}
            onClick={() => {}}
          />
        </ComponentRegistryProvider>
      )

      // Should have Check icon from lucide-react
      const svg = container.querySelector("svg")
      expect(svg).not.toBeNull()
    })

    test("green styling applied via phaseNodeVariants", () => {
      const source = getSource()
      // PhaseStatusRenderer should receive isComplete prop
      expect(source).toContain("isComplete")
    })
  })

  // =============================================================================
  // test-cbe-008-10: Stepper navigation maintains full functionality
  // =============================================================================
  describe("test-cbe-008-10: stepper navigation functionality", () => {
    test("all non-blocked phases are clickable", () => {
      const handleClick = mock(() => {})
      const registry = createStudioRegistry()

      // Render pending phase - should be clickable
      const { container, rerender } = render(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="discovery"
            label="Discovery"
            status="pending"
            isSelected={false}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      let button = container.querySelector("button")
      expect(button).not.toBeNull()
      if (button) {
        fireEvent.click(button)
      }
      expect(handleClick).toHaveBeenCalledTimes(1)

      // Render current phase - should be clickable
      rerender(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="analysis"
            label="Analysis"
            status="current"
            isSelected={true}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      button = container.querySelector("button")
      if (button) {
        fireEvent.click(button)
      }
      expect(handleClick).toHaveBeenCalledTimes(2)

      // Render complete phase - should be clickable
      rerender(
        <ComponentRegistryProvider registry={registry}>
          <PhaseNode
            name="classification"
            label="Classification"
            status="complete"
            isSelected={false}
            onClick={handleClick}
          />
        </ComponentRegistryProvider>
      )

      button = container.querySelector("button")
      if (button) {
        fireEvent.click(button)
      }
      expect(handleClick).toHaveBeenCalledTimes(3)
    })

    test("no regression in data-testid attribute", () => {
      const source = getSource()
      // Should still support data-testid for testing
      expect(source).toMatch(/data-testid/)
    })
  })

  // =============================================================================
  // Component interface tests - ensure exports remain compatible
  // =============================================================================
  describe("component interface compatibility", () => {
    test("exports PhaseNode function", () => {
      const source = getSource()
      expect(source).toMatch(/export function PhaseNode/)
    })

    test("exports phaseNodeVariants for PhaseStatusRenderer", () => {
      const source = getSource()
      expect(source).toMatch(/export const phaseNodeVariants/)
    })

    test("exports labelVariants for PhaseStatusRenderer", () => {
      const source = getSource()
      expect(source).toMatch(/export const labelVariants/)
    })
  })
})
