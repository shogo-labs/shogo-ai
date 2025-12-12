/**
 * RED Tests for EnvironmentProvider
 *
 * Phase 1 of the Elegant Domain Provider Architecture plan.
 * These tests should FAIL until EnvironmentContext.tsx is implemented.
 *
 * @jest-environment happy-dom
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test"
import { render, cleanup } from "@testing-library/react"
import React from "react"
import { Window } from "happy-dom"

// These imports will fail until the file is created
// import { EnvironmentProvider, useEnv, useOptionalEnv, createEnvironment } from "../EnvironmentContext"
// import type { IEnvironment } from "@shogo/state-api"

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

describe("createEnvironment factory", () => {
  test("creates IEnvironment with required persistence", () => {
    // Import will be added when file exists
    const { createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
    })

    expect(env.services.persistence).toBe(mockPersistence)
    expect(env.context.schemaName).toBe("default")
  })

  test("accepts optional workspace as location", () => {
    const { createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
      workspace: ".schemas/my-workspace",
    })

    expect(env.context.location).toBe(".schemas/my-workspace")
  })

  test("accepts optional auth service", () => {
    const { createEnvironment } = require("../EnvironmentContext")

    const mockAuth = { signIn: async () => null }
    const env = createEnvironment({
      persistence: mockPersistence,
      auth: mockAuth,
    })

    expect(env.services.auth).toBe(mockAuth)
  })

  test("defaults schemaName to 'default' when not provided", () => {
    const { createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
    })

    expect(env.context.schemaName).toBe("default")
  })
})

describe("useEnv hook", () => {
  test("throws when used outside EnvironmentProvider", () => {
    const { useEnv } = require("../EnvironmentContext")

    // Suppress React error boundary warnings
    const originalError = console.error
    console.error = () => {}

    function TestComponent() {
      useEnv()
      return <div>Should not render</div>
    }

    expect(() => {
      render(<TestComponent />)
    }).toThrow("useEnv must be used within EnvironmentProvider")

    console.error = originalError
  })

  test("returns environment when inside EnvironmentProvider", () => {
    const { EnvironmentProvider, useEnv, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
      workspace: "test-workspace",
    })

    let capturedEnv: any = null

    function TestComponent() {
      capturedEnv = useEnv()
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <TestComponent />
      </EnvironmentProvider>
    )

    expect(capturedEnv).not.toBeNull()
    expect(capturedEnv.services.persistence).toBe(mockPersistence)
    expect(capturedEnv.context.location).toBe("test-workspace")
  })
})

describe("useOptionalEnv hook", () => {
  test("returns null when used outside EnvironmentProvider (no throw)", () => {
    const { useOptionalEnv } = require("../EnvironmentContext")

    let capturedEnv: any = "sentinel"

    function TestComponent() {
      capturedEnv = useOptionalEnv()
      return <div>Test</div>
    }

    // Should NOT throw
    render(<TestComponent />)

    expect(capturedEnv).toBeNull()
  })

  test("returns environment when inside EnvironmentProvider", () => {
    const { EnvironmentProvider, useOptionalEnv, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
    })

    let capturedEnv: any = null

    function TestComponent() {
      capturedEnv = useOptionalEnv()
      return <div>Test</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <TestComponent />
      </EnvironmentProvider>
    )

    expect(capturedEnv).toBe(env)
  })
})

describe("EnvironmentProvider", () => {
  test("env is stable across re-renders", () => {
    const { EnvironmentProvider, useEnv, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
    })

    const capturedEnvs: any[] = []

    function TestComponent() {
      const env = useEnv()
      capturedEnvs.push(env)
      return <div>Test</div>
    }

    const { rerender } = render(
      <EnvironmentProvider env={env}>
        <TestComponent />
      </EnvironmentProvider>
    )

    // Force re-render
    rerender(
      <EnvironmentProvider env={env}>
        <TestComponent />
      </EnvironmentProvider>
    )

    expect(capturedEnvs.length).toBe(2)
    expect(capturedEnvs[0]).toBe(capturedEnvs[1])
  })

  test("provides env to deeply nested children", () => {
    const { EnvironmentProvider, useEnv, createEnvironment } = require("../EnvironmentContext")

    const env = createEnvironment({
      persistence: mockPersistence,
      workspace: "deep-test",
    })

    let capturedEnv: any = null

    function DeepChild() {
      capturedEnv = useEnv()
      return <div>Deep</div>
    }

    function MiddleComponent({ children }: { children: React.ReactNode }) {
      return <div>{children}</div>
    }

    render(
      <EnvironmentProvider env={env}>
        <MiddleComponent>
          <MiddleComponent>
            <DeepChild />
          </MiddleComponent>
        </MiddleComponent>
      </EnvironmentProvider>
    )

    expect(capturedEnv).not.toBeNull()
    expect(capturedEnv.context.location).toBe("deep-test")
  })
})
