/**
 * Tests for WorkspaceLayout Component
 * Task: task-2-2-004
 *
 * TDD tests for the workspace layout that provides sidebar + content structure.
 *
 * Test Specifications:
 * - test-2-2-004-001: WorkspaceLayout renders sidebar and content in flex row
 * - test-2-2-004-002: Sidebar area has fixed width with border separator
 * - test-2-2-004-003: WorkspaceLayout uses useWorkspaceData as smart component
 * - test-2-2-004-004: WorkspaceLayout renders ProjectDashboard when no feature selected
 * - test-2-2-004-005: WorkspaceLayout renders Outlet when feature is selected
 * - test-2-2-004-006: WorkspaceLayout manages NewFeatureModal open state
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
import React, { useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"
import { EnvironmentProvider, createEnvironment } from "../../../../contexts/EnvironmentContext"
import { DomainProvider } from "../../../../contexts/DomainProvider"
import { AuthProvider } from "../../../../contexts/AuthContext"
import {
  studioCoreDomain,
  platformFeaturesDomain,
  MockAuthService,
} from "@shogo/state-api"

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

// Mock persistence for testing
const mockPersistence = {
  loadCollection: async () => null,
  saveCollection: async () => {},
  loadEntity: async () => null,
  saveEntity: async () => {},
  loadSchema: async () => null,
  listSchemas: async () => [],
}

// ============================================================
// Test 1: WorkspaceLayout renders sidebar and content in flex row
// (test-2-2-004-001)
// ============================================================

describe("test-2-2-004-001: WorkspaceLayout renders sidebar and content in flex row", () => {
  test("Root element has flex and h-full classes", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Find the root element with data-testid
    const layoutRoot = container.querySelector('[data-testid="workspace-layout"]')
    expect(layoutRoot).not.toBeNull()
    expect(layoutRoot?.className).toMatch(/flex/)
    expect(layoutRoot?.className).toMatch(/h-full/)
  })

  test("Sidebar area renders on left", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const sidebar = container.querySelector('[data-testid="workspace-sidebar"]')
    expect(sidebar).not.toBeNull()
  })

  test("Content area renders on right with flex-1", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const content = container.querySelector('[data-testid="workspace-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toMatch(/flex-1/)
  })
})

// ============================================================
// Test 2: Sidebar area has fixed width with border separator
// (test-2-2-004-002)
// ============================================================

describe("test-2-2-004-002: Sidebar area has fixed width with border separator", () => {
  test("Sidebar has w-64 class (256px)", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const sidebar = container.querySelector('[data-testid="workspace-sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar?.className).toMatch(/w-64/)
  })

  test("Sidebar has border-r class for separator", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const sidebar = container.querySelector('[data-testid="workspace-sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar?.className).toMatch(/border-r/)
  })
})

// ============================================================
// Test 3: WorkspaceLayout uses useWorkspaceData as smart component
// (test-2-2-004-003)
// ============================================================

describe("test-2-2-004-003: WorkspaceLayout uses useWorkspaceData as smart component", () => {
  test("useWorkspaceData() hook is called", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use useWorkspaceData
    expect(componentSource).toMatch(/useWorkspaceData/)
  })

  test("Data is passed down to FeatureSidebar", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use featuresByPhase from hook
    expect(componentSource).toMatch(/featuresByPhase/)
  })

  test("Content area has overflow-auto and p-6 classes", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const content = container.querySelector('[data-testid="workspace-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toMatch(/overflow-auto/)
    expect(content?.className).toMatch(/p-6/)
  })
})

// ============================================================
// Test 4: WorkspaceLayout renders ProjectDashboard when no feature selected
// (test-2-2-004-004)
// ============================================================

describe("test-2-2-004-004: WorkspaceLayout renders ProjectDashboard when no feature selected", () => {
  test("ProjectDashboard component is rendered when featureId is null", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    // No feature param in URL means no feature selected
    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="">
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // ProjectDashboard should be rendered (placeholder div for now)
    const dashboard = container.querySelector('[data-testid="project-dashboard"]')
    expect(dashboard).not.toBeNull()
  })

  test("Outlet is not rendered when featureId is null", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    // No feature param in URL means no feature selected
    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="">
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Outlet area should NOT be present when no feature is selected
    const outletArea = container.querySelector('[data-testid="feature-outlet"]')
    expect(outletArea).toBeNull()
  })
})

// ============================================================
// Test 5: WorkspaceLayout renders Outlet when feature is selected
// (test-2-2-004-005)
// ============================================================

describe("test-2-2-004-005: WorkspaceLayout renders Outlet when feature is selected", () => {
  test("Outlet component is rendered when featureId is set", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    // Feature param in URL means feature is selected
    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?feature=test-feature-id">
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // Outlet area should be present when feature is selected
    const outletArea = container.querySelector('[data-testid="feature-outlet"]')
    expect(outletArea).not.toBeNull()
  })

  test("ProjectDashboard is not rendered when featureId is set", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
    } as const

    // Feature param in URL means feature is selected
    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?feature=test-feature-id">
          <MemoryRouter>
            <EnvironmentProvider env={env}>
              <AuthProvider authService={mockAuthService}>
                <DomainProvider domains={domains}>
                  <WorkspaceLayout />
                </DomainProvider>
              </AuthProvider>
            </EnvironmentProvider>
          </MemoryRouter>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    // ProjectDashboard should NOT be present when feature is selected
    const dashboard = container.querySelector('[data-testid="project-dashboard"]')
    expect(dashboard).toBeNull()
  })
})

// ============================================================
// Test 6: WorkspaceLayout manages NewFeatureModal open state
// (test-2-2-004-006)
// ============================================================

describe("test-2-2-004-006: WorkspaceLayout manages NewFeatureModal open state", () => {
  test("Component has modal state management", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have state for modal open/close
    expect(componentSource).toMatch(/useState/)
    // Should have isModalOpen or similar state variable
    expect(componentSource).toMatch(/isModalOpen|modalOpen|showModal/)
  })

  test("NewFeatureModal receives isOpen prop", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass isOpen or open prop to modal
    expect(componentSource).toMatch(/isOpen|open/)
  })

  test("NewFeatureModal receives onClose callback", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should pass onClose callback to modal
    expect(componentSource).toMatch(/onClose/)
  })
})

// ============================================================
// Test 8: Clean break - WorkspaceLayout in /components/app/workspace/
// (test-2-2-004-008)
// ============================================================

describe("test-2-2-004-008: Clean break - WorkspaceLayout in /components/app/workspace/", () => {
  test("File located at apps/web/src/components/app/workspace/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")

    // File should exist
    expect(fs.existsSync(componentPath)).toBe(true)

    // Path should be in /components/app/workspace/
    expect(componentPath).toMatch(/components\/app\/workspace\/WorkspaceLayout\.tsx$/)
  })

  test("Zero imports from /components/Studio/", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT import from /components/Studio/
    expect(componentSource).not.toMatch(/from ['"].*\/Studio\//)
    expect(componentSource).not.toMatch(/from ['"].*\/components\/Studio/)
  })

  test("Uses Tailwind utilities only (no inline styles)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should NOT have style={{ ... }} inline styles
    expect(componentSource).not.toMatch(/style=\{\{/)
  })
})
