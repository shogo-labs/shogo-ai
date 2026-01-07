/**
 * useKeyboardNavigation Hook
 * Task: task-w3-keyboard-navigation
 *
 * Provides keyboard navigation support for lists of interactive elements.
 * Supports arrow key navigation, selection with Enter/Space, and escape handling.
 *
 * Features:
 * - Arrow key navigation (up/down for vertical, left/right for horizontal)
 * - Home/End keys for jumping to first/last item
 * - Enter/Space to select focused item
 * - Escape to clear selection or trigger callback
 * - Optional focus wrapping at boundaries
 * - Screen reader announcement integration
 */

import { useState, useCallback, useMemo } from "react"

/**
 * Item that can be navigated to
 */
export interface NavigableItem {
  /** Unique identifier for the item */
  id: string
  /** Label for screen reader announcements */
  label: string
  /** Optional order for custom sorting */
  order?: number
  /** Whether the item is disabled */
  disabled?: boolean
}

/**
 * Options for useKeyboardNavigation hook
 */
export interface KeyboardNavigationOptions {
  /** List of navigable items */
  items: NavigableItem[]
  /** Navigation orientation */
  orientation?: "vertical" | "horizontal" | "grid"
  /** Whether to wrap focus at boundaries */
  wrap?: boolean
  /** Whether to trap focus within the component */
  trapFocus?: boolean
  /** Sort items by their order property */
  sortByOrder?: boolean
  /** Clear selection on Escape */
  clearSelectionOnEscape?: boolean
  /** Announce focus/selection changes for screen readers */
  announceChanges?: boolean
  /** Callback when item is selected */
  onSelect?: (id: string, item: NavigableItem) => void
  /** Callback when Escape is pressed */
  onEscape?: () => void
  /** Callback when focus exits the component */
  onFocusExit?: (direction: "forward" | "backward") => void
}

/**
 * Return type for useKeyboardNavigation hook
 */
export interface KeyboardNavigationResult {
  /** Currently focused item index (-1 if none) */
  focusedIndex: number
  /** Currently focused item ID (null if none) */
  focusedId: string | null
  /** Currently selected item ID (null if none) */
  selectedId: string | null
  /** Items sorted by order (if sortByOrder is true) */
  orderedItems: NavigableItem[]
  /** Last announcement made */
  lastAnnouncement: string | null
  /** Set focused index directly */
  setFocusedIndex: (index: number) => void
  /** Set focused ID directly */
  setFocusedId: (id: string | null) => void
  /** Set selected ID directly */
  setSelectedId: (id: string | null) => void
  /** Keyboard event handler to attach to container */
  handleKeyDown: (event: React.KeyboardEvent) => void
  /** Get props for an item */
  getItemProps: (id: string) => {
    tabIndex: number
    "aria-selected": boolean
    "data-focused": boolean
  }
}

/**
 * Hook for keyboard navigation of lists/grids
 *
 * @example
 * ```tsx
 * const items = [
 *   { id: "1", label: "Item 1" },
 *   { id: "2", label: "Item 2" },
 * ]
 *
 * const {
 *   focusedId,
 *   handleKeyDown,
 *   getItemProps
 * } = useKeyboardNavigation({
 *   items,
 *   onSelect: (id) => console.log("Selected:", id)
 * })
 *
 * return (
 *   <div onKeyDown={handleKeyDown}>
 *     {items.map(item => (
 *       <div key={item.id} {...getItemProps(item.id)}>
 *         {item.label}
 *       </div>
 *     ))}
 *   </div>
 * )
 * ```
 */
