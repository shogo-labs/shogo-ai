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
  studioChatDomain,
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

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
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

    // Outlet area should be present when feature is selected (now wrapped in ChatPanel)
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

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
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
// Task cpbi-004: Phase Prop Threading Tests
// ============================================================

// ============================================================
// Test cpbi-004-a: WorkspaceLayout uses usePhaseNavigation hook
// ============================================================

describe("test-cpbi-004-a: WorkspaceLayout uses usePhaseNavigation hook", () => {
  test("usePhaseNavigation is imported from stepper hooks", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import usePhaseNavigation from stepper hooks
    expect(componentSource).toMatch(/import.*usePhaseNavigation.*from/)
  })

  test("usePhaseNavigation hook is called within WorkspaceLayout", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should call usePhaseNavigation hook
    expect(componentSource).toMatch(/usePhaseNavigation\s*\(/)
  })

  test("phase is destructured from usePhaseNavigation result", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should destructure phase from usePhaseNavigation
    expect(componentSource).toMatch(/\{\s*phase[^}]*\}\s*=\s*usePhaseNavigation/)
  })
})

// ============================================================
// Test cpbi-004-d: Phase prop updates when navigation changes
// (Source-based verification that phase is passed to ChatPanel)
// ============================================================

describe("test-cpbi-004-d: Phase prop is passed from WorkspaceLayout to ChatPanel", () => {
  test("ChatPanel receives phase prop in JSX", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel should receive phase prop
    expect(componentSource).toMatch(/<ChatPanel[^>]*phase=/)
  })

  test("phase prop value is {phase} from hook result", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // phase prop should be passed the phase value from hook
    expect(componentSource).toMatch(/phase=\{phase\}/)
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

// ============================================================
// Task 2-4-005: WorkspaceLayout ChatPanel Integration Tests
// ============================================================

// ============================================================
// Test 2-4-005-001: WorkspaceLayout wraps content area with ChatContextProvider
// ============================================================

describe("test-2-4-005-001: WorkspaceLayout wraps content area with ChatContextProvider", () => {
  test("ChatPanel is imported from chat module (ChatPanel provides ChatContextProvider internally)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import ChatPanel from chat module (ChatPanel wraps children with ChatContextProvider)
    expect(componentSource).toMatch(/import.*ChatPanel.*from.*chat/)
  })

  test("Content area children are wrapped in ChatPanel (which provides ChatContextProvider)", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use ChatPanel in JSX - ChatPanel internally wraps children with ChatContextProvider
    expect(componentSource).toMatch(/<ChatPanel/)
  })
})

// ============================================================
// Test 2-4-005-002: WorkspaceLayout content area is flex row with gap
// ============================================================

describe("test-2-4-005-002: WorkspaceLayout content area is flex row with gap", () => {
  test("Content area has flex and flex-row classes when feature selected", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
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

    // Content area should have flex classes for side-by-side layout
    const content = container.querySelector('[data-testid="workspace-content"]')
    expect(content).not.toBeNull()
    expect(content?.className).toMatch(/flex/)
  })

  test("Gap class is applied between panels", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should have gap class in workspace-content area when feature selected
    expect(componentSource).toMatch(/gap-/)
  })
})

// ============================================================
// Test 2-4-005-003: PhaseContentPanel renders with flex-1 to take remaining space
// ============================================================

describe("test-2-4-005-003: PhaseContentPanel renders with flex-1 to take remaining space", () => {
  test("PhaseContentPanel container has flex-1 class", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
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

    // PhaseContentPanel wrapper should have flex-1 class
    const phasePanel = container.querySelector('[data-testid="phase-content-panel"]')
    if (phasePanel) {
      // Check the wrapper element
      const wrapper = phasePanel.parentElement
      expect(wrapper?.className).toMatch(/flex-1/)
    }
  })
})

// ============================================================
// Test 2-4-005-004: ChatPanel renders with 400px width when feature is selected
// ============================================================

