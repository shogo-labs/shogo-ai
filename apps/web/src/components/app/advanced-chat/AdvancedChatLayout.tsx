/**
 * AdvancedChatLayout - Smart component for the Advanced Chat Testbed
 *
 * Manages workspace state via useState + localStorage. Provides a flex layout
 * with DynamicWorkspace (flex-1) on the left and ChatPanel (fixed width) on the right.
 * Creates/uses a synthetic 'testbed-session' FeatureSession for chat persistence.
 *
 * Task: task-testbed-layout
 * Feature: virtual-tools-domain
 *
 * Design Decisions:
 * - dd-testbed-workspace-state-management: Use local useState + localStorage for panel state
 * - dd-testbed-session-strategy: Create synthetic 'testbed-session' FeatureSession on-demand
 * - dd-testbed-component-hierarchy: AdvancedChatLayout is the smart component at route level
 */

import { observer } from "mobx-react-lite"
import { useState, useCallback, useEffect } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { DynamicWorkspace } from "./DynamicWorkspace"
import { ChatPanel } from "../chat/ChatPanel"
import type { WorkspacePanelData } from "./WorkspacePanel"

// ============================================================
// Constants
// ============================================================

const TESTBED_SESSION_ID = "testbed-session"
const STORAGE_KEY = "advanced-chat-workspace-state"

// ============================================================
// Types
// ============================================================

interface WorkspaceState {
  panels: WorkspacePanelData[]
  layout: "single" | "split-h" | "split-v" | "grid"
}

// ============================================================
// LocalStorage Helpers
// ============================================================

function loadWorkspaceState(): WorkspaceState {
  if (typeof localStorage === "undefined") {
    return { panels: [], layout: "single" }
  }

  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      return JSON.parse(saved)
    } catch {
      // Invalid JSON, use default
    }
  }
  return { panels: [], layout: "single" }
}

function saveWorkspaceState(state: WorkspaceState): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

// ============================================================
// Component
// ============================================================

export const AdvancedChatLayout = observer(function AdvancedChatLayout() {
  const { platformFeatures, studioChat } = useDomains<{
    platformFeatures: any
    studioChat: any
  }>()

  // Load workspace state from localStorage
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>(loadWorkspaceState)

  // Persist workspace state to localStorage
  useEffect(() => {
    saveWorkspaceState(workspaceState)
  }, [workspaceState])

  // Ensure testbed session exists (for ChatPanel)
  useEffect(() => {
    const existing = platformFeatures.featureSessionCollection.get(TESTBED_SESSION_ID)
    if (!existing) {
      platformFeatures.featureSessionCollection.insertOne({
        id: TESTBED_SESSION_ID,
        name: "Advanced Chat Testbed",
        intent: "Virtual tools development testbed",
        status: "discovery",
        createdAt: Date.now(),
      })
    }
  }, [platformFeatures])

  // Panel management callbacks
  const handlePanelClose = useCallback((panelId: string) => {
    setWorkspaceState((prev) => ({
      ...prev,
      panels: prev.panels.filter((p) => p.id !== panelId),
    }))
  }, [])

  const handleOpenPanel = useCallback((panel: WorkspacePanelData) => {
    setWorkspaceState((prev) => ({
      ...prev,
      panels: [...prev.panels.filter((p) => p.id !== panel.id), panel],
    }))
  }, [])

  return (
    <div className="flex h-full">
      {/* Dynamic Workspace - fills available space */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <DynamicWorkspace
          panels={workspaceState.panels}
          layout={workspaceState.layout}
          onPanelClose={handlePanelClose}
        />
      </div>

      {/* Chat Panel - fixed width on right */}
      <div className="w-[400px] border-l flex-shrink-0">
        <ChatPanel
          featureId={TESTBED_SESSION_ID}
          featureName="Advanced Chat Testbed"
          phase={null}
          onOpenPanel={handleOpenPanel}
        />
      </div>
    </div>
  )
})
