/**
 * App.tsx Route Configuration Tests
 *
 * TDD tests for the root route configuration with AuthGate wrapper.
 * After demo cleanup:
 * - Root route (/*) is protected by AuthGate
 * - AuthGate renders LoginPage for unauthenticated users inline
 * - AppShell renders for authenticated users
 * - Outlet pattern supports nested routes
 *
 * These tests verify the simplified App.tsx structure.
 */

import { describe, test, expect } from "bun:test"

// ============================================================
// Test 1: App.tsx imports components from @/components/app
// ============================================================

describe("App.tsx imports from @/components/app", () => {
  test("AuthGate is exported from @/components/app", async () => {
    const components = await import("../components/app")
    expect(components.AuthGate).toBeDefined()
    // AuthGate is a MobX observer, which is an object with a displayName
    expect(typeof components.AuthGate === "function" || typeof components.AuthGate === "object").toBe(true)
  })

  test("AppShell is exported from @/components/app", async () => {
    const components = await import("../components/app")
    expect(components.AppShell).toBeDefined()
    // AppShell may be a function or MobX observer object
    expect(typeof components.AppShell === "function" || typeof components.AppShell === "object").toBe(true)
  })

  test("All barrel exports are available", async () => {
    const components = await import("../components/app")
    // Layout components
    expect(components.AuthGate).toBeDefined()
    expect(components.AppShell).toBeDefined()
    expect(components.AppHeader).toBeDefined()
    // Auth components
    expect(components.LoginPage).toBeDefined()
    expect(components.SignInForm).toBeDefined()
    expect(components.SignUpForm).toBeDefined()
    expect(components.GoogleOAuthButton).toBeDefined()
    // Shared components
    expect(components.UserMenu).toBeDefined()
    expect(components.ThemeToggle).toBeDefined()
    expect(components.SplashScreen).toBeDefined()
  })
})

// ============================================================
// Test 2: Root route structure
// ============================================================

describe("Root route structure", () => {
  test("App.tsx source imports AuthGate and AppShell from @/components/app", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for import from @/components/app
    expect(appSource).toMatch(/import\s*{[^}]*AuthGate[^}]*}\s*from\s*['"]@\/components\/app['"]/)
    expect(appSource).toMatch(/import\s*{[^}]*AppShell[^}]*}\s*from\s*['"]@\/components\/app['"]/)
  })

  test("Root route exists with AuthGate wrapping AppShell", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for root route with AuthGate wrapper
    expect(appSource).toMatch(/path=["']\/\*["']/)
    expect(appSource).toMatch(/<AuthGate>/)
    expect(appSource).toMatch(/<AppShell\s*\/>/)
  })

  test("No /login route is defined - AuthGate handles unauthenticated inline", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should NOT have a separate /login route
    expect(appSource).not.toMatch(/path=["']\/login["']/)
  })
})

// ============================================================
// Test 3: Outlet pattern supports nested routes
// ============================================================

describe("Outlet pattern for nested routes", () => {
  test("Root route uses element wrapper that contains AppShell with Outlet", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The root route should be structured to support nested routes
    // AppShell contains <Outlet /> for rendering nested route content
    expect(appSource).toMatch(/<Route\s+path=["']\/\*["']\s+element=/)
    expect(appSource).toMatch(/<AuthGate>[\s\S]*<AppShell/)
  })

  test("AppShell component contains Outlet for nested route rendering", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const shellPath = path.resolve(import.meta.dir, "../components/app/layout/AppShell.tsx")
    const shellSource = fs.readFileSync(shellPath, "utf-8")

    // AppShell should import and use Outlet from react-router-dom
    expect(shellSource).toMatch(/import\s*{[^}]*Outlet[^}]*}\s*from\s*['"]react-router-dom['"]/)
    expect(shellSource).toMatch(/<Outlet\s*\/>/)
  })
})

// ============================================================
// Test 4: Clean break - no demo imports
// ============================================================

describe("Clean break - no demo imports in App.tsx", () => {
  test("No demo page imports in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should NOT have any demo page imports
    expect(appSource).not.toMatch(/from\s+['"]\.\/pages\//)
    expect(appSource).not.toMatch(/HomePage/)
    expect(appSource).not.toMatch(/Unit1Page/)
    expect(appSource).not.toMatch(/Unit2Page/)
    expect(appSource).not.toMatch(/Unit3Page/)
    expect(appSource).not.toMatch(/AuthDemoPage/)
    expect(appSource).not.toMatch(/StudioPage/)
  })

  test("No demo routes in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should NOT have demo routes
    expect(appSource).not.toMatch(/path=["']\/unit1["']/)
    expect(appSource).not.toMatch(/path=["']\/unit2["']/)
    expect(appSource).not.toMatch(/path=["']\/auth-demo["']/)
    expect(appSource).not.toMatch(/path=["']\/teams-demo["']/)
    expect(appSource).not.toMatch(/path=["']\/studio["']/)
  })

  test("Zero imports from '/components/Studio/' in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for imports from /components/Studio/ (case insensitive)
    const hasStudioImport = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/.test(appSource)
    expect(hasStudioImport).toBe(false)
  })

  test("App.tsx imports from @/components/app for Studio App components", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should import from @/components/app
    expect(appSource).toMatch(/from\s+['"]@\/components\/app['"]/)
  })
})

// ============================================================
// Test 5: Root route configuration
// ============================================================

describe("Root route configuration", () => {
  test("Root route is configured in Routes", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Root route should exist (with wildcard for nested routes)
    expect(appSource).toMatch(/path=["']\/\*["']/)
  })

  test("Root route element includes AuthGate wrapping AppShell", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The element should be AuthGate wrapping AppShell
    expect(appSource).toMatch(/<AuthGate>[\s\S]*<AppShell\s*\/>[\s\S]*<\/AuthGate>/)
  })

  test("Root route structure allows for child routes (Route has closing tag)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The root route should have a closing </Route> tag (for nested routes)
    const hasRootRoute = appSource.includes('path="/*"')
    expect(hasRootRoute).toBe(true)

    // Should have closing Route tag after the root route (not self-closing)
    expect(appSource).toMatch(/path=["']\/\*["'][\s\S]*<\/Route>/)
  })
})
