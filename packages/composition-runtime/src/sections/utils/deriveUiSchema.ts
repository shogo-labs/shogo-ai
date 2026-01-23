/**
 * deriveUiSchema - Utility to derive JSON Forms UI Schema from PropertyMetadata
 *
 * Maps x-* extensions from Enhanced JSON Schema to JSON Forms UI Schema elements:
 * - x-renderer -> control type hint
 * - x-rendererConfig -> control options
 * - x-referenceType -> EntityPicker for references
 * - format -> appropriate input type (date, email, uri, etc.)
 * - type -> default control type
 */

import type { UISchemaElement, ControlElement, Layout, VerticalLayout, HorizontalLayout, GroupLayout } from "@jsonforms/core"

// ============================================================================
// Types
// ============================================================================

export interface DeriveUiSchemaOptions {
  /** Properties to include (if empty, includes all) */
  fields?: string[]
  /** Layout type: vertical (default), horizontal, or grouped */
  layout?: "vertical" | "horizontal" | "grouped"
  /** Group configuration for 'grouped' layout */
  groups?: Array<{
    label: string
    fields: string[]
  }>
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Determine the control type hint based on property metadata
 */
function getControlType(property: any): string | undefined {
  // Explicit renderer hint takes priority
  if (property.xRenderer) {
    return property.xRenderer
  }

  // Reference fields use EntityPicker
  if (property.xReferenceType === "single" || property.xReferenceType === "array") {
    return "entity-picker"
  }

  // Map format to control type
  if (property.format) {
    switch (property.format) {
      case "date":
      case "date-time":
        return "date"
      case "email":
        return "email"
      case "uri":
      case "url":
        return "url"
      case "textarea":
        return "textarea"
    }
  }

  // Map type to control type
  if (property.type === "boolean") {
    return "toggle"
  }

  // Enum fields use select
  if (property.enum && property.enum.length > 0) {
    return "select"
  }

  // Default based on type
  switch (property.type) {
    case "number":
    case "integer":
      return "number"
    case "string":
      return "text"
    case "array":
      return "array"
    case "object":
      return "object"
    default:
      return undefined
  }
}

/**
 * Build control options from property metadata
 */
function getControlOptions(property: any): Record<string, any> | undefined {
  const options: Record<string, any> = {}

  // Apply x-rendererConfig if present
  if (property.xRendererConfig) {
    Object.assign(options, property.xRendererConfig)
  }

  // Add control type hint
  const controlType = getControlType(property)
  if (controlType) {
    options.controlType = controlType
  }

  // Add reference target for entity picker
  if (property.xReferenceTarget) {
    options.referenceTarget = property.xReferenceTarget
  }

  // Add reference type
  if (property.xReferenceType) {
    options.referenceType = property.xReferenceType
  }

  // Add enum values
  if (property.enum && property.enum.length > 0) {
    options.enumValues = property.enum
  }

  // Add constraints
  if (property.minLength !== undefined) options.minLength = property.minLength
  if (property.maxLength !== undefined) options.maxLength = property.maxLength
  if (property.minimum !== undefined) options.minimum = property.minimum
  if (property.maximum !== undefined) options.maximum = property.maximum
  if (property.pattern !== undefined) options.pattern = property.pattern

  // Return undefined if no options
  return Object.keys(options).length > 0 ? options : undefined
}

/**
 * Create a control element for a property
 */
function createControl(property: any): ControlElement {
  const control: ControlElement = {
    type: "Control",
    scope: `#/properties/${property.name}`,
  }

  // Add label (use title or humanize name)
  const label = property.title || humanizePropertyName(property.name)
  if (label) {
    control.label = label
  }

  // Add options
  const options = getControlOptions(property)
  if (options) {
    control.options = options
  }

  return control
}

/**
 * Humanize a property name (camelCase -> Title Case)
 */
function humanizePropertyName(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Derive a JSON Forms UI Schema from PropertyMetadata array.
 *
 * Maps x-* extensions to JSON Forms control options:
 * - x-renderer: controlType hint for custom renderers
 * - x-referenceType: single/array for EntityPicker
 * - x-referenceTarget: target model for EntityPicker
 * - format: date, email, uri -> appropriate input types
 * - enum: select dropdown
 * - type: boolean -> toggle, number -> number input
 *
 * @param properties - Array of PropertyMetadata from meta-store model.properties
 * @param options - Configuration for field filtering and layout
 * @returns JSON Forms UI Schema
 *
 * @example
 * ```tsx
 * const { properties } = useFormMetadata("platform-features", "Requirement")
 * const uiSchema = deriveUiSchema(properties, {
 *   fields: ["name", "description", "priority"],
 *   layout: "vertical"
 * })
 * ```
 */
export function deriveUiSchema(
  properties: any[],
  options: DeriveUiSchemaOptions = {}
): UISchemaElement {
  const { fields = [], layout = "vertical", groups } = options

  // Filter properties if fields specified
  let filteredProperties = properties
  if (fields.length > 0) {
    // Maintain field order as specified
    const fieldSet = new Set(fields)
    filteredProperties = fields
      .map((fieldName) => properties.find((p) => p.name === fieldName))
      .filter((p): p is any => p !== undefined)
  }

  // Filter out computed properties (they shouldn't be in forms)
  filteredProperties = filteredProperties.filter((p) => !p.xComputed)

  // Create controls for each property
  const controls = filteredProperties.map(createControl)

  // Build layout based on option
  switch (layout) {
    case "horizontal":
      return {
        type: "HorizontalLayout",
        elements: controls,
      } as HorizontalLayout

    case "grouped":
      if (groups && groups.length > 0) {
        // Build groups with their controls
        const groupElements = groups.map((group) => {
          const groupControls = group.fields
            .map((fieldName) => {
              const property = properties.find((p) => p.name === fieldName)
              return property ? createControl(property) : null
            })
            .filter((c): c is ControlElement => c !== null)

          return {
            type: "Group",
            label: group.label,
            elements: groupControls,
          } as GroupLayout
        })

        return {
          type: "VerticalLayout",
          elements: groupElements,
        } as VerticalLayout
      }
      // Fall through to vertical if no groups defined
      return {
        type: "VerticalLayout",
        elements: controls,
      } as VerticalLayout

    case "vertical":
    default:
      return {
        type: "VerticalLayout",
        elements: controls,
      } as VerticalLayout
  }
}

/**
 * Filter properties for form display.
 *
 * Excludes:
 * - Computed properties (x-computed: true)
 * - ID field (typically auto-generated)
 * - Timestamp fields (createdAt, updatedAt)
 *
 * @param properties - All properties from model
 * @param excludeId - Whether to exclude the 'id' field (default true)
 * @param excludeTimestamps - Whether to exclude timestamp fields (default true)
 * @returns Filtered properties suitable for form input
 */
export function filterFormProperties(
  properties: any[],
  excludeId = true,
  excludeTimestamps = true
): any[] {
  return properties.filter((p) => {
    // Exclude computed properties
    if (p.xComputed) return false

    // Exclude ID if requested
    if (excludeId && p.name === "id") return false

    // Exclude timestamps if requested
    if (excludeTimestamps && (p.name === "createdAt" || p.name === "updatedAt")) {
      return false
    }

    return true
  })
}
