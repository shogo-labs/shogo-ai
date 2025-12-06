/**
 * Generated from TestSpecification: test-030 through test-034
 * Task: task-auth-010
 * Requirement: req-auth-002
 *
 * Note: These tests verify component structure using SSR rendering.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"
import React from "react"
import { renderToString } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { AuthProvider } from "../../../contexts/AuthContext"
import { LoginForm } from "../LoginForm"
import { MockAuthService } from "@shogo/state-api"

describe("LoginForm renders email and password inputs", () => {
  test("Email input field is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider authService={authService}>
          <LoginForm />
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
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider authService={authService}>
          <LoginForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for password input
    expect(html).toContain('type="password"')
    expect(html).toContain('name="password"')
  })

  test("Submit button is visible", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider authService={authService}>
          <LoginForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Check for submit button
    expect(html).toContain('type="submit"')
    expect(html.toLowerCase()).toContain("sign in")
  })
})

describe("LoginForm structure", () => {
  test("Form has correct structure", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider authService={authService}>
          <LoginForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Should have form element
    expect(html).toContain("<form")

    // Should have labels for accessibility
    expect(html.toLowerCase()).toContain("email")
    expect(html.toLowerCase()).toContain("password")
  })

  test("Has link to signup page", () => {
    const authService = new MockAuthService()

    const html = renderToString(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider authService={authService}>
          <LoginForm />
        </AuthProvider>
      </MemoryRouter>
    )

    // Should have link to signup
    expect(html.toLowerCase()).toContain("sign up")
  })
})
