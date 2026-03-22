// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * JSON Pointer helpers for dynamic app data binding.
 * Implements RFC 6901 JSON Pointer resolution and mutation.
 */

function parsePointer(pointer: string): string[] {
  if (!pointer || pointer === '/') return []
  if (!pointer.startsWith('/')) return []
  return pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

export function setByPointer(obj: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = parsePointer(pointer)
  if (parts.length === 0) return

  let current: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (current[key] === undefined || current[key] === null) {
      current[key] = /^\d+$/.test(parts[i + 1]) ? [] : {}
    }
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
}

export function getByPointer(obj: Record<string, unknown>, pointer: string): unknown {
  const parts = parsePointer(pointer)
  let current: unknown = obj
  for (const part of parts) {
    if (current === undefined || current === null) return undefined
    current = (current as any)[part]
  }
  return current
}
