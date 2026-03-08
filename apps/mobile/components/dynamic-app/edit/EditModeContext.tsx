// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'
import type { ComponentDefinition, SurfaceState } from '@shogo/shared-app/dynamic-app'

export interface EditAction {
  action: 'update' | 'add' | 'delete' | 'move'
  surfaceId: string
  componentId?: string
  componentIds?: string[]
  changes?: Record<string, unknown>
  component?: Record<string, unknown>
  parentId?: string
  newParentId?: string
  index?: number
}

export interface EditActionResult {
  ok?: boolean
  newComponentId?: string
  [key: string]: unknown
}

interface EditModeContextValue {
  isEditMode: boolean
  toggleEditMode: () => void
  selectedComponentId: string | null
  selectComponent: (id: string | null) => void
  showTreePanel: boolean
  toggleTreePanel: () => void
  updateComponentProp: (surfaceId: string, componentId: string, propKey: string, value: unknown) => Promise<void>
  updateComponentProps: (surfaceId: string, componentId: string, changes: Record<string, unknown>) => Promise<void>
  addComponent: (surfaceId: string, parentId: string, componentType: string, index?: number) => Promise<string | null>
  deleteComponent: (surfaceId: string, componentId: string) => Promise<void>
  moveComponent: (surfaceId: string, componentId: string, newParentId: string, index?: number) => Promise<void>
}

const EditModeContext = createContext<EditModeContextValue | null>(null)

export function useEditMode() {
  const ctx = useContext(EditModeContext)
  if (!ctx) throw new Error('useEditMode must be used within EditModeProvider')
  return ctx
}

export function useEditModeOptional() {
  return useContext(EditModeContext)
}

interface EditModeProviderProps {
  agentUrl?: string | null
  /** Local edit handler -- when provided, edits are applied locally instead of via HTTP */
  onEditAction?: (action: EditAction) => EditActionResult | Promise<EditActionResult>
  children: ReactNode
}

export function EditModeProvider({ agentUrl, onEditAction, children }: EditModeProviderProps) {
  const [isEditMode, setIsEditMode] = useState(false)
  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null)
  const [showTreePanel, setShowTreePanel] = useState(false)

  const toggleEditMode = useCallback(() => {
    setIsEditMode((prev) => {
      if (prev) {
        setSelectedComponentId(null)
        setShowTreePanel(false)
      }
      return !prev
    })
  }, [])

  const selectComponent = useCallback((id: string | null) => {
    setSelectedComponentId(id)
  }, [])

  const toggleTreePanel = useCallback(() => {
    setShowTreePanel((prev) => !prev)
  }, [])

  const dispatchEdit = useCallback(async (action: EditAction): Promise<EditActionResult | null> => {
    if (onEditAction) {
      return await onEditAction(action)
    }
    if (!agentUrl) return null
    try {
      const res = await fetch(`${agentUrl}/agent/dynamic-app/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      })
      return await res.json()
    } catch (err) {
      console.error('[EditMode] Failed to call edit endpoint:', err)
      return null
    }
  }, [agentUrl, onEditAction])

  const updateComponentProp = useCallback(async (surfaceId: string, componentId: string, propKey: string, value: unknown) => {
    await dispatchEdit({
      action: 'update',
      surfaceId,
      componentId,
      changes: { [propKey]: value },
    })
  }, [dispatchEdit])

  const updateComponentProps = useCallback(async (surfaceId: string, componentId: string, changes: Record<string, unknown>) => {
    await dispatchEdit({
      action: 'update',
      surfaceId,
      componentId,
      changes,
    })
  }, [dispatchEdit])

  const addComponent = useCallback(async (surfaceId: string, parentId: string, componentType: string, index?: number): Promise<string | null> => {
    const result = await dispatchEdit({
      action: 'add',
      surfaceId,
      parentId,
      component: { component: componentType },
      index,
    })
    return result?.newComponentId ?? null
  }, [dispatchEdit])

  const deleteComponent = useCallback(async (surfaceId: string, componentId: string) => {
    await dispatchEdit({
      action: 'delete',
      surfaceId,
      componentId,
    })
    setSelectedComponentId((prev) => (prev === componentId ? null : prev))
  }, [dispatchEdit])

  const moveComponent = useCallback(async (surfaceId: string, componentId: string, newParentId: string, index?: number) => {
    await dispatchEdit({
      action: 'move',
      surfaceId,
      componentId,
      newParentId,
      index,
    })
  }, [dispatchEdit])

  const value = useMemo<EditModeContextValue>(() => ({
    isEditMode,
    toggleEditMode,
    selectedComponentId,
    selectComponent,
    showTreePanel,
    toggleTreePanel,
    updateComponentProp,
    updateComponentProps,
    addComponent,
    deleteComponent,
    moveComponent,
  }), [
    isEditMode, toggleEditMode, selectedComponentId, selectComponent,
    showTreePanel, toggleTreePanel,
    updateComponentProp, updateComponentProps, addComponent, deleteComponent, moveComponent,
  ])

  return (
    <EditModeContext.Provider value={value}>
      {children}
    </EditModeContext.Provider>
  )
}
