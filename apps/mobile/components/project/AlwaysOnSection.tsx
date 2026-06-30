// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AlwaysOnSection - the "Always on" (min-scale=1, never sleeps) control for a
 * published project, shared between the Publish dropdown and project Settings.
 *
 * "Always on" keeps a warm pod for a published app so visitors never hit a cold
 * start. It works for both static apps (a cheap warm nginx pod) and
 * server-backed apps (the heavier runtime pod). It's entitlement-gated (Pro+
 * and a pooled number of slots per workspace); enabling it server-side may 402
 * when the plan/slots are exhausted, which we surface as an upgrade prompt.
 *
 * Two layouts via `embedded`:
 *  - embedded (default): compact bordered card rendered inside the Publish
 *    dropdown. Collapses to null when the app isn't published (keeps the
 *    dropdown clean).
 *  - embedded={false}: standalone, scrollable Settings pane with explanatory
 *    empty states instead of rendering nothing.
 *
 * Like CustomDomainsSection, `http` is passed in by the caller: the dropdown
 * variant renders inside a gluestack Popover whose overlay teleports outside
 * the SDKDomainProvider, so useDomainHttp() would throw there.
 */

import { useCallback, useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, ScrollView } from 'react-native'
import { Zap, ExternalLink } from 'lucide-react-native'
import { useRouter } from 'expo-router'
import type { HttpClient } from '@shogo-ai/sdk'
import { cn } from '@shogo/shared-ui/primitives'
import { Switch } from '@/components/ui/switch'
import { api } from '../../lib/api'

interface AlwaysOnSectionProps {
  projectId: string
  http: HttpClient
  /**
   * Compact variant for the publish dropdown (default). When false, renders a
   * standalone, scrollable Settings pane with visible empty/disabled states.
   */
  embedded?: boolean
  /**
   * Bump to force a reload of publish state (e.g. the dropdown re-opened, or the
   * project was just (re)published). The component also loads itself on mount.
   */
  reloadNonce?: number
  /** Called right before navigating to billing (e.g. to close the popover). */
  onBeforeNavigate?: () => void
}

