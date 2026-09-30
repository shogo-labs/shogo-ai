// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useAccentTheme } from "../../contexts/accent-theme"
import { ACCENT_PRESETS } from "../../lib/accent-themes"

/** The user's accent as a CSS color, for props that can't take a class
 * (icon and SVG colors). The island is always dark, so this is the dark
 * variant; Shogo Orange unless the user picked another accent. */
export function useIslandAccent(): string {
  const { accent } = useAccentTheme()
  return `rgb(${ACCENT_PRESETS[accent].dark.primary.split(" ").join(", ")})`
}