export function useKeyboardNavigation(
  options: KeyboardNavigationOptions
): KeyboardNavigationResult {
  const {
    items,
    orientation = "vertical",
    wrap = false,
    trapFocus = false,
    sortByOrder = false,
    clearSelectionOnEscape = false,
    announceChanges = false,
    onSelect,
    onEscape,
    onFocusExit,
  } = options

  // State
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [lastAnnouncement, setLastAnnouncement] = useState<string | null>(null)

  // Sort items by order if requested
  const orderedItems = useMemo(() => {
    if (!sortByOrder) return items
    return [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }, [items, sortByOrder])

  // Get focused ID from index
  const focusedId = useMemo(() => {
    if (focusedIndex < 0 || focusedIndex >= orderedItems.length) return null
    return orderedItems[focusedIndex]?.id ?? null
  }, [focusedIndex, orderedItems])

  // Set focused ID (finds index)
  const setFocusedId = useCallback(
    (id: string | null) => {
      if (id === null) {
        setFocusedIndex(-1)
        return
      }
      const index = orderedItems.findIndex((item) => item.id === id)
      setFocusedIndex(index)
    },
    [orderedItems]
  )

  // Announce change for screen readers
  const announce = useCallback(
    (message: string) => {
      if (announceChanges) {
        setLastAnnouncement(message)
      }
    },
    [announceChanges]
  )

  // Navigate to next/previous item
  const navigateToIndex = useCallback(
    (newIndex: number) => {
      const maxIndex = orderedItems.length - 1

      // Handle boundaries
      if (newIndex < 0) {
        newIndex = wrap ? maxIndex : 0
      } else if (newIndex > maxIndex) {
        newIndex = wrap ? 0 : maxIndex
      }

      // Skip disabled items
      let attempts = 0
      while (orderedItems[newIndex]?.disabled && attempts < orderedItems.length) {
        newIndex = newIndex + 1 > maxIndex ? (wrap ? 0 : maxIndex) : newIndex + 1
        attempts++
      }

      setFocusedIndex(newIndex)

      // Announce focus change
      const item = orderedItems[newIndex]
      if (item) {
        announce(`${item.label}, ${newIndex + 1} of ${orderedItems.length}`)
      }
    },
    [orderedItems, wrap, announce]
  )

  // Handle selection
  const selectFocusedItem = useCallback(() => {
    if (focusedIndex < 0 || focusedIndex >= orderedItems.length) return

    const item = orderedItems[focusedIndex]
    if (!item || item.disabled) return

    setSelectedId(item.id)
    onSelect?.(item.id, item)
    announce(`${item.label} selected`)
  }, [focusedIndex, orderedItems, onSelect, announce])

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const { key, shiftKey } = event

      // Determine navigation keys based on orientation
      const isNextKey =
        (orientation === "vertical" && key === "ArrowDown") ||
        (orientation === "horizontal" && key === "ArrowRight") ||
        (orientation === "grid" && (key === "ArrowDown" || key === "ArrowRight"))

      const isPrevKey =
        (orientation === "vertical" && key === "ArrowUp") ||
        (orientation === "horizontal" && key === "ArrowLeft") ||
        (orientation === "grid" && (key === "ArrowUp" || key === "ArrowLeft"))

      switch (key) {
        case "ArrowDown":
        case "ArrowUp":
        case "ArrowLeft":
        case "ArrowRight":
          if (isNextKey) {
            event.preventDefault()
            navigateToIndex(focusedIndex + 1)
          } else if (isPrevKey) {
            event.preventDefault()
            navigateToIndex(focusedIndex - 1)
          }
          break

        case "Home":
          event.preventDefault()
          navigateToIndex(0)
          break

        case "End":
          event.preventDefault()
          navigateToIndex(orderedItems.length - 1)
          break

        case "Enter":
        case " ": // Space
          event.preventDefault()
          selectFocusedItem()
          break

        case "Escape":
          event.preventDefault()
          if (clearSelectionOnEscape) {
            setSelectedId(null)
          }
          onEscape?.()
          break

        case "Tab":
          // Allow natural tab flow unless trapFocus is true
          if (!trapFocus) {
            onFocusExit?.(shiftKey ? "backward" : "forward")
          } else {
            event.preventDefault()
            // Trap focus within component
            if (shiftKey) {
              navigateToIndex(focusedIndex - 1)
            } else {
              navigateToIndex(focusedIndex + 1)
            }
          }
          break
      }
    },
    [
      orientation,
      focusedIndex,
      orderedItems.length,
      trapFocus,
      clearSelectionOnEscape,
      navigateToIndex,
      selectFocusedItem,
      onEscape,
      onFocusExit,
    ]
  )

  // Get props for an item
  const getItemProps = useCallback(
    (id: string) => {
      const index = orderedItems.findIndex((item) => item.id === id)
      const isFocused = index === focusedIndex
      const isSelected = id === selectedId

      return {
        tabIndex: isFocused || (focusedIndex === -1 && index === 0) ? 0 : -1,
        "aria-selected": isSelected,
        "data-focused": isFocused,
      }
    },
    [orderedItems, focusedIndex, selectedId]
  )

  return {
    focusedIndex,
    focusedId,
    selectedId,
    orderedItems,
    lastAnnouncement,
    setFocusedIndex,
    setFocusedId,
    setSelectedId,
    handleKeyDown,
    getItemProps,
  }
}
