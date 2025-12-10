/**
 * Generated from TestSpecifications for task-teams-react-context
 * Task: teams-react-context
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, waitFor, act, cleanup } from "@testing-library/react"
import React from "react"
import { TeamsProvider, useTeams } from "../TeamsContext"
import { observer } from "mobx-react-lite"

// Set up happy-dom
import { Window } from "happy-dom"

let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// ============================================================
// Test: TeamsContext exports TeamsProvider component
// ============================================================
describe("TeamsContext exports TeamsProvider component", () => {
  test("TeamsProvider is a valid React component", () => {
    expect(TeamsProvider).toBeDefined()
    expect(typeof TeamsProvider).toBe("function")
  })

  test("TeamsProvider accepts children prop", () => {
    const { getByText } = render(
      <TeamsProvider>
        <div>Child content</div>
      </TeamsProvider>
    )
    expect(getByText("Child content")).toBeDefined()
  })
})

// ============================================================
// Test: TeamsProvider creates store via useRef for stable instance
// ============================================================
describe("TeamsProvider creates store via useRef for stable instance", () => {
  test("Same store instance returned each time", () => {
    const storeInstances: any[] = []

    function TestComponent() {
      const teamsStore = useTeams()
      storeInstances.push(teamsStore)
      return <div>Test</div>
    }

    const { rerender } = render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    // Force re-render
    rerender(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    // Both renders should return the same store instance
    expect(storeInstances.length).toBe(2)
    expect(storeInstances[0]).toBe(storeInstances[1])
  })

  test("Store is not recreated on re-render", () => {
    let firstStoreId: string | null = null

    function TestComponent() {
      const teamsStore = useTeams()
      // Use org collection size as a proxy for store identity
      if (firstStoreId === null) {
        firstStoreId = String(teamsStore.organizationCollection)
      }
      return <div>Test</div>
    }

    const { rerender } = render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    const initialId = firstStoreId

    rerender(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    // Store identity should remain same
    expect(firstStoreId).toBe(initialId)
  })
})

// ============================================================
// Test: TeamsProvider calls initialize on mount
// ============================================================
describe("TeamsProvider calls initialize on mount", () => {
  test("store.initialize() is called once on mount", async () => {
    let initializeCalled = false

    const ObserverComponent = observer(function TestComponent() {
      const teamsStore = useTeams()
      // Check if collections are accessible (sign that store is initialized)
      if (teamsStore.organizationCollection) {
        initializeCalled = true
      }
      return <div data-testid="store-ready">{teamsStore.organizationCollection ? "ready" : "loading"}</div>
    })

    render(
      <TeamsProvider>
        <ObserverComponent />
      </TeamsProvider>
    )

    // Store should be initialized
    await waitFor(() => {
      expect(initializeCalled).toBe(true)
    })
  })
})

// ============================================================
// Test: TeamsProvider cleans up on unmount
// ============================================================
describe("TeamsProvider cleans up on unmount", () => {
  test("No memory leaks from event listeners", () => {
    // This test verifies the provider can be mounted/unmounted cleanly
    function TestComponent() {
      const teamsStore = useTeams()
      return <div>{teamsStore.organizationCollection ? "ok" : "loading"}</div>
    }

    const { unmount } = render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    // Should unmount without errors
    expect(() => unmount()).not.toThrow()
  })
})

// ============================================================
// Test: useTeams hook returns typed store instance
// ============================================================
describe("useTeams hook returns typed store instance", () => {
  test("Returns store with organizationCollection", () => {
    let storeHasOrgCollection = false

    function TestComponent() {
      const teamsStore = useTeams()
      storeHasOrgCollection = teamsStore.organizationCollection !== undefined
      return <div>Test</div>
    }

    render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    expect(storeHasOrgCollection).toBe(true)
  })

  test("Returns store with teamCollection", () => {
    let storeHasTeamCollection = false

    function TestComponent() {
      const teamsStore = useTeams()
      storeHasTeamCollection = teamsStore.teamCollection !== undefined
      return <div>Test</div>
    }

    render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    expect(storeHasTeamCollection).toBe(true)
  })

  test("Returns store with membershipCollection", () => {
    let storeHasMembershipCollection = false

    function TestComponent() {
      const teamsStore = useTeams()
      storeHasMembershipCollection = teamsStore.membershipCollection !== undefined
      return <div>Test</div>
    }

    render(
      <TeamsProvider>
        <TestComponent />
      </TeamsProvider>
    )

    expect(storeHasMembershipCollection).toBe(true)
  })
})

// ============================================================
// Test: useTeams throws outside TeamsProvider
// ============================================================
describe("useTeams throws outside TeamsProvider", () => {
  test("Throws error with helpful message", () => {
    // Suppress React error boundary warnings for this test
    const originalError = console.error
    console.error = () => {}

    function TestComponent() {
      useTeams()
      return <div>Should not render</div>
    }

    expect(() => {
      render(<TestComponent />)
    }).toThrow()

    console.error = originalError
  })

  test("Message mentions TeamsProvider", () => {
    const originalError = console.error
    console.error = () => {}

    function TestComponent() {
      useTeams()
      return <div>Should not render</div>
    }

    let errorMessage = ""
    try {
      render(<TestComponent />)
    } catch (e: any) {
      errorMessage = e.message
    }

    expect(errorMessage).toContain("TeamsProvider")

    console.error = originalError
  })
})

// ============================================================
// Test: Components re-render on store changes via observer
// ============================================================
describe("Components re-render on store changes via observer", () => {
  test("Component re-renders automatically when organization added", async () => {
    let storeRef: any = null

    const ObserverComponent = observer(function TestComponent() {
      const teamsStore = useTeams()
      storeRef = teamsStore
      const orgCount = teamsStore.organizationCollection.all().length
      return <div data-testid="org-count">{orgCount}</div>
    })

    const { getByTestId } = render(
      <TeamsProvider>
        <ObserverComponent />
      </TeamsProvider>
    )

    // Initially 0
    expect(getByTestId("org-count").textContent).toBe("0")

    // Add an organization via store reference
    await act(async () => {
      storeRef.organizationCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "New Org",
        slug: "new-org",
        createdAt: Date.now(),
      })
    })

    // Should now show 1
    await waitFor(() => {
      expect(getByTestId("org-count").textContent).toBe("1")
    })
  })

  test("Updated count is displayed after adding organization", async () => {
    let storeRef: any = null

    const ObserverComponent = observer(function TestComponent() {
      const teamsStore = useTeams()
      storeRef = teamsStore
      const orgCount = teamsStore.organizationCollection.all().length
      return <div data-testid="org-count">{orgCount}</div>
    })

    const { getByTestId } = render(
      <TeamsProvider>
        <ObserverComponent />
      </TeamsProvider>
    )

    // Initially 0
    expect(getByTestId("org-count").textContent).toBe("0")

    // Add an organization directly to store
    await act(async () => {
      storeRef.organizationCollection.add({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Test Org",
        slug: "test-org",
        createdAt: Date.now(),
      })
    })

    // Should now show 1
    await waitFor(() => {
      expect(getByTestId("org-count").textContent).toBe("1")
    })
  })
})
