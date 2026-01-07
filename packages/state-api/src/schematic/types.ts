/**
 * Shared type definitions for schematic layer
 *
 * Contains all shared types used across the schematic module:
 * - EnhancedJsonSchema - JSON Schema with x-* extensions
 * - MSTConversionOptions - Options for schema-to-MST conversion
 * - MSTConversionResult - Result of schema-to-MST conversion
 *
 * Separated to avoid circular dependencies between:
 * - enhanced-json-schema-to-mst.ts
 * - helpers-model-builder.ts
 * - helpers-store.ts
 * - helpers-type-resolution.ts
 */

import type { Scope } from 'arktype'
import type { IAnyModelType } from 'mobx-state-tree'

export interface EnhancedJsonSchemaOptions {
  /** The arkType scope for resolving references */
  scope?: Scope<any>;
  /** Internal: scope aliases for reference detection */
  scopeAliases?: Record<string, any>;
  /** Whether to detect and mark computed arrays */
  detectComputedArrays?: boolean;
}

export interface EnhancedJsonSchema {
  $schema?: string;
  $ref?: string;
  $defs?: Record<string, any>;
  type?: string;
  properties?: Record<string, any>;
  required?: string[];
  items?: any;
  anyOf?: any[];
  const?: any;
  pattern?: string;
  format?: string;
  description?: string;
  minLength?: number;
  minimum?: number;
  // Enhanced properties
  "x-arktype"?: string;
  "x-reference-type"?: "single" | "array";
  "x-reference-target"?: string;
  "x-computed"?: boolean;
  "x-inverse"?: string;
  "x-original-name"?: string;
  "x-mst-type"?: "identifier" | "reference" | "maybe-reference";
  "x-persistence"?: Record<string, any>;
  "x-domain"?: string;
  "x-renderer"?: string;
}

// ============================================================================
// MST Conversion Types
// ============================================================================

/**
 * Options for converting Enhanced JSON Schema to MST models.
 */
export interface MSTConversionOptions {
  /** Generate setter actions for each property */
  generateActions?: boolean
  /** Validate references exist when setting */
  validateReferences?: boolean
  /** ArkType scope for runtime validation */
  arkTypeScope?: any
  /** Hook to enhance entity models before store creation */
  enhanceModels?: (models: Record<string, IAnyModelType>) => Record<string, IAnyModelType>
  /** Hook to enhance collection models (e.g., compose with CollectionPersistable) */
  enhanceCollections?: (collections: Record<string, IAnyModelType>) => Record<string, IAnyModelType>
  /** Hook to enhance the root store model */
  enhanceRootStore?: (RootStoreModel: IAnyModelType) => IAnyModelType
}

/**
 * Result of converting Enhanced JSON Schema to MST.
 */
export interface MSTConversionResult {
  /** Entity models keyed by name */
  models: Record<string, IAnyModelType>
  /** Collection models keyed by name (e.g., "UserCollection") */
  collectionModels: Record<string, IAnyModelType>
  /** Root store model (optional, may not exist for domain-only conversions) */
  RootStoreModel?: IAnyModelType
  /** Factory function to create store instances */
  createStore: (environment?: any) => any
  /** Domain-specific results for multi-domain schemas */
  domains?: Record<string, MSTConversionResult>
}
