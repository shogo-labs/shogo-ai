// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Registers all lucide-react-native icons with NativeWind's cssInterop
 * so that className color classes (e.g. text-purple-400, text-muted-foreground)
 * work correctly. Without this, SVG icons render with default black stroke.
 *
 * Maps className directly to the `color` prop rather than going through
 * style → nativeStyleToProp, which is broken for SVGs in NativeWind >=4.1.22.
 * See: https://github.com/nativewind/nativewind/issues/1710
 *
 * Uses import * to auto-register every icon — no manual list to maintain.
 * Metro doesn't tree-shake on native anyway, so bundle impact is negligible.
 *
 * Import this file once at app startup (root _layout.tsx).
 */

import { cssInterop } from 'nativewind'
import * as LucideIcons from 'lucide-react-native'

for (const [name, component] of Object.entries(LucideIcons)) {
  if (component != null && /^[A-Z]/.test(name)) {
    cssInterop(component as any, {
      className: {
        target: 'style',
        nativeStyleToProp: { color: true },
      },
    })
  }
}
