// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Native (iOS/Android) GitKraken-style commit graph for the Checkpoint
// screen. Mirrors the web GraphView but renders with react-native-svg
// instead of raw HTML/SVG. The lane-layout math is shared via the pure
// `computeGraphLayout` module so web and native stay visually consistent.
//
// Data is the project workspace's real git history (useGitGraph -> the
// /git/graph API which runs `git log` on each project's .git). Checkpoint
// metadata is overlaid so checkpoint commits are highlighted and offer
// rollback on tap.

import { useCallback, useMemo, useState } from 'react'
import { View, Text, Pressable, ScrollView, ActivityIndicator } from 'react-native'
import Svg, { Path, Line, Circle, Text as SvgText, G } from 'react-native-svg'
import {
  AlertTriangle,
  BookmarkPlus,
  GitBranch,
  RefreshCw,
  Rocket,
} from 'lucide-react-native'

import {
  useCheckpoints,
  useGitGraph,
  usePublishState,
  type Checkpoint,
} from '@shogo/shared-app/hooks'
import { API_URL } from '../../../../../lib/api'
import { authClient } from '../../../../../lib/auth-client'
import { buildDisplayRows } from './displayRows'
import {
  NODE_RADIUS,
  ROW_HEIGHT,
  graphWidth,
  laneCenterX,
  type DisplayRow,
} from './types'
import { avatarColor, initials, isAiAuthor, relativeTime } from './gitAvatar'
import { CreateCheckpointModal, RollbackConfirmModal } from '../../CheckpointModals'

const CHECKPOINT_RING = '#f59e0b'
const LIVE_RING = '#10b981'

