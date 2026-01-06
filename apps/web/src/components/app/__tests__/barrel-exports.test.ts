/**
 * Generated from TestSpecifications for task-2-1-013
 * Tests: barrel export files for app components
 *
 * Verifies that all Session 2.1 components are properly exported from
 * the main barrel file at apps/web/src/components/app/index.ts
 *
 * Note: MobX observer() wraps components as objects, so we check for
 * defined exports rather than strict typeof === "function".
 */

import { describe, test, expect } from "bun:test"

/**
 * Helper to check if an export is a valid React component.
 * MobX observer() wraps components in React.memo, resulting in an object
 * with $$typeof: Symbol(react.memo) and a type property with the actual component.
 */
function isValidComponent(component: unknown): boolean {
  if (typeof component === "function") {
    return true
  }
  if (typeof component === "object" && component !== null) {
    const obj = component as Record<string, unknown>
    // React.memo wrapped components have $$typeof and type
    if ("$$typeof" in obj && "type" in obj) {
      return true
    }
    // Class components have render method
    if ("render" in obj) {
      return true
    }
  }
  return false
}

describe("barrel exports - layout components", () => {
  test("AuthGate can be imported from @/components/app", async () => {
    const { AuthGate } = await import("@/components/app")
    expect(AuthGate).toBeDefined()
    expect(isValidComponent(AuthGate)).toBe(true)
  })

  test("AppShell can be imported from @/components/app", async () => {
    const { AppShell } = await import("@/components/app")
    expect(AppShell).toBeDefined()
    expect(typeof AppShell).toBe("function")
  })

  test("AppHeader can be imported from @/components/app", async () => {
    const { AppHeader } = await import("@/components/app")
    expect(AppHeader).toBeDefined()
    expect(typeof AppHeader).toBe("function")
  })
})

describe("barrel exports - auth components", () => {
  test("LoginPage can be imported from @/components/app", async () => {
    const { LoginPage } = await import("@/components/app")
    expect(LoginPage).toBeDefined()
    expect(isValidComponent(LoginPage)).toBe(true)
  })

  test("SignInForm can be imported from @/components/app", async () => {
    const { SignInForm } = await import("@/components/app")
    expect(SignInForm).toBeDefined()
    expect(isValidComponent(SignInForm)).toBe(true)
  })

  test("SignUpForm can be imported from @/components/app", async () => {
    const { SignUpForm } = await import("@/components/app")
    expect(SignUpForm).toBeDefined()
    expect(isValidComponent(SignUpForm)).toBe(true)
  })

  test("GoogleOAuthButton can be imported from @/components/app", async () => {
    const { GoogleOAuthButton } = await import("@/components/app")
    expect(GoogleOAuthButton).toBeDefined()
    expect(typeof GoogleOAuthButton).toBe("function")
  })
})

describe("barrel exports - shared components", () => {
  test("UserMenu can be imported from @/components/app", async () => {
    const { UserMenu } = await import("@/components/app")
    expect(UserMenu).toBeDefined()
    expect(isValidComponent(UserMenu)).toBe(true)
  })

  test("ThemeToggle can be imported from @/components/app", async () => {
    const { ThemeToggle } = await import("@/components/app")
    expect(ThemeToggle).toBeDefined()
    expect(typeof ThemeToggle).toBe("function")
  })

  test("SplashScreen can be imported from @/components/app", async () => {
    const { SplashScreen } = await import("@/components/app")
    expect(SplashScreen).toBeDefined()
    expect(typeof SplashScreen).toBe("function")
  })
})

describe("barrel exports - all exports are named", () => {
  test("main barrel file has no default export", async () => {
    const barrel = await import("@/components/app")
    // Check that default export is undefined
    expect((barrel as { default?: unknown }).default).toBeUndefined()
  })

  test("all expected components are exported", async () => {
    const barrel = await import("@/components/app")
    const exportedNames = Object.keys(barrel)

    // Layout components
    expect(exportedNames).toContain("AuthGate")
    expect(exportedNames).toContain("AppShell")
    expect(exportedNames).toContain("AppHeader")

    // Auth components
    expect(exportedNames).toContain("LoginPage")
    expect(exportedNames).toContain("SignInForm")
    expect(exportedNames).toContain("SignUpForm")
    expect(exportedNames).toContain("GoogleOAuthButton")

    // Shared components
    expect(exportedNames).toContain("UserMenu")
    expect(exportedNames).toContain("ThemeToggle")
    expect(exportedNames).toContain("SplashScreen")
  })
})

describe("barrel exports - sub-directory barrels", () => {
  test("layout/index.ts exports all layout components", async () => {
    const layout = await import("@/components/app/layout")
    expect(layout.AuthGate).toBeDefined()
    expect(layout.AppShell).toBeDefined()
    expect(layout.AppHeader).toBeDefined()
  })

  test("auth/index.ts exports all auth components", async () => {
    const auth = await import("@/components/app/auth")
    expect(auth.LoginPage).toBeDefined()
    expect(auth.SignInForm).toBeDefined()
    expect(auth.SignUpForm).toBeDefined()
    expect(auth.GoogleOAuthButton).toBeDefined()
  })

  test("shared/index.ts exports all shared components", async () => {
    const shared = await import("@/components/app/shared")
    expect(shared.UserMenu).toBeDefined()
    expect(shared.ThemeToggle).toBeDefined()
    expect(shared.SplashScreen).toBeDefined()
  })
})
