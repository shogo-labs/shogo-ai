/**
 * Schema-aware default value generation for dynamic entity creation
 *
 * Uses meta-store Property metadata to generate type-appropriate defaults
 * so that MST validation passes for dynamically generated schemas.
 */

import { v4 as uuid } from 'uuid'

/**
 * Generate default values for an entity based on model metadata
 *
 * @param model - Model entity from meta-store with properties view
 * @returns Object with default values for all non-computed properties
 */
export function createEntityDefaults(model: any): Record<string, any> {
  const defaults: Record<string, any> = {
    id: uuid()
  }

  const properties = model.properties || []

  for (const prop of properties) {
    // Skip computed fields (derived values)
    if (prop.xComputed) continue

    // Skip id (we handle it separately with uuid)
    if (prop.name === 'id') continue

    // Generate default based on property metadata
    defaults[prop.name] = getDefaultForProperty(prop)
  }

  return defaults
}

/**
 * Get default value for a property based on its type, format, enum, etc.
 */
function getDefaultForProperty(prop: any): any {
  // Constant value takes precedence
  if (prop.const !== undefined) {
    return prop.const
  }

  // Enum: use first value
  if (prop.enum && prop.enum.length > 0) {
    return prop.enum[0]
  }

  // Type-based defaults
  switch (prop.type) {
    case 'string':
      return getStringDefault(prop)
    case 'number':
    case 'integer':
      return prop.minimum ?? 0
    case 'boolean':
      return false
    case 'array':
      return []
    case 'object':
      return {}
    default:
      // Fallback for unknown types
      return ''
  }
}

/**
 * Get default value for string properties based on format
 */
function getStringDefault(prop: any): string {
  // Format-specific defaults
  switch (prop.format) {
    case 'uuid':
      return uuid()
    case 'date-time':
      return new Date().toISOString()
    case 'date':
      return new Date().toISOString().split('T')[0]
    case 'time':
      return new Date().toISOString().split('T')[1].split('.')[0]
    case 'email':
      return 'user@example.com'
    case 'uri':
    case 'url':
      return 'https://example.com'
    default:
      // Use property name as hint for placeholder
      return getStringPlaceholder(prop.name)
  }
}

/**
 * Generate a sensible placeholder based on property name
 */
function getStringPlaceholder(name: string): string {
  const lowerName = name.toLowerCase()

  // Common field name patterns
  if (lowerName === 'name' || lowerName === 'title') {
    return 'New item'
  }
  if (lowerName.includes('name')) {
    return `New ${name.replace(/name/i, '').trim() || 'item'}`
  }
  if (lowerName === 'description') {
    return ''
  }
  if (lowerName === 'version') {
    return '1.0.0'
  }
  if (lowerName.includes('url') || lowerName.includes('link')) {
    return 'https://example.com'
  }
  if (lowerName.includes('email')) {
    return 'user@example.com'
  }

  // Default: empty string
  return ''
}
