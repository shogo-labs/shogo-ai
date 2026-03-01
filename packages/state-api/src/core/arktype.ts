/**
 * arkType integration utilities for the Shogo State API
 */

import { type, Type } from 'arktype'
import type { ArkTypeSchema, ArkTypeValidationResult, ValidationResult, ShogoSchema } from './types'

/**
 * Validates data against an arkType schema and returns a standardized result
 */
export function validateWithArkType<T>(
  schema: ArkTypeSchema<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema(data)
  
  if (typeof result === 'string') {
    return {
      success: false,
      errors: [result]
    }
  }
  
  return {
    success: true,
    data: result as T
  }
}

/**
 * Validates a specific field using arkType schema introspection
 * Simplified implementation - more sophisticated introspection may be added later
 */
export function validateField<T>(
  schema: ArkTypeSchema<T>,
  fieldName: string,
  value: unknown
): ValidationResult {
  try {
    // For now, validate the value against the full schema wrapped in an object
    const testObject = { [fieldName]: value }
    const result = schema(testObject as any)
    
    if (typeof result === 'string') {
      return {
        success: false,
        errors: [result]
      }
    }
    
    return {
      success: true,
      data: value
    }
  } catch (error) {
    return {
      success: false,
      errors: [`Field validation error for '${fieldName}': ${String(error)}`]
    }
  }
}

/**
 * Creates a Shogo schema wrapper with metadata
 */
export function createShogoSchema<T>(
  definition: string,
  metadata: Partial<ShogoSchema<T>['metadata']> = {}
): ShogoSchema<T> {
  const schema = type(definition as any)
  
  return {
    schema: schema as unknown as ArkTypeSchema<T>,
    metadata: {
      name: metadata.name || 'UnnamedSchema',
      description: metadata.description,
      version: metadata.version || '1.0.0',
      generated: metadata.generated || false
    }
  }
}

/**
 * Checks if a value is an arkType validation error
 */
export function isArkTypeError(result: unknown): result is string {
  return typeof result === 'string'
}

/**
 * Extracts field names from an arkType schema
 * This is a simplified implementation - more sophisticated introspection may be needed
 */
export function extractFieldNames(schema: ArkTypeSchema): string[] {
  try {
    // This is a basic implementation that will need enhancement
    // For now, return empty array as arkType introspection needs more research
    return []
  } catch {
    return []
  }
}

/**
 * Creates a type-safe validator function from an arkType schema
 */
export function createValidator<T>(schema: ArkTypeSchema<T>) {
  return (data: unknown): data is T => {
    const result = schema(data)
    return !(result instanceof type.errors)
  }
}

/**
 * Utility to safely convert arkType schema to JSON Schema
 * Uses arkType's built-in .toJsonSchema() method
 */
export function toJSONSchema(schema: ArkTypeSchema): object {
  try {
    // Use arkType's built-in JSON Schema conversion
    return schema.toJsonSchema() as object
  } catch (error) {
    console.warn('Failed to convert arkType schema to JSON Schema:', error)
    return {
      type: 'object',
      description: 'arkType schema (conversion failed)'
    }
  }
}