/**
 * Runtime Module - Project Vite Runtime Management
 *
 * Provides interfaces and implementations for managing isolated Vite dev server
 * runtimes per project.
 *
 * @example
 * ```typescript
 * import { RuntimeManager, MockRuntimeManager } from '@shogo/state-api/runtime'
 * import type { IRuntimeManager, IProjectRuntime } from '@shogo/state-api/runtime'
 *
 * // Production: spawn real Vite processes
 * const manager = new RuntimeManager({ basePort: 5200 })
 * const runtime = await manager.start('project-abc')
 * console.log(runtime.url) // http://project-abc.localhost:5200
 *
 * // Testing: simulate without real processes
 * const mock = new MockRuntimeManager()
 * await mock.start('project-xyz')
 * expect(mock.wasStarted('project-xyz')).toBe(true)
 * ```
 */

// Type exports
export type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'

// Manager implementation
export {
  RuntimeManager,
  createRuntimeManager,
  getRuntimeManager,
} from './manager'

// Mock implementation for testing
export {
  MockRuntimeManager,
  createMockRuntimeManager,
  type MockRuntimeConfig,
} from './mock'
