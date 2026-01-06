/**
 * App.tsx Route Configuration Tests for task-2-1-014
 *
 * TDD tests for the /app route configuration with AuthGate wrapper.
 * Per dd-2-1-route-structure:
 * - /app route is protected by AuthGate
 * - AuthGate renders LoginPage for unauthenticated users inline (no /app/login route)
 * - AppShell renders for authenticated users
 * - Outlet pattern supports future nested routes
 * - Existing demo routes remain functional
 *
 * These tests are written BEFORE implementation (RED phase).
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import React from "react"

// ============================================================
// Test 1: App.tsx imports components from @/components/app
// ============================================================

describe("test-2-1-014-imports: App.tsx imports from @/components/app", () => {
  test("AuthGate is exported from @/components/app", async () => {
    const components = await import("../components/app")
    expect(components.AuthGate).toBeDefined()
    // AuthGate is a MobX observer, which is an object with a displayName
    expect(typeof components.AuthGate === "function" || typeof components.AuthGate === "object").toBe(true)
  })

  test("AppShell is exported from @/components/app", async () => {
    const components = await import("../components/app")
    expect(components.AppShell).toBeDefined()
    // AppShell is a regular function component
    expect(typeof components.AppShell === "function").toBe(true)
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
// Test 2: /app route structure follows dd-2-1-route-structure
// ============================================================

describe("test-2-1-014-route-structure: Route structure per design decision", () => {
  test("App.tsx source imports AuthGate and AppShell from @/components/app", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for import from @/components/app
    expect(appSource).toMatch(/import\s*{[^}]*AuthGate[^}]*}\s*from\s*['"]@\/components\/app['"]/)
    expect(appSource).toMatch(/import\s*{[^}]*AppShell[^}]*}\s*from\s*['"]@\/components\/app['"]/)
  })

  test("/app route exists with AuthGate wrapping AppShell", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for /app route with AuthGate wrapper
    // Pattern: <Route path="/app/*" element={<AuthGate><AppShell /></AuthGate>}>
    expect(appSource).toMatch(/path=["']\/app\/\*["']/)
    expect(appSource).toMatch(/<AuthGate>/)
    expect(appSource).toMatch(/<AppShell\s*\/>/)
  })

  test("No /app/login route is defined - AuthGate handles unauthenticated inline", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Should NOT have a /app/login route
    expect(appSource).not.toMatch(/path=["']\/app\/login["']/)
  })
})

// ============================================================
// Test 3: Outlet pattern supports nested routes
// ============================================================

describe("test-2-1-014-outlet: Outlet pattern for nested routes", () => {
  test("/app route uses element wrapper that contains AppShell with Outlet", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The /app route should be structured to support nested routes
    // AppShell contains <Outlet /> for rendering nested route content
    // Pattern: <Route path="/app/*" element={...}> with child routes or index route
    expect(appSource).toMatch(/<Route\s+path=["']\/app\/\*["']\s+element=/)
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
// Test 4: Existing demo routes remain functional
// ============================================================

describe("test-2-1-014-demo-routes: Existing demo routes preserved", () => {
  test("All existing routes are still defined in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check that existing demo routes are preserved
    const existingRoutes = [
      "/",
      "/unit1",
      "/unit2",
      "/unit3",
      "/legacy-tests",
      "/auth-demo",
      "/better-auth-demo",
      "/teams-demo",
      "/tenant-demo",
      "/feature-control-plane",
      "/platform-features",
      "/ai-chat-demo",
      "/studio-core-demo",
      "/studio-chat-demo",
      "/studio",
    ]

    for (const route of existingRoutes) {
      const routePattern = new RegExp(`path=["']${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`)
      expect(appSource).toMatch(routePattern)
    }
  })

  test("Demo routes are NOT wrapped by AuthGate", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The existing routes should NOT be inside AuthGate
    // Only /app route should have AuthGate
    // Check that routes like /studio, /better-auth-demo use their page components directly
    expect(appSource).toMatch(/path=["']\/studio["']\s+element=\{<StudioPage\s*\/>\}/)
    expect(appSource).toMatch(/path=["']\/better-auth-demo["']\s+element=\{<BetterAuthDemoPage\s*\/>\}/)
  })
})

// ============================================================
// Test 5: New /app route is added alongside existing routes
// ============================================================

describe("test-2-1-014-app-route: /app route configuration", () => {
  test("/app route is configured in Routes", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // /app route should exist (with wildcard for nested routes)
    expect(appSource).toMatch(/path=["']\/app\/\*["']/)
  })

  test("/app route element includes AuthGate wrapping AppShell", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The element should be AuthGate wrapping AppShell
    // Pattern: element={\n  <AuthGate>\n    <AppShell />\n  </AuthGate>\n}
    expect(appSource).toMatch(/<AuthGate>[\s\S]*<AppShell\s*\/>[\s\S]*<\/AuthGate>/)
  })

  test("/app route structure allows for child routes (Route has closing tag)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // The /app/* route should have a closing </Route> tag (for nested routes)
    // This allows adding child routes inside the Route element in future sessions
    const hasAppRoute = appSource.includes('path="/app/*"')
    expect(hasAppRoute).toBe(true)

    // Should have closing Route tag after the /app/* route (not self-closing)
    expect(appSource).toMatch(/path=["']\/app\/\*["'][\s\S]*<\/Route>/)
  })
})
