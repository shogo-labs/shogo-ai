/**
 * Generated from TestSpecification: test-035 through test-039
 * Task: task-auth-011
 * Requirement: req-auth-001
 *
 * Note: These tests verify component structure using SSR rendering.
 */

import { describe, test, expect } from "bun:test"
import React from "react"
import { renderToString } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AuthProvider } from "../../../contexts/AuthContext"
import { SignupForm } from "../SignupForm"
import { MockAuthService } from "@shogo/state-api"

describe("SignupForm renders all required inputs", () => {
  test("Email input field is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for email input
    expect(html).toContain('type="email"')
    expect(html).toContain('name="email"')
  })

  test("Password input field is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for password input
    expect(html).toContain('type="password"')
    expect(html).toContain('name="password"')
  })

  test("Confirm password input field is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for confirm password input
    expect(html).toContain('name="confirmPassword"')
  })

  test("Submit button is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for submit button
    expect(html).toContain('type="submit"')
    expect(html.toLowerCase()).toContain("sign up")
  })
})

describe("SignupForm structure", () => {
  test("Form has correct structure with labels", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Should have form element
    expect(html).toContain("<form")

    // Should have labels for accessibility
    expect(html.toLowerCase()).toContain("email")
    expect(html.toLowerCase()).toContain("password")
    expect(html.toLowerCase()).toContain("confirm")
  })

  test("Has link to login page", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/signup"]}>
        <AuthProvider authService={authService}>
          <SignupForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Should have link to login
    expect(html.toLowerCase()).toContain("sign in")
  })
})
