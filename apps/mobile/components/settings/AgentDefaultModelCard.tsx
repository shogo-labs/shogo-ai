// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Workspace agent default model — the model the workspace agent uses when it
 * is tagged in a channel or thread (by a person or another agent). Direct
 * chats keep whatever model the person picks in the composer.
 *
 * Shown in Settings > Models and on the workspace agent's profile. Editing is
 * limited to workspace owners/admins (the server enforces it; `canManage`
 * comes back from the GET so the UI matches).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'
import { Bot as BotIcon, Check as CheckIcon, ChevronDown as ChevronDownIcon, Lock as LockIcon } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { AUTO_MODEL_ID } from '@shogo/model-catalog'
import { api } from '../../lib/api'
import { workspaceHttpProxy } from '../../lib/workspace-http'
import { resolveDisplayName, useModelPickerList } from '../../lib/visible-models'
import { Text, useAccountSheetIcons } from './account-sheet-chrome'

export function AgentDefaultModelCard({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const { Bot, Check, ChevronDown, Lock } = useAccountSheetIcons({
    Bot: BotIcon,
    Check: CheckIcon,
    ChevronDown: ChevronDownIcon,
    Lock: LockIcon,
  })
  // The card reads and *saves* the agent model of the workspace in view, so it
  // must go to that workspace's backend: a machine workspace's agent model
  // lives on the machine (SHO-108). The proxy resolves the client per call, so
  // the card is right even when it mounts before the domain provider does.
  const http = useMemo(() => workspaceHttpProxy(), [])
  const models = useModelPickerList()
  const [current, setCurrent] = useState<string | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    api.getAgentDefaultModel(http, workspaceId)
      .then((res) => {
        if (!live) return
        setCurrent(res.defaultModel)
        setCanManage(res.canManage)
      })
      .catch((err: any) => { if (live) setError(err?.message || 'Failed to load') })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [http, workspaceId])

  const choose = useCallback(async (id: string) => {
    const next = id === AUTO_MODEL_ID ? null : id
    setOpen(false)
    if (next === current) return
    const previous = current
    setCurrent(next)
    setSaving(true)
    setError(null)
    try {
      setCurrent(await api.setAgentDefaultModel(http, workspaceId, next))
    } catch (err: any) {
      setCurrent(previous)
      setError(err?.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [current, http, workspaceId])

  const selectedId = current ?? AUTO_MODEL_ID
  const options = useMemo(
    () => [{ id: AUTO_MODEL_ID, displayName: 'Auto' }, ...models.filter((m) => m.id !== AUTO_MODEL_ID)],
    [models],
  )

  return (
    <View className={cn('bg-card border border-border rounded-xl', className)} testID="agent-default-model-card">
      <View className="px-5 py-4 gap-1">
        <View className="flex-row items-center gap-2.5">
          <Bot size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">Workspace agent model</Text>
        </View>
        <Text className="text-xs text-muted-foreground">
          Model the workspace agent uses when it's tagged in a channel or thread. Direct chats use
          whatever model you pick.
        </Text>
        {!loading && !canManage && (
          <View className="flex-row items-center gap-1.5 mt-1">
            <Lock size={12} className="text-muted-foreground" />
            <Text className="text-[11px] text-muted-foreground">
              Only workspace owners and admins can change this.
            </Text>
          </View>
        )}
      </View>

      <View className="px-5 pb-4 gap-2">
        {loading ? (
          <ActivityIndicator size="small" />
        ) : (
          <Pressable
            onPress={() => setOpen((v) => !v)}
            disabled={!canManage || saving}
            accessibilityRole="button"
            accessibilityLabel="Workspace agent model"
            className={cn(
              'px-3 py-2.5 rounded-lg border border-border bg-background flex-row items-center gap-2',
              (!canManage || saving) && 'opacity-60',
            )}
          >
            <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
              {resolveDisplayName(selectedId)}
            </Text>
            {saving ? <ActivityIndicator size="small" /> : canManage ? <ChevronDown size={14} className="text-muted-foreground" /> : null}
          </Pressable>
        )}

        {open && canManage && (
          <ScrollView className="rounded-lg border border-border bg-background" style={{ maxHeight: 280 }} nestedScrollEnabled>
            {options.map((m) => {
              const checked = m.id === selectedId
              return (
                <Pressable
                  key={m.id}
                  onPress={() => void choose(m.id)}
                  accessibilityRole="radio"
                  aria-checked={checked}
                  className={cn('px-3 py-2 flex-row items-center gap-2 active:bg-muted', checked && 'bg-primary/5')}
                >
                  <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>{m.displayName}</Text>
                  {checked && <Check size={13} className="text-primary" />}
                </Pressable>
              )
            })}
          </ScrollView>
        )}

        {error && <Text className="text-xs text-red-500">{error}</Text>}
      </View>
    </View>
  )
}
