// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkspaceActivitySection
 *
 * The "who is doing what" part of Settings > Usage.
 *
 *   - Members with `workspace.analytics:read`: a per-member table (Business+) and a workspace-wide
 *     dashboard. Tapping a member drills into that person's dashboard.
 *   - Everyone else: just their own dashboard, on any plan.
 *
 * The API makes the same decisions (members are forced to themselves; the team
 * table is admin-only and Business+), so hiding things here is a convenience,
 * not the access control.
 */

import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { observer } from 'mobx-react-lite'
import { ArrowLeft } from 'lucide-react-native'
import { usePermissions } from '../../hooks/usePermissions'
import { Text } from '../settings/account-sheet-chrome'
import { UsageDashboard } from './UsageDashboard'
import { TeamWorkTable } from './TeamWorkTable'

export const WorkspaceActivitySection = observer(function WorkspaceActivitySection({
  workspaceId,
  isBusinessOrHigher,
}: {
  workspaceId: string
  isBusinessOrHigher: boolean
}) {
  const { can } = usePermissions({ workspaceId })
  const [selected, setSelected] = useState<{ userId: string; label: string } | null>(null)

  // A drill-in belongs to one workspace; switching workspaces must not carry it over.
  useEffect(() => setSelected(null), [workspaceId])

  const isAdmin = can('workspace.analytics:read')

  return (
    <View className="gap-4">
      {isAdmin && selected ? (
        <Pressable onPress={() => setSelected(null)} className="flex-row items-center gap-1.5 self-start">
          <ArrowLeft size={14} className="text-muted-foreground" />
          <Text className="text-xs font-medium text-muted-foreground">All members</Text>
        </Pressable>
      ) : null}

      {isAdmin && !selected ? (
        <TeamWorkTable
          workspaceId={workspaceId}
          locked={!isBusinessOrHigher}
          onSelectMember={(userId, label) => setSelected({ userId, label })}
        />
      ) : null}

      <UsageDashboard
        // Remount per person/workspace so a previous period or error never lingers.
        key={`${workspaceId}:${selected?.userId ?? 'all'}`}
        source={{ kind: 'workspace', workspaceId, userId: isAdmin ? selected?.userId : undefined }}
        title={
          !isAdmin ? 'Your activity' : selected ? `${selected.label}'s activity` : 'Workspace activity'
        }
        subtitle={
          !isAdmin
            ? 'Your usage and work in this workspace'
            : selected
              ? 'Usage and work for this member'
              : 'Everyone in this workspace combined'
        }
      />
    </View>
  )
})
