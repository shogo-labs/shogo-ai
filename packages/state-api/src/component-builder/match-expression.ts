/**
 * Match Expression Module
 *
 * Wraps ucast parseQuery + interpret for evaluating MongoDB-style match
 * expressions against PropertyMetadata objects. Includes AST caching for
 * performance.
 *
 * This module is isomorphic - no React dependencies. It produces matcher
 * functions that can be used by both state-api code and the apps/web
 * ComponentRegistry.
 *
 * @module component-builder/match-expression
 * @task task-dcb-002
 *
 * @example
 * ```typescript
 * import { createMatcherFromExpression } from './match-expression'
 *
 * // Simple type matching
 * const stringMatcher = createMatcherFromExpression({ type: 'string' })
 * stringMatcher({ name: 'title', type: 'string' }) // true
 *
 * // $exists operator for optional fields
 * const enumMatcher = createMatcherFromExpression({ enum: { $exists: true } })
 * enumMatcher({ name: 'status', enum: ['active', 'inactive'] }) // true
 *
 * // Logical operators
 * const complexMatcher = createMatcherFromExpression({
 *   $and: [
 *     { type: 'string' },
 *     { format: 'email' }
 *   ]
 * })
 * complexMatcher({ name: 'email', type: 'string', format: 'email' }) // true
 * ```
 */

import { createJsInterpreter as ucastCreateJsInterpreter, allInterpreters } from "@ucast/js"
import { parseQuery } from "../query/ast/parser"
import type { Condition } from "@ucast/core"
import type { PropertyMetadata } from "./types"

// Re-export PropertyMetadata for consumers who import from this module
export type { PropertyMetadata }

/**
 * MongoDB-style match expression for PropertyMetadata.
 * Supports field equality, operators like $exists, $gt, $lt, $in,
 * and logical operators $and, $or.
 */
export type MatchExpression = Record<string, unknown>

/**
 * Matcher function that evaluates PropertyMetadata against a match expression.
 */
export type PropertyMatcher = (meta: PropertyMetadata) => boolean

// ============================================================================
// AST Cache
// ============================================================================

/**
 * WeakMap cache for parsed AST nodes.
 *
 * Uses the match expression object as key (object identity).
 * This means the same expression object will reuse its parsed AST,
 * but identical content in different objects will parse separately.
 *
 * This is intentional - it matches how MST/MobX objects work where
 * the same entity maintains object identity across accesses.
 */
const astCache = new WeakMap<object, Condition>()

// ============================================================================
// Interpreter Setup
// ============================================================================

/**
 * Create the JS interpreter with all standard operators.
 * Uses the same interpreter setup as query/executors/memory.ts.
 */
const interpret = ucastCreateJsInterpreter(allInterpreters)

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a matcher function from a MongoDB-style match expression.
 *
 * The returned function evaluates PropertyMetadata objects against
 * the match expression, returning true if the metadata matches.
 *
 * Parsed AST is cached per expression object (via WeakMap) for performance.
 *
 * @param matchExpression - MongoDB-style query object
 * @returns Matcher function (meta: PropertyMetadata) => boolean
 *
 * @example
 * ```typescript
 * // Simple field matching
 * const typeMatcher = createMatcherFromExpression({ type: 'string' })
 * typeMatcher({ name: 'title', type: 'string' }) // true
 *
 * // $exists for optional fields
 * const enumMatcher = createMatcherFromExpression({ enum: { $exists: true } })
 * enumMatcher({ name: 'status', enum: ['a', 'b'] }) // true
 *
 * // $and/$or logical operators
 * const complexMatcher = createMatcherFromExpression({
 *   $or: [
 *     { format: 'email' },
 *     { format: 'uri' }
 *   ]
 * })
 * ```
 */
export function createMatcherFromExpression(
  matchExpression: MatchExpression
): PropertyMatcher {
  // Check cache first (using object identity)
  let ast = astCache.get(matchExpression)

  if (!ast) {
    // Parse the expression into a ucast AST
    ast = parseQuery(matchExpression)
    // Cache for future calls with the same expression object
    astCache.set(matchExpression, ast)
  }

  // Return a matcher function that interprets the AST against metadata
  return (meta: PropertyMetadata): boolean => {
    return interpret(ast!, meta)
  }
}

/**
 * Re-export createJsInterpreter from @ucast/js for custom interpreter creation.
 *
 * This allows consumers to create custom interpreters with additional operators
 * or different interpretation behavior.
 *
 * @example
 * ```typescript
 * import { createJsInterpreter } from './match-expression'
 * import { allInterpreters } from '@ucast/js'
 *
 * // Create custom interpreter with additional operators
 * const customInterpreter = createJsInterpreter({
 *   ...allInterpreters,
 *   myCustomOp: (condition, object, { get }) => {
 *     // custom logic
 *     return true
 *   }
 * })
 * ```
 */
export { ucastCreateJsInterpreter as createJsInterpreter }
