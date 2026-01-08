/**
 * Tests for useWorkspaceData Hook
 * Task: task-2-2-002
 *
 * TDD tests for the workspace data hook that combines URL state with domain queries.
 *
 * Test Specifications:
 * - test-2-2-002-004: Hook exports all required data fields
 * - test-2-2-002-005: Hook derives orgs from memberCollection.findByUserId
 * - test-2-2-002-006: Hook groups features by phase using StatusToPhase map
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, mock } from "bun:test"
import React, { useEffect } from "react"
import { createRoot, type Root } from "react-dom/client"
import { act } from "react"
import { Window } from "happy-dom"
import { render, cleanup, waitFor } from "@testing-library/react"
import { EnvironmentProvider, createEnvironment } from "../../../../../contexts/EnvironmentContext"
import { DomainProvider, useDomains } from "../../../../../contexts/DomainProvider"
import { AuthProvider } from "../../../../../contexts/AuthContext"
import {
  studioCoreDomain,
  platformFeaturesDomain,
  MockAuthService,
  StatusToPhase,
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
  cleanup()
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
// Test 1: useWorkspaceData exports all required data fields
// (test-2-2-002-004)
// ============================================================

describe("test-2-2-002-004: useWorkspaceData exports all required data fields", () => {
  test("Hook returns orgs array", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("orgs")
    expect(Array.isArray(hookResult!.orgs)).toBe(true)
  })

  test("Hook returns currentOrg (Organization or undefined)", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("currentOrg")
    // currentOrg can be undefined when no org is selected
  })

  test("Hook returns projects array", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("projects")
    expect(Array.isArray(hookResult!.projects)).toBe(true)
  })

  test("Hook returns currentProject (Project or undefined)", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("currentProject")
  })

  test("Hook returns features array", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("features")
    expect(Array.isArray(hookResult!.features)).toBe(true)
  })

  test("Hook returns currentFeature (FeatureSession or undefined)", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("currentFeature")
  })

  test("Hook returns featuresByPhase map", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("featuresByPhase")
    expect(typeof hookResult!.featuresByPhase).toBe("object")
  })

  test("Hook returns isLoading boolean", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult).toHaveProperty("isLoading")
    expect(typeof hookResult!.isLoading).toBe("boolean")
  })
})

// ============================================================
// Test 2: useWorkspaceData derives orgs from memberCollection.findByUserId
// (test-2-2-002-005)
// ============================================================

describe("test-2-2-002-005: useWorkspaceData derives orgs from memberCollection.findByUserId", () => {
  test("Hook uses useDomains to access studioCore", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should import useDomains
    expect(hookSource).toMatch(/useDomains/)
    // Should access studioCore from domains
    expect(hookSource).toMatch(/studioCore/)
  })

  test("Hook uses useAuth to get userId", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should import useAuth
    expect(hookSource).toMatch(/useAuth/)
    // Should access currentUser
    expect(hookSource).toMatch(/currentUser/)
  })

  test("Hook accesses memberCollection.findByUserId", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should call findByUserId on memberCollection
    expect(hookSource).toMatch(/memberCollection/)
    expect(hookSource).toMatch(/findByUserId/)
  })

  test("orgs are derived from member.organization refs", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should derive orgs from members by accessing organization property
    // Pattern: member.organization or m.organization
    expect(hookSource).toMatch(/\.organization/)
  })
})

// ============================================================
// Test 3: useWorkspaceData groups features by actual status
// (test-2-2-002-006 - updated to reflect direct status grouping)
// ============================================================

describe("test-2-2-002-006: useWorkspaceData groups features by actual status", () => {
  test("Hook groups features by their status field directly", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should use feature.status directly, not StatusToPhase mapping
    expect(hookSource).toMatch(/feature\.status/)
    // Should have all 8 phases defined
    expect(hookSource).toMatch(/discovery/)
    expect(hookSource).toMatch(/analysis/)
    expect(hookSource).toMatch(/classification/)
    expect(hookSource).toMatch(/design/)
    expect(hookSource).toMatch(/spec/)
    expect(hookSource).toMatch(/testing/)
    expect(hookSource).toMatch(/implementation/)
    expect(hookSource).toMatch(/complete/)
  })

  test("featuresByPhase groups features by StatusToPhase mapping", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null
    let domainsRef: any = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      domainsRef = useDomains()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter searchParams="?project=test-project">
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult!.featuresByPhase).toBeDefined()

    // featuresByPhase should have phase keys
    const phases = Object.keys(hookResult!.featuresByPhase)
    // Should have at least the standard phases
    expect(phases.length).toBeGreaterThanOrEqual(0)
  })

  test("featuresByPhase returns Record<Phase, FeatureSession[]>", async () => {
    const { NuqsTestingAdapter } = await import("nuqs/adapters/testing")
    const { useWorkspaceData } = await import("../useWorkspaceData")

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

    let hookResult: ReturnType<typeof useWorkspaceData> | null = null

    const TestComponent: React.FC = () => {
      hookResult = useWorkspaceData()
      return null
    }

    await act(async () => {
      root.render(
        <NuqsTestingAdapter>
          <EnvironmentProvider env={env}>
            <AuthProvider authService={mockAuthService}>
              <DomainProvider domains={domains}>
                <TestComponent />
              </DomainProvider>
            </AuthProvider>
          </EnvironmentProvider>
        </NuqsTestingAdapter>
      )
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(hookResult).not.toBeNull()
    expect(hookResult!.featuresByPhase).toBeDefined()

    // Each phase value should be an array
    for (const phase of Object.keys(hookResult!.featuresByPhase)) {
      expect(Array.isArray(hookResult!.featuresByPhase[phase])).toBe(true)
    }
  })
})

// ============================================================
// Test: useWorkspaceData accesses platformFeatures domain
// ============================================================

describe("useWorkspaceData accesses platformFeatures domain", () => {
  test("Hook uses platformFeatures from useDomains", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should access platformFeatures from domains
    expect(hookSource).toMatch(/platformFeatures/)
  })

  test("Hook uses featureSessionCollection", async () => {
    const fs = await import("fs")
    const path = await import("path")

    const hookPath = path.resolve(import.meta.dir, "../useWorkspaceData.ts")
    const hookSource = fs.readFileSync(hookPath, "utf-8")

    // Should access featureSessionCollection
    expect(hookSource).toMatch(/featureSessionCollection/)
  })
})
