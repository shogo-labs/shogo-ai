/**
 * Meta-Registry: ArkType scope defining the meta-schema
 *
 * This defines the structure for storing schema metadata as MST entities.
 * Following the "view over state" pattern: store as structured MST state,
 * view as JSON Schema.
 *
 * Design decisions:
 * - Single recursive Property entity (mirrors JSON Schema structure)
 * - Flat nesting via parentProperty references (avoids MST self-reference issues)
 * - Inline x-* extensions as camelCase fields (known extensions only)
 * - Serializable state only (no validation caching)
 */

import { scope } from "arktype"

export const MetaRegistry = scope({
  ViewDefinition: {
    id: "string.uuid",
    schema: "Schema",  // Reference to parent Schema
    name: "string",    // View name (unique within schema)
    type: "'query' | 'template'",

    // Query view properties
    "collection?": "string",
    "filter?": "object",  // Record<string, any> - simple equality filters (stored as frozen)
    "select?": "string[]",  // Optional field projection

    // Template view properties
    "dataSource?": "string",  // Reference to another view name
    "template?": "string",     // Template filename (e.g., "report.njk")
  },

  Schema: {
    id: "string.uuid",
    name: "string",
    format: "'enhanced-json-schema'",
    createdAt: "number",
    // Content checksum for detecting schema changes (used by ingestEnhancedJsonSchema)
    "contentChecksum?": "string",
    // Schema-level persistence configuration (x-persistence extension)
    // Cascades to models that don't have their own x-persistence
    "xPersistence?": {
      "backend?": "string",  // Backend identifier for query execution
      "strategy?": "'flat' | 'entity-per-file' | 'array-per-partition'",
      "bootstrap?": "boolean",  // If true, DDL auto-runs during BackendRegistry.initialize()
    },
  },

  Model: {
    id: "string.uuid",
    schema: "Schema",  // Reference to Schema, not UUID string
    name: "string",
    "domain?": "string",
    "description?": "string",
    // Persistence configuration (x-persistence extension)
    "xPersistence?": {
      strategy: "'flat' | 'entity-per-file' | 'array-per-partition'",
      "partitionKey?": "string",
      "displayKey?": "string",
      "nested?": "boolean",  // Store children under parent folder
      "backend?": "string",  // Backend identifier for query execution
    },
  },

  Property: {
    id: "string.uuid",
    model: "Model",  // Reference to parent Model
    name: "string",

    // For nested properties (object types, array items, composition)
    "parentProperty?": "string.uuid",  // UUID reference to parent Property (MST reference added via enhancement)
    "nestingType?": "'properties' | 'items' | 'oneOf' | 'anyOf' | 'allOf'",  // How this is nested

    // Core JSON Schema properties
    "type?": "string",
    "format?": "string",
    "title?": "string",
    "description?": "string",

    // Constraints
    "minLength?": "number",
    "maxLength?": "number",
    "minimum?": "number",
    "maximum?": "number",
    "pattern?": "string",
    "enum?": "string[]",
    "const?": "unknown",
    "default?": "unknown",  // JSON Schema default value (any type)

    // References
    "$ref?": "string",

    // Enhanced metadata (known x-* as camelCase fields)
    "xReferenceType?": "'single' | 'array'",
    "xReferenceTarget?": "string",
    "xComputed?": "boolean",
    "xInverse?": "string",
    "xArktype?": "string",
    "xMstType?": "string",
    "xOriginalName?": "string",
    "xRenderer?": "string",

    // Required tracking
    "required?": "boolean",
  }
})
