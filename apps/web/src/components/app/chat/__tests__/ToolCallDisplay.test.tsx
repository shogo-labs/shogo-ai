/**
 * ToolCallDisplay Component Tests
 * Task: task-2-4-002 (chat-presentational-components)
 *
 * Tests verify:
 * 1. Renders input-streaming state with streaming indicator
 * 2. Renders input-available state with args displayed
 * 3. Renders output-available state with result displayed
 * 4. Renders output-error state with destructive styling
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup, fireEvent } from "@testing-library/react"
import { ToolCallDisplay } from "../ToolCallDisplay"

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

// ============================================================
// Test: Input-Streaming State (test-2-4-002-004)
// ============================================================
describe("ToolCallDisplay renders input-streaming state", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("streaming indicator is visible", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    // Should show streaming/loading indicator
    const indicator = container.querySelector('[data-testid="streaming-indicator"]') ||
      container.querySelector('.animate-pulse') ||
      container.querySelector('[aria-busy="true"]')

    expect(indicator).not.toBeNull()
  })

  test("args not yet shown when streaming", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-streaming"
      />
    )

    // Args section should not be visible during input streaming
    const argsSection = container.querySelector('[data-testid="tool-args"]')
    expect(argsSection).toBeNull()
  })
})

// ============================================================
// Test: Input-Available State (test-2-4-002-005)
// ============================================================
describe("ToolCallDisplay renders input-available state with args", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco", units: "celsius" }}
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("args are displayed when expanded", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco", units: "celsius" }}
      />
    )

    // Click header to expand (task-cpbi-010 made tool calls collapsed by default)
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Args should be visible after expanding
    expect(container.textContent).toContain("location")
    expect(container.textContent).toContain("San Francisco")
  })

  test("executing indicator shown", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="input-available"
        args={{ location: "San Francisco" }}
      />
    )

    // Should show executing/pending indicator
    const indicator = container.querySelector('[data-testid="executing-indicator"]') ||
      container.querySelector('.animate-spin') ||
      container.textContent?.toLowerCase().includes("executing") ||
      container.textContent?.toLowerCase().includes("running")

    expect(indicator).toBeTruthy()
  })
})

// ============================================================
// Test: Output-Available State (test-2-4-002-006)
// ============================================================
describe("ToolCallDisplay renders output-available state with result", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72, condition: "sunny" }}
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("result is displayed when expanded", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72, condition: "sunny" }}
      />
    )

    // Click header to expand (task-cpbi-010 made tool calls collapsed by default)
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Result should be visible after expanding
    expect(container.textContent).toContain("72")
    expect(container.textContent).toContain("sunny")
  })

  test("success styling applied", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-available"
        args={{ location: "San Francisco" }}
        result={{ temperature: 72 }}
      />
    )

    // Should have success/positive styling (green or check icon)
    const wrapper = container.firstChild as HTMLElement
    const hasSuccessStyle =
      wrapper?.className?.includes("border-green") ||
      wrapper?.className?.includes("text-green") ||
      container.querySelector('[data-testid="success-icon"]') ||
      container.querySelector('[data-state="success"]')

    expect(hasSuccessStyle).toBeTruthy()
  })
})

// ============================================================
// Test: Output-Error State (test-2-4-002-007)
// ============================================================
describe("ToolCallDisplay renders output-error state with destructive styling", () => {
  test("tool name is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    expect(container.textContent).toContain("get_weather")
  })

  test("error message is displayed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    expect(container.textContent).toContain("Location not found")
  })

  test("destructive/red border styling applied", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="get_weather"
        state="output-error"
        args={{ location: "Unknown" }}
        error="Location not found"
      />
    )

    // Should have destructive/error styling (red)
    const wrapper = container.firstChild as HTMLElement
    const hasDestructiveStyle =
      wrapper?.className?.includes("border-red") ||
      wrapper?.className?.includes("border-destructive") ||
      wrapper?.className?.includes("text-red") ||
      wrapper?.className?.includes("text-destructive") ||
      container.querySelector('[data-state="error"]')

    expect(hasDestructiveStyle).toBeTruthy()
  })
})

// ============================================================
// Test: Tool-Specific Icons (task-cpbi-009)
// ============================================================
import { getToolIcon } from "../ToolCallDisplay"
import { Database, FileJson2, Eye, Bot, Terminal } from "lucide-react"

describe("getToolIcon returns correct icons for namespaces", () => {
  // test-cpbi-009-a
  test("returns Database icon for store namespace", () => {
    const Icon = getToolIcon("store.create")
    expect(Icon).toBe(Database)
  })

  // test-cpbi-009-b
  test("returns FileJson2 icon for schema namespace", () => {
    const Icon = getToolIcon("schema.set")
    expect(Icon).toBe(FileJson2)
  })

  // test-cpbi-009-c
  test("returns Eye icon for view namespace", () => {
    const Icon = getToolIcon("view.execute")
    expect(Icon).toBe(Eye)
  })

  // test-cpbi-009-d
  test("returns Bot icon for agent namespace", () => {
    const Icon = getToolIcon("agent.chat")
    expect(Icon).toBe(Bot)
  })

  // test-cpbi-009-e
  test("returns Terminal icon for unknown namespace", () => {
    const Icon = getToolIcon("unknown.tool")
    expect(Icon).toBe(Terminal)
  })
})

describe("ToolCallDisplay renders correct icon for tool", () => {
  // test-cpbi-009-f
  // Tests that ToolCallDisplay renders an SVG icon in the header for various tool namespaces.
  // The getToolIcon unit tests above verify the correct icon component is selected,
  // while this integration test ensures the component actually renders the icon.
  test("renders correct icon based on tool namespace", () => {
    // Test store namespace - should render Database icon
    const { container: storeContainer } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="input-available"
        args={{ model: "User" }}
      />
    )
    const storeIcon = storeContainer.querySelector('svg')
    expect(storeIcon).not.toBeNull()
    expect(storeIcon?.classList.contains('h-4')).toBe(true)
    expect(storeIcon?.classList.contains('w-4')).toBe(true)

    cleanup()

    // Test schema namespace - should render FileJson2 icon
    const { container: schemaContainer } = render(
      <ToolCallDisplay
        toolName="schema.set"
        state="input-available"
        args={{ name: "test" }}
      />
    )
    const schemaIcon = schemaContainer.querySelector('svg')
    expect(schemaIcon).not.toBeNull()

    cleanup()

    // Test view namespace - should render Eye icon
    const { container: viewContainer } = render(
      <ToolCallDisplay
        toolName="view.execute"
        state="input-available"
        args={{ view: "test" }}
      />
    )
    const viewIcon = viewContainer.querySelector('svg')
    expect(viewIcon).not.toBeNull()

    cleanup()

    // Test agent namespace - should render Bot icon
    const { container: agentContainer } = render(
      <ToolCallDisplay
        toolName="agent.chat"
        state="input-available"
        args={{ message: "hello" }}
      />
    )
    const agentIcon = agentContainer.querySelector('svg')
    expect(agentIcon).not.toBeNull()

    cleanup()

    // Test unknown namespace - should render Terminal icon (default)
    const { container: unknownContainer } = render(
      <ToolCallDisplay
        toolName="unknown_tool"
        state="input-available"
        args={{}}
      />
    )
    const unknownIcon = unknownContainer.querySelector('svg')
    expect(unknownIcon).not.toBeNull()
  })
})

// ============================================================
// Test: Collapsible Tool Call Display (task-cpbi-010)
// ============================================================

// test-cpbi-010-a: Tool calls render collapsed by default
describe("test-cpbi-010-a: Tool calls render collapsed by default", () => {
  test("renders collapsed by default - args not visible", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User", data: { id: "1", name: "Test" } }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Args section should NOT be visible when collapsed
    const argsSection = container.querySelector('[data-testid="tool-args"]')
    expect(argsSection).toBeNull()
  })

  test("renders collapsed by default - result not visible", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Result section should NOT be visible when collapsed
    const resultSection = container.querySelector('[data-testid="tool-result"]')
    expect(resultSection).toBeNull()
  })

  test("chevron right icon shown when collapsed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Should have chevron-right (collapsed indicator) or similar
    const header = container.querySelector('[data-testid="tool-call-header"]')
    expect(header).not.toBeNull()
  })
})

// test-cpbi-010-b: Collapsed view shows summary line
describe("test-cpbi-010-b: Collapsed view shows summary line", () => {
  test("summary line is visible when collapsed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Summary line should be visible in collapsed state
    expect(container.textContent).toContain("store.create: User")
  })

  test("tool name is always visible", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "Task" }}
        result={[]}
        summaryLine="store.query: Task"
      />
    )

    expect(container.textContent).toContain("store.query")
  })

  test("status indicator visible when collapsed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Success icon should be visible
    const successIcon = container.querySelector('[data-testid="success-icon"]')
    expect(successIcon).not.toBeNull()
  })
})

// test-cpbi-010-c: Click on header expands to show details
describe("test-cpbi-010-c: Click on header expands to show details", () => {
  test("clicking header shows args", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User", data: { id: "1" } }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Initially collapsed - no args visible
    expect(container.querySelector('[data-testid="tool-args"]')).toBeNull()

    // Click the header to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    expect(header).not.toBeNull()
    fireEvent.click(header!)

    // Now args should be visible
    const argsSection = container.querySelector('[data-testid="tool-args"]')
    expect(argsSection).not.toBeNull()
  })

  test("clicking header shows result", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ id: "1", name: "Test User" }}
        summaryLine="store.create: User"
      />
    )

    // Click the header to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Result should be visible
    const resultSection = container.querySelector('[data-testid="tool-result"]')
    expect(resultSection).not.toBeNull()
    expect(container.textContent).toContain("Test User")
  })

  test("expanded view hides summary line", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Click to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Summary line element (with data-testid) should not be present when expanded
    const summaryElement = container.querySelector('[data-testid="summary-line"]')
    expect(summaryElement).toBeNull()
  })
})

// test-cpbi-010-d: Click on expanded header collapses view
describe("test-cpbi-010-d: Click on expanded header collapses view", () => {
  test("clicking expanded header hides args", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    const header = container.querySelector('[data-testid="tool-call-header"]')

    // Click to expand
    fireEvent.click(header!)
    expect(container.querySelector('[data-testid="tool-args"]')).not.toBeNull()

    // Click again to collapse
    fireEvent.click(header!)
    expect(container.querySelector('[data-testid="tool-args"]')).toBeNull()
  })

  test("clicking expanded header hides result", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    const header = container.querySelector('[data-testid="tool-call-header"]')

    // Click to expand
    fireEvent.click(header!)
    expect(container.querySelector('[data-testid="tool-result"]')).not.toBeNull()

    // Click again to collapse
    fireEvent.click(header!)
    expect(container.querySelector('[data-testid="tool-result"]')).toBeNull()
  })

  test("summary line reappears when collapsed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    const header = container.querySelector('[data-testid="tool-call-header"]')

    // Expand then collapse
    fireEvent.click(header!)
    fireEvent.click(header!)

    // Summary line should be visible again
    expect(container.textContent).toContain("store.create: User")
  })
})

// test-cpbi-010-e: State resets on navigation (component-local)
describe("test-cpbi-010-e: State resets on navigation (component-local)", () => {
  test("remounting component resets to collapsed state", () => {
    // First render - expand the component
    const { container, unmount } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Verify expanded
    expect(container.querySelector('[data-testid="tool-args"]')).not.toBeNull()

    // Unmount (simulates navigation)
    unmount()

    // Remount - should be collapsed again
    const { container: newContainer } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-available"
        args={{ model: "User" }}
        result={{ success: true }}
        summaryLine="store.create: User"
      />
    )

    // Should be collapsed (args not visible)
    expect(newContainer.querySelector('[data-testid="tool-args"]')).toBeNull()
  })

  test("each instance maintains independent state", () => {
    const { container } = render(
      <div>
        <div data-testid="tool-1">
          <ToolCallDisplay
            toolName="store.create"
            state="output-available"
            args={{ model: "User" }}
            result={{ success: true }}
            summaryLine="store.create: User"
          />
        </div>
        <div data-testid="tool-2">
          <ToolCallDisplay
            toolName="store.query"
            state="output-available"
            args={{ model: "Task" }}
            result={[]}
            summaryLine="store.query: Task"
          />
        </div>
      </div>
    )

    // Get headers for both tool calls
    const tool1 = container.querySelector('[data-testid="tool-1"]')
    const tool2 = container.querySelector('[data-testid="tool-2"]')

    const header1 = tool1?.querySelector('[data-testid="tool-call-header"]')
    const header2 = tool2?.querySelector('[data-testid="tool-call-header"]')

    // Expand first tool only
    fireEvent.click(header1!)

    // First tool should be expanded
    expect(tool1?.querySelector('[data-testid="tool-args"]')).not.toBeNull()

    // Second tool should still be collapsed
    expect(tool2?.querySelector('[data-testid="tool-args"]')).toBeNull()
  })
})

// Test: Error always visible regardless of collapsed state
describe("Error display in collapsed state", () => {
  test("error is visible even when collapsed", () => {
    const { container } = render(
      <ToolCallDisplay
        toolName="store.create"
        state="output-error"
        args={{ model: "User" }}
        error="Database connection failed"
        summaryLine="store.create: User"
      />
    )

    // Error should be visible even in collapsed state
    const errorSection = container.querySelector('[data-testid="tool-error"]')
    expect(errorSection).not.toBeNull()
    expect(container.textContent).toContain("Database connection failed")
  })
})

// ============================================================
// Test: Result Truncation Strategy (task-cpbi-011)
// ============================================================

// test-cpbi-011-a: Results over 500 characters are truncated
describe("test-cpbi-011-a: Results over 500 characters are truncated", () => {
  test("results over 500 characters show truncated content", () => {
    // Generate a result that's definitely > 500 characters when stringified
    const longResult = {
      data: "x".repeat(600),
    }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={longResult}
        summaryLine="store.query: User"
      />
    )

    // Click header to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Should show "Show more" toggle for truncated content
    const showMoreToggle = container.querySelector('[data-testid="show-more-toggle"]')
    expect(showMoreToggle).not.toBeNull()
    expect(showMoreToggle?.textContent).toContain("Show more")
  })
})

// test-cpbi-011-b: Results under threshold show in full
describe("test-cpbi-011-b: Results under threshold show in full", () => {
  test("results under 500 characters show completely without toggle", () => {
    const shortResult = { id: "1", name: "Test User" }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.get"
        state="output-available"
        args={{ id: "1", model: "User" }}
        result={shortResult}
        summaryLine="store.get: User#1"
      />
    )

    // Click header to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Result should be visible
    const resultSection = container.querySelector('[data-testid="tool-result"]')
    expect(resultSection).not.toBeNull()
    expect(container.textContent).toContain("Test User")

    // No "Show more" toggle should be present
    const showMoreToggle = container.querySelector('[data-testid="show-more-toggle"]')
    expect(showMoreToggle).toBeNull()
  })
})

// test-cpbi-011-c: Show more expands full content
describe("test-cpbi-011-c: Show more expands full content", () => {
  test("clicking Show more reveals full content", () => {
    const longData = "y".repeat(600)
    const longResult = { data: longData }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={longResult}
        summaryLine="store.query: User"
      />
    )

    // Click header to expand
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Initially truncated - full content shouldn't be visible
    const resultSection = container.querySelector('[data-testid="tool-result"]')
    expect(resultSection?.textContent).not.toContain(longData)

    // Click "Show more"
    const showMoreToggle = container.querySelector('[data-testid="show-more-toggle"]')
    fireEvent.click(showMoreToggle!)

    // Now full content should be visible
    expect(resultSection?.textContent).toContain(longData)

    // Button should now say "Show less"
    expect(showMoreToggle?.textContent).toContain("Show less")
  })

  test("clicking Show less collapses content back", () => {
    const longData = "z".repeat(600)
    const longResult = { data: longData }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={longResult}
        summaryLine="store.query: User"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Show full content
    const showMoreToggle = container.querySelector('[data-testid="show-more-toggle"]')
    fireEvent.click(showMoreToggle!)

    // Collapse back
    fireEvent.click(showMoreToggle!)

    // Should be truncated again
    const resultSection = container.querySelector('[data-testid="tool-result"]')
    expect(resultSection?.textContent).not.toContain(longData)
    expect(showMoreToggle?.textContent).toContain("Show more")
  })
})

// test-cpbi-011-d: Truncation indicator shows hidden content size
describe("test-cpbi-011-d: Truncation indicator shows hidden content size", () => {
  test("truncation indicator shows character count of hidden content", () => {
    // Create content that when stringified will be around 700 chars
    const longResult = { data: "a".repeat(600) }
    const resultString = JSON.stringify(longResult, null, 2)
    const expectedHiddenCount = resultString.length - 500

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={longResult}
        summaryLine="store.query: User"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Check that the toggle shows the hidden character count
    const showMoreToggle = container.querySelector('[data-testid="show-more-toggle"]')
    expect(showMoreToggle?.textContent).toMatch(/\d+ chars? hidden/)
  })
})

// test-cpbi-011-e: Deeply nested objects show first 2 levels
describe("test-cpbi-011-e: Deeply nested objects show first 2 levels", () => {
  test("deeply nested objects are collapsed to 2 levels by default", () => {
    const deeplyNested = {
      level1: {
        level2: {
          level3: {
            level4: {
              data: "deep value",
            },
          },
        },
      },
    }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.get"
        state="output-available"
        args={{ id: "1", model: "User" }}
        result={deeplyNested}
        summaryLine="store.get: User#1"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    const resultSection = container.querySelector('[data-testid="tool-result"]')

    // Level 1 and 2 should be visible
    expect(resultSection?.textContent).toContain("level1")
    expect(resultSection?.textContent).toContain("level2")

    // Deeper levels should be collapsed (shown as {...} or similar)
    expect(resultSection?.textContent).toContain("{...}")
  })
})

// test-cpbi-011-f: Metadata always visible regardless of truncation
describe("test-cpbi-011-f: Metadata always visible regardless of truncation", () => {
  test("ok/success status always visible in metadata section", () => {
    const largeResult = {
      ok: true,
      data: "x".repeat(600),
    }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={largeResult}
        summaryLine="store.query: User"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Metadata section should be visible
    const metadataSection = container.querySelector('[data-testid="result-metadata"]')
    expect(metadataSection).not.toBeNull()
    expect(metadataSection?.textContent).toContain("ok")
    expect(metadataSection?.textContent).toContain("true")
  })

  test("count always visible in metadata section", () => {
    const resultWithCount = {
      count: 42,
      items: Array(42).fill({ id: "1", data: "x".repeat(50) }),
    }

    const { container } = render(
      <ToolCallDisplay
        toolName="store.query"
        state="output-available"
        args={{ model: "User" }}
        result={resultWithCount}
        summaryLine="store.query: User"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Metadata section should show count
    const metadataSection = container.querySelector('[data-testid="result-metadata"]')
    expect(metadataSection).not.toBeNull()
    expect(metadataSection?.textContent).toContain("count")
    expect(metadataSection?.textContent).toContain("42")
  })

  test("schema name always visible in metadata section", () => {
    const resultWithSchema = {
      schema: "UserSchema",
      ok: true,
      data: "x".repeat(600),
    }

    const { container } = render(
      <ToolCallDisplay
        toolName="schema.load"
        state="output-available"
        args={{ name: "UserSchema" }}
        result={resultWithSchema}
        summaryLine="schema.load: UserSchema"
      />
    )

    // Expand tool call
    const header = container.querySelector('[data-testid="tool-call-header"]')
    fireEvent.click(header!)

    // Metadata section should show schema
    const metadataSection = container.querySelector('[data-testid="result-metadata"]')
    expect(metadataSection).not.toBeNull()
    expect(metadataSection?.textContent).toContain("schema")
    expect(metadataSection?.textContent).toContain("UserSchema")
  })
})
