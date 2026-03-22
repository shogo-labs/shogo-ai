// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Data resolution utilities for the Dynamic App protocol.
 * Pure functions -- no platform dependencies.
 */

import { isDynamicPath, isApiBinding, type DynamicValue } from './types'

/**
 * Resolve a JSON Pointer (RFC 6901) path against a data model.
 */
export function getByPointer(data: Record<string, unknown>, pointer: string): unknown {
  if (!pointer || pointer === '/') return data

  const segments = pointer.replace(/^\//, '').split('/')
  let current: unknown = data

  for (const segment of segments) {
    const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || current === undefined) return undefined
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[decoded]
    } else {
      return undefined
    }
  }

  return current
}

/**
 * Resolve a single DynamicValue against a data model.
 * Returns the static value if not a path binding.
 * API bindings are not resolved here (they require a runtime hook).
 */
export function resolveValue<T>(
  val: DynamicValue<T>,
  dataModel: Record<string, unknown>,
): T | unknown {
  if (isDynamicPath(val)) {
    return getByPointer(dataModel, val.path)
  }
  if (isApiBinding(val)) {
    return undefined
  }
  return val
}

/**
 * Resolve all { path: "..." } bindings in a flat object.
 */
export function resolveObjectPaths(
  obj: Record<string, unknown>,
  dataModel: Record<string, unknown>,
): Record<string, unknown> {
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
