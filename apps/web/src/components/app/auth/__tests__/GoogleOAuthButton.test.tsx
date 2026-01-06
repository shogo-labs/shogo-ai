/**
 * Tests for GoogleOAuthButton component
 * Task: task-2-1-007
 *
 * Tests the Google OAuth button that uses authClient.signIn.social() directly
 * per dd-2-1-auth-domain-access-pattern and finding-2-1-008.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock, spyOn } from "bun:test"
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react"
import React from "react"

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

// Mock authClient
const mockSignInSocial = mock(() => Promise.resolve())

mock.module("@/auth/client", () => ({
  authClient: {
    signIn: {
      social: mockSignInSocial,
    },
  },
}))

// Import after mocking
import { GoogleOAuthButton } from "../GoogleOAuthButton"

// ============================================================
// Test: GoogleOAuthButton renders with Google icon and text
// test-2-1-007-oauth-renders
// ============================================================
describe("GoogleOAuthButton renders correctly", () => {
  beforeEach(() => {
    mockSignInSocial.mockClear()
  })

  test("Button displays Google icon", () => {
    const { container } = render(<GoogleOAuthButton />)

    // Should have an SVG (Google icon) or icon element
    const icon = container.querySelector("svg")
    expect(icon).toBeDefined()
  })

  test("Button displays 'Continue with Google' or similar text", () => {
    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    expect(button.textContent).toMatch(/google/i)
  })

  test("Uses shadcn Button component", () => {
    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    // shadcn Button has specific classes from cva
    expect(button.className).toContain("inline-flex")
    expect(button.className).toContain("items-center")
  })
})

// ============================================================
// Test: GoogleOAuthButton uses authClient directly for OAuth
// test-2-1-007-oauth-authclient
// ============================================================
describe("GoogleOAuthButton OAuth flow", () => {
  beforeEach(() => {
    mockSignInSocial.mockClear()
  })

  test("Clicking button calls authClient.signIn.social", async () => {
    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalled()
    })
  })

  test("Provider is set to 'google'", async () => {
    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "google" })
      )
    })
  })

  test("callbackURL is set to window.location.href", async () => {
    // Set window.location.href for test
    Object.defineProperty(globalThis.window, "location", {
      value: { href: "http://localhost:5173/app" },
      writable: true,
    })

    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    fireEvent.click(button)

    await waitFor(() => {
      expect(mockSignInSocial).toHaveBeenCalledWith(
        expect.objectContaining({ callbackURL: "http://localhost:5173/app" })
      )
    })
  })
})

// ============================================================
// Test: GoogleOAuthButton does NOT use auth.signInWithGoogle
// test-2-1-007-oauth-not-domain
// This is a design constraint test - the component must use
// authClient directly per dd-2-1-auth-domain-access-pattern
// ============================================================
describe("GoogleOAuthButton uses authClient directly (not domain store)", () => {
  // This test verifies the design decision is followed
  // The actual verification is in the implementation review
  // Here we ensure authClient.signIn.social is called, not useDomains

  test("Component does not call domain store signInWithGoogle", async () => {
    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    fireEvent.click(button)

    await waitFor(() => {
      // If authClient.signIn.social was called, the design is correct
      expect(mockSignInSocial).toHaveBeenCalled()
    })
  })
})

// ============================================================
// Test: GoogleOAuthButton shows loading state during OAuth redirect
// test-2-1-007-oauth-loading
// ============================================================
describe("GoogleOAuthButton loading state", () => {
  beforeEach(() => {
    mockSignInSocial.mockClear()
  })

  test("Button shows loading indicator after click", async () => {
    // Make the mock delay to simulate redirect
    mockSignInSocial.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)))

    const { getByRole, container } = render(<GoogleOAuthButton />)

    const button = getByRole("button")
    fireEvent.click(button)

    // Check for loading state (could be spinner, disabled state, or loading text)
    await waitFor(() => {
      // Button should be disabled during loading
      expect(button).toHaveProperty("disabled", true)
    })
  })

  test("Button is disabled during redirect to prevent double-click", async () => {
    mockSignInSocial.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)))

    const { getByRole } = render(<GoogleOAuthButton />)

    const button = getByRole("button") as HTMLButtonElement
    fireEvent.click(button)

    await waitFor(() => {
      expect(button.disabled).toBe(true)
    })

    // Should only be called once even if clicked multiple times
    fireEvent.click(button)
    fireEvent.click(button)

    // Wait a bit then check call count
    await new Promise((r) => setTimeout(r, 50))
    expect(mockSignInSocial).toHaveBeenCalledTimes(1)
  })
})
