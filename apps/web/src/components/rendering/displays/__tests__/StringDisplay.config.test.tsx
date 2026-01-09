/**
 * StringDisplay Config Support Tests
 *
 * TDD: RED phase - Tests written before implementation
 * Tests for XRendererConfig support in StringDisplay component.
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

import { StringDisplay } from "../StringDisplay"
import type { DisplayRendererProps } from "../../types"

describe("StringDisplay config support", () => {
  const baseProps: DisplayRendererProps = {
    property: { name: "test", type: "string" },
    value: "Hello World"
  }

  test("renders with default config when none provided", () => {
    const { container } = render(<StringDisplay {...baseProps} />)
    expect(container.textContent).toContain("Hello World")
  })

  test("applies size lg via className", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ size: "lg" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-lg")
  })

  test("applies size xs via className", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ size: "xs" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-xs")
  })

  test("applies size sm via className", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ size: "sm" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-sm")
  })

  test("applies size xl via className", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ size: "xl" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-xl")
  })

  test("truncates text when truncate is number", () => {
    const longText = "A".repeat(100)
    const { container } = render(<StringDisplay {...baseProps} value={longText} config={{ truncate: 50 }} />)
    expect(container.textContent?.length).toBeLessThanOrEqual(53) // 50 + "..."
    expect(container.textContent).toContain("...")
  })

  test("truncates at default 200 chars when truncate is true", () => {
    const longText = "A".repeat(250)
    const { container } = render(<StringDisplay {...baseProps} value={longText} config={{ truncate: true }} />)
    expect(container.textContent?.length).toBeLessThanOrEqual(203) // 200 + "..."
    expect(container.textContent).toContain("...")
  })

  test("does not truncate when truncate is false", () => {
    const longText = "A".repeat(250)
    const { container } = render(<StringDisplay {...baseProps} value={longText} config={{ truncate: false }} />)
    expect(container.textContent).toBe(longText)
  })

  test("uses default truncation (200) when no config provided for long text", () => {
    const longText = "A".repeat(250)
    const { container } = render(<StringDisplay {...baseProps} value={longText} />)
    expect(container.textContent?.length).toBeLessThanOrEqual(203)
    expect(container.textContent).toContain("...")
  })

  test("applies variant muted", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ variant: "muted" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-muted-foreground")
  })

  test("applies variant emphasized", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ variant: "emphasized" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("font-semibold")
  })

  test("applies variant warning", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ variant: "warning" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-amber")
  })

  test("applies variant success", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ variant: "success" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-green")
  })

  test("applies variant error", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ variant: "error" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-red")
  })

  test("combines size and variant", () => {
    const { container } = render(<StringDisplay {...baseProps} config={{ size: "lg", variant: "success" }} />)
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-lg")
    expect(span?.className).toContain("text-green")
  })

  test("handles null value with config", () => {
    const { container } = render(<StringDisplay {...baseProps} value={null} config={{ variant: "muted" }} />)
    expect(container.textContent).toBe("-")
    const span = container.querySelector("span")
    expect(span?.className).toContain("text-muted-foreground")
  })

  test("exposes supportedConfig static property", () => {
    expect((StringDisplay as any).supportedConfig).toContain("size")
    expect((StringDisplay as any).supportedConfig).toContain("truncate")
    expect((StringDisplay as any).supportedConfig).toContain("variant")
  })
})