export function AlwaysOnSection({
  projectId,
  http,
  embedded = true,
  reloadNonce,
  onBeforeNavigate,
}: AlwaysOnSectionProps) {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [isPublished, setIsPublished] = useState(false)
  const [alwaysOn, setAlwaysOn] = useState(false)
  // null allowance = unlimited (enterprise/local).
  const [alwaysOnAllowance, setAlwaysOnAllowance] = useState<number | null>(null)
  const [alwaysOnUsed, setAlwaysOnUsed] = useState(0)
  const [isToggling, setIsToggling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.getPublishState(http, projectId)
      setIsPublished(!!data.subdomain)
      setAlwaysOn(data.alwaysOn === true)
      setAlwaysOnAllowance(data.alwaysOnAllowance ?? null)
      setAlwaysOnUsed(data.alwaysOnUsed ?? 0)
    } catch {
      // Best-effort: leave defaults; the toggle just won't show in embedded mode.
    } finally {
      setLoading(false)
    }
  }, [http, projectId])

  useEffect(() => {
    load()
  }, [load, reloadNonce])

  // Flip the always-on toggle. Optimistic: update immediately, revert + surface
  // the server message on failure (e.g. 402 slot_exhausted / plan_not_allowed).
  const handleToggle = async (next: boolean) => {
    if (isToggling) return
    setIsToggling(true)
    setError(null)
    const prevOn = alwaysOn
    const prevUsed = alwaysOnUsed
    setAlwaysOn(next)
    setAlwaysOnUsed((u) => Math.max(0, u + (next ? 1 : -1)))
    try {
      const data = await api.updatePublishSettings(http, projectId, { alwaysOn: next })
      setAlwaysOn(data.alwaysOn === true)
    } catch (err: any) {
      setAlwaysOn(prevOn)
      setAlwaysOnUsed(prevUsed)
      setError(err?.message || 'Failed to update always-on')
    } finally {
      setIsToggling(false)
    }
  }

  const goToBilling = () => {
    onBeforeNavigate?.()
    router.push('/(app)/billing' as any)
  }

  const unlimitedAlwaysOn = alwaysOnAllowance == null
  const planAllowsAlwaysOn = unlimitedAlwaysOn || (alwaysOnAllowance ?? 0) > 0
  const alwaysOnSlotsFull = !unlimitedAlwaysOn && alwaysOnUsed >= (alwaysOnAllowance ?? 0)
  // Turning OFF is always allowed; turning ON requires a free slot in the pool.
  const canToggle = alwaysOn || unlimitedAlwaysOn || !alwaysOnSlotsFull

  // The actual control (plan gate OR live toggle). Shared by both layouts.
  const control = !planAllowsAlwaysOn ? (
    <Pressable onPress={goToBilling} className="flex-row items-center gap-3">
      <Zap size={16} className="text-muted-foreground" />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text className="text-sm font-medium text-foreground">Always on</Text>
          <View className="rounded px-1.5 bg-primary/10">
            <Text className="text-[10px] text-primary font-medium">Pro</Text>
          </View>
        </View>
        <Text className="text-[11px] text-muted-foreground mt-0.5">
          Keep your app instant for every visitor — no wake-up delay. Available on Pro & Business.
        </Text>
      </View>
      <ExternalLink size={14} className="text-primary" />
    </Pressable>
  ) : (
    <>
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <View className="flex-row items-center gap-1.5">
            <Zap size={14} className="text-foreground" />
            <Text className="text-sm font-medium text-foreground">Always on</Text>
          </View>
          <Text className="text-[11px] text-muted-foreground mt-0.5">
            {alwaysOn
              ? 'Instant for every visitor, no wake-up delay.'
              : 'Sleeps when idle — the first visit after ~30 min takes a few seconds to wake.'}
          </Text>
        </View>
        {isToggling ? (
          <ActivityIndicator size="small" />
        ) : (
          <Switch value={alwaysOn} onValueChange={handleToggle} disabled={!canToggle} />
        )}
      </View>
      <Text className="text-[11px] text-muted-foreground mt-2">
        {unlimitedAlwaysOn
          ? 'Always-on apps: unlimited'
          : `Always-on apps: ${alwaysOnUsed} of ${alwaysOnAllowance} used`}
      </Text>
      {!alwaysOn && alwaysOnSlotsFull && !unlimitedAlwaysOn && (
        <Pressable onPress={goToBilling} className="mt-1">
          <Text className="text-[11px] text-primary">
            You&apos;re using all {alwaysOnAllowance} always-on apps. Upgrade or add a seat.
          </Text>
        </Pressable>
      )}
      {error && <Text className="text-[11px] text-destructive mt-1.5">{error}</Text>}
    </>
  )

  // ── Embedded (publish dropdown): collapse to null unless meaningful ────────
  if (embedded) {
    if (loading || !isPublished) return null
    return <View className="mb-4 rounded-lg border border-border p-3">{control}</View>
  }

  // ── Standalone (Settings pane): always render with explanatory states ─────
  const header = (
    <>
      <View className="flex-row items-center gap-1.5 mb-1">
        <Zap size={15} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">Always on</Text>
      </View>
      <Text className="text-[11px] text-muted-foreground mb-3">
        Keep your published app instant for every visitor — no wake-up delay after it&apos;s been
        idle. Otherwise the app sleeps when idle and the first visit takes a few seconds to wake.
      </Text>
    </>
  )

  let body: React.ReactNode
  if (loading) {
    body = (
      <View className="flex-1 items-center justify-center py-6">
        <ActivityIndicator size="small" />
      </View>
    )
  } else if (!isPublished) {
    body = (
      <Text className="text-[11px] text-muted-foreground">
        Publish this app first, then you can keep it always on.
      </Text>
    )
  } else {
    body = <View className="rounded-lg border border-border p-3">{control}</View>
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 16 }}>
      {header}
      {body}
    </ScrollView>
  )
}
