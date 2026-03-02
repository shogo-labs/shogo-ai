/**
 * Smart defaults for dynamic app component definitions.
 *
 * Applies deterministic enhancements to component definitions before rendering:
 * - Root Column gets gap "lg" if not specified
 * - DataList/Table direct children of root Column auto-wrap in Card
 * - Auto-inject Separators between form and data sections
 * - Badge outline → secondary (outline is indistinguishable from text inputs)
 * - Grid label-value Columns get tight gap for visual cohesion
 *
 * These ensure canvases look polished regardless of agent output.
 */

import type { ComponentDefinition } from '@shogo/shared-app/dynamic-app'

export interface SmartDefaultsContext {
  isRoot: boolean
  parentComponent?: string
  components: Map<string, ComponentDefinition>
}

const NEEDS_CARD_WRAP = new Set(['DataList', 'Table'])

/**
 * Apply smart defaults to a component definition before rendering.
 * Returns a new definition (never mutates the original).
 */
export function applySmartDefaults(
  definition: ComponentDefinition,
  ctx: SmartDefaultsContext,
): ComponentDefinition {
  let def = definition

  // Root Column: default to gap "lg" for breathing room between sections
  if (ctx.isRoot && def.component === 'Column' && !def.gap) {
    def = { ...def, gap: 'lg' }
  }

  // Root Column: auto-wrap naked DataList/Table children in Cards and inject Separators
  if (ctx.isRoot && def.component === 'Column' && Array.isArray(def.children)) {
    def = enhanceRootChildren(def, ctx)
  }

  // Badge: outline variant is visually identical to text inputs — normalize to secondary
  if (def.component === 'Badge' && def.variant === 'outline') {
    def = { ...def, variant: 'secondary' }
  }

  // Grid: ensure label-value Columns have tight gap
  if (def.component === 'Grid' && Array.isArray(def.children)) {
    normalizeGridLabelValueGaps(def, ctx)
  }

  return def
}

/**
 * Analyze root Column children and enhance them:
 * 1. Auto-wrap DataList/Table in Card if not already in one
 * 2. Auto-inject Separator between interactive and data sections
 */
function enhanceRootChildren(
  def: ComponentDefinition,
  ctx: SmartDefaultsContext,
): ComponentDefinition {
  const childIds = def.children as string[]
  const newChildren: string[] = []
  let hasInteractiveSection = false
  let hasDataSection = false
  let needsSeparator = false

  for (const childId of childIds) {
    const childDef = ctx.components.get(childId)
    if (!childDef) {
      newChildren.push(childId)
      continue
    }

    // Track section types for auto-separator
    if (isInteractiveComponent(childDef, ctx.components)) {
      hasInteractiveSection = true
    }
    if (isDataDisplayComponent(childDef, ctx.components)) {
      if (hasInteractiveSection && !hasDataSection) {
        needsSeparator = true
      }
      hasDataSection = true
    }

    // Auto-inject separator between interactive and data sections
    if (needsSeparator && childDef.component !== 'Separator') {
      if (!childIds.includes('_auto_sep') && !ctx.components.has('_auto_sep')) {
        ctx.components.set('_auto_sep', {
          id: '_auto_sep',
          component: 'Separator',
        })
        newChildren.push('_auto_sep')
      }
      needsSeparator = false
    }

    // Auto-wrap naked DataList/Table in Card
    if (NEEDS_CARD_WRAP.has(childDef.component)) {
      const wrapperId = `_auto_card_${childId}`
      if (!ctx.components.has(wrapperId)) {
        ctx.components.set(wrapperId, {
          id: wrapperId,
          component: 'Card',
          child: childId,
        })
      }
      newChildren.push(wrapperId)
    } else {
      newChildren.push(childId)
    }
  }

  if (arraysEqual(childIds, newChildren)) return def
  return { ...def, children: newChildren }
}

/**
 * Detect label-value Column pairs inside Grids and default tight gap
 * so caption labels sit close to their values.
 */
function normalizeGridLabelValueGaps(
  def: ComponentDefinition,
  ctx: SmartDefaultsContext,
): void {
  const childIds = def.children as string[]

  for (const childId of childIds) {
    const child = ctx.components.get(childId)
    if (!child || child.component !== 'Column') continue
    if (!Array.isArray(child.children) || child.children.length < 2) continue
    if (child.gap) continue

    const [labelId] = child.children as string[]
    const label = ctx.components.get(labelId)
    if (!label) continue

    const isLabelValue = label.component === 'Text' &&
      (label.variant === 'caption' || label.variant === 'muted' || label.color === 'muted')

    if (isLabelValue) {
      ctx.components.set(childId, { ...child, gap: 'xs' })
    }
  }
}

function isInteractiveComponent(def: ComponentDefinition, components: Map<string, ComponentDefinition>): boolean {
  if (['Button', 'TextField', 'Select', 'Checkbox'].includes(def.component)) return true
  if (def.component === 'Card' && def.child) {
    const child = components.get(def.child)
    if (child) return isInteractiveComponent(child, components)
  }
  if (def.component === 'Card' && Array.isArray(def.children)) {
    return (def.children as string[]).some(id => {
      const child = components.get(id)
      return child ? isInteractiveComponent(child, components) : false
    })
  }
  if (['Row', 'Column'].includes(def.component) && Array.isArray(def.children)) {
    return (def.children as string[]).some(id => {
      const child = components.get(id)
      return child ? isInteractiveComponent(child, components) : false
    })
  }
  return false
}

function isDataDisplayComponent(def: ComponentDefinition, components: Map<string, ComponentDefinition>): boolean {
  if (['DataList', 'Table', 'Chart'].includes(def.component)) return true
  if (def.component === 'Card' && def.child) {
    const child = components.get(def.child)
    if (child) return isDataDisplayComponent(child, components)
  }
  return false
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}
