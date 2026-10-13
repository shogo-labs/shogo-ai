// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * NativeWind `className` → SVG `color` for Lucide icons.
 *
 * This used to `import *` the whole icon set at startup, which put every
 * icon into the desktop web chunk. Named imports are rewritten by
 * `scripts/babel-plugin-lucide-direct.js`, which calls `cssInterop` on
 * each icon it loads. Dynamic names go through `lib/lucide-catalog.tsx`.
 *
 * Kept as a side-effect import from `app/_layout.tsx` so the startup
 * hook stays obvious; the module itself no longer loads icons.
 */
export {}
