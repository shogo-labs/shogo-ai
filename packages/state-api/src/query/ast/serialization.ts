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
import type { SerializedCondition, SubqueryCondition, ParsedCondition } from './types'

/**
 * PCRE/Python inline flags that JavaScript RegExp doesn't support.
 * These appear at the start of a pattern like (?i) for case-insensitive.
 */
const PCRE_INLINE_FLAG_PATTERN = /^\(\?([imsluxUXJ]+)\)/

/**
 * Map PCRE inline flags to JavaScript RegExp flags where possible.
 * Not all PCRE flags have JS equivalents.
 */
const PCRE_TO_JS_FLAG_MAP: Record<string, string> = {
  i: 'i', // case-insensitive
  m: 'm', // multiline
  s: 's', // dotAll (. matches newline)
  // x, l, u, U, X, J have no direct JS equivalents
}

/**
 * Normalize a regex pattern by converting PCRE inline flags to JS flags.
 *
 * @param pattern - The regex pattern string (may contain PCRE inline flags)
 * @param existingFlags - Any existing flags from $options
 * @returns Object with normalized pattern and flags
 *
 * @example
 * normalizeRegexPattern('(?i)(foo|bar)', '')
 * // => { pattern: '(foo|bar)', flags: 'i' }
 *
 * normalizeRegexPattern('(?im)pattern', 'g')
 * // => { pattern: 'pattern', flags: 'gim' }
 */
function normalizeRegexPattern(
  pattern: string,
  existingFlags: string
): { pattern: string; flags: string } {
  const match = PCRE_INLINE_FLAG_PATTERN.exec(pattern)

  if (!match) {
    return { pattern, flags: existingFlags }
  }

  const pcreFlags = match[1]
  const normalizedPattern = pattern.slice(match[0].length)

  // Convert PCRE flags to JS flags where possible
  let additionalFlags = ''
  for (const flag of pcreFlags) {
    const jsFlag = PCRE_TO_JS_FLAG_MAP[flag]
    if (jsFlag && !existingFlags.includes(jsFlag)) {
      additionalFlags += jsFlag
    }
  }

  return {
    pattern: normalizedPattern,
    flags: existingFlags + additionalFlags
  }
}

/**
 * Safely create a RegExp, returning null if the pattern is invalid.
 * Logs a warning for debugging purposes.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags
 * @returns RegExp instance or null if invalid
 */
function safeCreateRegExp(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags)
  } catch (error) {
    console.warn(
      `[Query Serialization] Invalid regex pattern: /${pattern}/${flags}. ` +
      `Error: ${error instanceof Error ? error.message : String(error)}. ` +
      `The query will match nothing.`
    )
    return null
  }
}

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
export function serializeCondition(condition: ParsedCondition): SerializedCondition {
  // Handle SubqueryCondition (our custom type, not @ucast/core)
  if ('type' in condition && condition.type === 'subquery') {
    const subquery = condition as SubqueryCondition
    return {
      type: 'subquery',
      field: subquery.field,
      operator: subquery.operator,
      subquery: {
        schema: subquery.subquery.schema,
        model: subquery.subquery.model,
        filter: subquery.subquery.filter ? serializeCondition(subquery.subquery.filter) : undefined,
        field: subquery.subquery.selectField
      }
    }
  }

  // Handle @ucast/core FieldCondition
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
  }

  // Handle @ucast/core CompoundCondition
  if (condition instanceof CompoundCondition) {
    return {
      type: 'compound',
      operator: condition.operator,
      value: condition.value.map(serializeCondition)
    }
  }

  throw new Error(
    `Cannot serialize unknown condition type: ${condition}. ` +
    `Expected FieldCondition, CompoundCondition, or SubqueryCondition.`
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
export function deserializeCondition(json: any): Condition | SubqueryCondition {
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
      // Normalize PCRE inline flags (like (?i)) to JS flags
      const { pattern, flags } = normalizeRegexPattern(
        json.value.$regex,
        json.value.$options || ''
      )

      // Safely create the RegExp - returns null on invalid patterns
      const regex = safeCreateRegExp(pattern, flags)

      // If regex creation failed, use a pattern that matches nothing
      // This prevents crashes while still allowing the query to execute
      deserializedValue = regex ?? /(?!)/  // Negative lookahead matches nothing
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
  } else if (json.type === 'subquery') {
    // Handle SubqueryCondition (our custom type, not @ucast/core)
    return {
      type: 'subquery',
      field: json.field,
      operator: json.operator,
      subquery: {
        schema: json.subquery.schema,
        model: json.subquery.model,
        filter: json.subquery.filter ? deserializeCondition(json.subquery.filter) : undefined,
        selectField: json.subquery.field
      }
    } as SubqueryCondition
  }

  throw new Error(
    `Cannot deserialize unknown condition type: ${json.type}. ` +
    `Expected 'field', 'compound', or 'subquery'.`
  )
}
