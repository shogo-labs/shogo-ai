// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Remote Control Page
 *
 * Manage local Shogo instances, view their status, and switch between them.
 * Includes metrics for connected, available, and total instances.
 */

import { useMemo, useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Platform,
  Alert,
  TextInput,
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
  Pencil,
  Trash2,
  Copy,
  X as XIcon,
} from 'lucide-react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
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

function relativeTime(iso?: string | null): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

const INSTALL_SNIPPET = `# 1. Install the CLI
curl -fsSL https://install.shogo.ai | bash

# 2. Paste your API key (create one at /api-keys)
shogo login --api-key shogo_sk_XXXXXXXX

# 3. Start the worker in a repo you want to expose
shogo worker start --worker-dir ~/code/myrepo`


export default observer(function RemoteControlPage() {
  const router = useRouter()
  const workspace = useActiveWorkspace()
  const { instance: activeInstance, setInstance, clearInstance } = useActiveInstance()
  const [addOpen, setAddOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Instance | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

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

  const apiBase = API_URL ?? ''

  const openRename = useCallback((inst: Instance) => {
    setRenameTarget(inst)
    setRenameValue(inst.name)
  }, [])

  const submitRename = useCallback(async () => {
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next || next === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setBusyId(renameTarget.id)
    try {
      const res = await fetch(`${apiBase}/api/instances/${renameTarget.id}`, {
        method: 'PUT',
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        headers: { 'content-type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ name: next }),
      })
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        Alert.alert('Rename failed', `HTTP ${res.status} ${msg.slice(0, 200)}`)
      } else {
        await refresh()
      }
    } catch (e: any) {
      Alert.alert('Rename failed', String(e?.message ?? e))
    } finally {
      setBusyId(null)
      setRenameTarget(null)
    }
  }, [renameTarget, renameValue, apiBase, refresh])

  const confirmRemove = useCallback((inst: Instance) => {
    const run = async () => {
      setBusyId(inst.id)
      try {
        const res = await fetch(`${apiBase}/api/instances/${inst.id}`, {
          method: 'DELETE',
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          headers: { ...getAuthHeaders() },
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          Alert.alert('Remove failed', `HTTP ${res.status} ${msg.slice(0, 200)}`)
        } else {
          if (activeInstance?.instanceId === inst.id) clearInstance()
          await refresh()
        }
      } catch (e: any) {
        Alert.alert('Remove failed', String(e?.message ?? e))
      } finally {
        setBusyId(null)
      }
    }
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (confirm(`Remove ${inst.name}? The worker token will be revoked.`)) void run()
      return
    }
    Alert.alert('Remove device', `Remove ${inst.name}? The worker token will be revoked.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void run() },
    ])
  }, [apiBase, refresh, activeInstance, clearInstance])

  const copyInstall = useCallback(async () => {
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(INSTALL_SNIPPET)
        return
      }
      const Clipboard = await import('expo-clipboard').catch(() => null as any)
      await Clipboard?.setStringAsync?.(INSTALL_SNIPPET)
    } catch {}
  }, [])

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
            onPress={() => setAddOpen(true)}
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
                          {inst.os && (
                            <Text className="text-xs text-muted-foreground">· {inst.os}</Text>
                          )}
                          {relativeTime(inst.lastSeenAt) && (
                            <Text className="text-xs text-muted-foreground">· {relativeTime(inst.lastSeenAt)}</Text>
                          )}
                        </View>
                      </View>
                      {isConnecting ? (
                        <ActivityIndicator size="small" color="rgb(var(--color-primary))" />
                      ) : (
                        <View className="flex-row items-center gap-1">
                          {isActive && <Check size={18} className="text-primary mr-1" />}
                          <Pressable
                            onPress={(e) => { e.stopPropagation?.(); openRename(inst) }}
                            disabled={busyId === inst.id}
                            accessibilityLabel="Rename device"
                            className="p-2 rounded-md hover:bg-muted active:bg-muted"
                          >
                            <Pencil size={16} className="text-muted-foreground" />
                          </Pressable>
                          <Pressable
                            onPress={(e) => { e.stopPropagation?.(); confirmRemove(inst) }}
                            disabled={busyId === inst.id}
                            accessibilityLabel="Remove device"
                            className="p-2 rounded-md hover:bg-destructive/10 active:bg-destructive/10"
                          >
                            <Trash2 size={16} className="text-muted-foreground" />
                          </Pressable>
                        </View>
                      )}
                    </Pressable>
                  </View>
                )
              })}
            </CardContent>
          </Card>
        )}
      </ScrollView>

      {/* Add Device — install snippet */}
      <Modal isOpen={addOpen} onClose={() => setAddOpen(false)} size="md">
        <ModalBackdrop />
        <ModalContent>
          <ModalHeader>
            <Text className="text-lg font-semibold text-foreground">Connect a machine</Text>
            <ModalCloseButton>
              <XIcon size={16} className="text-muted-foreground" />
            </ModalCloseButton>
          </ModalHeader>
          <ModalBody>
            <Text className="text-sm text-muted-foreground mb-3">
              Run these three commands on the machine you want to expose. It will appear here within a few seconds.
            </Text>
            <View className="rounded-md bg-surface-1 border border-border p-3">
              <Text selectable className="text-xs font-mono text-foreground whitespace-pre" style={{ fontFamily: Platform.select({ web: 'ui-monospace, Menlo, monospace', default: 'Menlo' }) }}>
                {INSTALL_SNIPPET}
              </Text>
            </View>
            <Text className="text-xs text-muted-foreground mt-3">
              Don't have an API key yet? Create one on the API Keys page.
            </Text>
          </ModalBody>
          <ModalFooter>
            <View className="flex-row gap-2">
              <Button variant="outline" size="sm" onPress={copyInstall}>
                <View className="flex-row items-center gap-1.5 px-1">
                  <Copy size={14} className="text-foreground" />
                  <Text className="text-sm text-foreground">Copy snippet</Text>
                </View>
              </Button>
              <Button size="sm" onPress={() => { setAddOpen(false); router.push('/(app)/api-keys') }}>
                <Text className="text-sm font-semibold text-white px-1">Create API key</Text>
              </Button>
            </View>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* Rename device */}
      <Modal isOpen={!!renameTarget} onClose={() => setRenameTarget(null)} size="sm">
        <ModalBackdrop />
        <ModalContent>
          <ModalHeader>
            <Text className="text-lg font-semibold text-foreground">Rename device</Text>
            <ModalCloseButton>
              <XIcon size={16} className="text-muted-foreground" />
            </ModalCloseButton>
          </ModalHeader>
          <ModalBody>
            <TextInput
              value={renameValue}
              onChangeText={setRenameValue}
              autoFocus
              placeholder="mbp-ashutosh"
              placeholderTextColor="rgb(var(--color-muted-foreground))"
              onSubmitEditing={submitRename}
              className="rounded-md border border-border bg-background px-3 py-2 text-foreground"
            />
          </ModalBody>
          <ModalFooter>
            <View className="flex-row gap-2">
              <Button variant="outline" size="sm" onPress={() => setRenameTarget(null)}>
                <Text className="text-sm text-foreground px-1">Cancel</Text>
              </Button>
              <Button size="sm" onPress={submitRename} disabled={!renameValue.trim() || busyId === renameTarget?.id}>
                <Text className="text-sm font-semibold text-white px-1">
                  {busyId === renameTarget?.id ? 'Saving…' : 'Save'}
                </Text>
              </Button>
            </View>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </View>
  )
})
