// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shared prop resolution for dynamic app components.
 *
 * Resolves data bindings ({ path: "/some/pointer" }) and API bindings
 * against the surface's data model. Used by both web and mobile renderers.
 */

import { isDynamicPath, isApiBinding } from './types'
import { getByPointer } from './pointer'
import type { ComponentDefinition } from './types'

export const RESERVED_KEYS = new Set(['id', 'component', 'child', 'children'])

const TEXT_RENDER_PROPS = new Set([
  'text', 'title', 'label', 'description', 'footer', 'subtitle',
  'value', 'trendValue', 'placeholder', 'content', 'message',
])

export interface ApiDataSourceLike {
  getData(api: string): unknown
}

/**
 * Recursively resolve a single value against the data model and API data source.
 */
export function resolveValue(
  value: unknown,
  dataModel: Record<string, unknown>,
  apiDataSource?: ApiDataSourceLike | null,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
): unknown {
  if (apiDataSource && isApiBinding(value)) {
    return apiDataSource.getData((value as any).api)
  }

  if (isDynamicPath(value)) {
    const path = (value as any).path as string
    if (!path.startsWith('/') && scopeData) {
      return (scopeData as any)[path]
    }
    return getByPointer(dataModel, path)
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, dataModel, apiDataSource, scopeData, scopePath))
  }

  if (typeof value === 'object' && value !== null) {
    if ('name' in value && typeof (value as any).name === 'string') {
      const action = value as Record<string, unknown>
      const resolvedContext: Record<string, unknown> = {}
      if (action.context && typeof action.context === 'object') {
        for (const [k, v] of Object.entries(action.context as Record<string, unknown>)) {
          resolvedContext[k] = resolveValue(v, dataModel, apiDataSource, scopeData, scopePath)
        }
      }
      if (action.mutation && typeof action.mutation === 'object') {
        const mut = action.mutation as Record<string, unknown>
        const resolvedMutBody = mut.body && typeof mut.body === 'object'
          ? resolveValue(mut.body, dataModel, apiDataSource, scopeData, scopePath)
          : mut.body
        const rawEndpoint = isDynamicPath(mut.endpoint)
          ? resolveValue(mut.endpoint, dataModel, apiDataSource, scopeData, scopePath)
          : mut.endpoint
        let resolvedEndpoint = typeof rawEndpoint === 'string' ? rawEndpoint : ''
        if (resolvedEndpoint && resolvedEndpoint.includes(':')) {
          const params = (mut.params || {}) as Record<string, unknown>
          for (const [pk, pv] of Object.entries(params)) {
            const resolved = resolveValue(pv, dataModel, apiDataSource, scopeData, scopePath)
            resolvedEndpoint = resolvedEndpoint.replace(`:${pk}`, String(resolved ?? ''))
          }
        }
        resolvedContext._mutation = { endpoint: resolvedEndpoint, method: mut.method, body: resolvedMutBody }
      }
      return { ...action, context: { ...resolvedContext } }
    }

    const resolved: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, dataModel, apiDataSource, scopeData, scopePath)
    }
    return resolved
  }

  return value
}

/**
 * Sanitize resolved props — convert objects in text-render props to strings
 * to avoid React Error #31: "Objects are not valid as a React child."
 */
export function sanitizeForRender(resolved: Record<string, unknown>): Record<string, unknown> {
  for (const key of TEXT_RENDER_PROPS) {
    const val = resolved[key]
    if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
      resolved[key] = JSON.stringify(val)
    }
  }
  return resolved
}

/**
 * Resolve all props on a component definition against the data model.
 * Simple version without API bindings (suitable for mobile or basic use).
 */
export function resolveComponentProps(
  definition: ComponentDefinition,
  dataModel: Record<string, unknown>,
  apiDataSource?: ApiDataSourceLike | null,
  scopeData?: Record<string, unknown>,
  scopePath?: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(definition)) {
    if (RESERVED_KEYS.has(key)) continue
    resolved[key] = resolveValue(value, dataModel, apiDataSource, scopeData, scopePath)
  }
  return sanitizeForRender(resolved)
}
