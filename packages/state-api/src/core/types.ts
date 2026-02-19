/**
 * Core type definitions and generic patterns for the Shogo State API
 */

import type { Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree'
import type { Type } from 'arktype'

/**
 * Generic MST utility types (enhanced from dev-ai patterns)
 */
export type InstanceOfModel<M extends IAnyModelType> = Instance<M>
export type SnapshotInOfModel<M extends IAnyModelType> = SnapshotIn<M>
export type SnapshotOutOfModel<M extends IAnyModelType> = SnapshotOut<M>

/**
 * arkType integration types
 */
export type ArkTypeSchema<T = any> = Type<T>
export type ArkTypeValidationResult<T> = T | string[]

/**
 * Base interface for models that support arkType validation
 */
export interface ArkTypeValidated {
  validate(data: unknown): ArkTypeValidationResult<any>
  validateField(field: string, value: unknown): ArkTypeValidationResult<any>
}

/**
 * Generic environment interface for dependency injection
 * Supports isomorphic execution without specifying concrete services
 */
export interface Environment {
  [serviceName: string]: any
}

/**
 * Environment factory function type
 */
export type EnvironmentFactory<T extends Environment = Environment> = () => T

/**
 * Base interface for items that can be managed in collections
 */
export interface Identifiable {
  id: string
}

/**
 * Generic validation result wrapper
 */
export interface ValidationResult<T = any> {
  success: boolean
  data?: T
  errors?: string[]
}

/**
 * Schema generation metadata
 */
export interface SchemaMetadata {
  name: string
  description?: string
  version?: string
  generated?: boolean
}

/**
 * Type for arkType schema definitions with metadata
 */
export interface ShogoSchema<T = any> {
  schema: ArkTypeSchema<T>
  metadata: SchemaMetadata
}