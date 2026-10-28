// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The line a moved-from workspace shows above the composer (SHO-246, D1).
 *
 * After a move switches over, the copy that stayed behind is kept: nothing in
 * it is deleted, its schedules and triggers are off, and `movedToWorkspaceId`
 * points at the workspace that took over. Without a banner that copy is
 * indistinguishable from a live workspace, which is how someone ends up working
 * in the one that no longer runs anything.
 *
 * "Switch back" hands the schedules and triggers back to this copy, so the
 * banner disappears on its own once the API clears the field.
 */

import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ArrowRightLeft, ExternalLink } from 'lucide-react-native'
import { Text } from '../ui/text'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp, useWorkspaceCollection, useProjectCollection } from '../../contexts/domain'
import { api } from '../../lib/api'
import { openInWorkspace } from '../../lib/switch-workspace'

export function WorkspaceMovedBanner() {
  const workspace = useActiveWorkspace()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()
  const http = useDomainHttp()
  const router = useRouter()
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const targetId = (workspace as any)?.movedToWorkspaceId as string | undefined

  const switchBack = useCallback(async () => {
    if (!workspace) return
    setSwitching(true)
    setError(null)
    try {
      // The banner does not carry the move id; the workspace's own move list
      // does, and the switched-over one is the only candidate.
      const moves = await api.listWorkspaceMoves(http, workspace.id)
      const move = (moves as any[]).find((candidate) => candidate.switchedOverAt)
      if (!move) {
        setError('No switched-over move was found for this workspace.')
        return
      }
      await api.controlWorkspaceMove(http, move.id, 'switch-back')
      // The API has already flipped the schedules; re-reading the collection is
      // what removes this banner (movedToWorkspaceId goes back to null).
      await workspaces?.loadAll?.()
    } catch (err: any) {
      setError(err?.message || 'Could not switch back.')
    } finally {
      setSwitching(false)
    }
  }, [http, workspace, workspaces])

  if (!workspace || !targetId) return null

  const target = (workspaces?.all ?? []).find((candidate: any) => candidate.id === targetId)
  const targetName = target?.name ?? 'the new workspace'

  return (
    <View
      accessibilityRole="alert"
      testID="workspace-moved-banner"
      className="border-b border-border bg-muted/50 px-4 py-2"
    >
      <View className="flex-row items-center gap-2">
        <ArrowRightLeft size={14} className="text-muted-foreground" />
        <Text className="flex-1 text-xs text-foreground" numberOfLines={2}>
          Moved to {targetName}. This copy is kept, with its schedules and triggers off.
        </Text>
      </View>
      <View className="mt-2 flex-row flex-wrap gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${targetName}`}
          onPress={() =>
            openInWorkspace(router as any, targetId, '/(app)', workspace.id, projects as any)
          }
          className="flex-row items-center gap-1 rounded-md border border-border px-2 py-1"
        >
          <ExternalLink size={12} className="text-foreground" />
          <Text className="text-xs font-medium text-foreground">Open new workspace</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Switch back to this workspace"
          disabled={switching}
          onPress={() => void switchBack()}
          className="rounded-md border border-border px-2 py-1"
        >
          <Text className="text-xs font-medium text-foreground">
            {switching ? 'Switching back…' : 'Switch back'}
          </Text>
        </Pressable>
      </View>
      {error ? <Text className="mt-1 text-xs text-red-500">{error}</Text> : null}
    </View>
  )
}
