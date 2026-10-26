// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Native has no HTML drag and drop; cards move through the card's move menu
 * (long press). See drag.web.tsx for the web version.
 */
import type { ReactNode } from 'react'

export interface DraggableCardProps {
  id: string
  children: ReactNode
  onDragStart?: (id: string) => void
  onDragEnd?: () => void
}

export function DraggableCard({ children }: DraggableCardProps) {
  return <>{children}</>
}

export interface DropZoneProps {
  children: ReactNode
  onDrop: (itemId: string) => void
  onHover?: (over: boolean) => void
  grow?: boolean
}

export function DropZone({ children }: DropZoneProps) {
  return <>{children}</>
}

export const supportsDrag = false
