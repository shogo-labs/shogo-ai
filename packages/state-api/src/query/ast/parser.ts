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
import type { Condition } from '@ucast/core'
import type { QueryFilter } from './types'
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
 * @param filter - MongoDB-style query filter object
 * @returns Condition AST (FieldCondition or CompoundCondition)
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
 * // Logical operators
 * const ast3 = parseQuery({
 *   $or: [
 *     { role: 'admin' },
 *     { price: { $lt: 100 } }
 *   ]
 * })
 * ```
 */
export function parseQuery(filter: QueryFilter): Condition {
  try {
    return defaultParser.parse(filter)
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
