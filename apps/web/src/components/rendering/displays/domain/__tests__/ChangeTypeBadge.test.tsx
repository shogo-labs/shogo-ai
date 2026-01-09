/**
 * ChangeTypeBadge Component Tests
 * Task: task-cbe-001
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for ChangeTypeBadge component that renders IntegrationPoint.changeType enum values.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import { Window } from "happy-dom"
import React from "react"

// Set up happy-dom BEFORE importing components
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

import { ChangeTypeBadge } from "../ChangeTypeBadge"
import { changeTypeBadgeVariants } from "../variants"
import type { DisplayRendererProps } from "../../../types"

describe("ChangeTypeBadge", () => {
  const baseProps: DisplayRendererProps = {
    property: { name: "changeType", type: "string", enum: ["add", "modify", "extend", "remove"] },
    value: "add"
  }

  describe("exports", () => {
    test("exports ChangeTypeBadge as named export", () => {
      expect(ChangeTypeBadge).toBeDefined()
      // MobX observer wraps component, making it an object with render function
      expect(typeof ChangeTypeBadge === "function" || typeof ChangeTypeBadge === "object").toBe(true)
    })

    test("exports ChangeTypeBadge as default export", async () => {
      const module = await import("../ChangeTypeBadge")
      expect(module.default).toBeDefined()
      expect(module.default).toBe(ChangeTypeBadge)
    })
  })

  describe("rendering add variant", () => {
    test("renders Badge with 'Add' text (capitalized)", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="add" />)
      expect(container.textContent).toBe("Add")
    })

    test("applies green color classes from changeTypeBadgeVariants", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="add" />)
      const badge = container.firstChild as HTMLElement
      const expectedClasses = changeTypeBadgeVariants({ changeType: "add" })
      // Check for green color classes
      expect(badge.className).toContain("bg-green")
      expect(badge.className).toContain("text-green")
    })
  })

  describe("rendering modify variant", () => {
    test("renders Badge with 'Modify' text (capitalized)", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="modify" />)
      expect(container.textContent).toBe("Modify")
    })

    test("applies blue color classes from changeTypeBadgeVariants", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="modify" />)
      const badge = container.firstChild as HTMLElement
      // Check for blue color classes
      expect(badge.className).toContain("bg-blue")
      expect(badge.className).toContain("text-blue")
    })
  })

  describe("rendering extend variant", () => {
    test("renders Badge with 'Extend' text (capitalized)", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="extend" />)
      expect(container.textContent).toBe("Extend")
    })

    test("applies purple color classes from changeTypeBadgeVariants", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="extend" />)
      const badge = container.firstChild as HTMLElement
      // Check for purple color classes
      expect(badge.className).toContain("bg-purple")
      expect(badge.className).toContain("text-purple")
    })
  })

  describe("rendering remove variant", () => {
    test("renders Badge with 'Remove' text (capitalized)", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="remove" />)
      expect(container.textContent).toBe("Remove")
    })

    test("applies red color classes from changeTypeBadgeVariants", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="remove" />)
      const badge = container.firstChild as HTMLElement
      // Check for red color classes
      expect(badge.className).toContain("bg-red")
      expect(badge.className).toContain("text-red")
    })
  })

  describe("null/undefined handling", () => {
    test("returns dash indicator for null value", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value={null} />)
      expect(container.textContent).toBe("-")
    })

    test("returns dash indicator for undefined value", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value={undefined} />)
      expect(container.textContent).toBe("-")
    })

    test("applies muted foreground styling for null value", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value={null} />)
      const span = container.querySelector("span")
      expect(span?.className).toContain("text-muted-foreground")
    })
  })

  describe("props interface", () => {
    test("accepts value prop", () => {
      const { container } = render(<ChangeTypeBadge {...baseProps} value="add" />)
      expect(container.textContent).toBe("Add")
    })

    test("accepts optional config prop", () => {
      const { container } = render(
        <ChangeTypeBadge {...baseProps} value="add" config={{ variant: "emphasized" }} />
      )
      expect(container.textContent).toBe("Add")
    })
  })
})
