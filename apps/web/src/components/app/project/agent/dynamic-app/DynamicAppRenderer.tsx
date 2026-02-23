/**
 * DynamicAppRenderer
 *
 * Core rendering engine for the Dynamic App canvas. Takes a surface's
 * component map and data model, then recursively renders from the "root"
 * component, resolving data bindings and dispatching user actions.
 *
 * Supports two data binding modes:
 * - { path: "/some/pointer" } -- resolves against in-memory dataModel
 * - { api: "/api/todos" }     -- fetches from managed API runtime
 *
 * Supports two action modes:
 * - Actions with a `mutation` key are handled by the frontend directly
 * - Actions without `mutation` dispatch to the agent via canvas_action_wait
 */

import { useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { SurfaceState, ComponentDefinition } from './types'
import { isDynamicPath, isApiBinding } from './types'
import { getByPointer } from './use-dynamic-app-stream'
import { useApiDataSource, type ApiDataSourceResult } from './use-api-data-source'
import { COMPONENT_CATALOG } from './catalog'

interface RendererProps {
  surface: SurfaceState
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
}

export function DynamicAppRenderer({ surface, agentUrl, onAction, onDataChange }: RendererProps) {
  const apiDataSource = useApiDataSource(agentUrl, surface.surfaceId)

  const handleAction = useCallback(
    async (name: string, context?: Record<string, unknown>) => {
      onAction(surface.surfaceId, name, context)
    },
    [surface.surfaceId, onAction],
  )

  const handleDataChange = useCallback(
    (path: string, value: unknown) => {
      if (onDataChange) {
        onDataChange(surface.surfaceId, path, value)
      }
    },
    [surface.surfaceId, onDataChange],
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
        onDataChange={handleDataChange}
        apiDataSource={apiDataSource}
      />
    </div>
  )
}

function resolveObjectPaths(obj: Record<string, unknown>, dataModel: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(obj)) {
    if (isDynamicPath(val)) {
      result[key] = getByPointer(dataModel, val.path)
    } else {
      result[key] = val
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Recursive Component Node
// ---------------------------------------------------------------------------

interface ComponentNodeProps {
  definition: ComponentDefinition
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  onAction: (name: string, context?: Record<string, unknown>) => void
  onDataChange?: (path: string, value: unknown) => void
  apiDataSource: ApiDataSourceResult
  /** Scoped data for template rendering (DataList items) */
  scopeData?: Record<string, unknown>
  scopePath?: string
}

function ComponentNode({ definition, components, dataModel, onAction, onDataChange, apiDataSource, scopeData, scopePath }: ComponentNodeProps) {
  const catalogEntry = COMPONENT_CATALOG[definition.component]
  if (!catalogEntry) {
    return (
      <div className="text-xs text-red-500 border border-red-200 rounded px-2 py-1">
        Unknown component: {definition.component}
      </div>
    )
  }

  let resolvedProps = useResolvedProps(definition, dataModel, apiDataSource, scopeData, scopePath)

  // Auto-derive tabs from TabPanel children when `tabs` prop is missing
  if (definition.component === 'Tabs' && !resolvedProps.tabs && Array.isArray(definition.children)) {
    const childIds = definition.children as string[]
    const autoTabs = childIds.map((childId) => {
      const childDef = components.get(childId)
      const label = childDef?.title ?? childDef?.label
      return label ? { id: childId, label: String(label) } : null
    }).filter((t): t is { id: string; label: string } => t !== null)
    if (autoTabs.length > 0) {
      resolvedProps = { ...resolvedProps, tabs: autoTabs }
    }
  }

  const children = useRenderedChildren(definition, components, dataModel, onAction, onDataChange, apiDataSource, scopeData, scopePath)

  const Component = catalogEntry.component

  return (
    <Component
      {...resolvedProps}
      onAction={onAction}
      onDataChange={onDataChange}
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
  apiDataSource: ApiDataSourceResult,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
) {
  // Collect and register API bindings found anywhere in this component's props (deep scan)
  const apiBindings = useMemo(() => {
    const bindings: Array<{ key: string; api: string; params?: Record<string, unknown>; refreshInterval?: number }> = []
    function scan(val: unknown, keyPath: string) {
      if (isApiBinding(val)) {
        bindings.push({ key: `${definition.id}:${keyPath}`, ...val })
        return
      }
      if (Array.isArray(val)) {
        val.forEach((item, i) => scan(item, `${keyPath}[${i}]`))
        return
      }
      if (typeof val === 'object' && val !== null) {
        for (const [k, v] of Object.entries(val)) {
          scan(v, keyPath ? `${keyPath}.${k}` : k)
        }
      }
    }
    for (const [key, value] of Object.entries(definition)) {
      if (RESERVED_KEYS.has(key)) continue
      scan(value, key)
    }
    return bindings
  }, [definition])

  const registeredRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentKeys = new Set<string>()
    for (const binding of apiBindings) {
      currentKeys.add(binding.key)
      apiDataSource.registerBinding(binding.key, {
        api: binding.api,
        params: binding.params,
        refreshInterval: binding.refreshInterval,
      })
    }
    // Unregister bindings that are no longer present
    for (const key of registeredRef.current) {
      if (!currentKeys.has(key)) {
        apiDataSource.unregisterBinding(key)
      }
    }
    registeredRef.current = currentKeys
    return () => {
      for (const key of currentKeys) {
        apiDataSource.unregisterBinding(key)
      }
    }
  }, [apiBindings, apiDataSource])

  return useMemo(() => {
    const resolved: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(definition)) {
      if (RESERVED_KEYS.has(key)) continue
      resolved[key] = resolveValue(value, dataModel, apiDataSource, scopeData, scopePath)
    }

    return resolved
  }, [definition, dataModel, apiDataSource, scopeData, scopePath])
}

function resolveValue(
  value: unknown,
  dataModel: Record<string, unknown>,
  apiDataSource: ApiDataSourceResult,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
): unknown {
  if (isApiBinding(value)) {
    return apiDataSource.getData(value.api)
  }

  if (isDynamicPath(value)) {
    const path = value.path
    if (!path.startsWith('/') && scopeData) {
      return (scopeData as any)[path]
    }
    return getByPointer(dataModel, path)
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, dataModel, apiDataSource, scopeData, scopePath))
  }

  if (typeof value === 'object' && value !== null) {
    // Check if it's an action definition -- resolve context values but preserve mutation descriptors
    if ('name' in value && typeof (value as any).name === 'string') {
      const action = value as Record<string, unknown>
      const resolvedContext: Record<string, unknown> = {}
      if (action.context && typeof action.context === 'object') {
        for (const [k, v] of Object.entries(action.context as Record<string, unknown>)) {
          resolvedContext[k] = resolveValue(v, dataModel, apiDataSource, scopeData, scopePath)
        }
      }
      // If the action has a mutation descriptor, inject it into the context for the handler
      if (action.mutation && typeof action.mutation === 'object') {
        const mut = action.mutation as Record<string, unknown>
        const resolvedMutBody = mut.body && typeof mut.body === 'object'
          ? resolveValue(mut.body, dataModel, apiDataSource, scopeData, scopePath)
          : mut.body
        // Resolve endpoint — supports data binding { path: "url" } as well as string literals
        const rawEndpoint = isDynamicPath(mut.endpoint)
          ? resolveValue(mut.endpoint, dataModel, apiDataSource, scopeData, scopePath)
          : mut.endpoint
        let resolvedEndpoint = typeof rawEndpoint === 'string' ? rawEndpoint : ''
        // Resolve :param placeholders in endpoint from context or data model
        if (resolvedEndpoint && resolvedEndpoint.includes(':')) {
          const params = (mut.params || {}) as Record<string, unknown>
          for (const [pk, pv] of Object.entries(params)) {
            const resolved = resolveValue(pv, dataModel, apiDataSource, scopeData, scopePath)
            resolvedEndpoint = resolvedEndpoint.replace(`:${pk}`, String(resolved ?? ''))
          }
        }
        resolvedContext._mutation = { endpoint: resolvedEndpoint, method: mut.method, body: resolvedMutBody }
      }
      return { ...action, context: { ...resolvedContext, ...(action.context ? {} : {}) } }
    }

    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, dataModel, apiDataSource, scopeData, scopePath)
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
  onDataChange: ((path: string, value: unknown) => void) | undefined,
  apiDataSource: ApiDataSourceResult,
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
          onDataChange={onDataChange}
          apiDataSource={apiDataSource}
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
            onDataChange={onDataChange}
            apiDataSource={apiDataSource}
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
            onDataChange={onDataChange}
            apiDataSource={apiDataSource}
            scopeData={scopeData}
            scopePath={scopePath}
          />
        )
      })
    }

    return null
  }, [definition, components, dataModel, onAction, onDataChange, apiDataSource, scopeData, scopePath])
}

// ---------------------------------------------------------------------------
// Multi-Surface Renderer
// ---------------------------------------------------------------------------

interface MultiSurfaceRendererProps {
  surfaces: Map<string, SurfaceState>
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
}

export function MultiSurfaceRenderer({ surfaces, agentUrl, onAction, onDataChange }: MultiSurfaceRendererProps) {
  const surfaceList = useMemo(() => [...surfaces.values()], [surfaces])

  if (surfaceList.length === 0) {
    return null
  }

  if (surfaceList.length === 1) {
    return <DynamicAppRenderer surface={surfaceList[0]} agentUrl={agentUrl} onAction={onAction} onDataChange={onDataChange} />
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      {surfaceList.map((surface) => (
        <div key={surface.surfaceId}>
          {surface.title && (
            <h3 className="text-lg font-semibold mb-3">{surface.title}</h3>
          )}
          <DynamicAppRenderer surface={surface} agentUrl={agentUrl} onAction={onAction} onDataChange={onDataChange} />
        </div>
      ))}
    </div>
  )
}
