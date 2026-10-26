// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Whether the wide sidebar's list panel is open. The shell draws the content
 * card's left corners from this: rounded only on the right while the panel
 * is the card's left half, and fully rounded once the panel is hidden.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

const WidePanelVisibleContext = createContext(true)
const WidePanelSetterContext = createContext<(visible: boolean) => void>(() => {})

export function WidePanelProvider({ children }: { children: ReactNode }) {
  const [panelVisible, setPanelVisible] = useState(true)
  const setter = useMemo(() => setPanelVisible, [])
  return (
    <WidePanelSetterContext.Provider value={setter}>
      <WidePanelVisibleContext.Provider value={panelVisible}>{children}</WidePanelVisibleContext.Provider>
    </WidePanelSetterContext.Provider>
  )
}

export function useWidePanelVisible(): boolean {
  return useContext(WidePanelVisibleContext)
}

/** Reports the list panel. No-op outside the wide shell. */
export function useReportWidePanel(visible: boolean) {
  const setPanelVisible = useContext(WidePanelSetterContext)
  useLayoutEffect(() => {
    setPanelVisible(visible)
  }, [setPanelVisible, visible])
}
