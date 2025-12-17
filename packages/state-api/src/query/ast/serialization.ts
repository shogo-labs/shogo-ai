/**
 * Query AST Serialization and Deserialization
 *
 * This module provides utilities for converting @ucast Condition AST nodes
 * to and from JSON-safe format for transport over MCP (Model Context Protocol).
 *
 * @module query/ast/serialization
 *
 * Requirements:
 * - AST-03: JSON-serializable for MCP transport
 *
 * Design decisions:
 * - serializeCondition(ast) converts AST to plain objects (no class instances)
 * - deserializeCondition(json) reconstructs AST from JSON
 * - RegExp values serialized as { $regex: string, $options: string } format
 * - Preserves operator, field, and value information through roundtrip
 * - Handles both FieldCondition and CompoundCondition types
 *
 * Critical gotchas:
 * - RegExp is not JSON-native and must be converted to object format
 * - Class instances (FieldCondition, CompoundCondition) must be reconstructed
 *
 * @example
 * ```typescript
 * import { serializeCondition, deserializeCondition } from './serialization'
 * import { parseQuery } from './parser'
 *
 * // Parse query to AST
 * const ast = parseQuery({ age: { $gt: 18 } })
 *
 * // Serialize for MCP transport
 * const serialized = serializeCondition(ast)
 * const jsonString = JSON.stringify(serialized)
 *
 * // Send over network...
 *
 * // Deserialize back to AST
 * const parsed = JSON.parse(jsonString)
 * const restored = deserializeCondition(parsed)
 * ```
 */

import { FieldCondition, CompoundCondition, Condition } from '@ucast/core'
import type { SerializedCondition } from './types'

/**
 * Serialize a Condition AST node to JSON-safe format.
 *
 * Converts FieldCondition and CompoundCondition instances to plain objects
 * that can be safely JSON.stringify'd. Handles RegExp special case by
 * converting to { $regex: string, $options: string } format.
 *
 * @param condition - Condition AST node to serialize
 * @returns Plain object representation (JSON-safe)
 * @throws {Error} If condition is not a recognized type
 *
 * @example
 * ```typescript
 * import { serializeCondition } from './serialization'
 * import { parseQuery } from './parser'
 *
 * const ast = parseQuery({ email: { $regex: '@example\\.com$' } })
 * const serialized = serializeCondition(ast)
 *
 * // serialized = {
 * //   type: 'field',
 * //   operator: 'regex',
 * //   field: 'email',
 * //   value: { $regex: '@example\\.com$', $options: '' }
 * // }
 * ```
 */
export function serializeCondition(condition: Condition): SerializedCondition {
  if (condition instanceof FieldCondition) {
    // Handle RegExp value special case
    let serializedValue = condition.value
    if (condition.value instanceof RegExp) {
      serializedValue = {
        $regex: condition.value.source,
        $options: condition.value.flags
      }
    }

    return {
      type: 'field',
      operator: condition.operator,
      field: condition.field,
      value: serializedValue
    }
  } else if (condition instanceof CompoundCondition) {
    return {
      type: 'compound',
      operator: condition.operator,
      value: condition.value.map(serializeCondition)
    }
  }

  throw new Error(
    `Cannot serialize unknown condition type: ${condition}. ` +
    `Expected FieldCondition or CompoundCondition.`
  )
}

/**
 * Deserialize a JSON object back to a Condition AST node.
 *
 * Reconstructs FieldCondition or CompoundCondition instances from plain
 * objects. Handles RegExp reconstruction from { $regex, $options } format.
 *
 * @param json - Serialized condition object
 * @returns Condition AST node (FieldCondition or CompoundCondition)
 * @throws {Error} If json is not a recognized format
 *
 * @example
 * ```typescript
 * import { deserializeCondition } from './serialization'
 *
 * const json = {
 *   type: 'field',
 *   operator: 'regex',
 *   field: 'email',
 *   value: { $regex: '@example\\.com$', $options: 'i' }
 * }
 *
 * const condition = deserializeCondition(json)
 * // condition is FieldCondition with RegExp value
 * ```
 */
export function deserializeCondition(json: any): Condition {
  if (!json || typeof json !== 'object') {
    throw new Error(
      `Cannot deserialize condition: expected object, got ${typeof json}`
    )
  }

  if (json.type === 'field') {
    // Reconstruct RegExp if value is in { $regex, $options } format
    let deserializedValue = json.value
    if (
      json.value &&
      typeof json.value === 'object' &&
      '$regex' in json.value
    ) {
      deserializedValue = new RegExp(
        json.value.$regex,
        json.value.$options || ''
      )
    }

    return new FieldCondition(
      json.operator,
      json.field,
      deserializedValue
    )
  } else if (json.type === 'compound') {
    return new CompoundCondition(
      json.operator,
      json.value.map(deserializeCondition)
    )
  }

  throw new Error(
    `Cannot deserialize unknown condition type: ${json.type}. ` +
    `Expected 'field' or 'compound'.`
  )
}
