/**
 * Keyboard Navigation Hooks Tests
 * Task: task-w3-keyboard-navigation
 *
 * Tests verify keyboard navigation accessibility features:
 * 1. Graph nodes navigable with arrow keys
 * 2. Enter/Space selects focused element
 * 3. Escape closes detail panels
 * 4. Tab order follows logical flow
 * 5. Focus indicators visible using phase colors
 * 6. No focus traps in any view
 * 7. Screen reader announcements for state changes
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { renderHook, act } from "@testing-library/react"
import { Window } from "happy-dom"
import {
  useKeyboardNavigation,
  type KeyboardNavigationOptions,
  type NavigableItem
} from "../useKeyboardNavigation"
import {
  useFocusManagement,
  type FocusManagementOptions
} from "../useFocusManagement"
import {
  useAriaAnnounce,
  type AriaAnnounceOptions
} from "../useAriaAnnounce"

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

// ============================================================
// Test 1: Graph nodes navigable with arrow keys
// (test-w3-keyboard-graph-navigation)
// ============================================================

describe("test-w3-keyboard-graph-navigation: Graph nodes are navigable with arrow keys", () => {
  test("useKeyboardNavigation returns navigation handlers", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
      { id: "node-3", label: "Entity C" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    expect(result.current).toBeDefined()
    expect(result.current.focusedIndex).toBe(-1)
    expect(result.current.focusedId).toBe(null)
    expect(typeof result.current.handleKeyDown).toBe("function")
  })

  test("ArrowDown moves focus to next item", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
      { id: "node-3", label: "Entity C" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    // Set initial focus
    act(() => {
      result.current.setFocusedIndex(0)
    })

    expect(result.current.focusedIndex).toBe(0)
    expect(result.current.focusedId).toBe("node-1")

    // Press ArrowDown
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(1)
    expect(result.current.focusedId).toBe("node-2")
  })

  test("ArrowUp moves focus to previous item", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
      { id: "node-3", label: "Entity C" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    // Set initial focus to middle item
    act(() => {
      result.current.setFocusedIndex(1)
    })

    // Press ArrowUp
    act(() => {
      result.current.handleKeyDown({
        key: "ArrowUp",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(0)
    expect(result.current.focusedId).toBe("node-1")
  })

  test("ArrowRight moves focus in horizontal mode", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, orientation: "horizontal" })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "ArrowRight",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(1)
  })

  test("ArrowLeft moves focus backward in horizontal mode", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, orientation: "horizontal" })
    )

    act(() => {
      result.current.setFocusedIndex(1)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "ArrowLeft",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(0)
  })

  test("Focus wraps around at boundaries when wrap is enabled", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, wrap: true })
    )

    act(() => {
      result.current.setFocusedIndex(1) // Last item
    })

    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(0) // Wrapped to first
  })

  test("Home key moves focus to first item", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
      { id: "node-3", label: "Entity C" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    act(() => {
      result.current.setFocusedIndex(2)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Home",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(0)
  })

  test("End key moves focus to last item", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
      { id: "node-3", label: "Entity C" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "End",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.focusedIndex).toBe(2)
  })
})

// ============================================================
// Test 2: Enter and Space keys select focused element
// (test-w3-keyboard-enter-select)
// ============================================================

describe("test-w3-keyboard-enter-select: Enter and Space keys select focused element", () => {
  test("Enter key triggers onSelect callback", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]
    const onSelect = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onSelect })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(onSelect).toHaveBeenCalledWith("node-1", items[0])
  })

  test("Space key triggers onSelect callback", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]
    const onSelect = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onSelect })
    )

    act(() => {
      result.current.setFocusedIndex(1)
    })

    act(() => {
      result.current.handleKeyDown({
        key: " ",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(onSelect).toHaveBeenCalledWith("node-2", items[1])
  })

  test("selectedId is updated when item is selected", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.selectedId).toBe("node-1")
  })

  test("Selection does not occur when no item is focused", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
    ]
    const onSelect = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onSelect })
    )

    // focusedIndex is -1 by default

    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ============================================================
// Test 3: Escape key closes detail panels
// (test-w3-keyboard-escape-close)
// ============================================================

describe("test-w3-keyboard-escape-close: Escape key closes detail panels", () => {
  test("Escape key triggers onEscape callback", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
    ]
    const onEscape = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onEscape })
    )

    act(() => {
      result.current.handleKeyDown({
        key: "Escape",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(onEscape).toHaveBeenCalled()
  })

  test("Escape clears selection when configured", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, clearSelectionOnEscape: true })
    )

    // First select an item
    act(() => {
      result.current.setFocusedIndex(0)
    })
    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })
    expect(result.current.selectedId).toBe("node-1")

    // Now press Escape
    act(() => {
      result.current.handleKeyDown({
        key: "Escape",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.selectedId).toBe(null)
  })

  test("useFocusManagement returns to trigger element on close", () => {
    const { result } = renderHook(() =>
      useFocusManagement({ trapFocus: false })
    )

    expect(result.current.returnFocusOnClose).toBeDefined()
    expect(typeof result.current.setTriggerRef).toBe("function")
    expect(typeof result.current.returnFocusOnClose).toBe("function")
  })
})

// ============================================================
// Test 4: Tab order follows logical reading flow
// (test-w3-keyboard-tab-order)
// ============================================================

describe("test-w3-keyboard-tab-order: Tab order follows logical reading flow", () => {
  test("useFocusManagement provides tabIndex management", () => {
    const { result } = renderHook(() =>
      useFocusManagement({})
    )

    expect(result.current).toBeDefined()
    expect(typeof result.current.getTabIndex).toBe("function")
  })

  test("Roving tabindex returns 0 for focused, -1 for others", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
      { id: "item-2", label: "Second" },
      { id: "item-3", label: "Third" },
    ]

    const { result } = renderHook(() =>
      useFocusManagement({ rovingTabIndex: true, items })
    )

    act(() => {
      result.current.setFocusedId("item-2")
    })

    expect(result.current.getTabIndex("item-1")).toBe(-1)
    expect(result.current.getTabIndex("item-2")).toBe(0)
    expect(result.current.getTabIndex("item-3")).toBe(-1)
  })

  test("First item receives tabIndex 0 when no item is focused", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
      { id: "item-2", label: "Second" },
    ]

    const { result } = renderHook(() =>
      useFocusManagement({ rovingTabIndex: true, items })
    )

    // No item focused - first should be tabbable
    expect(result.current.getTabIndex("item-1")).toBe(0)
    expect(result.current.getTabIndex("item-2")).toBe(-1)
  })

  test("Focus order can be set programmatically", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First", order: 2 },
      { id: "item-2", label: "Second", order: 1 },
      { id: "item-3", label: "Third", order: 3 },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, sortByOrder: true })
    )

    // Items should be reordered by their order property
    expect(result.current.orderedItems[0].id).toBe("item-2")
    expect(result.current.orderedItems[1].id).toBe("item-1")
    expect(result.current.orderedItems[2].id).toBe("item-3")
  })
})

// ============================================================
// Test 5: Focus indicators visible using phase colors
// (test-w3-keyboard-focus-visible)
// ============================================================

describe("test-w3-keyboard-focus-visible: Focus indicators are visible and use phase colors", () => {
  test("useFocusManagement provides focus ring class generator", () => {
    const { result } = renderHook(() =>
      useFocusManagement({ phase: "design" })
    )

    expect(typeof result.current.getFocusRingClass).toBe("function")
  })

  test("Focus ring class uses phase-specific color", () => {
    const { result: designResult } = renderHook(() =>
      useFocusManagement({ phase: "design" })
    )

    const designClass = designResult.current.getFocusRingClass()
    expect(designClass).toContain("ring-")
    expect(designClass).toMatch(/amber|phase-design/)

    const { result: specResult } = renderHook(() =>
      useFocusManagement({ phase: "spec" })
    )

    const specClass = specResult.current.getFocusRingClass()
    expect(specClass).toContain("ring-")
    expect(specClass).toMatch(/emerald|phase-spec/)
  })

  test("Focus ring has sufficient contrast (ring-2 minimum)", () => {
    const { result } = renderHook(() =>
      useFocusManagement({ phase: "design" })
    )

    const focusClass = result.current.getFocusRingClass()
    expect(focusClass).toMatch(/ring-2|ring-\[/)
  })

  test("Focus visible class includes focus-visible pseudo-class", () => {
    const { result } = renderHook(() =>
      useFocusManagement({ phase: "design" })
    )

    const focusClass = result.current.getFocusRingClass({ focusVisible: true })
    expect(focusClass).toContain("focus-visible:")
  })

  test("Consistent focus style across all phases", () => {
    const phases = ["discovery", "analysis", "classification", "design", "spec", "testing", "implementation", "complete"]

    phases.forEach(phase => {
      const { result } = renderHook(() =>
        useFocusManagement({ phase })
      )

      const focusClass = result.current.getFocusRingClass()
      // All phases should have ring styling
      expect(focusClass).toContain("ring-")
      // All phases should have offset for visibility
      expect(focusClass).toContain("ring-offset-")
    })
  })
})

// ============================================================
// Test 6: No focus traps exist in any view
// (test-w3-keyboard-no-traps)
// ============================================================

describe("test-w3-keyboard-no-traps: No focus traps exist in any view", () => {
  test("useFocusManagement trapFocus defaults to false", () => {
    const { result } = renderHook(() =>
      useFocusManagement({})
    )

    expect(result.current.trapFocus).toBe(false)
  })

  test("Tab key does not prevent default when trapFocus is false", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
      { id: "item-2", label: "Last" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, trapFocus: false })
    )

    const preventDefault = mock(() => {})

    act(() => {
      result.current.setFocusedIndex(1) // Last item
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Tab",
        preventDefault,
        shiftKey: false,
      } as unknown as React.KeyboardEvent)
    })

    // Should NOT prevent default - allow natural tab flow
    expect(preventDefault).not.toHaveBeenCalled()
  })

  test("Focus can exit component via Tab", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
    ]
    const onFocusExit = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onFocusExit })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Tab",
        preventDefault: () => {},
        shiftKey: false,
      } as unknown as React.KeyboardEvent)
    })

    expect(onFocusExit).toHaveBeenCalledWith("forward")
  })

  test("Shift+Tab allows backward exit", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
    ]
    const onFocusExit = mock(() => {})

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, onFocusExit })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Tab",
        preventDefault: () => {},
        shiftKey: true,
      } as unknown as React.KeyboardEvent)
    })

    expect(onFocusExit).toHaveBeenCalledWith("backward")
  })

  test("Arrow keys at boundary do not trap focus when wrap is false", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
      { id: "item-2", label: "Last" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, wrap: false })
    )

    act(() => {
      result.current.setFocusedIndex(1) // Last item
    })

    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    // Should stay at last item, not wrap
    expect(result.current.focusedIndex).toBe(1)
  })
})

// ============================================================
// Test 7: Screen reader announcements for state changes
// (test-w3-keyboard-screen-reader)
// ============================================================

describe("test-w3-keyboard-screen-reader: Screen reader announcements for state changes", () => {
  test("useAriaAnnounce provides announce function", () => {
    const { result } = renderHook(() =>
      useAriaAnnounce()
    )

    expect(typeof result.current.announce).toBe("function")
    expect(typeof result.current.announcePolite).toBe("function")
    expect(typeof result.current.announceAssertive).toBe("function")
  })

  test("announcePolite uses aria-live polite", () => {
    const { result } = renderHook(() =>
      useAriaAnnounce()
    )

    // Should not throw
    act(() => {
      result.current.announcePolite("Item selected")
    })

    expect(result.current.lastAnnouncement).toBe("Item selected")
    expect(result.current.lastPoliteness).toBe("polite")
  })

  test("announceAssertive uses aria-live assertive", () => {
    const { result } = renderHook(() =>
      useAriaAnnounce()
    )

    act(() => {
      result.current.announceAssertive("Error occurred")
    })

    expect(result.current.lastAnnouncement).toBe("Error occurred")
    expect(result.current.lastPoliteness).toBe("assertive")
  })

  test("useKeyboardNavigation announces selection changes", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "Entity A" },
      { id: "node-2", label: "Entity B" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, announceChanges: true })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "Enter",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.lastAnnouncement).toContain("Entity A")
  })

  test("Focus changes are announced", () => {
    const items: NavigableItem[] = [
      { id: "node-1", label: "First item" },
      { id: "node-2", label: "Second item" },
    ]

    const { result } = renderHook(() =>
      useKeyboardNavigation({ items, announceChanges: true })
    )

    act(() => {
      result.current.setFocusedIndex(0)
    })

    act(() => {
      result.current.handleKeyDown({
        key: "ArrowDown",
        preventDefault: () => {}
      } as React.KeyboardEvent)
    })

    expect(result.current.lastAnnouncement).toContain("Second item")
  })

  test("Debounces rapid announcements", async () => {
    const { result } = renderHook(() =>
      useAriaAnnounce({ debounceMs: 100 })
    )

    act(() => {
      result.current.announcePolite("First")
      result.current.announcePolite("Second")
      result.current.announcePolite("Third")
    })

    // Only the last one should be queued after debounce
    expect(result.current.pendingAnnouncement).toBe("Third")
  })

  test("Provides aria-live region props", () => {
    const { result } = renderHook(() =>
      useAriaAnnounce()
    )

    const props = result.current.getLiveRegionProps()

    expect(props).toHaveProperty("role", "status")
    expect(props).toHaveProperty("aria-live")
    expect(props).toHaveProperty("aria-atomic", true)
  })
})

// ============================================================
// Integration Tests
// ============================================================

describe("Keyboard navigation integration", () => {
  test("useKeyboardNavigation integrates with useFocusManagement via controlled focusedId", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
      { id: "item-2", label: "Second" },
    ]

    // Test that both hooks work with the same focused state
    // In real usage, a component would pass focusedId from nav to focus management
    const { result: navResult } = renderHook(() =>
      useKeyboardNavigation({ items })
    )

    act(() => {
      navResult.current.setFocusedIndex(1)
    })

    // Now create focus management with the updated focusedId
    const { result: focusResult } = renderHook(() =>
      useFocusManagement({
        rovingTabIndex: true,
        items,
        focusedId: navResult.current.focusedId
      })
    )

    // Focus management should reflect the navigation state
    expect(focusResult.current.getTabIndex("item-2")).toBe(0)
    expect(focusResult.current.getTabIndex("item-1")).toBe(-1)
  })

  test("All hooks can be used together", () => {
    const items: NavigableItem[] = [
      { id: "item-1", label: "First" },
    ]

    const { result: navResult } = renderHook(() =>
      useKeyboardNavigation({ items, announceChanges: true })
    )

    const { result: focusResult } = renderHook(() =>
      useFocusManagement({ phase: "design" })
    )

    const { result: announceResult } = renderHook(() =>
      useAriaAnnounce()
    )

    // All hooks should work without conflicts
    expect(navResult.current).toBeDefined()
    expect(focusResult.current).toBeDefined()
    expect(announceResult.current).toBeDefined()
  })
})
