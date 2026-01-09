/**
 * Tests for AppShell Registry Integration
 * Task: task-sdr-v2-004
 *
 * TDD tests for integrating domain-driven ComponentRegistry into AppShell.
 *
 * Test Specifications:
 * - test-sdr-004-01: AppShell provides ComponentRegistry from domain
 * - test-sdr-004-02: App routes render correctly with domain-driven registry
 * - test-sdr-004-03: Registry updates when domain bindings change
 * - test-sdr-004-04: AppShell handles missing componentBuilder gracefully
 *
 * Per ip-sdr-v2-003:
 * - Replace createStudioRegistry() with createRegistryFromDomain(componentBuilder)
 * - Access componentBuilder via useDomains() hook
 * - Wrap AppShell with MobX observer for reactivity
 */

import { describe, test, expect } from "bun:test"
import fs from "fs"
import path from "path"

const componentPath = path.resolve(import.meta.dir, "../AppShell.tsx")
const componentSource = fs.readFileSync(componentPath, "utf-8")

// ============================================================
// Test: test-sdr-004-01 - AppShell provides ComponentRegistry from domain
// ============================================================

describe("test-sdr-004-01: AppShell provides ComponentRegistry from domain", () => {
  test("AppShell imports createRegistryFromDomain from registryFactory", () => {
    // Should import createRegistryFromDomain
    expect(componentSource).toMatch(/createRegistryFromDomain/)
    expect(componentSource).toMatch(/from\s+["']@\/components\/rendering\/registryFactory["']/)
  })

  test("AppShell imports useDomains from DomainProvider", () => {
    // Should import useDomains hook
    expect(componentSource).toMatch(/useDomains/)
    expect(componentSource).toMatch(/from\s+["']@\/contexts\/DomainProvider["']/)
  })

  test("AppShell accesses componentBuilder from useDomains()", () => {
    // Should destructure componentBuilder from useDomains()
    expect(componentSource).toMatch(/componentBuilder/)
    expect(componentSource).toMatch(/useDomains\s*\(\s*\)/)
  })

  test("AppShell passes domain-driven registry to ComponentRegistryProvider", () => {
    // Should call createRegistryFromDomain with componentBuilder
    expect(componentSource).toMatch(/createRegistryFromDomain\s*\(\s*componentBuilder\s*\)/)
  })
})

// ============================================================
// Test: test-sdr-004-02 - App routes render correctly with domain-driven registry
// ============================================================

describe("test-sdr-004-02: App routes render correctly with domain-driven registry", () => {
  test("AppShell still wraps content with ComponentRegistryProvider", () => {
    // Should still use ComponentRegistryProvider
    expect(componentSource).toMatch(/<ComponentRegistryProvider/)
    expect(componentSource).toMatch(/registry=\{/)
  })

  test("AppShell retains existing layout structure", () => {
    // Should maintain h-screen, flex, flex-col structure
    expect(componentSource).toMatch(/h-screen/)
    expect(componentSource).toMatch(/flex/)
    expect(componentSource).toMatch(/flex-col/)
  })

  test("AppShell still renders AppHeader", () => {
    // Should render AppHeader component
    expect(componentSource).toMatch(/<AppHeader/)
  })

  test("AppShell still renders Outlet", () => {
    // Should render React Router Outlet
    expect(componentSource).toMatch(/<Outlet/)
  })
})

// ============================================================
// Test: test-sdr-004-03 - Registry updates when domain bindings change
// ============================================================

describe("test-sdr-004-03: Registry updates when domain bindings change", () => {
  test("AppShell is wrapped with MobX observer", () => {
    // Should import observer from mobx-react-lite
    expect(componentSource).toMatch(/import\s*\{[^}]*observer[^}]*\}\s*from\s*["']mobx-react-lite["']/)

    // Should wrap with observer()
    expect(componentSource).toMatch(/observer\s*\(/)
  })

  test("AppShell function is named for debugging", () => {
    // Should have named function for better debugging in React DevTools
    // Pattern: observer(function AppShell() or export const AppShell = observer(function AppShell()
    expect(componentSource).toMatch(/observer\s*\(\s*function\s+AppShell/)
  })

  test("Registry is computed from domain state (useMemo dependency)", () => {
    // Registry should depend on domain state for reactivity
    // Either via useMemo with dependencies OR by being inside observer component
    // The observer wrapper handles reactivity automatically when accessing domain observables

    // Verify useMemo is used for registry creation
    expect(componentSource).toMatch(/useMemo\s*\(\s*\(\)\s*=>\s*createRegistryFromDomain/)
  })
})

// ============================================================
// Test: test-sdr-004-04 - AppShell handles missing componentBuilder gracefully
// ============================================================

describe("test-sdr-004-04: AppShell handles missing componentBuilder gracefully", () => {
  test("AppShell has conditional registry creation", () => {
    // The registry factory should handle missing componentBuilder
    // createRegistryFromDomain already returns fallback registry when defaultRegistry is missing
    // AppShell should pass componentBuilder (even if undefined) and let factory handle fallback

    // Verify we're calling createRegistryFromDomain (which has fallback logic)
    expect(componentSource).toMatch(/createRegistryFromDomain/)
  })

  test("AppShell does not crash on undefined componentBuilder access", () => {
    // The useDomains() hook always returns an object (even if componentBuilder is undefined)
    // The factory handles undefined gracefully
    // This is a structural test - actual behavior tested in integration tests

    // Verify destructuring pattern allows undefined
    expect(componentSource).toMatch(/\{\s*componentBuilder\s*\}/)
  })
})

// ============================================================
// Test: AppShell no longer uses hardcoded studioRegistry
// ============================================================

describe("AppShell migration from studioRegistry", () => {
  test("AppShell no longer imports createStudioRegistry", () => {
    // Should NOT import from studioRegistry anymore
    expect(componentSource).not.toMatch(/from\s+["']@\/components\/rendering\/studioRegistry["']/)
  })

  test("AppShell no longer calls createStudioRegistry()", () => {
    // Should NOT call createStudioRegistry
    expect(componentSource).not.toMatch(/createStudioRegistry\s*\(\s*\)/)
  })
})

// ============================================================
// Test: AppShell module exports
// ============================================================

describe("AppShell module exports", () => {
  test("AppShell can be imported", async () => {
    const module = await import("../AppShell")
    expect(module.AppShell).toBeDefined()
    // AppShell should be wrapped with observer(), which returns a React component
    expect(module.AppShell).toBeTruthy()
  })
})
