import * as React from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Data structure for a workspace panel
 */
export interface WorkspacePanelData {
  id: string
  type: "preview" | "code" | "schema" | "docs"
  title: string
  content?: React.ReactNode
  metadata?: Record<string, unknown>
}

/**
 * Props for the WorkspacePanel component
 */
export interface WorkspacePanelProps {
  panel: WorkspacePanelData
  onClose: () => void
  onResize?: (size: number) => void
  children?: React.ReactNode
}

/**
 * WorkspacePanel - A wrapper component with panel chrome (title bar, close button)
 * and content slot for the advanced chat workspace.
 */
export function WorkspacePanel({
  panel,
  onClose,
  children,
}: WorkspacePanelProps) {
  return (
    <div className="border bg-card rounded-lg flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="font-medium text-sm">{panel.title}</span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {children ?? panel.content}
      </div>
    </div>
  )
}
