/**
 * Tests for useWorkspaceNavigation Hook
 * Task: task-2-2-002
 *
 * TDD tests for the workspace navigation hook that manages URL state
 * for workspace/project/feature selection using nuqs and localStorage.
 *
 * Test Specifications:
 * - test-2-2-002-001: Hook exports all required state and setters
 * - test-2-2-002-002: Changing workspace cascades to clear project and feature
 * - test-2-2-002-003: Changing project cascades to clear feature only
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import React from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"

// ============================================================
// Happy-DOM Setup
// ============================================================

let window: Window
let container: HTMLElement
let root: Root
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window({ url: "http://localhost:3000/" })
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

beforeEach(() => {
  container = window.document.createElement("div")
  container.id = "root"
  window.document.body.appendChild(container)
  root = createRoot(container)
  // Clear localStorage before each test
  window.localStorage.clear()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

// ============================================================
// Test 1: useWorkspaceNavigation exports all required state and setters
// (test-2-2-002-001)
// ============================================================

describe("test-2-2-002-001: useWorkspaceNavigation exports all required state and setters", () => {
  test("Hook returns workspaceSlug and setWorkspaceSlug", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("workspaceSlug")
    expect(hookResult).toHaveProperty("setWorkspaceSlug")
    expect(typeof hookResult!.setWorkspaceSlug).toBe("function")
  })

  test("Hook returns projectId and setProjectId", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("projectId")
    expect(hookResult).toHaveProperty("setProjectId")
    expect(typeof hookResult!.setProjectId).toBe("function")
  })

  test("Hook returns featureId and setFeatureId", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("featureId")
    expect(hookResult).toHaveProperty("setFeatureId")
    expect(typeof hookResult!.setFeatureId).toBe("function")
  })

  test("Hook returns clearFeature and clearProject functions", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("clearFeature")
    expect(hookResult).toHaveProperty("clearProject")
    expect(typeof hookResult!.clearFeature).toBe("function")
    expect(typeof hookResult!.clearProject).toBe("function")
  })

  test("Hook reads initial URL params correctly", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set workspace in localStorage (workspace is stored in localStorage, not URL)
    window.localStorage.setItem("shogo-current-workspace", "shogo")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj-123&feature=feat-456">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult!.workspaceSlug).toBe("shogo")
    expect(hookResult!.projectId).toBe("proj-123")
    expect(hookResult!.featureId).toBe("feat-456")
  })

  test("Hook returns null for missing URL params", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(hookResult).not.toBeNull()
    expect(hookResult!.workspaceSlug).toBeNull()
    expect(hookResult!.projectId).toBeNull()
    expect(hookResult!.featureId).toBeNull()
  })
})

// ============================================================
// Test 2: Changing workspace cascades to clear project and feature
// (test-2-2-002-002)
// ============================================================

describe("test-2-2-002-002: Changing workspace cascades to clear project and feature", () => {
  test("setWorkspaceSlug clears projectId and featureId", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return (
        <div>
          <span data-testid="workspace">{hookResult.workspaceSlug ?? "null"}</span>
          <span data-testid="project">{hookResult.projectId ?? "null"}</span>
          <span data-testid="feature">{hookResult.featureId ?? "null"}</span>
        </div>
      )
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify initial state
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBe("proj1")
    expect(hookResult!.featureId).toBe("feat1")

    // Change workspace - should cascade clear project and feature
    await act(async () => {
      hookResult!.setWorkspaceSlug("workspace2")
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify workspace changed and project/feature cleared
    expect(hookResult!.workspaceSlug).toBe("workspace2")
    expect(hookResult!.projectId).toBeNull()
    expect(hookResult!.featureId).toBeNull()
  })

  test("setWorkspaceSlug to null clears all navigation state", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Set workspace to null
    await act(async () => {
      hookResult!.setWorkspaceSlug(null)
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // All should be null
    expect(hookResult!.workspaceSlug).toBeNull()
    expect(hookResult!.projectId).toBeNull()
    expect(hookResult!.featureId).toBeNull()
  })
})

// ============================================================
// Test 3: Changing project cascades to clear feature only
// (test-2-2-002-003)
// ============================================================

describe("test-2-2-002-003: Changing project cascades to clear feature only", () => {
  test("setProjectId clears featureId but preserves workspaceSlug", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify initial state
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBe("proj1")
    expect(hookResult!.featureId).toBe("feat1")

    // Change project - should clear feature but preserve workspace
    await act(async () => {
      await hookResult!.setProjectId("proj2")
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify project changed, feature cleared, workspace preserved
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBe("proj2")
    expect(hookResult!.featureId).toBeNull()
  })

  test("clearProject clears projectId and featureId but preserves workspaceSlug", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Clear project
    await act(async () => {
      await hookResult!.clearProject()
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify workspace preserved, project and feature cleared
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBeNull()
    expect(hookResult!.featureId).toBeNull()
  })

  test("clearFeature only clears featureId", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Clear feature
    await act(async () => {
      await hookResult!.clearFeature()
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify only feature cleared
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBe("proj1")
    expect(hookResult!.featureId).toBeNull()
  })

  test("setFeatureId does not affect workspaceSlug or projectId", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceNavigation } = await import("../useWorkspaceNavigation")

    // Set initial workspace in localStorage
    window.localStorage.setItem("shogo-current-workspace", "workspace1")

    let hookResult: ReturnType<typeof useWorkspaceNavigation> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceNavigation()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=proj1&feature=feat1">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    // Change feature
    await act(async () => {
      await hookResult!.setFeatureId("feat2")
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Verify only feature changed
    expect(hookResult!.workspaceSlug).toBe("workspace1")
    expect(hookResult!.projectId).toBe("proj1")
    expect(hookResult!.featureId).toBe("feat2")
  })
})

// ============================================================
// Test: useWorkspaceNavigation uses nuqs parseAsString
// ============================================================

describe("useWorkspaceNavigation uses nuqs parseAsString for all params", () => {
  test("File imports parseAsString from nuqs", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceNavigation.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should import parseAsString from nuqs
    expect(hookSource).toMatch(/import\s*{[^}]*parseAsString[^}]*}\s*from\s*['"]nuqs['"]/)
  })

  test("File uses useQueryState from nuqs", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceNavigation.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should import useQueryState from nuqs
    expect(hookSource).toMatch(/import\s*{[^}]*useQueryState[^}]*}\s*from\s*['"]nuqs['"]/)
  })
})
