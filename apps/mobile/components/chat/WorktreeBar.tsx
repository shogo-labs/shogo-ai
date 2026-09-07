// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { GitBranch, GitMerge, Check, AlertTriangle, ChevronDown, ChevronRight, Users } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { agentFetch } from '../../lib/agent-fetch'

interface WorktreeStatus {
  chatSessionId: string
  branch: string
  ahead: number
  behind: number
  dirtyFiles: number
  changedFiles: string[]
}

interface WorktreesResponse {
  enabled?: boolean
  worktrees?: WorktreeStatus[]
}

export type MergeState = 'idle' | 'merging' | 'merged' | 'conflict'

export interface UseWorktreeStatusResult {
  /** True once the running agent reports per-chat worktrees are turned on. */
  enabled: boolean
  /** This chat's own worktree row, or null if it doesn't have one (yet). */
  status: WorktreeStatus | null
  /** Other chats' worktrees in the same project. */
  siblings: WorktreeStatus[]
  mergeState: MergeState
  error: string | null
  /** True when the panel should be shown at all — mirrors the old
   *  `WorktreeBar` early-return guard so callers can decide dock visibility. */
  visible: boolean
  handleMerge: () => Promise<void>
}

/**
 * BETA: per-chat git worktrees — polls this chat's worktree status and
 * exposes the merge action, decoupled from any UI so a dock panel can decide
 * whether to show itself without needing to mount the presentational view
 * first (which would create a chicken-and-egg problem: the view is what used
 * to decide "am I enabled?").
 */
export function useWorktreeStatus(
  agentUrl: string | null,
  chatSessionId: string | null,
  isStreaming: boolean,
  onSendMessage: (text: string) => void,
): UseWorktreeStatusResult {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [siblings, setSiblings] = useState<WorktreeStatus[]>([])
  const [enabled, setEnabled] = useState(false)
  const [mergeState, setMergeState] = useState<MergeState>('idle')
  const [error, setError] = useState<string | null>(null)
  const prevStreaming = useRef(isStreaming)

  const refresh = useCallback(async () => {
    if (!agentUrl || !chatSessionId) return
    try {
      const res = await agentFetch(`${agentUrl}/agent/worktrees`)
      if (!res.ok) return
      const data = (await res.json()) as WorktreesResponse
      setEnabled(!!data.enabled)
      const all = data.worktrees ?? []
      const mine = all.find(w => w.chatSessionId === chatSessionId) ?? null
      setStatus(mine)
      setSiblings(all.filter(w => w.chatSessionId !== chatSessionId))
      // If a merge was in flight and our branch is gone, it completed.
      if (!mine && (mergeState === 'merging' || mergeState === 'conflict')) {
        setMergeState('merged')
      }
    } catch {
      /* best-effort */
    }
  }, [agentUrl, chatSessionId, mergeState])

  // Initial load + reload whenever the chat changes.
  useEffect(() => {
    setMergeState('idle')
    setError(null)
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentUrl, chatSessionId])

  // Re-check after each turn completes (status/ahead changes; conflict turns
  // may have finished the merge).
  useEffect(() => {
    if (prevStreaming.current && !isStreaming) {
      void refresh()
    }
    prevStreaming.current = isStreaming
  }, [isStreaming, refresh])

  const handleMerge = useCallback(async () => {
    if (!agentUrl || !chatSessionId) return
    setError(null)
    setMergeState('merging')
    try {
      const res = await agentFetch(`${agentUrl}/agent/worktrees/${chatSessionId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = (await res.json().catch(() => ({}))) as {
        status?: string
        conflictedFiles?: string[]
        error?: string
      }
      if (!res.ok) {
        setError(data.error || 'Merge failed')
        setMergeState('idle')
        return
      }
      if (data.status === 'merged' || data.status === 'noop') {
        setMergeState('merged')
        return
      }
      if (data.status === 'conflict') {
        setMergeState('conflict')
        const files = (data.conflictedFiles ?? []).slice(0, 20)
        const fileList = files.length ? `\n\nConflicting files:\n${files.map(f => `- ${f}`).join('\n')}` : ''
        onSendMessage(
          `Merging this chat's branch into main produced merge conflicts. Resolve all conflicts in your worktree carefully, preserving the intent of both sides, then the merge will be completed automatically.${fileList}\n\nIf any conflict is genuinely ambiguous and you cannot safely decide, use the ask_user tool to ask me before resolving it.`,
        )
        return
      }
      // Unknown status — re-sync.
      void refresh()
      setMergeState('idle')
    } catch (err: any) {
      setError(err?.message || 'Merge failed')
      setMergeState('idle')
    }
  }, [agentUrl, chatSessionId, onSendMessage, refresh])

  return {
    enabled,
    status,
    siblings,
    mergeState,
    error,
    visible: enabled || mergeState !== 'idle',
    handleMerge,
  }
}

