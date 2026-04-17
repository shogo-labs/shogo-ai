// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control Page
 *
 * Manage local Shogo instances, view their status, and switch between them.
 * Includes metrics for connected, available, and total instances.
 */

import { useMemo, useEffect } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import {
  Monitor,
  Laptop,
  Check,
  Plus,
  RefreshCw,
  ArrowLeft,
} from 'lucide-react-native'
import { useActiveInstance } from '../../contexts/active-instance'
import { useInstancePicker, type Instance } from '@shogo/shared-app/hooks'
import { API_URL } from '../../lib/api'
import { authClient } from '../../lib/auth-client'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import {
  Card,
  CardContent,
  Button,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

function StatusDot({ status }: { status: Instance['status'] }) {
  const color =
    status === 'online' ? 'bg-green-500'
    : status === 'heartbeat' ? 'bg-yellow-500'
    : 'bg-muted-foreground/40'

  return <View className={cn('h-2.5 w-2.5 rounded-full', color)} />
}

export default observer(function RemoteControlPage() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const { instance: activeInstance, setInstance, clearInstance } = useActiveInstance()

  const fetchOptions: RequestInit = useMemo(
    () => ({
      credentials: Platform.OS === 'web' ? ('include' as const) : ('omit' as const),
      headers: { ...getAuthHeaders() },
    }),
    [],
  )

  const picker = useInstancePicker({
    workspaceId: workspace?.id,
    apiUrl: API_URL ?? '',
    activeInstance,
    setInstance,
    clearInstance,
    fetchOptions,
  })

  const {
    instances,
    loading,
    connecting,
    isOpen,
    select,
    disconnect,
    refresh,
  } = picker

  useEffect(() => {
    refresh()
  }, [workspace?.id, refresh])

  const connectedCount = instances.filter(i => i.status === 'online').length
  const standbyCount = instances.filter(i => i.status === 'heartbeat').length
  const totalCount = instances.length

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-6 py-5 border-b border-border">
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/index')}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-2xl font-bold text-foreground">Remote Control</Text>
          <Text className="text-sm text-muted-foreground">
            Manage your local Shogo instances
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
           <Button
            variant="outline"
            size="sm"
            onPress={refresh}
            disabled={loading}
            className="h-9 w-9 p-0"
          >
            <RefreshCw size={16} className={cn("text-muted-foreground", loading && "animate-spin")} />
          </Button>
          <Button
            size="sm"
            onPress={() => router.push('/(app)/api-keys')}
            className="bg-brand-landing hover:opacity-90"
          >
            <View className="flex-row items-center gap-1.5 px-1">
              <Plus size={16} color="#fff" />
              <Text className="text-sm font-semibold text-white">Add Device</Text>
            </View>
          </Button>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-6 pb-20 max-w-5xl w-full mx-auto"
      >
        {/* Metrics Row */}
        <View className="flex-row flex-wrap gap-4 mb-8">
          <Card className="flex-1 min-w-[180px]">
            <CardContent className="p-4">
              <Text className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Connected</Text>
              <Text className="text-3xl font-bold text-green-500">{connectedCount}</Text>
            </CardContent>
          </Card>
          <Card className="flex-1 min-w-[180px]">
            <CardContent className="p-4">
              <Text className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Available</Text>
              <Text className="text-3xl font-bold text-blue-500">{connectedCount + standbyCount}</Text>
            </CardContent>
          </Card>
          <Card className="flex-1 min-w-[180px]">
            <CardContent className="p-4">
              <Text className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-2">Total</Text>
              <Text className="text-3xl font-bold text-foreground">{totalCount}</Text>
            </CardContent>
          </Card>
        </View>

        {/* This Device Section */}
        <Text className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 px-1">Controlling</Text>
        <Card className="mb-8">
          <CardContent className="p-0">
            <Pressable
              onPress={disconnect}
              className={cn(
                "flex-row items-center gap-4 px-5 py-4 active:bg-muted/50 transition-colors",
                !activeInstance && "bg-accent/40"
              )}
            >
              <View className="h-10 w-10 rounded-lg bg-surface-1 items-center justify-center border border-border">
                <Monitor size={20} className={!activeInstance ? "text-primary" : "text-muted-foreground"} />
              </View>
              <View className="flex-1">
                <Text className="text-base font-medium text-foreground">This device</Text>
                <Text className="text-xs text-muted-foreground">Local environment</Text>
              </View>
              {!activeInstance && <Check size={20} className="text-primary" />}
            </Pressable>
          </CardContent>
        </Card>

        {/* Remote Instances Section */}
        <Text className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-3 px-1">Remote Instances</Text>

        {loading && instances.length === 0 ? (
          <View className="py-20 items-center">
            <ActivityIndicator size="large" color="rgb(var(--color-primary))" />
            <Text className="text-sm text-muted-foreground mt-4">Discovering instances...</Text>
          </View>
        ) : instances.length === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="p-10 items-center">
              <View className="h-16 w-16 rounded-full bg-muted/30 items-center justify-center mb-4">
                <Monitor size={32} className="text-muted-foreground/40" />
              </View>
              <Text className="text-lg font-semibold text-foreground mb-2">No instances registered</Text>
              <Text className="text-sm text-muted-foreground text-center max-w-sm mb-6">
                Create an API key and enter it in your local Shogo instance's settings. It will appear here automatically once connected.
              </Text>
              <Button
                variant="outline"
                onPress={() => router.push('/(app)/api-keys')}
              >
                <View className="flex-row items-center gap-2">
                  <Plus size={16} className="text-foreground" />
                  <Text className="text-sm font-medium text-foreground">Create API Key</Text>
                </View>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              {instances.map((inst, index) => {
                const isActive = activeInstance?.instanceId === inst.id
                const isConnecting = connecting === inst.id

                return (
                  <View key={inst.id}>
                    {index > 0 && <View className="h-px bg-border mx-5" />}
                    <Pressable
                      onPress={() => select(inst)}
                      disabled={isConnecting}
                      className={cn(
                        "flex-row items-center gap-4 px-5 py-4 active:bg-muted/50 transition-colors",
                        isActive && "bg-accent/40",
                        isConnecting && "opacity-60"
                      )}
                    >
                      <View className="h-10 w-10 rounded-lg bg-surface-1 items-center justify-center border border-border">
                        <Laptop size={20} className={isActive ? "text-primary" : "text-muted-foreground"} />
                      </View>
                      <View className="flex-1 min-w-0">
                        <Text className="text-base font-medium text-foreground" numberOfLines={1}>
                          {inst.name}
                        </Text>
                        <View className="flex-row items-center gap-2 mt-1">
                          <StatusDot status={inst.status} />
                          <Text className="text-xs text-muted-foreground">
                            {inst.status === 'online' ? 'Online' : inst.status === 'heartbeat' ? 'Standby' : 'Offline'}
                          </Text>
                        </View>
                      </View>
                      {isConnecting ? (
                        <ActivityIndicator size="small" color="rgb(var(--color-primary))" />
                      ) : (
                        isActive && <Check size={20} className="text-primary" />
                      )}
                    </Pressable>
                  </View>
                )
              })}
            </CardContent>
          </Card>
        )}
      </ScrollView>
    </View>
  )
})
