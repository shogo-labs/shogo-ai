// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Platform } from "react-native"

interface WebTooltipProps {
  label: string
  children: React.ReactNode
  placement?: "top" | "bottom"
}

const OFFSET = 8

export function WebTooltip({ label, children, placement = "top" }: WebTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (Platform.OS !== "web") return
    setMounted(true)
  }, [])

  useLayoutEffect(() => {
    if (!visible || !triggerRef.current || !tooltipRef.current || typeof window === "undefined") return

    const triggerRect = triggerRef.current.getBoundingClientRect()
    const tooltipRect = tooltipRef.current.getBoundingClientRect()
    const left = Math.min(
      Math.max(triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2, OFFSET),
      window.innerWidth - tooltipRect.width - OFFSET,
    )
    const topPlacement = triggerRect.top - tooltipRect.height - OFFSET
    const bottomPlacement = triggerRect.bottom + OFFSET
    const canPlaceAbove = topPlacement >= OFFSET
    const canPlaceBelow = bottomPlacement + tooltipRect.height <= window.innerHeight - OFFSET
    const top = placement === "bottom"
      ? (canPlaceBelow || !canPlaceAbove ? bottomPlacement : topPlacement)
      : (canPlaceAbove || !canPlaceBelow ? topPlacement : bottomPlacement)

    setPosition({ top, left })
  }, [visible, label, placement])

  if (Platform.OS !== "web" || !mounted || typeof document === "undefined") {
    return <>{children}</>
  }

  const wrapped = React.createElement(
    "span",
    {
      ref: triggerRef,
      onMouseEnter: () => setVisible(true),
      onMouseLeave: () => setVisible(false),
      onFocus: () => setVisible(true),
      onBlur: () => setVisible(false),
      style: { display: "inline-flex", alignItems: "center" },
    },
    children,
  )

  if (!visible) return wrapped

  const tooltip = React.createElement(
    "div",
    {
      ref: tooltipRef,
      role: "tooltip",
      style: {
        position: "fixed",
        top: position.top,
        left: position.left,
        zIndex: 2147483647,
        maxWidth: 260,
        padding: "6px 8px",
        borderRadius: 8,
        border: "1px solid var(--color-border, rgba(148, 163, 184, 0.24))",
        background: "var(--color-popover, #ffffff)",
        color: "var(--color-popover-foreground, #0f172a)",
        boxShadow: "0 10px 30px rgba(15, 23, 42, 0.18)",
        fontSize: 12,
        lineHeight: "16px",
        fontWeight: 500,
        pointerEvents: "none",
        whiteSpace: "nowrap",
      },
    },
    label,
  )

  const { createPortal } = require("react-dom") as typeof import("react-dom")
  return (
    <>
      {wrapped}
      {createPortal(tooltip, document.body)}
    </>
  )
}