export interface WorktreeBarViewProps extends UseWorktreeStatusResult {
  isStreaming: boolean
}

/** Pure presentational body — no data fetching of its own. */
export function WorktreeBarView({ status, siblings, mergeState, error, isStreaming, handleMerge }: WorktreeBarViewProps) {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const branchShort = status?.branch?.replace(/^shogo\/chat\//, '') ?? ''
  const ahead = status?.ahead ?? 0
  const changed = status ? status.changedFiles.length + status.dirtyFiles : 0

  return (
    <View>
      <View className="flex-row items-center gap-2">
        <Pressable
          onPress={() => siblings.length > 0 && setExpanded(e => !e)}
          className="flex-row items-center gap-2 flex-1 min-w-0"
          disabled={siblings.length === 0}
        >
          <GitBranch size={13} className="text-muted-foreground" />
          <View className="flex-1 min-w-0">
          <View className="flex-row items-center gap-1">
            <Text className="text-[11px] font-medium text-foreground" numberOfLines={1}>
              {branchShort ? `chat/${branchShort.slice(0, 8)}` : 'worktree'}
            </Text>
            {siblings.length > 0 && (
              <View className="flex-row items-center gap-0.5">
                <Users size={9} className="text-muted-foreground" />
                <Text className="text-[9px] text-muted-foreground">{siblings.length}</Text>
                {expanded ? (
                  <ChevronDown size={10} className="text-muted-foreground" />
                ) : (
                  <ChevronRight size={10} className="text-muted-foreground" />
                )}
              </View>
            )}
          </View>
          {mergeState === 'merged' ? (
            <Text className="text-[10px] text-emerald-600">Merged into main</Text>
          ) : mergeState === 'conflict' ? (
            <Text className="text-[10px] text-amber-600">Resolving merge conflicts…</Text>
          ) : (
            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
              {ahead > 0 ? `${ahead} ahead of main` : 'up to date with main'}
              {changed > 0 ? ` · ${changed} file${changed !== 1 ? 's' : ''} changed` : ''}
            </Text>
          )}
          </View>
        </Pressable>

        {mergeState === 'merged' ? (
          <View className="flex-row items-center gap-1 px-1.5 py-1">
            <Check size={12} className="text-emerald-600" />
          </View>
        ) : mergeState === 'merging' ? (
          <ActivityIndicator size="small" />
        ) : mergeState === 'conflict' ? (
          <AlertTriangle size={13} className="text-amber-600" />
        ) : confirming ? (
          <View className="flex-row items-center gap-1.5">
            <Pressable
              onPress={() => {
                setConfirming(false)
                void handleMerge()
              }}
              className="px-2 py-1 rounded-md bg-primary active:bg-primary/80"
            >
              <Text className="text-[10px] font-semibold text-primary-foreground">Merge</Text>
            </Pressable>
            <Pressable
              onPress={() => setConfirming(false)}
              className="px-2 py-1 rounded-md border border-border active:bg-muted"
            >
              <Text className="text-[10px] font-medium text-foreground">Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={() => setConfirming(true)}
            disabled={isStreaming}
            className={cn(
              'flex-row items-center gap-1 px-2 py-1 rounded-md border border-border active:bg-muted',
              isStreaming && 'opacity-50',
            )}
          >
            <GitMerge size={12} className="text-foreground" />
            <Text className="text-[10px] font-medium text-foreground">Mark done & merge</Text>
          </Pressable>
        )}
      </View>

      {expanded && siblings.length > 0 && (
        <View className="mt-1.5 pt-1.5 border-t border-border/60 gap-1">
          <Text className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            Other chats in this project
          </Text>
          {siblings.map((w) => {
            const sb = w.branch.replace(/^shogo\/chat\//, '').slice(0, 8)
            const sChanged = w.changedFiles.length + w.dirtyFiles
            return (
              <View key={w.chatSessionId} className="flex-row items-center gap-2">
                <GitBranch size={11} className="text-muted-foreground" />
                <Text className="text-[10px] text-foreground flex-1" numberOfLines={1}>
                  chat/{sb}
                </Text>
                <Text className="text-[9px] text-muted-foreground" numberOfLines={1}>
                  {w.ahead > 0 ? `${w.ahead} ahead` : 'up to date'}
                  {sChanged > 0 ? ` · ${sChanged} changed` : ''}
                </Text>
              </View>
            )
          })}
        </View>
      )}

      {error && <Text className="text-[10px] text-destructive mt-1">{error}</Text>}
    </View>
  )
}
