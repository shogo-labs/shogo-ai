/**
 * Generic environment injection patterns for isomorphic execution
 * Provides the foundation for dependency injection without specifying concrete services
 */

import { getEnv } from 'mobx-state-tree'
import type { Environment, EnvironmentFactory } from './types'

/**
 * Base environment interface
 * Intentionally generic to support various service patterns
 */
export interface BaseEnvironment extends Environment {
  // Context information
  context?: 'client' | 'server' | 'test'
  
  // Generic service registry
  services?: Record<string, any>
  
  // Configuration
  config?: Record<string, any>
}

/**
 * Environment registry for managing different environment contexts
 */
class EnvironmentRegistry {
  private environments = new Map<string, EnvironmentFactory>()
  private currentContext: string = 'default'
  
  /**
   * Registers an environment factory for a specific context
   */
  register<T extends BaseEnvironment>(
    context: string, 
    factory: EnvironmentFactory<T>
  ): void {
    this.environments.set(context, factory)
  }
  
  /**
   * Gets the environment for a specific context
   */
  get<T extends BaseEnvironment>(context: string): T {
    const factory = this.environments.get(context)
    if (!factory) {
      throw new Error(`No environment registered for context: ${context}`)
    }
    return factory() as T
  }
  
  /**
   * Gets the current environment
   */
  getCurrent<T extends BaseEnvironment>(): T {
    return this.get<T>(this.currentContext)
  }
  
  /**
   * Sets the current environment context
   */
  setContext(context: string): void {
    if (!this.environments.has(context)) {
      throw new Error(`No environment registered for context: ${context}`)
    }
    this.currentContext = context
  }
  
  /**
   * Lists all registered environment contexts
   */
  getContexts(): string[] {
    return Array.from(this.environments.keys())
  }
}

/**
 * Global environment registry instance
 */
export const environmentRegistry = new EnvironmentRegistry()

/**
 * Utility for safely getting environment from MST models
 */
export function getEnvironment<T extends BaseEnvironment>(model: any): T {
  try {
    return getEnv<T>(model)
  } catch (error) {
    throw new Error(
      `Failed to get environment from model. Ensure the model was created with an environment. ${error}`
    )
  }
}

/**
 * Helper for accessing services from environment
 */
export function getService<T = any>(
  model: any, 
  serviceName: string
): T {
  const env = getEnvironment<BaseEnvironment>(model)
  
  if (!env.services || !(serviceName in env.services)) {
    throw new Error(
      `Service '${serviceName}' not found in environment. Available services: ${
        env.services ? Object.keys(env.services).join(', ') : 'none'
      }`
    )
  }
  
  return env.services[serviceName] as T
}

/**
 * Helper for accessing configuration from environment
 */
export function getConfig<T = any>(
  model: any, 
  configKey?: string
): T {
  const env = getEnvironment<BaseEnvironment>(model)
  
  if (!env.config) {
    throw new Error('No configuration found in environment')
  }
  
  if (configKey) {
    if (!(configKey in env.config)) {
      throw new Error(
        `Configuration key '${configKey}' not found. Available keys: ${
          Object.keys(env.config).join(', ')
        }`
      )
    }
    return env.config[configKey] as T
  }
  
  return env.config as T
}

/**
 * Creates a basic environment with services and config
 */
export function createEnvironment(
  context: 'client' | 'server' | 'test',
  services: Record<string, any> = {},
  config: Record<string, any> = {}
): BaseEnvironment {
  return {
    context,
    services,
    config
  }
}

/**
 * Factory for creating isomorphic environment pairs
 */
export function createIsomorphicEnvironments<
  TClient extends BaseEnvironment = BaseEnvironment,
  TServer extends BaseEnvironment = BaseEnvironment
>(
  clientFactory: EnvironmentFactory<TClient>,
  serverFactory: EnvironmentFactory<TServer>
) {
  // Register both environments
  environmentRegistry.register('client', clientFactory)
  environmentRegistry.register('server', serverFactory)
  
  return {
    client: clientFactory,
    server: serverFactory,
    getForContext: (context: 'client' | 'server') => {
      return environmentRegistry.get(context)
    }
  }
}

/**
 * Decorator for MST models that automatically inject environment helpers
 */
export function withEnvironmentHelpers<T>(modelType: T) {
  return (modelType as any).actions((self: any) => ({
    getService<S = any>(serviceName: string): S {
      return getService<S>(self, serviceName)
    },
    
    getConfig<C = any>(configKey?: string): C {
      return getConfig<C>(self, configKey)
    },
    
    getEnvironment<E extends BaseEnvironment = BaseEnvironment>(): E {
      return getEnvironment<E>(self)
    }
  }))
}

/**
 * Type guard for checking environment context
 */
export function isClientEnvironment(env: BaseEnvironment): boolean {
  return env.context === 'client'
}

/**
 * Type guard for checking environment context
 */
export function isServerEnvironment(env: BaseEnvironment): boolean {
  return env.context === 'server'
}

/**
 * Type guard for checking environment context
 */
export function isTestEnvironment(env: BaseEnvironment): boolean {
  return env.context === 'test'
}