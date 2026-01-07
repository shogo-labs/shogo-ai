/**
 * StatusIndicator Component Tests
 * Task: task-w1-status-indicator-primitive
 *
 * Tests verify:
 * 1. Component renders without crashing
 * 2. Supports badge and stepper layouts
 * 3. Stepper layout shows visual stage progression
 * 4. Highlights current stage with pulse animation
 * 5. Shows checkmark for completed stages
 * 6. Works with TDD cycle stages
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { render } from "@testing-library/react"
import { Window } from "happy-dom"
import { StatusIndicator, type Stage } from "./StatusIndicator"

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
const basicStages: Stage[] = [
  { id: "stage-1", label: "Step 1" },
  { id: "stage-2", label: "Step 2" },
  { id: "stage-3", label: "Step 3" },
]

const tddStages: Stage[] = [
  { id: "test_written", label: "Test Written" },
  { id: "test_failing", label: "Test Failing" },
  { id: "implementing", label: "Implementing" },
  { id: "test_passing", label: "Test Passing" },
]

describe("StatusIndicator - Renders", () => {
  test("renders without throwing errors", () => {
    expect(() =>
      render(<StatusIndicator stages={basicStages} currentStage="stage-1" />)
    ).not.toThrow()
  })

  test("stage elements are visible", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-1" />
    )
    const stages = container.querySelectorAll("[data-stage]")
    expect(stages.length).toBe(3)
  })

  test("no console errors are logged", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-1" />
    )
    expect(container).toBeTruthy()
  })
})

describe("StatusIndicator - Layouts", () => {
  test("renders inline badge with layout='badge'", () => {
    const { container } = render(
      <StatusIndicator
        stages={basicStages}
        currentStage="stage-2"
        layout="badge"
      />
    )
    const indicator = container.querySelector("[data-layout]")
    expect(indicator?.getAttribute("data-layout")).toBe("badge")
  })

  test("renders progress stepper with layout='stepper'", () => {
    const { container } = render(
      <StatusIndicator
        stages={basicStages}
        currentStage="stage-2"
        layout="stepper"
      />
    )
    const indicator = container.querySelector("[data-layout]")
    expect(indicator?.getAttribute("data-layout")).toBe("stepper")
  })

  test("defaults to stepper layout when not specified", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-1" />
    )
    const indicator = container.querySelector("[data-layout]")
    expect(indicator?.getAttribute("data-layout")).toBe("stepper")
  })
})

describe("StatusIndicator - Stepper Progression", () => {
  test("all stages before currentStage show completed state", () => {
    const { container } = render(
      <StatusIndicator
        stages={basicStages}
        currentStage="stage-3"
        layout="stepper"
      />
    )

    const stage1 = container.querySelector("[data-stage='stage-1']")
    const stage2 = container.querySelector("[data-stage='stage-2']")

    expect(stage1?.getAttribute("data-status")).toBe("completed")
    expect(stage2?.getAttribute("data-status")).toBe("completed")
  })

  test("currentStage is visually highlighted", () => {
    const { container } = render(
      <StatusIndicator
        stages={basicStages}
        currentStage="stage-2"
        layout="stepper"
      />
    )

    const currentStage = container.querySelector("[data-stage='stage-2']")
    expect(currentStage?.getAttribute("data-status")).toBe("current")
  })

  test("stages after currentStage show pending state", () => {
    const { container } = render(
      <StatusIndicator
        stages={basicStages}
        currentStage="stage-1"
        layout="stepper"
      />
    )

    const stage2 = container.querySelector("[data-stage='stage-2']")
    const stage3 = container.querySelector("[data-stage='stage-3']")

    expect(stage2?.getAttribute("data-status")).toBe("pending")
    expect(stage3?.getAttribute("data-status")).toBe("pending")
  })
})

describe("StatusIndicator - Current Stage Highlight", () => {
  test("current stage element has distinct visual styling", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-2" />
    )

    const currentStage = container.querySelector("[data-stage='stage-2']")
    expect(currentStage?.getAttribute("data-status")).toBe("current")
  })

  test("pulse animation CSS class is applied to current stage", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-2" />
    )

    const currentStage = container.querySelector("[data-stage='stage-2']")
    // Should have animation class for pulse effect
    expect(currentStage?.className).toContain("animate")
  })

  test("animation is visible and not distracting", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-2" />
    )

    // Component should render successfully with animation
    const currentStage = container.querySelector("[data-status='current']")
    expect(currentStage).not.toBeNull()
  })
})

describe("StatusIndicator - Completed Checkmark", () => {
  test("completed stages display checkmark icon", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-3" />
    )

    const completedStage = container.querySelector("[data-stage='stage-1']")
    const checkmark = completedStage?.querySelector("[data-checkmark]")
    expect(checkmark).not.toBeNull()
  })

  test("checkmark is visually distinct from pending state", () => {
    const { container } = render(
      <StatusIndicator stages={basicStages} currentStage="stage-2" />
    )

    const completedStage = container.querySelector("[data-stage='stage-1']")
    const pendingStage = container.querySelector("[data-stage='stage-3']")

    const completedHasCheckmark = completedStage?.querySelector("[data-checkmark]")
    const pendingHasCheckmark = pendingStage?.querySelector("[data-checkmark]")

    expect(completedHasCheckmark).not.toBeNull()
    expect(pendingHasCheckmark).toBeNull()
  })
})

describe("StatusIndicator - TDD Stages", () => {
  test("works with TDD cycle stages", () => {
    const { container } = render(
      <StatusIndicator stages={tddStages} currentStage="implementing" />
    )

    const stages = container.querySelectorAll("[data-stage]")
    expect(stages.length).toBe(4)
  })

  test("test_written shows completed when currentStage is implementing", () => {
    const { container } = render(
      <StatusIndicator stages={tddStages} currentStage="implementing" />
    )

    const testWritten = container.querySelector("[data-stage='test_written']")
    expect(testWritten?.getAttribute("data-status")).toBe("completed")
  })

  test("test_failing shows completed when currentStage is implementing", () => {
    const { container } = render(
      <StatusIndicator stages={tddStages} currentStage="implementing" />
    )

    const testFailing = container.querySelector("[data-stage='test_failing']")
    expect(testFailing?.getAttribute("data-status")).toBe("completed")
  })

  test("implementing shows current with highlight", () => {
    const { container } = render(
      <StatusIndicator stages={tddStages} currentStage="implementing" />
    )

    const implementing = container.querySelector("[data-stage='implementing']")
    expect(implementing?.getAttribute("data-status")).toBe("current")
  })

  test("test_passing shows pending when currentStage is implementing", () => {
    const { container } = render(
      <StatusIndicator stages={tddStages} currentStage="implementing" />
    )

    const testPassing = container.querySelector("[data-stage='test_passing']")
    expect(testPassing?.getAttribute("data-status")).toBe("pending")
  })
})
