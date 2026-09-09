// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native browser tooltip on hover (web only). `display: contents` so layout
 * and the trigger's own ref (popover positioning) are unaffected. On native
 * this is a passthrough — the icon click opens the menu which already shows
 * the full label.
 */
import React from "react"
import { Platform } from "react-native"

export function WebTooltip({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  if (Platform.OS !== "web") return <>{children}</>
  return React.createElement(
    "div",
    { title: label, style: { display: "contents" } },
    children,
  )
}
