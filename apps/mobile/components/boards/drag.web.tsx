// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** HTML drag and drop for board cards on web. */
import { useRef } from 'react'
import type { DraggableCardProps, DropZoneProps } from './drag'

const MIME = 'text/x-shogo-card'

export function DraggableCard({ id, children, onDragStart, onDragEnd }: DraggableCardProps) {
  return (
    <div
      draggable
      data-card-id={id}
      style={{ display: 'flex', flexDirection: 'column', cursor: 'grab' }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        try {
          e.dataTransfer.setData(MIME, id)
          e.dataTransfer.setData('text/plain', id)
        } catch {}
        onDragStart?.(id)
      }}
      onDragEnd={() => onDragEnd?.()}
    >
      {children}
    </div>
  )
}

export function DropZone({ children, onDrop, onHover, grow }: DropZoneProps) {
  const depth = useRef(0)
  const isCard = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(MIME)
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', ...(grow ? { flex: 1, minHeight: 0 } : {}) }}
      onDragEnter={(e) => {
        if (!isCard(e)) return
        depth.current++
        onHover?.(true)
      }}
      onDragOver={(e) => {
        if (!isCard(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDragLeave={(e) => {
        if (!isCard(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (!depth.current) onHover?.(false)
      }}
      onDrop={(e) => {
        if (!isCard(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        onHover?.(false)
        const id = e.dataTransfer.getData(MIME)
        if (id) onDrop(id)
      }}
    >
      {children}
    </div>
  )
}

export const supportsDrag = true