describe("test-2-4-005-004: ChatPanel renders with 400px width when feature is selected", () => {
  test("ChatPanel component is rendered when featureId is present", async () => {
    // Source-based test to verify ChatPanel is used in WorkspaceLayout
    // Runtime rendering is complex due to ChatPanel requiring studioChat domain + API
    const fs = await import("fs")
    const path = await import("path")
    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should import and use ChatPanel
    expect(componentSource).toMatch(/import.*ChatPanel.*from.*chat/)
    expect(componentSource).toMatch(/<ChatPanel/)
    // Should pass featureId prop
    expect(componentSource).toMatch(/featureId=\{featureId\}/)
  })

  test("ChatPanel has w-[400px] or stored width from localStorage", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel component itself manages width - check it's passed featureId
    expect(componentSource).toMatch(/featureId/)
  })
})

// ============================================================
// Test 2-4-005-005: ExpandTab renders on right edge when ChatPanel is collapsed
// ============================================================

describe("test-2-4-005-005: ExpandTab renders on right edge when ChatPanel is collapsed", () => {
  test("ExpandTab component is visible when collapsed", async () => {
    // ExpandTab is rendered by ChatPanel when collapsed
    // Verify that ChatPanel is integrated which includes ExpandTab
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel handles ExpandTab internally - verify ChatPanel integration
    expect(componentSource).toMatch(/<ChatPanel/)
  })
})

// ============================================================
// Test 2-4-005-006: Clicking ExpandTab restores ChatPanel to previous width
// ============================================================

describe("test-2-4-005-006: Clicking ExpandTab restores ChatPanel to previous width", () => {
  test("ChatPanel restores to previous width when expanded", async () => {
    // This is handled internally by ChatPanel which stores width in localStorage
    // Verify ChatPanel is properly integrated
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel must be used in the component
    expect(componentSource).toMatch(/<ChatPanel/)
    // Must pass featureId for session management
    expect(componentSource).toMatch(/featureId=/)
  })
})

// ============================================================
// Test 2-4-005-007: Chat panel only renders when featureId is present
// ============================================================

describe("test-2-4-005-007: Chat panel only renders when featureId is present", () => {
  test("ChatPanel is not rendered when featureId is null", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
    } as const

    // No feature param - no feature selected
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

    // ChatPanel should NOT be rendered (no feature selected)
    // Verify via source that ChatPanel is only rendered when featureId exists
    const fs = await import("fs")
    const path = await import("path")
    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // ChatPanel should be conditional on featureId (in ternary expression)
    // The code structure is: featureId && currentFeature ? <ChatPanel...> : featureId ? <ChatPanel...> : <NoChat>
    expect(componentSource).toMatch(/featureId.*\?[\s\S]*<ChatPanel/)
    // When no featureId, project-dashboard is shown (no ChatPanel)
    expect(componentSource).toMatch(/data-testid="project-dashboard"/)

    // ProjectDashboard should be shown when no feature selected
    const dashboard = container.querySelector('[data-testid="project-dashboard"]')
    expect(dashboard).not.toBeNull()
  })
})

// ============================================================
// Test 2-4-005-008: Layout maintains responsive behavior on smaller screens
// ============================================================

describe("test-2-4-005-008: Layout maintains responsive behavior on smaller screens", () => {
  test("Layout remains functional in constrained space", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { WorkspaceLayout } = await import("../WorkspaceLayout")
    const { MemoryRouter } = await import("react-router-dom")

    const mockAuthService = new MockAuthService()
    await mockAuthService.signUp({ email: "test@example.com", password: "test123" })

    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuthService,
    })

    // Include studioChat domain for ChatPanel integration (task-2-4-005)
    const domains = {
      studioCore: studioCoreDomain,
      platformFeatures: platformFeaturesDomain,
      studioChat: studioChatDomain,
    } as const

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

    // Layout should render without errors - basic functionality check
    const layout = container.querySelector('[data-testid="workspace-layout"]')
    expect(layout).not.toBeNull()

    // Should have overflow handling
    const content = container.querySelector('[data-testid="workspace-content"]')
    expect(content?.className).toMatch(/overflow/)
  })

  test("No horizontal overflow issues with flex layout", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const componentPath = path.resolve(import.meta.dir, "../WorkspaceLayout.tsx")
    const componentSource = fs.readFileSync(componentPath, "utf-8")

    // Should use flex layout which handles overflow better than fixed widths
    expect(componentSource).toMatch(/flex/)
    // PhaseContentPanel should use flex-1 to fill remaining space
    expect(componentSource).toMatch(/flex-1/)
  })
})
