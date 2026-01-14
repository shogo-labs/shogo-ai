/**
 * Generated from TestSpecification: test-route-exists, test-route-protected
 * Task: task-testbed-route
 * Requirement: req-testbed-route
 *
 * Tests for the /advanced-chat route configuration.
 * Per dd-testbed-route-layout-adjustments:
 * - Route renders inside AppShell's Outlet, inheriting AuthGate protection
 * - Route path is "advanced-chat" (relative to /*)
 * - AdvancedChatLayout renders in main content area
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

// ============================================================
// Test 1: /advanced-chat route exists (test-route-exists)
// ============================================================

describe("test-route-exists: Advanced chat route is accessible", () => {
  test("App.tsx imports AdvancedChatLayout from ./components/app/advanced-chat", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for import from ./components/app/advanced-chat
    expect(appSource).toMatch(
      /import\s*{[^}]*AdvancedChatLayout[^}]*}\s*from\s*['"]\.\/components\/app\/advanced-chat['"]/
    )
  })

  test("/advanced-chat route is defined as child of /* route", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Route should be defined with path="advanced-chat" as a child of /*
    expect(appSource).toMatch(/path=["']advanced-chat["']/)
  })

  test("Route renders AdvancedChatLayout component", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Route element should use AdvancedChatLayout
    expect(appSource).toMatch(
      /path=["']advanced-chat["']\s+element=\{<AdvancedChatLayout\s*\/>\}/
    )
  })

  test("Route is positioned inside /* Route block (after index route)", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The advanced-chat route should be inside the /* Route (between opening tag and </Route>)
    // Pattern: /* route opening, then index route, then advanced-chat route, then </Route>
    const appRouteBlockPattern = /path=["']\/\*["'][^>]*>[\s\S]*?<Route\s+index[^>]*>[\s\S]*?<Route\s+path=["']advanced-chat["'][\s\S]*?<\/Route>/
    expect(appSource).toMatch(appRouteBlockPattern)
  })
})

// ============================================================
// Test 2: Route is protected (test-route-protected)
// ============================================================

describe("test-route-protected: Route requires authentication", () => {
  test("advanced-chat route inherits AuthGate protection from parent /* route", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The /* route wraps AuthGate around AppShell
    // Child routes (like advanced-chat) render in AppShell's Outlet
    // Therefore AuthGate protection is inherited
    expect(appSource).toMatch(
      /path=["']\/\*["'][\s\S]*element=\{[\s\S]*<AuthGate>[\s\S]*<AppShell\s*\/>[\s\S]*<\/AuthGate>[\s\S]*\}/
    )

    // And the advanced-chat route is a child of /*
    expect(appSource).toMatch(/path=["']advanced-chat["']/)
  })

  test("advanced-chat route does NOT have its own AuthGate wrapper", () => {
    const appPath = path.resolve(import.meta.dir, "../../../../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The route element should just be <AdvancedChatLayout />, not wrapped in AuthGate
    // This tests that we're relying on inherited protection, not redundant wrapping
    expect(appSource).not.toMatch(
      /path=["']advanced-chat["'][\s\S]*<AuthGate>[\s\S]*AdvancedChatLayout/
    )
  })
})

// ============================================================
// Test 3: AppHeader visible (structural verification)
// ============================================================

describe("test-route-structure: AppHeader visible on route", () => {
  test("AppShell component contains AppHeader", async () => {
    const shellPath = path.resolve(
      import.meta.dir,
      "../../layout/AppShell.tsx"
    )
    const shellSource = fs.readFileSync(shellPath, "utf-8")

    // AppShell should render AppHeader
    expect(shellSource).toMatch(/<AppHeader/)
  })

  test("AppShell component contains Outlet for nested route content", () => {
    const shellPath = path.resolve(
      import.meta.dir,
      "../../layout/AppShell.tsx"
    )
    const shellSource = fs.readFileSync(shellPath, "utf-8")

    // AppShell should import and use Outlet
    expect(shellSource).toMatch(
      /import\s*{[^}]*Outlet[^}]*}\s*from\s*['"]react-router-dom['"]/
    )
    expect(shellSource).toMatch(/<Outlet\s*\/>/)
  })
})

// ============================================================
// Test 4: AdvancedChatLayout is exported correctly
// ============================================================

describe("test-exports: AdvancedChatLayout is properly exported", () => {
  test("AdvancedChatLayout is exported from @/components/app/advanced-chat", async () => {
    const components = await import("../index")
    expect(components.AdvancedChatLayout).toBeDefined()
    expect(
      typeof components.AdvancedChatLayout === "function" ||
        typeof components.AdvancedChatLayout === "object"
    ).toBe(true)
  })
})
