/**
 * Registers all lucide-react-native icons with NativeWind's cssInterop
 * so that className color classes (e.g. text-purple-400, text-muted-foreground)
 * work correctly on web. Without this, SVG icons render with default black stroke.
 *
 * Uses import * to auto-register every icon — no manual list to maintain.
 * Metro doesn't tree-shake on native anyway, so bundle impact is negligible.
 *
 * Import this file once at app startup (root _layout.tsx).
 */

import { cssInterop } from 'nativewind'
import * as LucideIcons from 'lucide-react-native'

const config = {
  className: {
    target: 'style',
    nativeStyleToProp: { color: true },
  },
} as const

for (const [name, component] of Object.entries(LucideIcons)) {
  if (typeof component === 'function' && /^[A-Z]/.test(name)) {
    cssInterop(component as any, config)
  }
}
