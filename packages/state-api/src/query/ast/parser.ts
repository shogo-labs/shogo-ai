/**
 * Query AST Parser Implementation
 *
 * This module provides parser functionality for converting MongoDB-style
 * filter objects into @ucast Condition AST nodes.
 *
 * @module query/ast/parser
 *
 * Requirements:
 * - AST-01: All comparison operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $regex, $contains)
 * - AST-02: Logical operators ($and, $or, $not) with arbitrary nesting
 * - AST-05: Extensible for future operators
 *
 * Design decisions:
 * - Uses MongoQueryParser from @ucast/mongo for standard operator support
 * - createQueryParser factory accepts custom operator configuration
 * - defaultParser instance includes $contains custom operator
 * - parseQuery convenience function uses defaultParser
 * - All parsing errors throw descriptive error messages
 *
 * @example
 * ```typescript
 * import { parseQuery } from './parser'
 *
 * // Simple equality
 * const ast1 = parseQuery({ status: 'active' })
 *
 * // Comparison operator
 * const ast2 = parseQuery({ age: { $gt: 18 } })
 *
 * // Custom $contains operator
 * const ast3 = parseQuery({ tags: { $contains: 'urgent' } })
 *
 * // Logical operators
 * const ast4 = parseQuery({
 *   $and: [
 *     { category: 'electronics' },
 *     { $or: [{ price: { $lt: 100 } }, { onSale: true }] }
 *   ]
 * })
 * ```
 */

import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
import { Condition, FieldCondition, CompoundCondition } from '@ucast/core'
import type { QueryFilter, SubqueryCondition, SubqueryExpression } from './types'
import { isSubqueryExpression } from './types'
import { getCustomParsingInstructions } from './operators'

/**
 * Options for creating a custom query parser.
 */
export interface CreateQueryParserOptions {
  /**
   * Additional custom operator instructions to merge with standard operators.
   * Keys should be operator names with $ prefix (e.g., '$myOp').
   */
  operators?: Record<string, { type: 'field' | 'document' | 'compound' }>
}

/**
 * Create a query parser with custom operator support.
 *
 * Combines standard MongoDB operators from @ucast/mongo with custom operators.
 * Returns a MongoQueryParser instance that can parse queries into AST.
 *
 * @param options - Configuration options including custom operators
 * @returns MongoQueryParser instance
 *
 * @example
 * ```typescript
 * import { createQueryParser } from './parser'
 *
 * // Create parser with custom operator
 * const parser = createQueryParser({
 *   operators: {
 *     $myCustomOp: { type: 'field' }
 *   }
 * })
 *
 * // Use the parser
 * const ast = parser.parse({ field: { $myCustomOp: 'value' } })
 * ```
 */
export function createQueryParser(options: CreateQueryParserOptions = {}): MongoQueryParser {
  // Merge standard operators, default custom operators, and user-provided operators
  const instructions = {
    ...allParsingInstructions,
    ...getCustomParsingInstructions(),
    ...(options.operators || {})
  }

  return new MongoQueryParser(instructions)
}

/**
 * Default parser instance with standard operators and $contains custom operator.
 *
 * This is a pre-configured parser that includes:
 * - All standard MongoDB operators ($eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $regex, etc.)
 * - Logical operators ($and, $or, $not)
 * - Custom $contains operator for string/array containment
 *
 * @example
 * ```typescript
 * import { defaultParser } from './parser'
 *
 * const ast = defaultParser.parse({ name: { $contains: 'test' } })
 * ```
 */
export const defaultParser = createQueryParser()

/**
 * Parse a MongoDB-style query filter into a Condition AST.
 *
 * This is a convenience function that uses the defaultParser instance.
 * Throws descriptive errors if the query is invalid.
 *
 * Supports subquery expressions in $in/$nin operators:
 * ```typescript
 * { authorId: { $in: { $query: { model: 'User', filter: { role: 'admin' } } } } }
 * ```
 *
 * @param filter - MongoDB-style query filter object
 * @returns Condition AST (FieldCondition, CompoundCondition, or SubqueryCondition)
 * @throws {Error} If query is invalid or uses unknown operators
 *
 * @example
 * ```typescript
 * import { parseQuery } from './parser'
 *
 * // Simple equality
 * const ast1 = parseQuery({ status: 'active' })
 *
 * // Comparison
 * const ast2 = parseQuery({ age: { $gt: 18 } })
 *
 * // Subquery (filter posts by admin authors)
 * const ast3 = parseQuery({
 *   authorId: { $in: { $query: { model: 'User', filter: { role: 'admin' } } } }
 * })
 *
 * // Logical operators
 * const ast4 = parseQuery({
 *   $or: [
 *     { role: 'admin' },
 *     { price: { $lt: 100 } }
 *   ]
 * })
 * ```
 */
