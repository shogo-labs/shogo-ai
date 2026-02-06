/**
 * WorkspaceLayout - Simplified workspace layout
 * 
 * Shows the HomePage which has project creation and navigation
 */

import { observer } from "mobx-react-lite"
import { HomePage } from "./dashboard"
import { useWorkspaceData } from "./hooks"
import { useState, useRef } from "react"

export const WorkspaceLayout = observer(function WorkspaceLayout() {
  return (
    <div data-testid="workspace-layout" className="h-full">
      <HomePage />
    </div>
  )
})
