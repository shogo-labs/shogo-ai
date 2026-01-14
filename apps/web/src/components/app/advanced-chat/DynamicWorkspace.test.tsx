/**
 * DynamicWorkspace Component Tests
 *
 * Task: task-testbed-workspace
 * Feature: virtual-tools-domain
 *
 * Tests for the DynamicWorkspace component which manages the workspace
 * panel layout system, rendering BlankState when empty or a grid of
 * WorkspacePanel components based on the layout prop.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, mock, beforeAll, afterAll, afterEach } from "bun:test"
import { render, fireEvent, cleanup } from "@testing-library/react"
import { DynamicWorkspace } from "./DynamicWorkspace"
import type { WorkspacePanelData } from "./WorkspacePanel"

// Set up happy-dom
import { Window } from "happy-dom"

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

describe("DynamicWorkspace", () => {
  // Test: test-workspace-empty
  // Scenario: DynamicWorkspace shows BlankState when empty
  describe("when panels array is empty", () => {
    test("renders BlankState component", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={[]}
          layout="single"
          onPanelClose={() => {}}
        />
      )

      // BlankState shows this heading
      expect(container.textContent).toContain("How can I help you build today?")
    })

    test("does not render any WorkspacePanel elements", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={[]}
          layout="single"
          onPanelClose={() => {}}
        />
      )

      // WorkspacePanel would show a close button with this aria-label
      const closeButtons = container.querySelectorAll('[aria-label="Close panel"]')
      expect(closeButtons.length).toBe(0)
    })
  })

  // Test: test-workspace-with-panels
  // Scenario: DynamicWorkspace renders panels
  describe("when panels array has items", () => {
    const mockPanels: WorkspacePanelData[] = [
      { id: "panel-1", type: "preview", title: "Preview Panel" },
      { id: "panel-2", type: "code", title: "Code Panel" },
    ]

    test("renders WorkspacePanel for each panel in array", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={mockPanels}
          layout="split-h"
          onPanelClose={() => {}}
        />
      )

      expect(container.textContent).toContain("Preview Panel")
      expect(container.textContent).toContain("Code Panel")
    })

    test("does not render BlankState when panels exist", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={mockPanels}
          layout="split-h"
          onPanelClose={() => {}}
        />
      )

      expect(container.textContent).not.toContain("How can I help you build today?")
    })

    test("renders correct number of close buttons", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={mockPanels}
          layout="split-h"
          onPanelClose={() => {}}
        />
      )

      const closeButtons = container.querySelectorAll('[aria-label="Close panel"]')
      expect(closeButtons.length).toBe(2)
    })
  })

  // Test: test-workspace-panel-close
  // Scenario: Closing panel removes it from workspace
  describe("panel close interaction", () => {
    test("calls onPanelClose with correct panel id when close button clicked", () => {
      const onPanelClose = mock(() => {})
      const panels: WorkspacePanelData[] = [
        { id: "panel-to-close", type: "docs", title: "Docs Panel" },
      ]

      const { container } = render(
        <DynamicWorkspace
          panels={panels}
          layout="single"
          onPanelClose={onPanelClose}
        />
      )

      const closeButton = container.querySelector('[aria-label="Close panel"]') as HTMLElement
      expect(closeButton).toBeDefined()
      fireEvent.click(closeButton)

      expect(onPanelClose).toHaveBeenCalledWith("panel-to-close")
    })
  })

  // Layout class tests
  describe("layout modes", () => {
    const singlePanel: WorkspacePanelData[] = [
      { id: "p1", type: "preview", title: "Panel 1" },
    ]

    test("applies h-full class for full height", () => {
      const { container } = render(
        <DynamicWorkspace
          panels={singlePanel}
          layout="single"
          onPanelClose={() => {}}
        />
      )

      // The container should have h-full for full height
      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain("h-full")
    })

    test("applies correct classes for split-h layout", () => {
      const twoPanels: WorkspacePanelData[] = [
        { id: "p1", type: "preview", title: "Panel 1" },
        { id: "p2", type: "code", title: "Panel 2" },
      ]

      const { container } = render(
        <DynamicWorkspace
          panels={twoPanels}
          layout="split-h"
          onPanelClose={() => {}}
        />
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain("grid-cols-2")
    })

    test("applies correct classes for split-v layout", () => {
      const twoPanels: WorkspacePanelData[] = [
        { id: "p1", type: "preview", title: "Panel 1" },
        { id: "p2", type: "code", title: "Panel 2" },
      ]

      const { container } = render(
        <DynamicWorkspace
          panels={twoPanels}
          layout="split-v"
          onPanelClose={() => {}}
        />
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain("grid-rows-2")
    })

    test("applies correct classes for grid layout", () => {
      const fourPanels: WorkspacePanelData[] = [
        { id: "p1", type: "preview", title: "Panel 1" },
        { id: "p2", type: "code", title: "Panel 2" },
        { id: "p3", type: "schema", title: "Panel 3" },
        { id: "p4", type: "docs", title: "Panel 4" },
      ]

      const { container } = render(
        <DynamicWorkspace
          panels={fourPanels}
          layout="grid"
          onPanelClose={() => {}}
        />
      )

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toContain("grid-cols-2")
      expect(wrapper.className).toContain("grid-rows-2")
    })
  })
})