export function parseQuery(filter: QueryFilter): Condition | SubqueryCondition {
  try {
    return parseFilterWithSubqueries(filter)
  } catch (error: any) {
    // Enhance error message with more context
    if (error.message) {
      // Re-throw with enhanced message
      throw new Error(
        `Query parsing failed: ${error.message}. ` +
        `Filter: ${JSON.stringify(filter, null, 2)}`
      )
    }
    throw error
  }
}

// ============================================================================
// Subquery Parsing Support
// ============================================================================

/**
 * Parse a filter, handling subquery expressions in $in/$nin operators.
 */
function parseFilterWithSubqueries(filter: QueryFilter): Condition | SubqueryCondition {
  // Handle logical operators ($and, $or, $not)
  // Note: CompoundCondition expects Condition[], but we allow SubqueryCondition children.
  // The cast is safe because our backends handle both types at runtime.
  if ('$and' in filter && Array.isArray((filter as any).$and)) {
    const children = (filter as any).$and.map((child: QueryFilter) =>
      parseFilterWithSubqueries(child)
    )
    return new CompoundCondition('and', children as Condition[])
  }

  if ('$or' in filter && Array.isArray((filter as any).$or)) {
    const children = (filter as any).$or.map((child: QueryFilter) =>
      parseFilterWithSubqueries(child)
    )
    return new CompoundCondition('or', children as Condition[])
  }

  if ('$not' in filter) {
    const child = parseFilterWithSubqueries((filter as any).$not)
    return new CompoundCondition('not', [child] as Condition[])
  }

  // Handle field conditions
  const keys = Object.keys(filter)
  if (keys.length === 0) {
    // Empty filter - return a condition that matches everything
    return defaultParser.parse({})
  }

  if (keys.length === 1) {
    const field = keys[0]
    const value = (filter as any)[field]

    // Check for subquery in $in or $nin
    const subqueryResult = tryParseSubqueryField(field, value)
    if (subqueryResult) {
      return subqueryResult
    }

    // Standard field condition - delegate to @ucast/mongo
    return defaultParser.parse(filter)
  }

  // Multiple fields - wrap in implicit $and
  const children = keys.map((field) => {
    const value = (filter as any)[field]

    // Check for subquery
    const subqueryResult = tryParseSubqueryField(field, value)
    if (subqueryResult) {
      return subqueryResult
    }

    // Standard field condition
    return defaultParser.parse({ [field]: value })
  })

  return new CompoundCondition('and', children as Condition[])
}

/**
 * Try to parse a field condition as a subquery.
 * Returns SubqueryCondition if the value contains $in/$nin with $query,
 * otherwise returns undefined.
 */
function tryParseSubqueryField(
  field: string,
  value: unknown
): SubqueryCondition | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  // Check for $in with subquery
  if ('$in' in value && isSubqueryExpression((value as any).$in)) {
    return createSubqueryCondition(field, 'in', (value as any).$in)
  }

  // Check for $nin with subquery
  if ('$nin' in value && isSubqueryExpression((value as any).$nin)) {
    return createSubqueryCondition(field, 'nin', (value as any).$nin)
  }

  return undefined
}

/**
 * Create a SubqueryCondition from a SubqueryExpression.
 */
function createSubqueryCondition(
  field: string,
  operator: 'in' | 'nin',
  expr: SubqueryExpression
): SubqueryCondition {
  const { schema, model, filter, field: selectField } = expr.$query

  // Validate model name
  if (!model || typeof model !== 'string' || model.trim() === '') {
    throw new Error(`Subquery $query must have a non-empty 'model' property`)
  }

  // Recursively parse the inner filter if present
  let parsedFilter: Condition | SubqueryCondition | undefined
  if (filter) {
    parsedFilter = parseFilterWithSubqueries(filter)
  }

  return {
    type: 'subquery',
    field,
    operator,
    subquery: {
      schema,
      model,
      filter: parsedFilter,
      selectField: selectField ?? 'id'
    }
  }
}
