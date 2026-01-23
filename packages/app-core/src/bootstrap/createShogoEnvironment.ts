/**
 * Convenience factory for creating a complete Shogo environment.
 *
 * This wires up MCPService, MCPPersistence, MCPBackend, and environment
 * in a single function call, dramatically simplifying app bootstrap.
 *
 * @example
 * ```typescript
 * // Minimal setup (defaults to '/mcp' endpoint)
 * const { mcpService, env } = createShogoEnvironment({
 *   workspace: '.schemas/my-project',
 * })
 *
 * // With custom MCP URL
 * const { mcpService, env } = createShogoEnvironment({
 *   mcpUrl: 'http://localhost:3001/mcp',
 *   workspace: '.schemas/my-project',
 * })
 *
 * // With auth service
 * const { mcpService, env } = createShogoEnvironment({
 *   workspace: '.schemas/my-project',
 *   authService: betterAuthService,
 * })
 * ```
 */

import type { IAuthService, IEnvironment } from '@shogo/state-api'
import { createBackendRegistry, AuthorizationService } from '@shogo/state-api'
import { MCPService } from '../services/MCPService'
import { MCPPersistence } from '../persistence/MCPPersistence'
import { MCPBackend } from '../query/MCPBackend'
import { createEnvironment } from '../environment/EnvironmentContext'

/**
 * Configuration options for createShogoEnvironment.
 */
export interface ShogoEnvironmentConfig {
  /**
   * MCP server URL.
   * - For same-origin: '/mcp' (default)
   * - For cross-origin: 'http://localhost:3001/mcp'
   */
  mcpUrl?: string

  /**
   * Workspace path for data isolation.
   * Maps to context.location in the environment.
   */
  workspace?: string

  /**
   * Optional auth service for user authentication.
   * Used by auth-aware stores for session management.
   */
  authService?: IAuthService
}

/**
 * Result of createShogoEnvironment - provides both the MCPService
 * instance (for direct tool calls) and the configured environment.
 */
export interface ShogoEnvironment {
  /** The MCPService instance for direct MCP calls (chat, schema generation, etc.) */
  mcpService: MCPService

  /** The configured IEnvironment for MST stores */
  env: IEnvironment
}

/**
 * Create a complete Shogo environment with MCPService, persistence, and backend.
 *
 * This is the recommended way to bootstrap a Shogo-enabled application.
 * It creates and wires up all the necessary services in the correct order.
 *
 * @param config - Environment configuration options
 * @returns Object containing mcpService and configured env
 *
 * @example
 * ```tsx
 * // In App.tsx
 * const { mcpService, env } = createShogoEnvironment({
 *   mcpUrl: import.meta.env.VITE_MCP_URL,
 *   workspace: import.meta.env.VITE_WORKSPACE,
 *   authService: betterAuthService,
 * })
 *
 * function App() {
 *   return (
 *     <EnvironmentProvider env={env}>
 *       <DomainProvider domains={domains}>
 *         <AppContent />
 *       </DomainProvider>
 *     </EnvironmentProvider>
 *   )
 * }
 * ```
 */
export function createShogoEnvironment(config: ShogoEnvironmentConfig = {}): ShogoEnvironment {
  const { mcpUrl, workspace, authService } = config

  // Create MCP service
  const mcpService = new MCPService({
    baseUrl: mcpUrl ?? '/mcp',
  })

  // Create MCP-backed backend
  const mcpBackend = new MCPBackend(mcpService, workspace)

  // Create backend registry with postgres alias for x-persistence.backend: 'postgres'
  const backendRegistry = createBackendRegistry({
    default: 'postgres',
    backends: { postgres: mcpBackend }
  })

  // Create environment
  const env = createEnvironment({
    persistence: new MCPPersistence(mcpService),
    backendRegistry,
    auth: authService,
    authorization: new AuthorizationService(),
    workspace,
  })

  return { mcpService, env }
}
