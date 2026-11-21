// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The "Working set" chat-dock panel (SHO-484).
 *
 * The projects a workspace chat can use used to be their own row between the
 * header and the transcript, which on a phone also paid the floating header's
 * clearance a second time. It is now one panel in the chat dock above the
 * composer — the same place plan, checklist, queue and the rest already live —
 * so both surfaces get one chip strip and the transcript keeps its single
 * top padding.
 *
 * Built as a descriptor (not a component) because the host screen renders
 * above `ChatPanel` and cannot register with the chat's dock store from there:
 * it hands the descriptor down through `ChatPanel`'s `dockPanels` prop.
 */

import { Pressable, Text, View } from "react-native"
import { FolderKanban, SlidersHorizontal } from "lucide-react-native"
import type { DockPanelDescriptor } from "../../lib/chat-dock-store"

/** The bit of a session attachment this panel needs. */
export interface WorkingSetAttachment {
  id: string
  projectId: string
}

export interface WorkingSetDockPanelOptions {
  attachments: WorkingSetAttachment[]
  /** The project the next prompt goes to; its chip is the highlighted one. */
  focusedProjectId: string | null
  projectName: (projectId: string) => string
  /**
   * Whether a project can open beside this chat (SHO-427). Chips then select
   * the side pane; without a side slot they open the project page instead.
   */
  hasSidePane: boolean
  /** The project currently in the side pane, when there is one. */
  paneProjectId: string | null
  onPressChip: (projectId: string) => void
  onManage: () => void
}

export function buildWorkingSetDockPanel({
  attachments,
  focusedProjectId,
  projectName,
  hasSidePane,
  paneProjectId,
  onPressChip,
  onManage,
}: WorkingSetDockPanelOptions): DockPanelDescriptor {
  const focusedId = focusedProjectId ?? attachments[0]?.projectId ?? null
  const focusedName = focusedId ? projectName(focusedId) : undefined
  const extra = attachments.length - 1
  const summary =
    focusedName && extra > 0 ? `${focusedName} +${extra}` : focusedName

  return {
    id: "working-set",
    kind: "status",
    order: 5,
    title: "Working set",
    icon: FolderKanban,
    summary,
    defaultExpanded: false,
    // Keep the scope sheet one tap away while the panel is collapsed.
    headerActions: (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Manage project scope"
        testID="working-set-manage"
        onPress={onManage}
        className="h-7 w-7 items-center justify-center rounded-full active:bg-muted"
      >
        <SlidersHorizontal size={14} className="text-muted-foreground" />
      </Pressable>
    ),
    render: () => (
      // Wrapping chips, not the old horizontal ScrollView: the dock is as wide
      // as the composer, so a long working set wraps instead of scrolling.
      <View
        className="flex-row flex-wrap items-center gap-2"
        testID="working-set-projects"
      >
        {attachments.map((attachment) => {
          const name = projectName(attachment.projectId)
          const shown = hasSidePane
            ? paneProjectId === attachment.projectId
            : attachment.projectId === focusedId
          return (
            <Pressable
              key={attachment.id}
              accessibilityRole="button"
              accessibilityLabel={`${name} project`}
              accessibilityHint={
                hasSidePane
                  ? shown
                    ? "Closes the project beside this chat"
                    : "Shows the project beside this chat"
                  : "Opens this project"
              }
              aria-selected={shown}
              testID={`working-set-project-${attachment.projectId}`}
              onPress={() => onPressChip(attachment.projectId)}
              className={`max-w-[190px] rounded-full border px-2.5 py-1 active:bg-muted ${
                shown ? "border-primary bg-primary/10" : "border-border bg-card"
              }`}
            >
              <Text
                className={`text-xs font-medium ${
                  shown ? "text-primary" : "text-foreground"
                }`}
                numberOfLines={1}
              >
                {name}
              </Text>
            </Pressable>
          )
        })}
      </View>
    ),
  }
}
