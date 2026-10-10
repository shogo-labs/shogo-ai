// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dynamic Lucide lookup for icons chosen by data (marketplace categories,
 * integration tags). Named imports go through the Babel plugin and never
 * touch this module. Loading the catalog pulls the full icon barrel into
 * its own chunk, on first use, instead of the app entry.
 */
import { useEffect, useState, type ComponentType } from 'react'
import { cssInterop } from 'nativewind'

type Icon = ComponentType<{ size?: number; color?: string; className?: string }>

let loading: Promise<Record<string, Icon>> | null = null

export function loadLucideCatalog(): Promise<Record<string, Icon>> {
  loading ??= import('lucide-react-native').then((mod) => {
    const icons = mod as unknown as Record<string, Icon>
    for (const [name, component] of Object.entries(icons)) {
      if (component && /^[A-Z]/.test(name) && (typeof component === 'function' || typeof component === 'object')) {
        cssInterop(component as never, {
          className: {
            target: 'style',
            nativeStyleToProp: { color: true },
          },
        })
      }
    }
    return icons
  })
  return loading
}

export function useLucideIcon(name: string | null | undefined, fallback: string | null = 'Sparkles'): Icon | null {
  const [Icon, setIcon] = useState<Icon | null>(null)
  useEffect(() => {
    let cancelled = false
    void loadLucideCatalog().then((icons) => {
      if (cancelled) return
      const resolved = (name && icons[name]) || (fallback ? icons[fallback] : null) || null
      setIcon(resolved)
    })
    return () => {
      cancelled = true
    }
  }, [name, fallback])
  return Icon
}

export function LucideByName({
  name,
  size,
  color,
  fallback = 'Sparkles',
}: {
  name: string
  size?: number
  color?: string
  fallback?: string | null
}) {
  const Icon = useLucideIcon(name, fallback)
  if (!Icon) return null
  return <Icon size={size} color={color} />
}
