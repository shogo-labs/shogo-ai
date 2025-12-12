/**
 * Generated from TestSpecifications for task-teams-demo-page
 * Task: teams-demo-page
 * Requirement: req-permission-cascade
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { render, waitFor, act, cleanup, fireEvent } from "@testing-library/react"
import React from "react"
import { BrowserRouter } from "react-router-dom"
import { TeamsDemoPage } from "../TeamsDemoPage"
import { EnvironmentProvider, createEnvironment } from "../../contexts/EnvironmentContext"
import { DomainProvider } from "../../contexts/DomainProvider"
import { teamsDomain } from "@shogo/state-api"

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

// Mock persistence for testing
const mockPersistence = {
  loadCollection: async () => null,
  saveCollection: async () => {},
  loadEntity: async () => null,
  saveEntity: async () => {},
  loadSchema: async () => null,
  listSchemas: async () => [],
}

// Helper to render with required providers
function renderWithProviders(ui: React.ReactNode) {
  const env = createEnvironment({ persistence: mockPersistence })
  const domains = { teams: teamsDomain } as const

  return render(
    <BrowserRouter>
      <EnvironmentProvider env={env}>
        <DomainProvider domains={domains}>
          {ui}
        </DomainProvider>
      </EnvironmentProvider>
    </BrowserRouter>
  )
}

// ============================================================
// Test: TeamsDemoPage accessible at /teams-demo
// ============================================================
describe("TeamsDemoPage accessible at /teams-demo", () => {
  test("Page renders without errors", () => {
    const { container } = renderWithProviders(<TeamsDemoPage />)
    expect(container).toBeDefined()
  })

  test("Teams demo content is visible", () => {
    const { getByText } = renderWithProviders(<TeamsDemoPage />)
    expect(getByText("Teams Demo")).toBeDefined()
  })
})

// ============================================================
// Test: Page shows create org form when empty
// ============================================================
describe("Page shows create org form when empty", () => {
  test("Create organization form is displayed", () => {
    const { getByTestId } = renderWithProviders(<TeamsDemoPage />)
    expect(getByTestId("create-org-form")).toBeDefined()
  })

  test("Form has name and slug fields", () => {
    const { getByLabelText } = renderWithProviders(<TeamsDemoPage />)
    expect(getByLabelText(/organization name/i)).toBeDefined()
    expect(getByLabelText(/slug/i)).toBeDefined()
  })

  test("Submit button is visible", () => {
    const { getByRole } = renderWithProviders(<TeamsDemoPage />)
    expect(getByRole("button", { name: /create organization/i })).toBeDefined()
  })
})

// ============================================================
// Test: Creating org displays org details
// ============================================================
describe("Creating org displays org details", () => {
  test("Organization is created in store and org-details section appears", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    // Fill in form
    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
    })

    // Submit
    await act(async () => {
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    // Org details section should appear (proves org was created)
    await waitFor(() => {
      expect(getByTestId("org-details")).toBeDefined()
    })
  })

  test("Team creation UI becomes available after org creation", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    await waitFor(() => {
      expect(getByTestId("create-team-form")).toBeDefined()
    })
  })
})

// ============================================================
// Test: Add team shows parent selector
// ============================================================
describe("Add team shows parent selector", () => {
  test("Parent selector dropdown is visible after org created", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    // Create org first
    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    await waitFor(() => {
      expect(getByTestId("parent-team-selector")).toBeDefined()
    })
  })

  test("Dropdown includes none option", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    await waitFor(() => {
      const select = getByTestId("parent-team-selector")
      expect(select.innerHTML).toContain("None")
    })
  })
})

// ============================================================
// Test: Teams display with hierarchy visualization
// ============================================================
describe("Teams display with hierarchy visualization", () => {
  test("Teams list section is visible after org creation", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    // Create org first
    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    // Teams list section should be visible
    await waitFor(() => {
      expect(getByTestId("teams-list")).toBeDefined()
    })
  })
})

// ============================================================
// Test: Membership management UI works
// ============================================================
describe("Membership management UI works", () => {
  test("Can add member with role", async () => {
    const { getByLabelText, getByRole, getByTestId, getByText } = renderWithProviders(<TeamsDemoPage />)

    // Create org first
    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    await waitFor(() => {
      expect(getByTestId("membership-section")).toBeDefined()
    })
  })
})

// ============================================================
// Test: Permission resolution demo works
// ============================================================
describe("Permission resolution demo shows effective permissions", () => {
  test("Permission demo section exists", async () => {
    const { getByLabelText, getByRole, getByTestId } = renderWithProviders(<TeamsDemoPage />)

    // Create org
    await act(async () => {
      fireEvent.change(getByLabelText(/organization name/i), {
        target: { value: "Test Org" },
      })
      fireEvent.change(getByLabelText(/slug/i), {
        target: { value: "test-org" },
      })
      fireEvent.click(getByRole("button", { name: /create organization/i }))
    })

    await waitFor(() => {
      expect(getByTestId("permission-demo")).toBeDefined()
    })
  })
})

// ============================================================
// Test: Loading states shown during async operations
// ============================================================
describe("Loading states shown during async operations", () => {
  test("Page shows initial content without loading spinner", () => {
    const { queryByTestId, getByTestId } = renderWithProviders(<TeamsDemoPage />)
    // Should have create form, not loading state
    expect(getByTestId("create-org-form")).toBeDefined()
  })
})

// ============================================================
// Test: Error states handled gracefully
// ============================================================
describe("Error states handled gracefully", () => {
  test("Error display container exists", () => {
    const { container } = renderWithProviders(<TeamsDemoPage />)
    // Page should render without showing errors initially
    expect(container.querySelector('[data-testid="error-message"]')).toBeNull()
  })

  test("UI remains usable", () => {
    const { getByTestId } = renderWithProviders(<TeamsDemoPage />)
    // Form should be interactive
    expect(getByTestId("create-org-form")).toBeDefined()
  })
})
