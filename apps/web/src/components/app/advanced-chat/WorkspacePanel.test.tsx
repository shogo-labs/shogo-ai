/**
 * Generated from TestSpecifications: test-panel-render, test-panel-close
 * Task: task-testbed-panel
 * Requirement: req-testbed-panel-wrapper
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
import { render, fireEvent, cleanup } from "@testing-library/react"
import { WorkspacePanel, type WorkspacePanelData } from "./WorkspacePanel"

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

describe("WorkspacePanel renders with title", () => {
  // Given: Panel data with title 'Test Panel'
  let testPanel: WorkspacePanelData
  let onCloseMock: ReturnType<typeof mock>

  beforeEach(() => {
    testPanel = {
      id: "panel-1",
      type: "preview",
      title: "Test Panel",
    }
    onCloseMock = mock(() => {})
  })

  test("Title 'Test Panel' visible in header", () => {
    // When: WorkspacePanel renders
    const { container } = render(<WorkspacePanel panel={testPanel} onClose={onCloseMock} />)

    // Then: Title 'Test Panel' visible in header
    const title = container.querySelector("span")
    expect(title).not.toBeNull()
    expect(title?.textContent).toBe("Test Panel")
  })

  test("Close button visible", () => {
    // When: WorkspacePanel renders
    const { container } = render(<WorkspacePanel panel={testPanel} onClose={onCloseMock} />)

    // Then: Close button visible with aria-label
    const closeButton = container.querySelector('button[aria-label="Close panel"]')
    expect(closeButton).not.toBeNull()
  })

  test("Content slot renders children", () => {
    // When: WorkspacePanel renders with children
    const { container } = render(
      <WorkspacePanel panel={testPanel} onClose={onCloseMock}>
        <div data-testid="child-content">Child Content</div>
      </WorkspacePanel>
    )

    // Then: Content slot renders children
    const childContent = container.querySelector('[data-testid="child-content"]')
    expect(childContent).not.toBeNull()
    expect(childContent?.textContent).toBe("Child Content")
  })
})

describe("WorkspacePanel close button calls callback", () => {
  // Given: Panel with onClose callback
  let testPanel: WorkspacePanelData
  let onCloseMock: ReturnType<typeof mock>

  beforeEach(() => {
    testPanel = {
      id: "panel-1",
      type: "code",
      title: "Code Panel",
    }
    onCloseMock = mock(() => {})
  })

  test("User clicks close button -> onClose callback called", () => {
    // When: WorkspacePanel renders
    const { container } = render(<WorkspacePanel panel={testPanel} onClose={onCloseMock} />)

    // When: User clicks close button
    const closeButton = container.querySelector('button[aria-label="Close panel"]')!
    fireEvent.click(closeButton)

    // Then: onClose callback called
    expect(onCloseMock).toHaveBeenCalled()
  })
})
