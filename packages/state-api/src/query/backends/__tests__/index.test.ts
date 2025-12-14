/**
 * Barrel Exports Tests
 *
 * Tests that all backend abstractions are properly exported from backends/index.ts
 * Generated from TestSpecification: test-registry-index-exports
 */

import { describe, test, expect } from "bun:test"

describe("backends/index.ts exports", () => {
  test("BackendRegistry class accessible", async () => {
    const { BackendRegistry } = await import('../index')
    expect(BackendRegistry).toBeDefined()
    expect(typeof BackendRegistry).toBe('function')

    // Verify it's constructable
    const instance = new BackendRegistry()
    expect(instance).toBeDefined()
  })

  test("IBackendRegistry interface accessible", async () => {
    const module = await import('../index')
    // Interface is a type-only export, so we can't test it directly at runtime
    // But we can verify BackendRegistry implements it by checking methods exist
    const { BackendRegistry } = module
    const instance = new BackendRegistry()

    expect(typeof instance.register).toBe('function')
    expect(typeof instance.get).toBe('function')
    expect(typeof instance.has).toBe('function')
    expect(typeof instance.resolve).toBe('function')
    expect(typeof instance.setDefault).toBe('function')
  })

  test("createBackendRegistry function accessible", async () => {
    const { createBackendRegistry } = await import('../index')
    expect(createBackendRegistry).toBeDefined()
    expect(typeof createBackendRegistry).toBe('function')

    // Verify it returns a BackendRegistry
    const registry = createBackendRegistry()
    expect(registry).toBeDefined()
  })

  test("MemoryBackend accessible", async () => {
    const { MemoryBackend } = await import('../index')
    expect(MemoryBackend).toBeDefined()
    expect(typeof MemoryBackend).toBe('function')
  })

  test("IBackend type accessible", async () => {
    const module = await import('../index')
    // IBackend is a type-only export, verified by checking MemoryBackend implements it
    const { MemoryBackend } = module
    const backend = new MemoryBackend()

    expect(backend.capabilities).toBeDefined()
    expect(typeof backend.execute).toBe('function')
  })
})
