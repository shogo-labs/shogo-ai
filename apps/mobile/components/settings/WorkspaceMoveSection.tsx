// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Data: move a workspace (or part of it) between desktop and cloud.
 *
 * The flow is the plan's: direction → whole workspace or chosen channels and
 * projects → review (bytes, what the ignores save, quota, what has to be
 * reconnected) → progress → "Switch over". Nothing here decides what travels;
 * the API's plan step does, and this screen shows exactly what it said.
 *
 * The one thing this screen must never do is imply that both copies run at once:
 * schedules and triggers arrive at the target **off**, and "Switch over" is the
 * only thing that moves them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, View } from 'react-native'
import { observer } from 'mobx-react-lite'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { api } from '../../lib/api'
import { Button, Card, CardContent } from '@shogo/shared-ui/primitives'
import { Text } from './account-sheet-chrome'

type Direction = 'desktop_to_cloud' | 'cloud_to_desktop'

interface Plan {
  source: { workspaceId: string; name: string }
  target: { name: string }
  totals: { models: number; rows: number; files: number; bytes: number; filesIgnored: number; bytesIgnored: number }
  projects: Array<{ id: string; name: string; mode: 'copy' | 'git-relink'; files: number; bytes: number; git?: { remote: string; branch: string } }>
  ignores: { rules: string[]; files: number; bytes: number }
  quota: { limitBytes: number | null; neededBytes: number; ok: boolean }
  credentials: Array<{ channel: string; field: string; label: string }>
  handover: { schedules: number; triggers: number }
  warnings: string[]
  selection: {
    conversations: Array<{ id: string; name: string; kind: string }>
    projects: Array<{ id: string; name: string }>
  }
}

