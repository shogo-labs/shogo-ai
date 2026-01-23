/**
 * Runtime Manager Module
 *
 * Exports RuntimeManager for managing Vite dev server processes per project.
 */

export { RuntimeManager, createRuntimeManager, getRuntimeManager } from './manager'
export type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'
