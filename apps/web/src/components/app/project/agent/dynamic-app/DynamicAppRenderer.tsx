/**
 * DynamicAppRenderer
 *
 * Core rendering engine for the Dynamic App canvas. Takes a surface's
 * component map and data model, then recursively renders from the "root"
 * component, resolving data bindings and dispatching user actions.
 */

import { useMemo, useCallback, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { SurfaceState, ComponentDefinition } from './types'
import { isDynamicPath } from './types'
import { getByPointer } from './use-dynamic-app-stream'
import { COMPONENT_CATALOG } from './catalog'

interface RendererProps {
  surface: SurfaceState
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
}

export function DynamicAppRenderer({ surface, onAction }: RendererProps) {
  const handleAction = useCallback(
    (name: string, context?: Record<string, unknown>) => {
      onAction(surface.surfaceId, name, context)
    },
    [surface.surfaceId, onAction],
  )

  const rootComponent = surface.components.get('root')
  if (!rootComponent) {
    return (
      <div className="flex items-center justify-center h-32 gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-4 animate-spin" />
        <span>Loading...</span>
      </div>
    )
  }

  return (
    <div className="p-4">
      <ComponentNode
        definition={rootComponent}
        components={surface.components}
        dataModel={surface.dataModel}
        onAction={handleAction}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recursive Component Node
// ---------------------------------------------------------------------------

interface ComponentNodeProps {
  definition: ComponentDefinition
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  onAction: (name: string, context?: Record<string, unknown>) => void
  /** Scoped data for template rendering (DataList items) */
  scopeData?: Record<string, unknown>
  scopePath?: string
}

function ComponentNode({ definition, components, dataModel, onAction, scopeData, scopePath }: ComponentNodeProps) {
  const catalogEntry = COMPONENT_CATALOG[definition.component]
  if (!catalogEntry) {
    return (
      <div className="text-xs text-red-500 border border-red-200 rounded px-2 py-1">
        Unknown component: {definition.component}
      </div>
    )
  }

  const resolvedProps = useResolvedProps(definition, dataModel, scopeData, scopePath)
  const children = useRenderedChildren(definition, components, dataModel, onAction, scopeData, scopePath)

  const Component = catalogEntry.component

  return (
    <Component
      {...resolvedProps}
      onAction={onAction}
    >
      {children}
    </Component>
  )
}

// ---------------------------------------------------------------------------
// Prop Resolution (data binding)
// ---------------------------------------------------------------------------

const RESERVED_KEYS = new Set(['id', 'component', 'child', 'children'])

function useResolvedProps(
  definition: ComponentDefinition,
  dataModel: Record<string, unknown>,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
) {
  return useMemo(() => {
    const resolved: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(definition)) {
      if (RESERVED_KEYS.has(key)) continue
      resolved[key] = resolveValue(value, dataModel, scopeData, scopePath)
    }

    return resolved
  }, [definition, dataModel, scopeData, scopePath])
}

function resolveValue(
  value: unknown,
  dataModel: Record<string, unknown>,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
): unknown {
  if (isDynamicPath(value)) {
    const path = value.path
    // Relative paths resolve against scope data
    if (!path.startsWith('/') && scopeData) {
      return (scopeData as any)[path]
    }
    return getByPointer(dataModel, path)
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, dataModel, scopeData, scopePath))
  }

  if (typeof value === 'object' && value !== null) {
    // Check if it's an action definition (pass through)
    if ('name' in value && typeof (value as any).name === 'string') {
      const action = value as Record<string, unknown>
      if (action.context && typeof action.context === 'object') {
        const resolvedContext: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(action.context as Record<string, unknown>)) {
          resolvedContext[k] = resolveValue(v, dataModel, scopeData, scopePath)
        }
        return { ...action, context: resolvedContext }
      }
      return value
    }

    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, dataModel, scopeData, scopePath)
    }
    return resolved
  }

  return value
}

// ---------------------------------------------------------------------------
// Children Resolution
// ---------------------------------------------------------------------------

function useRenderedChildren(
  definition: ComponentDefinition,
  components: Map<string, ComponentDefinition>,
  dataModel: Record<string, unknown>,
  onAction: (name: string, context?: Record<string, unknown>) => void,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
): ReactNode {
  return useMemo(() => {
    // Single child reference
    if (definition.child) {
      const childDef = components.get(definition.child)
      if (!childDef) return null
      return (
        <ComponentNode
          key={definition.child}
          definition={childDef}
          components={components}
          dataModel={dataModel}
          onAction={onAction}
          scopeData={scopeData}
          scopePath={scopePath}
        />
      )
    }

    // Array of children or template
    if (definition.children) {
      // Template-based children (DataList): { path: "/items", templateId: "item_template" }
      if (typeof definition.children === 'object' && !Array.isArray(definition.children)) {
        const tmpl = definition.children as { path: string; templateId: string }
        const items = getByPointer(dataModel, tmpl.path)
        if (!Array.isArray(items)) return null

        const templateDef = components.get(tmpl.templateId)
        if (!templateDef) return null

        return items.map((item, index) => (
          <ComponentNode
            key={`${tmpl.templateId}-${index}`}
            definition={templateDef}
            components={components}
            dataModel={dataModel}
            onAction={onAction}
            scopeData={typeof item === 'object' && item !== null ? item as Record<string, unknown> : { value: item }}
            scopePath={`${tmpl.path}/${index}`}
          />
        ))
      }

      // Static array of child IDs
      const childIds = definition.children as string[]
      return childIds.map((childId) => {
        const childDef = components.get(childId)
        if (!childDef) return null
        return (
          <ComponentNode
            key={childId}
            definition={childDef}
            components={components}
            dataModel={dataModel}
            onAction={onAction}
            scopeData={scopeData}
            scopePath={scopePath}
          />
        )
      })
    }

    return null
  }, [definition, components, dataModel, onAction, scopeData, scopePath])
}

// ---------------------------------------------------------------------------
// Multi-Surface Renderer
// ---------------------------------------------------------------------------

interface MultiSurfaceRendererProps {
  surfaces: Map<string, SurfaceState>
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
}

export function MultiSurfaceRenderer({ surfaces, onAction }: MultiSurfaceRendererProps) {
  const surfaceList = useMemo(() => [...surfaces.values()], [surfaces])

  if (surfaceList.length === 0) {
    return null
  }

  if (surfaceList.length === 1) {
    return <DynamicAppRenderer surface={surfaceList[0]} onAction={onAction} />
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {surfaceList.map((surface) => (
        <div key={surface.surfaceId}>
          {surface.title && (
            <h3 className="text-lg font-semibold mb-3">{surface.title}</h3>
          )}
          <DynamicAppRenderer surface={surface} onAction={onAction} />
        </div>
      ))}
    </div>
  )
}
