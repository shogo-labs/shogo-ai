// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared child resolution for dynamic app components.
 *
 * Determines which children a component has (single, array, or template-based)
 * and returns descriptors that platform-specific renderers can use.
 */

import { getByPointer } from './pointer'
import type { ComponentDefinition } from './types'

export type ChildDescriptor =
  | { kind: 'single'; childId: string; definition: ComponentDefinition }
  | { kind: 'static'; childId: string; definition: ComponentDefinition }
  | { kind: 'template'; index: number; definition: ComponentDefinition; scopeData: Record<string, unknown>; scopePath: string }

/**
 * Resolve the children of a component definition into descriptors.
 * Returns an array of child descriptors that renderers can iterate over.
 */
export function resolveChildDescriptors(
  definition: ComponentDefinition,
  components: Map<string, ComponentDefinition>,
  dataModel: Record<string, unknown>,
): ChildDescriptor[] {
  if (definition.child) {
    const childDef = components.get(definition.child)
    if (childDef) {
      return [{ kind: 'single', childId: definition.child, definition: childDef }]
    }
  }

  if (definition.children) {
    if (typeof definition.children === 'object' && !Array.isArray(definition.children)) {
      const tmpl = definition.children as { path: string; templateId: string }
      const items = getByPointer(dataModel, tmpl.path)
      if (!Array.isArray(items)) return []

      const templateDef = components.get(tmpl.templateId)
      if (!templateDef) return []

      return items.map((item, index) => ({
        kind: 'template' as const,
        index,
        definition: templateDef,
        scopeData: typeof item === 'object' && item !== null
          ? item as Record<string, unknown>
          : { value: item },
        scopePath: `${tmpl.path}/${index}`,
      }))
    }

    const childIds = definition.children as string[]
    const result: ChildDescriptor[] = []
    for (const childId of childIds) {
      const childDef = components.get(childId)
      if (childDef) {
        result.push({ kind: 'static', childId, definition: childDef })
      }
    }
    return result
  }

  return []
}