export function CheckpointGraphNative({ projectId }: { projectId: string }) {
  const nativeHeaders = useMemo(
    () =>
      (): Record<string, string> => {
        const cookie = (authClient as any).getCookie?.()
        return cookie ? { Cookie: cookie } : {}
      },
    [],
  )

  const graph = useGitGraph(projectId, { baseUrl: API_URL, headers: nativeHeaders })
  const publish = usePublishState(projectId, { baseUrl: API_URL, headers: nativeHeaders })
  const {
    checkpoints,
    rollback,
    createCheckpoint,
    isMutating,
    disabledForExternalMode: checkpointsDisabled,
    refetch: refetchCheckpoints,
  } = useCheckpoints(projectId, { baseUrl: API_URL, headers: nativeHeaders })

  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [rollbackTarget, setRollbackTarget] = useState<Checkpoint | null>(null)

  // sha -> checkpoint, so we can highlight and offer rollback on the matching
  // commit node.
  const checkpointBySha = useMemo(() => {
    const m = new Map<string, Checkpoint>()
    for (const cp of checkpoints) m.set(cp.commitSha, cp)
    return m
  }, [checkpoints])

  // Resolve the live commit from the stable `published/<subdomain>` pointer tag
  // (falling back to the recorded sha). Mirrors the web GraphView.
  const livePointerTag = publish.subdomain ? `published/${publish.subdomain}` : null
  const liveSha = useMemo(() => {
    if (!publish.isPublished) return null
    if (livePointerTag) {
      const byTag = graph.commits.find((c) =>
        c.refs.some((r) => r.type === 'tag' && r.name === livePointerTag),
      )
      if (byTag) return byTag.sha
    }
    return publish.publishedCommitSha ?? null
  }, [publish.isPublished, publish.publishedCommitSha, livePointerTag, graph.commits])

  const { rows, maxLanes } = useMemo(() => {
    const checkpointShas = new Set(checkpointBySha.keys())
    return buildDisplayRows(graph.commits, graph.workingStatus, checkpointShas, liveSha)
  }, [graph.commits, graph.workingStatus, checkpointBySha, liveSha])

  const handleRowPress = useCallback(
    (row: DisplayRow) => {
      if (row.kind !== 'commit' || !row.sha) return
      setSelectedSha(row.sha)
      const cp = checkpointBySha.get(row.sha)
      if (cp) setRollbackTarget(cp)
    },
    [checkpointBySha],
  )

  const handleCreate = useCallback(
    async (opts: { message: string; name?: string; description?: string }) => {
      setShowCreate(false)
      const created = await createCheckpoint(opts)
      if (created) {
        graph.refetch()
        refetchCheckpoints()
      }
    },
    [createCheckpoint, graph, refetchCheckpoints],
  )

  const handleRollback = useCallback(async () => {
    if (!rollbackTarget) return
    setRollbackTarget(null)
    const ok = await rollback(rollbackTarget.id)
    if (ok) {
      graph.refetch()
      refetchCheckpoints()
    }
  }, [rollbackTarget, rollback, graph, refetchCheckpoints])

  const canCreate = !graph.disabledForExternalMode && !checkpointsDisabled
  const gWidth = graphWidth(maxLanes)
  const totalHeight = rows.length * ROW_HEIGHT

  return (
    <View className="h-full w-full flex-col bg-background">
      {/* Header */}
      <View className="px-4 py-3 border-b border-border flex-row items-center justify-between">
        <View className="flex-row items-center gap-2 flex-1 min-w-0">
          <GitBranch size={14} className="text-muted-foreground" />
          <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
            {graph.currentBranch ?? 'Checkpoints'}
          </Text>
          {graph.commits.length > 0 && (
            <View className="bg-muted rounded-full px-1.5 py-0.5">
              <Text className="text-[10px] font-medium text-muted-foreground">
                {graph.commits.length}
              </Text>
            </View>
          )}
        </View>
        <View className="flex-row items-center gap-2">
          {canCreate && (
            <Pressable
              onPress={() => setShowCreate(true)}
              disabled={isMutating}
              className="flex-row items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 active:opacity-80"
            >
              <BookmarkPlus size={14} className="text-primary-foreground" />
              <Text className="text-xs font-medium text-primary-foreground">Create</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => graph.refetch()}
            className="p-1.5 rounded-lg border border-border active:bg-muted"
          >
            <RefreshCw size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      {/* Content */}
      {graph.disabledForExternalMode ? (
        <View className="flex-1 px-6 pt-10 items-center">
          <GitBranch size={28} className="text-muted-foreground mb-3" />
          <Text className="text-base font-semibold text-foreground mb-2 text-center">
            Graph is off in folder mode
          </Text>
          <Text className="text-sm text-muted-foreground text-center">
            This project is linked to a folder on your machine. Use your own git client for history
            on local folders.
          </Text>
        </View>
      ) : graph.isLoading && graph.commits.length === 0 ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground text-sm mt-3">Loading commit graph...</Text>
        </View>
      ) : graph.error ? (
        <View className="flex-1 items-center justify-center px-6">
          <AlertTriangle size={24} className="text-destructive mb-2" />
          <Text className="text-sm text-destructive text-center">{graph.error.message}</Text>
          <Pressable
            onPress={() => graph.refetch()}
            className="mt-3 px-4 py-2 rounded-lg border border-border active:bg-muted"
          >
            <Text className="text-sm font-medium text-foreground">Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View className="flex-1 items-center justify-center px-6">
          <GitBranch size={32} className="text-muted-foreground mb-3" />
          <Text className="text-base font-semibold text-foreground mb-1">No commits yet</Text>
          <Text className="text-sm text-muted-foreground text-center">
            Checkpoints are snapshots of your project. Create one before making major changes so you
            can always go back.
          </Text>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 16 }}>
          <View className="flex-row" style={{ minHeight: totalHeight }}>
            {/* Graph column (svg lanes + nodes) */}
            <View style={{ width: gWidth, height: totalHeight }}>
              <GraphSvg rows={rows} width={gWidth} height={totalHeight} selectedSha={selectedSha} />
            </View>

            {/* Message column */}
            <View className="flex-1">
              {rows.map((row, i) => (
                <MessageRow
                  key={row.sha ?? `wip-${i}`}
                  row={row}
                  selected={!!row.sha && row.sha === selectedSha}
                  onPress={() => handleRowPress(row)}
                />
              ))}
            </View>
          </View>

          {graph.hasMore && (
            <Pressable
              onPress={() => graph.loadMore()}
              disabled={graph.isLoadingMore}
              className="mx-4 mt-2 flex-row items-center justify-center gap-2 rounded-lg border border-border py-2 active:bg-muted"
            >
              {graph.isLoadingMore && <ActivityIndicator size="small" />}
              <Text className="text-xs font-medium text-foreground">Load more</Text>
            </Pressable>
          )}
        </ScrollView>
      )}

      <CreateCheckpointModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        isMutating={isMutating}
      />
      <RollbackConfirmModal
        visible={rollbackTarget !== null}
        checkpoint={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={handleRollback}
        isMutating={isMutating}
      />
    </View>
  )
}