interface Move {
  id: string
  status: string
  direction: Direction
  sourceName: string
  targetName: string | null
  targetWorkspaceId: string | null
  rowsCopied: number
  filesCopied: number
  bytesCopied: number
  error: string | null
  switchedOverAt: string | null
  plan: Plan | null
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const STATUS_LABEL: Record<string, string> = {
  planning: 'Planning…',
  records: 'Copying records…',
  files: 'Copying files…',
  handover: 'Finishing…',
  paused: 'Paused',
  done: 'Copied — ready to switch over',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const WorkspaceMoveSection = observer(function WorkspaceMoveSection() {
  const workspace = useActiveWorkspace()
  const http = useDomainHttp()
  const workspaceId = workspace?.id

  const [direction, setDirection] = useState<Direction>('desktop_to_cloud')
  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [conversationIds, setConversationIds] = useState<string[]>([])
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [options, setOptions] = useState<{
    conversations: Plan['selection']['conversations']
    projects: Plan['selection']['projects']
    desktop: { linked: boolean; name: string | null; lastSeenAt: string | null }
  } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [move, setMove] = useState<Move | null>(null)
  const [busy, setBusy] = useState<'plan' | 'start' | 'action' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const selection = useMemo(
    () => (mode === 'all' ? { mode: 'all' as const } : { mode: 'selected' as const, conversationIds, projectIds }),
    [mode, conversationIds, projectIds],
  )

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void (async () => {
      try {
        const data = await api.getWorkspaceMoveOptions(http, workspaceId)
        if (!cancelled) setOptions(data)
      } catch (err: any) {
        if (!cancelled) setError(err?.message || 'Could not list channels and projects.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [http, workspaceId])

  const stopPolling = useCallback(() => {
    if (poll.current) {
      clearInterval(poll.current)
      poll.current = null
    }
  }, [])

  const watch = useCallback(
    (moveId: string) => {
      stopPolling()
      poll.current = setInterval(async () => {
        try {
          const next = (await api.getWorkspaceMove(http, moveId)) as Move
          setMove(next)
          if (['done', 'failed', 'cancelled'].includes(next.status)) stopPolling()
        } catch {
          // A dropped poll is not a failed move; the next tick retries.
        }
      }, 2000)
    },
    [http, stopPolling],
  )

  useEffect(() => stopPolling, [stopPolling])

  const review = useCallback(async () => {
    if (!workspaceId) return
    setBusy('plan')
    setError(null)
    try {
      const next = (await api.planWorkspaceMove(http, {
        workspaceId,
        direction,
        selection,
        targetKind: direction === 'cloud_to_desktop' ? 'desktop' : 'cloud',
      })) as Plan
      setPlan(next)
    } catch (err: any) {
      setError(err?.message || 'Could not plan this move.')
      setPlan(null)
    } finally {
      setBusy(null)
    }
  }, [direction, http, selection, workspaceId])

  const start = useCallback(async () => {
    if (!workspaceId) return
    setBusy('start')
    setError(null)
    try {
      const created = await api.createWorkspaceMove(http, {
        workspaceId,
        direction,
        selection,
        targetKind: direction === 'cloud_to_desktop' ? 'desktop' : 'cloud',
      })
      setMove(created.move as Move)
      setPlan(created.plan as Plan)
      watch(created.move.id)
    } catch (err: any) {
      setError(err?.message || 'The move could not be started.')
    } finally {
      setBusy(null)
    }
  }, [direction, http, selection, watch, workspaceId])

  const act = useCallback(
    async (action: 'pause' | 'resume' | 'cancel' | 'switch-over' | 'switch-back') => {
      if (!move) return
      setBusy('action')
      setError(null)
      try {
        await api.controlWorkspaceMove(http, move.id, action)
        const next = (await api.getWorkspaceMove(http, move.id)) as Move
        setMove(next)
        if (action === 'resume') watch(move.id)
      } catch (err: any) {
        setError(err?.message || 'That action did not go through.')
      } finally {
        setBusy(null)
      }
    },
    [http, move, watch],
  )

  if (!workspaceId) return null

  const shown = plan ?? move?.plan ?? null
  const running = move ? ['planning', 'records', 'files', 'handover'].includes(move.status) : false
  // A cloud -> desktop move is driven by the desktop, so on the web it can only
  // start once a machine is linked. Without this the section offers a move that
  // can never run (plan §4).
  const needsDesktop =
    direction === 'cloud_to_desktop' && Platform.OS === 'web' && !(options?.desktop?.linked ?? false)

  return (
    <Card>
      <CardContent className="gap-3 p-4">
        <Text className="text-base font-semibold">Move workspace</Text>
        <Text className="text-sm text-muted-foreground">
          Take this workspace — or just some of its channels and projects — to the other side
          without a zip. Schedules and triggers arrive switched off, so nothing runs twice; the
          copy you leave behind is kept and marked as moved.
        </Text>

        <View className="flex-row gap-2">
          {(
            [
              ['desktop_to_cloud', 'Desktop → Cloud'],
              ['cloud_to_desktop', 'Cloud → Desktop'],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              onPress={() => {
                setDirection(value)
                setPlan(null)
              }}
              className={`flex-1 rounded-lg border px-3 py-2 ${
                direction === value ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              <Text className="text-center text-sm">{label}</Text>
            </Pressable>
          ))}
        </View>

        <View className="flex-row gap-2">
          {(
            [
              ['all', 'Whole workspace'],
              ['selected', 'Channels & agents'],
            ] as const
          ).map(([value, label]) => (
            <Pressable
              key={value}
              onPress={() => {
                setMode(value)
                setPlan(null)
              }}
              className={`flex-1 rounded-lg border px-3 py-2 ${
                mode === value ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              <Text className="text-center text-sm">{label}</Text>
            </Pressable>
          ))}
        </View>

        {mode === 'selected' && options ? (
          <View className="gap-2">
            <Text className="text-xs font-medium">Channels</Text>
            {options.conversations.map((conversation) => {
              const checked = conversationIds.includes(conversation.id)
              return (
                <Pressable
                  key={conversation.id}
                  onPress={() => {
                    setPlan(null)
                    setConversationIds((current) =>
                      current.includes(conversation.id)
                        ? current.filter((id) => id !== conversation.id)
                        : [...current, conversation.id],
                    )
                  }}
                  className="flex-row items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <Text className="flex-1 pr-2 text-sm">{conversation.name}</Text>
                  <Text className="text-xs text-muted-foreground">{checked ? 'included' : 'skipped'}</Text>
                </Pressable>
              )
            })}
            <Text className="mt-1 text-xs font-medium">Projects (and their agents)</Text>
            {options.projects.map((project) => {
              const checked = projectIds.includes(project.id)
              return (
                <Pressable
                  key={project.id}
                  onPress={() => {
                    setPlan(null)
                    setProjectIds((current) =>
                      current.includes(project.id)
                        ? current.filter((id) => id !== project.id)
                        : [...current, project.id],
                    )
                  }}
                  className="flex-row items-center justify-between rounded-lg border border-border px-3 py-2"
                >
                  <Text className="flex-1 pr-2 text-sm">{project.name}</Text>
                  <Text className="text-xs text-muted-foreground">{checked ? 'included' : 'skipped'}</Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}

        <Button variant="outline" onPress={review} disabled={busy !== null || running || needsDesktop}>
          <Text className="text-sm font-medium">{busy === 'plan' ? 'Reviewing…' : 'Review what will move'}</Text>
        </Button>

        {error ? <Text className="text-xs text-red-400">{error}</Text> : null}

        {needsDesktop ? (
          <View className="gap-1 rounded-lg border border-border bg-muted/40 p-3">
            <Text className="text-sm font-medium">Open in Shogo Desktop to start</Text>
            <Text className="text-xs text-muted-foreground">
              A cloud → desktop move is driven by the desktop: the cloud cannot reach your
              machine. Link one in Settings → My Machines, then open this workspace there.
            </Text>
          </View>
        ) : null}

        {shown ? (
          <View className="gap-1 rounded-lg border border-border p-3">
            <Text className="text-sm font-medium">{shown.target.name}</Text>
            <Text className="text-xs text-muted-foreground">
              {shown.totals.rows.toLocaleString()} rows · {shown.totals.files.toLocaleString()} files ·{' '}
              {formatBytes(shown.totals.bytes)}
            </Text>
            {shown.totals.bytesIgnored > 0 ? (
              <Text className="text-xs text-muted-foreground">
                Ignores save {formatBytes(shown.totals.bytesIgnored)} ({shown.totals.filesIgnored.toLocaleString()}{' '}
                files): {shown.ignores.rules.join(', ')}
              </Text>
            ) : null}
            {shown.handover.schedules + shown.handover.triggers > 0 ? (
              <Text className="text-xs text-muted-foreground">
                {shown.handover.schedules} schedule(s) and {shown.handover.triggers} trigger(s) arrive off until you
                switch over.
              </Text>
            ) : null}
            {shown.projects
              .filter((project) => project.mode === 'git-relink')
              .map((project) => (
                <Text key={project.id} className="text-xs text-muted-foreground">
                  {project.name}: re-linked from {project.git?.remote} ({project.git?.branch}), no files copied.
                </Text>
              ))}
            {!shown.quota.ok ? (
              <Text className="text-xs text-red-400">
                The target needs {formatBytes(shown.quota.neededBytes)} and allows{' '}
                {formatBytes(shown.quota.limitBytes ?? 0)}.
              </Text>
            ) : null}
            {shown.warnings.slice(0, 5).map((warning) => (
              <Text key={warning} className="text-xs text-amber-400">
                {warning}
              </Text>
            ))}
            {shown.credentials.length ? (
              <View className="mt-1 gap-1">
                <Text className="text-xs font-medium">Reconnect at the target</Text>
                {shown.credentials.slice(0, 8).map((credential) => (
                  <Text key={`${credential.channel}:${credential.field}`} className="text-xs text-muted-foreground">
                    {credential.label || credential.field} — {credential.channel}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {!move ? (
          <Button onPress={start} disabled={busy !== null || !shown || !shown.quota.ok || needsDesktop}>
            <Text className="text-sm font-medium text-primary-foreground">
              {busy === 'start' ? 'Starting…' : 'Start move'}
            </Text>
          </Button>
        ) : (
          <View className="gap-2">
            <Text className="text-sm font-medium">{STATUS_LABEL[move.status] ?? move.status}</Text>
            <Text className="text-xs text-muted-foreground">
              {move.rowsCopied.toLocaleString()} rows · {move.filesCopied.toLocaleString()} files ·{' '}
              {formatBytes(move.bytesCopied)}
            </Text>
            {move.error ? <Text className="text-xs text-red-400">{move.error}</Text> : null}

            <View className="flex-row flex-wrap gap-2">
              {running ? (
                <Button variant="outline" onPress={() => act('pause')} disabled={busy !== null}>
                  <Text className="text-sm">Pause</Text>
                </Button>
              ) : null}
              {move.status === 'paused' || move.status === 'failed' ? (
                <Button variant="outline" onPress={() => act('resume')} disabled={busy !== null}>
                  <Text className="text-sm">Resume</Text>
                </Button>
              ) : null}
              {move.status !== 'done' && move.status !== 'cancelled' ? (
                <Button variant="outline" onPress={() => act('cancel')} disabled={busy !== null}>
                  <Text className="text-sm">Cancel</Text>
                </Button>
              ) : null}
              {move.status === 'done' && !move.switchedOverAt ? (
                <Button onPress={() => act('switch-over')} disabled={busy !== null}>
                  <Text className="text-sm font-medium text-primary-foreground">Switch over</Text>
                </Button>
              ) : null}
              {move.switchedOverAt ? (
                <Button variant="outline" onPress={() => act('switch-back')} disabled={busy !== null}>
                  <Text className="text-sm">Switch back</Text>
                </Button>
              ) : null}
            </View>

            {move.switchedOverAt ? (
              <Text className="text-xs text-muted-foreground">
                This workspace now runs at {move.targetName ?? 'the target'}. The copy here is kept, with its
                schedules and triggers off.
              </Text>
            ) : null}
          </View>
        )}
      </CardContent>
    </Card>
  )
})
