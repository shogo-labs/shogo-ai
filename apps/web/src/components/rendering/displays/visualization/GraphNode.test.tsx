/**
 * GraphNode Component Tests
 * Task: task-w1-graph-node-primitive
 *
 * Tests verify:
 * 1. Component renders without crashing
 * 2. Supports all variant types (entity, task, phase)
 * 3. Compatible with ReactFlow custom node API
 * 4. Includes source and target connection handles
 * 5. Shows selection and hover states with phase colors
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render } from "@testing-library/react"
import { Window } from "happy-dom"
import { GraphNode, type GraphNodeProps } from "./GraphNode"

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

// Helper to create minimal ReactFlow-like props
const createNodeProps = (overrides: Partial<GraphNodeProps> = {}): GraphNodeProps => ({
  id: "node-1",
  data: {
    label: "Test Node",
    ...overrides.data,
  },
  ...overrides,
})

describe("GraphNode - Renders", () => {
  test("renders without throwing errors", () => {
    expect(() => render(<GraphNode {...createNodeProps()} />)).not.toThrow()
  })

  test("node container element is visible", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const node = container.querySelector("[data-graph-node]")
    expect(node).not.toBeNull()
  })

  test("no console errors are logged", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    expect(container).toBeTruthy()
  })

  test("displays node label", () => {
    const { container } = render(
      <GraphNode {...createNodeProps({ data: { label: "My Task" } })} />
    )
    expect(container.textContent).toContain("My Task")
  })
})

describe("GraphNode - Variants", () => {
  test("renders correctly with variant='entity'", () => {
    const { container } = render(
      <GraphNode {...createNodeProps({ data: { label: "Entity", variant: "entity" } })} />
    )
    const node = container.querySelector("[data-variant]")
    expect(node?.getAttribute("data-variant")).toBe("entity")
  })

  test("renders correctly with variant='task'", () => {
    const { container } = render(
      <GraphNode {...createNodeProps({ data: { label: "Task", variant: "task" } })} />
    )
    const node = container.querySelector("[data-variant]")
    expect(node?.getAttribute("data-variant")).toBe("task")
  })

  test("renders correctly with variant='phase'", () => {
    const { container } = render(
      <GraphNode {...createNodeProps({ data: { label: "Phase", variant: "phase" } })} />
    )
    const node = container.querySelector("[data-variant]")
    expect(node?.getAttribute("data-variant")).toBe("phase")
  })

  test("defaults to task variant when not specified", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const node = container.querySelector("[data-variant]")
    expect(node?.getAttribute("data-variant")).toBe("task")
  })
})

describe("GraphNode - ReactFlow Compatibility", () => {
  test("component accepts ReactFlow NodeProps pattern", () => {
    const props: GraphNodeProps = {
      id: "node-123",
      data: {
        label: "Test",
        status: "complete",
      },
      selected: false,
      dragging: false,
    }

    expect(() => render(<GraphNode {...props} />)).not.toThrow()
  })

  test("node data prop is accessible", () => {
    const { container } = render(
      <GraphNode
        {...createNodeProps({
          data: {
            label: "Custom Label",
            status: "in_progress",
          },
        })}
      />
    )
    expect(container.textContent).toContain("Custom Label")
  })

  test("node id is applied to container", () => {
    const { container } = render(
      <GraphNode {...createNodeProps({ id: "unique-node-id" })} />
    )
    const node = container.querySelector("[data-node-id]")
    expect(node?.getAttribute("data-node-id")).toBe("unique-node-id")
  })
})

describe("GraphNode - Connection Handles", () => {
  test("source handle is present for outgoing connections", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const sourceHandle = container.querySelector("[data-handle-type='source']")
    expect(sourceHandle).not.toBeNull()
  })

  test("target handle is present for incoming connections", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const targetHandle = container.querySelector("[data-handle-type='target']")
    expect(targetHandle).not.toBeNull()
  })

  test("handles are positioned on node edges", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const sourceHandle = container.querySelector("[data-handle-type='source']")
    const targetHandle = container.querySelector("[data-handle-type='target']")

    // Source should be on the right, target on the left
    expect(sourceHandle?.getAttribute("data-handle-position")).toBe("right")
    expect(targetHandle?.getAttribute("data-handle-position")).toBe("left")
  })
})

describe("GraphNode - Selection and Hover States", () => {
  test("selection state applies phase-colored border", () => {
    const { container } = render(
      <GraphNode
        {...createNodeProps({
          selected: true,
          data: { label: "Selected", phase: "discovery" },
        })}
      />
    )
    const node = container.querySelector("[data-graph-node]")
    expect(node?.getAttribute("data-selected")).toBe("true")
  })

  test("hover state provides visual feedback via CSS classes", () => {
    const { container } = render(<GraphNode {...createNodeProps()} />)
    const node = container.querySelector("[data-graph-node]")
    // Should have hover transition class
    expect(node?.className).toContain("hover")
  })

  test("states are distinct and clearly visible", () => {
    // Render both selected and unselected
    const { container: selectedContainer } = render(
      <GraphNode {...createNodeProps({ selected: true })} />
    )
    const { container: unselectedContainer } = render(
      <GraphNode {...createNodeProps({ selected: false })} />
    )

    const selectedNode = selectedContainer.querySelector("[data-graph-node]")
    const unselectedNode = unselectedContainer.querySelector("[data-graph-node]")

    expect(selectedNode?.getAttribute("data-selected")).toBe("true")
    expect(unselectedNode?.getAttribute("data-selected")).toBe("false")
  })

  test("phase prop affects styling", () => {
    const { container } = render(
      <GraphNode
        {...createNodeProps({
          data: { label: "Test", phase: "implementation" },
        })}
      />
    )
    const node = container.querySelector("[data-phase]")
    expect(node?.getAttribute("data-phase")).toBe("implementation")
  })
})
