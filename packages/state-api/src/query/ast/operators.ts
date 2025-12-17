/**
 * Custom Operator Definitions for Query AST
 *
 * This module provides custom parsing instructions for MongoDB-style operators
 * that are not part of the standard @ucast/mongo instruction set.
 *
 * @module query/ast/operators
 *
 * Requirements:
 * - AST-05: Extensible for future operators
 * - REQ-02: MongoDB-style operators including custom $contains
 *
 * Design decisions:
 * - containsInstruction defines $contains as field-type operator
 * - Runtime registry allows adding operators without code changes
 * - getCustomParsingInstructions() returns all registered custom operators
 * - registerCustomOperator() enables runtime extensibility
 *
 * @example
 * ```typescript
 * import { getCustomParsingInstructions } from './operators'
 * import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
 *
 * const parser = new MongoQueryParser({
 *   ...allParsingInstructions,
 *   ...getCustomParsingInstructions()
 * })
 * ```
 */

/**
 * Parsing instruction type from @ucast/mongo.
 * Defines how an operator should be parsed.
 */
type ParsingInstruction = {
  /**
   * Instruction type:
   * - 'field': Operator acts on a field (e.g., $contains, $eq)
   * - 'document': Operator acts on the whole document (e.g., $where)
   * - 'compound': Operator combines conditions (e.g., $and, $or)
   */
  type: 'field' | 'document' | 'compound'
}

/**
 * Custom parsing instruction for $contains operator.
 *
 * The $contains operator checks if:
 * - A string contains a substring
 * - An array contains an element
 *
 * @example
 * ```typescript
 * // String containment
 * { name: { $contains: 'test' } }
 * // -> matches if name includes 'test'
 *
 * // Array containment
 * { tags: { $contains: 'urgent' } }
 * // -> matches if 'urgent' is in tags array
 * ```
 */
export const containsInstruction: ParsingInstruction = {
  type: 'field'
}

/**
 * Runtime registry of custom parsing instructions.
 * Initialized with built-in custom operators like $contains.
 */
const customOperatorRegistry: Record<string, ParsingInstruction> = {
  $contains: containsInstruction
}

/**
 * Get all registered custom parsing instructions.
 *
 * Returns an object mapping operator names (with $ prefix) to their
 * parsing instructions. This can be spread into MongoQueryParser config.
 *
 * @returns Object mapping operator names to parsing instructions
 *
 * @example
 * ```typescript
 * import { getCustomParsingInstructions } from './operators'
 * import { MongoQueryParser, allParsingInstructions } from '@ucast/mongo'
 *
 * const instructions = {
 *   ...allParsingInstructions,
 *   ...getCustomParsingInstructions()
 * }
 * const parser = new MongoQueryParser(instructions)
 * ```
 */
export function getCustomParsingInstructions(): Record<string, ParsingInstruction> {
  // Return a shallow copy to prevent external mutation
  return { ...customOperatorRegistry }
}

/**
 * Register a custom operator at runtime.
 *
 * Allows extending the query system with new operators without modifying code.
 * Registered operators are returned by getCustomParsingInstructions().
 *
 * @param operatorName - Operator name with $ prefix (e.g., '$myCustomOp')
 * @param instruction - Parsing instruction defining operator behavior
 *
 * @throws {Error} If operatorName doesn't start with $
 *
 * @example
 * ```typescript
 * import { registerCustomOperator } from './operators'
 *
 * // Register a custom $startsWith operator
 * registerCustomOperator('$startsWith', {
 *   type: 'field'
 * })
 *
 * // Now it's available in getCustomParsingInstructions()
 * ```
 */
export function registerCustomOperator(
  operatorName: string,
  instruction: ParsingInstruction
): void {
  // Validate operator name format
  if (!operatorName.startsWith('$')) {
    throw new Error(
      `Invalid operator name '${operatorName}': custom operators must start with '$'`
    )
  }

  // Add to registry
  customOperatorRegistry[operatorName] = instruction
}
