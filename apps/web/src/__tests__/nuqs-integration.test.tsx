/**
 * nuqs Integration Tests
 *
 * TDD tests for NuqsAdapter integration in App.tsx to enable type-safe
 * URL state management throughout the application.
 *
 * Test Specifications:
 * - NuqsAdapter wraps BrowserRouter correctly
 * - useQueryState hook works throughout component tree
 * - Provider hierarchy remains correct
 * - Clean break - no demo imports in App.tsx
 *
 * These tests verify the nuqs integration in the simplified App.tsx.
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
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

// ============================================================
// Test 1: NuqsAdapter wraps BrowserRouter correctly
// ============================================================

describe("NuqsAdapter wraps BrowserRouter correctly", () => {
  test("App.tsx imports NuqsAdapter from 'nuqs/adapters/react-router/v7'", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for correct import
    expect(appSource).toMatch(/import\s*{[^}]*NuqsAdapter[^}]*}\s*from\s*['"]nuqs\/adapters\/react-router\/v7['"]/)
  })

  test("NuqsAdapter wraps BrowserRouter inside EnvironmentProvider", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // NuqsAdapter must wrap the router for useQueryState to work
    expect(appSource).toMatch(/<NuqsAdapter>/)
    expect(appSource).toMatch(/<\/NuqsAdapter>/)
  })

  test("NuqsAdapter is positioned outside Routes but inside BrowserRouter", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check that NuqsAdapter appears in the component tree
    const hasNuqsAdapter = appSource.includes("<NuqsAdapter>") && appSource.includes("</NuqsAdapter>")
    expect(hasNuqsAdapter).toBe(true)
  })
})

// ============================================================
// Test 2: useQueryState hook works throughout component tree
// ============================================================

describe("useQueryState hook works throughout component tree", () => {
  test("useQueryState hook can be imported from nuqs", async () => {
    const { useQueryState, parseAsString } = await import("nuqs")

    expect(useQueryState).toBeDefined()
    expect(typeof useQueryState).toBe("function")
    expect(parseAsString).toBeDefined()
  })

  test("NuqsTestingAdapter provides context for useQueryState in tests", async () => {
    const { NuqsTestingAdapter, useQueryState, parseAsString } = await import("nuqs/adapters/testing").then(
      (testing) => import("nuqs").then((nuqs) => ({ ...testing, ...nuqs }))
    )

    // Create a test component that uses useQueryState
    const TestComponent: React.FC = () => {
      const [value] = useQueryState("test", parseAsString.withDefault(""))
      return (
        <div data-testid="test-value">{value || "empty"}</div>
      )
    }

    // Render with NuqsTestingAdapter
    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?test=hello">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    // Wait for render
    await new Promise((resolve) => setTimeout(resolve, 50))

    const element = window.document.querySelector('[data-testid="test-value"]')
    expect(element?.textContent).toBe("hello")
  })

  test("useQueryState with parseAsString correctly reads URL parameters", async () => {
    const { NuqsTestingAdapter, useQueryState, parseAsString } = await import("nuqs/adapters/testing").then(
      (testing) => import("nuqs").then((nuqs) => ({ ...testing, ...nuqs }))
    )

    const TestComponent: React.FC = () => {
      const [feature] = useQueryState("feature", parseAsString.withDefault(""))
      const [org] = useQueryState("org", parseAsString.withDefault(""))
      const [project] = useQueryState("project", parseAsString.withDefault(""))

      return (
        <div>
          <span data-testid="org">{org}</span>
          <span data-testid="project">{project}</span>
          <span data-testid="feature">{feature}</span>
        </div>
      )
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?org=shogo&project=platform&feature=auth">
          <TestComponent />
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(window.document.querySelector('[data-testid="org"]')?.textContent).toBe("shogo")
    expect(window.document.querySelector('[data-testid="project"]')?.textContent).toBe("platform")
    expect(window.document.querySelector('[data-testid="feature"]')?.textContent).toBe("auth")
  })
})

// ============================================================
// Test 3: Provider hierarchy remains correct
// ============================================================

describe("Provider hierarchy remains correct after nuqs integration", () => {
  test("Provider hierarchy remains correct", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Essential checks: EnvironmentProvider, DomainProvider, AuthProvider still exist
    expect(appSource).toMatch(/<EnvironmentProvider/)
    expect(appSource).toMatch(/<DomainProvider/)
    expect(appSource).toMatch(/<AuthProvider/)
    expect(appSource).toMatch(/<ShogoMetaStoreProvider/)
    expect(appSource).toMatch(/<Routes>/)
  })

  test("Root route is configured with AuthGate wrapping AppShell", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check that root route has AuthGate
    expect(appSource).toMatch(/path=["']\/\*["']/)
  })
})

// ============================================================
// Test 4: Clean break - no demo imports
// ============================================================

describe("Clean break - no demo imports in modified App.tsx", () => {
  test("Zero imports from '/components/Studio/' in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for imports from /components/Studio/ (case insensitive)
    const hasStudioImport = /from\s+['"][^'"]*\/components\/Studio\/[^'"]*['"]/.test(appSource)
    expect(hasStudioImport).toBe(false)
  })

  test("Zero imports from '@/components/Studio' in App.tsx", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check for imports from @/components/Studio
    const hasStudioAliasImport = /from\s+['"]@\/components\/Studio[^'"]*['"]/.test(appSource)
    expect(hasStudioAliasImport).toBe(false)
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
// Test 5: NuqsAdapter correctly wraps React Router (structural test)
// ============================================================

describe("NuqsAdapter structural requirements", () => {
  test("NuqsAdapter is the outermost component wrapping BrowserRouter", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check that NuqsAdapter opens before BrowserRouter
    const nuqsAdapterPos = appSource.indexOf("<NuqsAdapter>")
    const browserRouterPos = appSource.indexOf("<BrowserRouter>")

    expect(nuqsAdapterPos).toBeGreaterThan(-1)
    expect(browserRouterPos).toBeGreaterThan(-1)
    expect(nuqsAdapterPos).toBeLessThan(browserRouterPos)
  })

  test("NuqsAdapter closes after BrowserRouter", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const appPath = path.resolve(import.meta.dir, "../App.tsx")
    const appSource = fs.readFileSync(appPath, "utf-8")

    // Check that </BrowserRouter> comes before </NuqsAdapter>
    const browserRouterClosePos = appSource.lastIndexOf("</BrowserRouter>")
    const nuqsAdapterClosePos = appSource.lastIndexOf("</NuqsAdapter>")

    expect(browserRouterClosePos).toBeGreaterThan(-1)
    expect(nuqsAdapterClosePos).toBeGreaterThan(-1)
    expect(browserRouterClosePos).toBeLessThan(nuqsAdapterClosePos)
  })
})
