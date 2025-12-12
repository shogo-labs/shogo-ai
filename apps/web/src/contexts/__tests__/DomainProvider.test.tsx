/**
 * RED Tests for DomainProvider
 *
 * Phase 2 of the Elegant Domain Provider Architecture plan.
 * These tests should FAIL until DomainProvider.tsx is implemented.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import React from "react"
import { Window } from "happy-dom"

// Set up happy-dom
let window: Window
let originalWindow: typeof globalThis.window
let originalDocument: typeof globalThis.document

beforeAll(() => {
  window = new Window()
  originalWindow = globalThis.window
  originalDocument = globalThis.document
  // @ts-expect-error - happy-dom Window
  globalThis.window = window
  globalThis.document = window.document
})

afterAll(() => {
  // @ts-expect-error - restore original
  globalThis.window = originalWindow
  globalThis.document = originalDocument
  window.close()
})

afterEach(() => {
  cleanup()
})

// Mock persistence for testing
const mockPersistence = {
  loadCollection: async () => null,
  saveCollection: async () => {},
  loadEntity: async () => null,
  saveEntity: async () => {},
}

// Mock domain result - simulates what domain() returns
function createMockDomain(name: string) {
  return {
    name,
    enhancedSchema: { type: "object", properties: {} },
    models: {},
    createStore: (env: any) => ({
      _name: name,
      _env: env,
      testCollection: {
        all: () => [],
        loadAll: async () => {},
      },
    }),
    register: () => ({ id: `schema-${name}` }),
  }
}

const mockTeamsDomain = createMockDomain("teams-workspace")
const mockAuthDomain = createMockDomain("auth")

describe("useDomains hook", () => {
  test("useDomains throws when used outside DomainProvider", () => {
    const { useDomains } = require("../DomainProvider")

    // Suppress React error boundary warnings
    const originalError = console.error
    console.error = () => {}

    function TestComponent() {
      useDomains()
      return <div>Should not render</div>
    }

    expect(() => {
      render(<TestComponent />)
    }).toThrow("useDomains must be used within DomainProvider")

    console.error = originalError
  })

  test("useDomains returns object with keys matching domains map", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    let capturedStores: any = null

    function TestComponent() {
      capturedStores = useDomains()
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain, auth: mockAuthDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    expect(capturedStores).not.toBeNull()
    expect(capturedStores.teams).toBeDefined()
    expect(capturedStores.auth).toBeDefined()
    expect(Object.keys(capturedStores)).toEqual(["teams", "auth"])
  })

  test("keys match object keys, not domain.name (allows aliasing)", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    // Create domain with different internal name than the key we use
    const aliasedDomain = createMockDomain("teams-workspace") // domain.name is "teams-workspace"

    let capturedStores: any = null

    function TestComponent() {
      capturedStores = useDomains()
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        {/* Key is "myTeams" but domain.name is "teams-workspace" */}
        <DomainProvider domains={{ myTeams: aliasedDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    // Should use object key "myTeams", NOT domain.name "teams-workspace"
    expect(capturedStores.myTeams).toBeDefined()
    expect(capturedStores["teams-workspace"]).toBeUndefined()
  })

  test("can destructure useDomains() result", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    let teamsStore: any = null
    let authStore: any = null

    function TestComponent() {
      const { teams, auth } = useDomains()
      teamsStore = teams
      authStore = auth
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain, auth: mockAuthDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    expect(teamsStore).toBeDefined()
    expect(authStore).toBeDefined()
    expect(teamsStore._name).toBe("teams-workspace")
    expect(authStore._name).toBe("auth")
  })
})

describe("DomainProvider store stability", () => {
  test("stores are stable across re-renders", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    const capturedStores: any[] = []

    function TestComponent() {
      const stores = useDomains()
      capturedStores.push(stores)
      return <div>Test</div>
    }

    const { rerender } = render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    // Force re-render
    rerender(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    expect(capturedStores.length).toBe(2)
    // Same object reference
    expect(capturedStores[0]).toBe(capturedStores[1])
    // Same store instances
    expect(capturedStores[0].teams).toBe(capturedStores[1].teams)
  })

  test("individual store instances are referentially stable", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    const teamsInstances: any[] = []

    function TestComponent() {
      const { teams } = useDomains()
      teamsInstances.push(teams)
      return <div>Test</div>
    }

    const { rerender } = render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    rerender(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    expect(teamsInstances.length).toBe(2)
    expect(teamsInstances[0]).toBe(teamsInstances[1])
  })
})

describe("DomainProvider environment integration", () => {
  test("uses env from EnvironmentProvider", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
      workspace: "test-workspace",
    })

    let capturedStore: any = null

    function TestComponent() {
      const { teams } = useDomains()
      capturedStore = teams
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    // Store should have received env with persistence and workspace
    expect(capturedStore._env.services.persistence).toBe(mockPersistence)
    expect(capturedStore._env.context.location).toBe("test-workspace")
  })

  test("passes domain.name as schemaName in env.context", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    let capturedStore: any = null

    function TestComponent() {
      const { teams } = useDomains()
      capturedStore = teams
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <TestComponent />
        </DomainProvider>
      </EnvironmentProvider>
    )

    // env.context.schemaName should be set to domain.name
    expect(capturedStore._env.context.schemaName).toBe("teams-workspace")
  })

  test("throws if used without EnvironmentProvider", () => {
    const { DomainProvider } = require("../DomainProvider")

    // Suppress React error boundary warnings
    const originalError = console.error
    console.error = () => {}

    expect(() => {
      render(
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <div>Test</div>
        </DomainProvider>
      )
    }).toThrow()

    console.error = originalError
  })
})

describe("DomainProvider provides to nested children", () => {
  test("deeply nested components can access stores", () => {
    const { DomainProvider, useDomains } = require("../DomainProvider")
    const { EnvironmentProvider, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({ persistence: mockPersistence })

    let capturedStores: any = null

    function DeepChild() {
      capturedStores = useDomains()
      return <div>Deep</div>
    }

    function MiddleComponent({ children }: { children: React.ReactNode }) {
      return <div>{children}</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <DomainProvider domains={{ teams: mockTeamsDomain }}>
          <MiddleComponent>
            <MiddleComponent>
              <DeepChild />
            </MiddleComponent>
          </MiddleComponent>
        </DomainProvider>
      </EnvironmentProvider>
    )

    expect(capturedStores).not.toBeNull()
    expect(capturedStores.teams).toBeDefined()
  })
})
