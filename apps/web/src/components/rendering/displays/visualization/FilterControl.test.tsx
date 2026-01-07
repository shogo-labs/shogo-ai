/**
 * FilterControl Component Tests
 * Task: task-w3-filter-controls
 *
 * Tests verify:
 * 1. Component renders without crashing
 * 2. Displays filter options
 * 3. Supports chip-select variant with clickable pill buttons
 * 4. Supports dropdown variant with select element
 * 5. Supports toggle variant with on/off switch controls
 * 6. Filter changes update view immediately via React state
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, mock } from "bun:test"
import { render, fireEvent, screen } from "@testing-library/react"
import { Window } from "happy-dom"
import { FilterControl, type FilterOption, type FilterVariant } from "./FilterControl"

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

// Test data
const basicOptions: FilterOption[] = [
  { id: "option-1", label: "Option 1" },
  { id: "option-2", label: "Option 2" },
  { id: "option-3", label: "Option 3" },
]

const coloredOptions: FilterOption[] = [
  { id: "pattern", label: "Patterns", color: "violet" },
  { id: "risk", label: "Risks", color: "red" },
  { id: "gap", label: "Gaps", color: "amber" },
]

describe("FilterControl - Renders", () => {
  test("renders without throwing errors", () => {
    expect(() =>
      render(
        <FilterControl
          options={basicOptions}
          value={[]}
          onChange={() => {}}
        />
      )
    ).not.toThrow()
  })

  test("filter options are displayed", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
      />
    )

    // Should show all options
    expect(container.textContent).toContain("Option 1")
    expect(container.textContent).toContain("Option 2")
    expect(container.textContent).toContain("Option 3")
  })

  test("initial state shows none selected when value is empty array", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    const selectedChips = container.querySelectorAll("[data-selected='true']")
    expect(selectedChips.length).toBe(0)
  })

  test("initial state shows all selected when value contains all option ids", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1", "option-2", "option-3"]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    const selectedChips = container.querySelectorAll("[data-selected='true']")
    expect(selectedChips.length).toBe(3)
  })
})

describe("FilterControl - Chip-select Variant", () => {
  test("renders clickable pill buttons with variant='chip-select'", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    const chips = container.querySelectorAll("[data-chip]")
    expect(chips.length).toBe(3)

    // Chips should be buttons
    chips.forEach((chip) => {
      expect(chip.tagName.toLowerCase()).toBe("button")
    })
  })

  test("chip-select shows visual selected state", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-2"]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    const selectedChip = container.querySelector("[data-chip='option-2']")
    expect(selectedChip?.getAttribute("data-selected")).toBe("true")

    const unselectedChip = container.querySelector("[data-chip='option-1']")
    expect(unselectedChip?.getAttribute("data-selected")).toBe("false")
  })

  test("clicking chip calls onChange with updated selection (multi-select)", () => {
    const mockOnChange = mock(() => {})
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1"]}
        onChange={mockOnChange}
        variant="chip-select"
        multiSelect
      />
    )

    const chip2 = container.querySelector("[data-chip='option-2']")
    fireEvent.click(chip2!)

    // Should add option-2 to existing selection
    expect(mockOnChange).toHaveBeenCalledWith(["option-1", "option-2"])
  })

  test("clicking selected chip removes it from selection", () => {
    const mockOnChange = mock(() => {})
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1", "option-2"]}
        onChange={mockOnChange}
        variant="chip-select"
        multiSelect
      />
    )

    const chip1 = container.querySelector("[data-chip='option-1']")
    fireEvent.click(chip1!)

    // Should remove option-1, leaving only option-2
    expect(mockOnChange).toHaveBeenCalledWith(["option-2"])
  })

  test("chip-select supports colored options", () => {
    const { container } = render(
      <FilterControl
        options={coloredOptions}
        value={["pattern"]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    const patternChip = container.querySelector("[data-chip='pattern']")
    expect(patternChip).toBeTruthy()
    // Color should influence styling
    expect(patternChip?.className).toMatch(/violet|purple/)
  })
})

describe("FilterControl - Dropdown Variant", () => {
  test("renders select element with variant='dropdown'", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="dropdown"
      />
    )

    const select = container.querySelector("select")
    expect(select).toBeTruthy()
  })

  test("dropdown shows all options in select", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="dropdown"
      />
    )

    const options = container.querySelectorAll("option")
    // +1 for placeholder/all option
    expect(options.length).toBeGreaterThanOrEqual(3)
  })

  test("dropdown fires onChange when selection changes", () => {
    const mockOnChange = mock(() => {})
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={mockOnChange}
        variant="dropdown"
      />
    )

    const select = container.querySelector("select")!
    fireEvent.change(select, { target: { value: "option-2" } })

    expect(mockOnChange).toHaveBeenCalledWith(["option-2"])
  })

  test("dropdown shows current selection", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-2"]}
        onChange={() => {}}
        variant="dropdown"
      />
    )

    const select = container.querySelector("select") as HTMLSelectElement
    expect(select.value).toBe("option-2")
  })
})

describe("FilterControl - Toggle Variant", () => {
  test("renders toggle switches with variant='toggle'", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="toggle"
      />
    )

    const toggles = container.querySelectorAll("[data-toggle]")
    expect(toggles.length).toBe(3)
  })

  test("toggle shows on/off states", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1", "option-3"]}
        onChange={() => {}}
        variant="toggle"
      />
    )

    const toggle1 = container.querySelector("[data-toggle='option-1']")
    const toggle2 = container.querySelector("[data-toggle='option-2']")
    const toggle3 = container.querySelector("[data-toggle='option-3']")

    expect(toggle1?.getAttribute("data-checked")).toBe("true")
    expect(toggle2?.getAttribute("data-checked")).toBe("false")
    expect(toggle3?.getAttribute("data-checked")).toBe("true")
  })

  test("clicking toggle fires onChange", () => {
    const mockOnChange = mock(() => {})
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1"]}
        onChange={mockOnChange}
        variant="toggle"
      />
    )

    const toggle2 = container.querySelector("[data-toggle='option-2']")
    fireEvent.click(toggle2!)

    expect(mockOnChange).toHaveBeenCalledWith(["option-1", "option-2"])
  })
})

describe("FilterControl - Immediate Updates", () => {
  test("filter changes propagate immediately without submit", () => {
    let currentValue: string[] = []
    const handleChange = (newValue: string[]) => {
      currentValue = newValue
    }

    const { container, rerender } = render(
      <FilterControl
        options={basicOptions}
        value={currentValue}
        onChange={handleChange}
        variant="chip-select"
        multiSelect
      />
    )

    const chip1 = container.querySelector("[data-chip='option-1']")
    fireEvent.click(chip1!)

    // Value should update immediately
    expect(currentValue).toEqual(["option-1"])

    // Re-render with new value
    rerender(
      <FilterControl
        options={basicOptions}
        value={currentValue}
        onChange={handleChange}
        variant="chip-select"
        multiSelect
      />
    )

    // UI should reflect new state immediately
    const selectedChip = container.querySelector("[data-chip='option-1']")
    expect(selectedChip?.getAttribute("data-selected")).toBe("true")
  })

  test("no loading state for filter changes", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="chip-select"
      />
    )

    // Should not have any loading indicators
    const loadingElements = container.querySelectorAll("[data-loading]")
    expect(loadingElements.length).toBe(0)

    const chip1 = container.querySelector("[data-chip='option-1']")
    fireEvent.click(chip1!)

    // Still no loading after interaction
    const loadingAfter = container.querySelectorAll("[data-loading]")
    expect(loadingAfter.length).toBe(0)
  })
})

describe("FilterControl - Accessibility", () => {
  test("chip-select has proper ARIA attributes", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1"]}
        onChange={() => {}}
        variant="chip-select"
        label="Filter by type"
      />
    )

    const group = container.querySelector("[role='group']")
    expect(group).toBeTruthy()
    expect(group?.getAttribute("aria-label")).toBe("Filter by type")
  })

  test("dropdown has accessible label", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={[]}
        onChange={() => {}}
        variant="dropdown"
        label="Sort order"
      />
    )

    const select = container.querySelector("select")
    expect(select?.getAttribute("aria-label")).toBe("Sort order")
  })
})

describe("FilterControl - Clear All / Select All", () => {
  test("shows 'Clear All' button when items are selected", () => {
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1", "option-2"]}
        onChange={() => {}}
        variant="chip-select"
        multiSelect
        showClearAll
      />
    )

    const clearButton = container.querySelector("[data-clear-all]")
    expect(clearButton).toBeTruthy()
  })

  test("'Clear All' button clears selection", () => {
    const mockOnChange = mock(() => {})
    const { container } = render(
      <FilterControl
        options={basicOptions}
        value={["option-1", "option-2"]}
        onChange={mockOnChange}
        variant="chip-select"
        multiSelect
        showClearAll
      />
    )

    const clearButton = container.querySelector("[data-clear-all]")
    fireEvent.click(clearButton!)

    expect(mockOnChange).toHaveBeenCalledWith([])
  })
})
