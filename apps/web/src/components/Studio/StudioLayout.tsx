/**
 * StudioLayout - Resizable sidebar + main content layout
 *
 * Features:
 * - Collapsible sidebar with smooth animation
 * - Resizable sidebar with drag handle
 * - Responsive layout
 */

import { useRef, useState, useCallback, useEffect, type ReactNode } from "react"

interface StudioLayoutProps {
  sidebarCollapsed: boolean
  sidebarWidth: number
  onSidebarToggle: () => void
  onSidebarResize: (width: number) => void
  sidebar: ReactNode
  children: ReactNode
}

const MIN_WIDTH = 200
const MAX_WIDTH = 400

export function StudioLayout({
  sidebarCollapsed,
  sidebarWidth,
  onSidebarToggle,
  onSidebarResize,
  sidebar,
  children,
}: StudioLayoutProps) {
  const [isResizing, setIsResizing] = useState(false)
  const layoutRef = useRef<HTMLDivElement>(null)

  // Handle resize start
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

  // Handle resize move
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!layoutRef.current) return
      const rect = layoutRef.current.getBoundingClientRect()
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - rect.left))
      onSidebarResize(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isResizing, onSidebarResize])

  return (
    <div ref={layoutRef} className="studio-layout" data-resizing={isResizing}>
      <style>{layoutStyles}</style>

      {/* Sidebar */}
      <aside
        className="studio-sidebar"
        style={{
          width: sidebarCollapsed ? 0 : sidebarWidth,
          minWidth: sidebarCollapsed ? 0 : sidebarWidth,
        }}
      >
        <div className="studio-sidebar-content">
          {sidebar}
        </div>

        {/* Resize handle */}
        {!sidebarCollapsed && (
          <div
            className="studio-resize-handle"
            onMouseDown={handleResizeStart}
          />
        )}
      </aside>

      {/* Main content */}
      <main className="studio-main">
        {children}
      </main>

      {/* Collapse toggle */}
      <button
        className="studio-collapse-toggle"
        onClick={onSidebarToggle}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {sidebarCollapsed ? ">" : "<"}
      </button>
    </div>
  )
}

const layoutStyles = `
  .studio-layout {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .studio-layout[data-resizing="true"] {
    cursor: col-resize;
    user-select: none;
  }

  .studio-sidebar {
    display: flex;
    flex-shrink: 0;
    background: var(--studio-bg-elevated);
    border-right: 1px solid var(--studio-border);
    overflow: hidden;
    transition: width 0.2s ease, min-width 0.2s ease;
    position: relative;
  }

  .studio-layout[data-resizing="true"] .studio-sidebar {
    transition: none;
  }

  .studio-sidebar-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
  }

  .studio-resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    background: transparent;
    transition: background 0.15s ease;
    z-index: 10;
  }

  .studio-resize-handle:hover,
  .studio-layout[data-resizing="true"] .studio-resize-handle {
    background: var(--studio-accent);
  }

  .studio-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--studio-bg-base);
  }

  .studio-collapse-toggle {
    position: absolute;
    bottom: 1rem;
    left: 0;
    z-index: 20;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--studio-bg-card);
    border: 1px solid var(--studio-border);
    border-left: none;
    border-radius: 0 4px 4px 0;
    color: var(--studio-text-muted);
    font-size: 12px;
    cursor: pointer;
    transition: color 0.15s ease, background 0.15s ease;
  }

  .studio-collapse-toggle:hover {
    color: var(--studio-text);
    background: var(--studio-bg-elevated);
  }
`
