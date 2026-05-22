// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectSourceMenu — consolidated "where does this project come from?" picker.
 *
 * Surfaces the three ways a user can start a project in one popover:
 *   1. **Blank** — a managed Shogo project. The composer's Send button
 *      already produces this; the menu entry exists as an explicit
 *      affordance so users know "just typing here = new blank project."
 *   2. **Open folder…** — VS Code-style external project that points at
 *      a folder on the user's machine. Uses the OS-native file selector
 *      (Electron's `dialog.showOpenDialog` via the desktop preload), so
 *      this row is hidden whenever that bridge isn't available (web
 *      browser tabs, `bun dev:all`, native mobile). The browser File
 *      System Access API can't substitute because it doesn't expose
 *      absolute paths, which the backend's validation gauntlet requires.
 *   3. **Import .shogo-project…** — restore a previously-exported
 *      project ZIP via `ProjectImportModal`.
 *
 * Two visual variants:
 *   - 'chip'    — small toolbar pill, matches the model / mode chips
 *                 on the home composer. Triggered next to those.
 *   - 'button'  — full-height filled button, matches the action row on
 *                 the `/projects` list page. Replaces the standalone
 *                 "Import" button there.
 *
 * The import modal is mounted internally, so the parent only renders
 * this one element.
 */
import React, { useCallback, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from '../ui/popover'
import {
  FilePlus2,
  FolderOpen,
  Sparkles,
  ChevronDown,
  Check,
  Download,
} from 'lucide-react-native'
import { ProjectImportModal } from '../projects/ProjectImportModal'
import { useOpenLocalFolder } from './useOpenLocalFolder'

export type ProjectSourceVariant = 'chip' | 'button'

export interface ProjectSourceMenuProps {
  workspaceId: string | undefined
  variant?: ProjectSourceVariant
  /**
   * Handler invoked when the user picks "Blank project" from the menu.
   * On the home composer this is typically a no-op (the composer itself
   * is the blank-project surface) — passing nothing means "just close
   * the menu." On `/projects` we route to home so the user lands on the
   * composer.
   */
  onSelectBlank?: () => void
  /**
   * Called after the folder picker / importer has produced a Project.
   * If omitted, the underlying hooks navigate to the new project page
   * themselves. `name` is guaranteed non-empty (callers fall back to
   * "Untitled" if the API omits one).
   */
  onProjectOpened?: (project: { id: string; name: string }) => void
}

export function ProjectSourceMenu({
  workspaceId,
  variant = 'chip',
  onSelectBlank,
  onProjectOpened,
}: ProjectSourceMenuProps) {
  const [open, setOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const {
    openFolder,
    isPicking,
    isAvailable: canOpenFolder,
  } = useOpenLocalFolder({
    workspaceId,
    onSuccess: onProjectOpened,
  })

  const handleSelectBlank = useCallback(() => {
    setOpen(false)
    onSelectBlank?.()
  }, [onSelectBlank])

  const handleSelectFolder = useCallback(() => {
    setOpen(false)
    void openFolder()
  }, [openFolder])

  const handleSelectImport = useCallback(() => {
    setOpen(false)
    setImportOpen(true)
  }, [])

  const handleImportCompleted = useCallback(
    (project: { id: string; name: string }) => {
      setImportOpen(false)
      onProjectOpened?.(project)
    },
    [onProjectOpened],
  )

  const trigger = (triggerProps: any) =>
    variant === 'chip' ? (
      <Pressable
        {...triggerProps}
        accessibilityLabel="Project source"
        className={cn(
          'h-[22px] flex-row items-center gap-1 rounded-md px-1.5',
          'border border-border/60 bg-muted/40 active:opacity-80',
          isPicking && 'opacity-60',
        )}
        testID="project-source-menu-trigger"
      >
        <Sparkles className="h-3 w-3 text-muted-foreground" size={12} />
        <Text className="text-[11px] text-muted-foreground">New</Text>
        <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
      </Pressable>
    ) : (
      <Pressable
        {...triggerProps}
        accessibilityLabel="New project"
        className={cn(
          'flex-row items-center gap-1.5 px-3 py-2 rounded-lg',
          'bg-primary active:opacity-80',
          isPicking && 'opacity-70',
        )}
        testID="project-source-menu-trigger"
      >
        <FilePlus2 size={14} className="text-primary-foreground" />
        <Text className="text-xs font-medium text-primary-foreground">New project</Text>
        <ChevronDown size={12} className="text-primary-foreground/70" />
      </Pressable>
    )

  // Match the popover position to where the trigger lives: composer
  // chips are at the bottom of the screen (open upward) and the
  // /projects "+ New project" button sits in the page header (open
  // downward). Wrong placement clips the menu off-screen.
  const placement: 'top' | 'bottom left' = variant === 'chip' ? 'top' : 'bottom left'

  return (
    <>
      <Popover
        placement={placement}
        size="xs"
        isOpen={open}
        onOpen={() => setOpen(true)}
        onClose={() => setOpen(false)}
        trigger={trigger}
      >
        <PopoverBackdrop />
        <PopoverContent className="w-[280px] p-0">
          <View className="py-1">
            {/* Blank project — the implicit default of the composer. We
                still render it explicitly so the menu reads as a
                complete set of choices, not "two random alternatives." */}
            <Pressable
              onPress={handleSelectBlank}
              className="flex-row items-center gap-3 p-3 rounded-lg active:bg-muted"
            >
              <View className="w-8 items-center">
                <Sparkles size={16} className="text-muted-foreground" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">Blank project</Text>
                <Text className="text-[11px] text-muted-foreground">
                  Describe what you want to build. Shogo creates the project for you.
                </Text>
              </View>
              {/* The check mark advertises "this is what Send does." */}
              <Check size={14} className="text-primary" />
            </Pressable>

            {canOpenFolder ? (
              <Pressable
                onPress={handleSelectFolder}
                disabled={isPicking}
                className="flex-row items-center gap-3 p-3 rounded-lg active:bg-muted"
              >
                <View className="w-8 items-center">
                  <FolderOpen size={16} className="text-muted-foreground" />
                </View>
                <View className="flex-1">
                  <Text className="text-sm font-medium text-foreground">Open folder…</Text>
                  <Text className="text-[11px] text-muted-foreground">
                    Pick a folder on this machine with the system file dialog.
                  </Text>
                </View>
              </Pressable>
            ) : null}

            <Pressable
              onPress={handleSelectImport}
              className="flex-row items-center gap-3 p-3 rounded-lg active:bg-muted"
            >
              <View className="w-8 items-center">
                <Download size={16} className="text-muted-foreground" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">Import .shogo-project…</Text>
                <Text className="text-[11px] text-muted-foreground">
                  Restore a project previously exported from Shogo.
                </Text>
              </View>
            </Pressable>
          </View>
        </PopoverContent>
      </Popover>

      {/* Import modal lives here so the menu is the single owner. */}
      {workspaceId ? (
        <ProjectImportModal
          open={importOpen}
          onOpenChange={setImportOpen}
          workspaceId={workspaceId}
          onOpenProject={handleImportCompleted}
        />
      ) : null}
    </>
  )
}
