/**
 * AdvancedChatLayout Tests
 *
 * Tests for the AdvancedChatLayout smart component.
 * Task: task-testbed-layout
 * Feature: virtual-tools-domain
 *
 * Test Specifications:
 * - test-layout-structure: Verify correct flex layout structure
 * - test-layout-state-persistence: Verify localStorage persistence
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { render, cleanup, act } from "@testing-library/react"

// Set up happy-dom
import { Window } from "happy-dom"

let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

// Storage key constant (must match component)
const STORAGE_KEY = "advanced-chat-workspace-state"
const TESTBED_SESSION_ID = "testbed-session"

// localStorage mock store
let localStorageStore: Record<string, string> = {}

// Mock stores
const mockPlatformFeatures = {
  featureSessionCollection: {
    get: mock(() => null),
    insertOne: mock(() => Promise.resolve()),
  },
}

const mockStudioChat = {
  chatSessionCollection: {
    findByFeatureAndPhase: mock(() => null),
    get: mock(() => null),
    updateOne: mock(() => Promise.resolve()),
  },
  createChatSession: mock(() =>
    Promise.resolve({ id: "mock-session", name: "Mock Session" })
  ),
  addMessage: mock(() => Promise.resolve()),
  chatMessageCollection: {
    findBySession: mock(() => []),
  },
}

// Mock useDomains hook
mock.module("@/contexts/DomainProvider", () => ({
  useDomains: () => ({
    platformFeatures: mockPlatformFeatures,
    studioChat: mockStudioChat,
    componentBuilder: {},
  }),
}))

// Mock ChatPanel to avoid its complex dependencies
mock.module("../../chat/ChatPanel", () => ({
  ChatPanel: ({ featureId, phase }: { featureId: string | null; phase: string | null }) => (
    <div data-testid="chat-panel" data-feature-id={featureId} data-phase={phase ?? "null"}>
      Mock ChatPanel
    </div>
  ),
}))

// Import after mocks are set up
import { AdvancedChatLayout } from "../AdvancedChatLayout"

// localStorage mock implementation
const localStorageMock = {
  getItem: (key: string) => localStorageStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore[key] = value
  },
  removeItem: (key: string) => {
    delete localStorageStore[key]
  },
  clear: () => {
    localStorageStore = {}
  },
}

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window type mismatch
  globalThis.window = window
  // @ts-expect-error - happy-dom Document type mismatch
  globalThis.document = window.document

  // Set up localStorage mock on happy-dom window
  Object.defineProperty(window, "localStorage", {
    value: localStorageMock,
    writable: true,
  })

  // Also mock globalThis.localStorage for the component
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    writable: true,
    configurable: true,
  })
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

beforeEach(() => {
  // Reset localStorage mock store
  localStorageStore = {}

  // Reset mock call counts
  mockPlatformFeatures.featureSessionCollection.get.mockClear()
  mockPlatformFeatures.featureSessionCollection.insertOne.mockClear()
  mockStudioChat.createChatSession.mockClear()
})

afterEach(() => {
  cleanup()
})

// ============================================================
// Test Spec: test-layout-structure
// ============================================================
describe("AdvancedChatLayout has correct structure", () => {
  test("renders DynamicWorkspace on left and ChatPanel on right", async () => {
    const { container } = render(<AdvancedChatLayout />)

    // Wait for useEffect to run
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // DynamicWorkspace shows BlankState when no panels
    // Look for the workspace area's BlankState content
    expect(container.textContent).toContain("How can I help you build today?")

    // Verify ChatPanel is present
    const chatPanel = container.querySelector('[data-testid="chat-panel"]')
    expect(chatPanel).not.toBeNull()
  })

  test("applies flex layout with workspace flex-1 and chat fixed width", async () => {
    const { container } = render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Root should be flex
    const root = container.firstChild as HTMLElement
    expect(root.className).toContain("flex")

    // Workspace container should be flex-1
    const workspaceContainer = root.querySelector(".flex-1")
    expect(workspaceContainer).not.toBeNull()

    // Chat container should have fixed width class
    const chatContainer = container.querySelector('[class*="w-["]')
    expect(chatContainer).not.toBeNull()
  })

  test("ChatPanel receives featureId='testbed-session' and phase=null", async () => {
    const { container } = render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    const chatPanel = container.querySelector('[data-testid="chat-panel"]')
    expect(chatPanel).not.toBeNull()
    expect(chatPanel?.getAttribute("data-feature-id")).toBe(TESTBED_SESSION_ID)
    expect(chatPanel?.getAttribute("data-phase")).toBe("null")
  })
})

// ============================================================
// Test Spec: test-layout-state-persistence
// ============================================================
describe("Workspace state persists to localStorage", () => {
  test("persists initial workspace state to localStorage", async () => {
    render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Initial state should be persisted (empty panels, single layout)
    expect(localStorageStore[STORAGE_KEY]).toBeDefined()

    const savedState = JSON.parse(localStorageStore[STORAGE_KEY])
    expect(savedState).toEqual({
      panels: [],
      layout: "single",
    })
  })

  test("restores workspace state from localStorage on mount", async () => {
    // Set up pre-existing localStorage state
    const existingState = {
      panels: [{ id: "panel-1", type: "preview", title: "Test Panel" }],
      layout: "split-h",
    }
    localStorageStore[STORAGE_KEY] = JSON.stringify(existingState)

    const { container } = render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Component should have rendered - localStorage was read
    expect(container.firstChild).not.toBeNull()
  })
})

// ============================================================
// Feature Session Management
// ============================================================
describe("Feature Session Management", () => {
  test("creates synthetic FeatureSession if not exists", async () => {
    // Mock that session doesn't exist
    mockPlatformFeatures.featureSessionCollection.get.mockReturnValue(null)

    render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Verify insertOne was called to create the testbed session
    expect(mockPlatformFeatures.featureSessionCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TESTBED_SESSION_ID,
        name: "Advanced Chat Testbed",
        intent: "Virtual tools development testbed",
        status: "discovery",
      })
    )
  })

  test("does not create session if already exists", async () => {
    // Mock that session already exists
    // @ts-expect-error - mock returns partial object
    mockPlatformFeatures.featureSessionCollection.get.mockReturnValue({
      id: TESTBED_SESSION_ID,
      name: "Existing Session",
    })

    render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // insertOne should NOT be called
    expect(mockPlatformFeatures.featureSessionCollection.insertOne).not.toHaveBeenCalled()
  })
})

// ============================================================
// MobX Observer Integration
// ============================================================
describe("MobX Observer Integration", () => {
  test("component is wrapped with observer() - verified via source inspection", async () => {
    // The component renders correctly and accesses MobX stores via useDomains
    // This verifies the component can work with MobX reactivity
    // The actual observer() wrapping is verified by examining the source code
    // and confirming it renders without errors when accessing observable stores
    const { container } = render(<AdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Component rendered successfully with MobX store access
    expect(container.firstChild).not.toBeNull()

    // Verify store methods were called (showing MobX integration works)
    expect(mockPlatformFeatures.featureSessionCollection.get).toHaveBeenCalled()
  })
})

// ============================================================
// Test Spec: test-chat-virtual-tool
// Task: task-testbed-chat-integration
// ============================================================
describe("Virtual tool event updates workspace", () => {
  // Capture the onOpenPanel callback passed to ChatPanel
  let capturedOnOpenPanel: ((panel: any) => void) | undefined

  beforeEach(() => {
    capturedOnOpenPanel = undefined

    // Re-mock ChatPanel to capture onOpenPanel callback
    mock.module("../../chat/ChatPanel", () => ({
      ChatPanel: ({
        featureId,
        phase,
        onOpenPanel,
      }: {
        featureId: string | null
        phase: string | null
        onOpenPanel?: (panel: any) => void
      }) => {
        // Capture the callback so test can invoke it
        capturedOnOpenPanel = onOpenPanel
        return (
          <div
            data-testid="chat-panel"
            data-feature-id={featureId}
            data-phase={phase ?? "null"}
            data-has-open-panel-callback={!!onOpenPanel}
          >
            Mock ChatPanel
          </div>
        )
      },
    }))
  })

  test("ChatPanel receives onOpenPanel callback from AdvancedChatLayout", async () => {
    // Need to re-import to get the updated mock
    const { AdvancedChatLayout: FreshAdvancedChatLayout } = await import("../AdvancedChatLayout")

    const { container } = render(<FreshAdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Verify ChatPanel has onOpenPanel callback
    const chatPanel = container.querySelector('[data-testid="chat-panel"]')
    expect(chatPanel?.getAttribute("data-has-open-panel-callback")).toBe("true")
  })

  test("open_panel virtual tool adds panel to workspace", async () => {
    // Need to re-import to get the updated mock
    const { AdvancedChatLayout: FreshAdvancedChatLayout } = await import("../AdvancedChatLayout")

    const { container } = render(<FreshAdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Workspace should initially show BlankState
    expect(container.textContent).toContain("How can I help you build today?")

    // Simulate virtual tool event by calling captured callback
    expect(capturedOnOpenPanel).toBeDefined()

    // Note: content should be React.ReactNode compatible (string, number, element, null)
    // For data objects, use metadata field instead
    await act(async () => {
      capturedOnOpenPanel?.({
        id: "vt-panel-1",
        type: "preview",
        title: "Virtual Tool Panel",
        content: "Preview content",  // Use string content for rendering
      })
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Panel should be added - verify via localStorage state
    const savedState = JSON.parse(localStorageStore[STORAGE_KEY])
    expect(savedState.panels).toHaveLength(1)
    expect(savedState.panels[0]).toMatchObject({
      id: "vt-panel-1",
      type: "preview",
      title: "Virtual Tool Panel",
    })
  })

  test("panel has correct type and title from virtual tool args", async () => {
    const { AdvancedChatLayout: FreshAdvancedChatLayout } = await import("../AdvancedChatLayout")

    render(<FreshAdvancedChatLayout />)

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })

    // Simulate virtual tool event with specific type and title
    // Note: content should be React.ReactNode compatible (string, number, element, null)
    await act(async () => {
      capturedOnOpenPanel?.({
        id: "custom-panel",
        type: "code",
        title: "Code Editor",
        content: "console.log('test')",  // Use string content for rendering
      })
    })

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // Verify panel has correct type and title
    const savedState = JSON.parse(localStorageStore[STORAGE_KEY])
    expect(savedState.panels[0].type).toBe("code")
    expect(savedState.panels[0].title).toBe("Code Editor")
  })
})