function GraphSvg({
  rows,
  width,
  height,
  selectedSha,
}: {
  rows: DisplayRow[]
  width: number
  height: number
  selectedSha: string | null
}) {
  return (
    <Svg width={width} height={height}>
      {/* Lane connectors (drawn first so nodes sit on top) */}
      {rows.map((row, i) => {
        const topY = i * ROW_HEIGHT + ROW_HEIGHT / 2
        const bottomY = (i + 1) * ROW_HEIGHT + ROW_HEIGHT / 2
        return row.edges.map((e, j) => {
          const x1 = laneCenterX(e.fromLane)
          const x2 = laneCenterX(e.toLane)
          if (x1 === x2) {
            return (
              <Line
                key={`e-${i}-${j}`}
                x1={x1}
                y1={topY}
                x2={x2}
                y2={bottomY}
                stroke={e.color}
                strokeWidth={2}
              />
            )
          }
          const midY = (topY + bottomY) / 2
          const d = `M ${x1} ${topY} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${bottomY}`
          return <Path key={`e-${i}-${j}`} d={d} fill="none" stroke={e.color} strokeWidth={2} />
        })
      })}

      {/* Commit / WIP nodes */}
      {rows.map((row, i) => {
        const cx = laneCenterX(row.lane)
        const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2
        const selected = !!row.sha && row.sha === selectedSha

        if (row.kind === 'wip') {
          return (
            <Circle
              key={`n-wip-${i}`}
              cx={cx}
              cy={cy}
              r={NODE_RADIUS}
              fill="transparent"
              stroke={row.color}
              strokeWidth={2}
              strokeDasharray="3,3"
            />
          )
        }

        const commit = row.commit!
        const ai = isAiAuthor(commit.author, commit.authorEmail)
        const bg = ai ? '#e0457b' : avatarColor(commit.authorEmail || commit.author)
        return (
          <G key={`n-${row.sha}`}>
            {row.isLive && (
              <Circle
                cx={cx}
                cy={cy}
                r={NODE_RADIUS + (row.isCheckpoint ? 4.5 : 2.5)}
                fill="transparent"
                stroke={LIVE_RING}
                strokeWidth={2}
              />
            )}
            {row.isCheckpoint && (
              <Circle
                cx={cx}
                cy={cy}
                r={NODE_RADIUS + 2.5}
                fill="transparent"
                stroke={CHECKPOINT_RING}
                strokeWidth={2}
              />
            )}
            <Circle
              cx={cx}
              cy={cy}
              r={NODE_RADIUS}
              fill={bg}
              stroke={selected ? '#ffffff' : 'rgba(0,0,0,0.4)'}
              strokeWidth={selected ? 2 : 1}
            />
            <SvgText
              x={cx}
              y={cy + 3}
              fontSize={8}
              fontWeight="bold"
              fill="#ffffff"
              textAnchor="middle"
            >
              {ai ? 'S' : initials(commit.author)}
            </SvgText>
          </G>
        )
      })}
    </Svg>
  )
}

function MessageRow({
  row,
  selected,
  onPress,
}: {
  row: DisplayRow
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      className={selected ? 'bg-muted' : undefined}
      style={{ height: ROW_HEIGHT }}
    >
      <View className="flex-1 flex-row items-center gap-2 pr-3">
        {row.kind === 'wip' ? (
          <>
            <Text className="text-xs font-mono text-muted-foreground">// WIP</Text>
            {row.wipCount ? (
              <Text className="text-[10px] text-emerald-500">+{row.wipCount}</Text>
            ) : null}
          </>
        ) : (
          <>
            {row.isLive && <Rocket size={11} color={LIVE_RING} />}
            {row.isCheckpoint && (
              <BookmarkPlus size={11} color={CHECKPOINT_RING} />
            )}
            <Text className="text-[13px] text-foreground flex-1" numberOfLines={1}>
              {row.commit!.subject}
            </Text>
            <Text className="text-[10px] text-muted-foreground">
              {relativeTime(row.commit!.date)}
            </Text>
            <Text className="text-[10px] font-mono text-muted-foreground">
              {row.commit!.shortSha}
            </Text>
          </>
        )}
      </View>
    </Pressable>
  )
}
