// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * API Keys Management Page
 *
 * Allows cloud users to create, view, and revoke API keys for
 * authenticating Shogo Local instances against the cloud proxy.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  ArrowLeft,
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  X,
  AlertTriangle,
  Monitor,
  ChevronDown,
  ChevronRight,
  Laptop,
  Smartphone,
  LogOut,
} from 'lucide-react-native'
import { PlatformApi, type ApiKeyInfo } from '@shogo-ai/sdk'
import { formatDistanceToNow } from 'date-fns'
import { useDomainHttp } from '../../contexts/domain'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import {
  Card,
  CardContent,
  Button,
  Input,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'
import { useNativePhoneWindow } from '../../lib/native-phone-layout'

function formatLastSeen(ts: string | null | undefined): string {
  if (!ts) return 'Never'
  const d = new Date(ts)
  const diffMs = Date.now() - d.getTime()
  if (diffMs < 2 * 60 * 1000) return 'Active now'
  return formatDistanceToNow(d, { addSuffix: true })
}

function platformLabel(p?: string | null): string {
  if (!p) return 'Unknown'
  switch (p) {
    case 'darwin': return 'macOS'
    case 'win32': return 'Windows'
    case 'linux': return 'Linux'
    case 'android': return 'Android'
    case 'ios': return 'iOS'
    default: return p
  }
}

function PlatformIcon({ platform, size = 16 }: { platform?: string | null; size?: number }) {
  if (platform === 'android' || platform === 'ios') {
    return <Smartphone size={size} className="text-muted-foreground" />
  }
  return <Laptop size={size} className="text-muted-foreground" />
}

export default observer(function ApiKeysPage() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { isPhone: isNativePhone } = useNativePhoneWindow()
  const workspace = useActiveWorkspace()
  const http = useDomainHttp()

  const platform = useMemo(() => new PlatformApi(http), [http])

  const [keys, setKeys] = useState<ApiKeyInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewKeyName] = useState('Shogo Local')
  const [isCreating, setIsCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)
  const [showManualKeys, setShowManualKeys] = useState(false)

  const deviceKeys = useMemo(() => keys.filter((k) => k.kind === 'device'), [keys])
  const userKeys = useMemo(() => keys.filter((k) => k.kind !== 'device'), [keys])

  const loadKeys = useCallback(async () => {
    if (!workspace?.id) {
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    try {
      setKeys(await platform.listApiKeys(workspace.id))
    } catch (err) {
      console.error('[ApiKeys] Failed to load:', err)
    } finally {
      setIsLoading(false)
    }
  }, [workspace?.id, platform])

  useEffect(() => { loadKeys() }, [loadKeys])

  const handleCreate = async () => {
    if (!workspace?.id || !newKeyName.trim()) return
    setIsCreating(true)
    try {
      const data = await platform.createApiKey(newKeyName.trim(), workspace.id)
      setCreatedKey(data.key)
      await loadKeys()
    } catch (err) {
      console.error('[ApiKeys] Failed to create:', err)
    } finally {
      setIsCreating(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setIsRevoking(true)
    try {
      await platform.revokeApiKey(revokeTarget.id)
      setRevokeTarget(null)
      await loadKeys()
    } catch (err) {
      console.error('[ApiKeys] Failed to revoke:', err)
    } finally {
      setIsRevoking(false)
    }
  }

  const handleCopy = async (text: string) => {
    // `navigator.clipboard.writeText` rejects with NotAllowedError on
    // Windows/Electron when the document isn't focused. Use the
    // cross-platform expo-clipboard helper and never let a copy failure
    // surface as an unhandled rejection (Sentry SHOGO-DESKTOP-2).
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('[ApiKeys] Clipboard write failed:', err)
    }
  }

  const closeCreateModal = () => {
    setShowCreateModal(false)
    setCreatedKey(null)
    setNewKeyName('Shogo Local')
    setCopied(false)
  }

  return (
    <View className="flex-1 bg-muted/20">
      {/* Header */}
      <View
        className={cn(
          "flex-row items-center gap-3 border-b border-border/80 bg-background",
          isNativePhone ? "px-4 pb-3" : "px-6 py-4"
        )}
        style={isNativePhone ? { paddingTop: Math.max(insets.top, 12) } : undefined}
      >
        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/settings')}
          hitSlop={8}
          className={cn(
            "items-center justify-center rounded-full border border-border bg-background",
            isNativePhone ? "h-11 w-11" : "h-9 w-9"
          )}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={isNativePhone ? 22 : 20} className="text-foreground" />
        </Pressable>
        <View className="flex-1 min-w-0">
          <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">Workspace access</Text>
          <Text className={cn("mt-0.5 font-semibold tracking-tight text-foreground", isNativePhone ? "text-xl" : "text-2xl")}>Devices & API Keys</Text>
          <Text className={cn("text-muted-foreground", isNativePhone ? "text-sm mt-1" : "text-sm mt-0.5")}>
            Manage desktop sessions and advanced credentials
          </Text>
          {workspace?.id && (
            <Text
              className="text-xs text-muted-foreground/70 font-mono mt-0.5"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              Workspace: {workspace.id}
            </Text>
          )}
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName={isNativePhone ? "p-4" : "p-6 max-w-3xl w-full mx-auto"}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom + 32, isNativePhone ? 96 : 80) }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Info banner */}
        <Card className="mb-7 rounded-2xl border-border/80 bg-card">
          <CardContent className="p-5">
            <View className="flex-row items-start gap-3">
              <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <Monitor size={20} className="text-primary" />
              </View>
              <View className="flex-1 min-w-0">
                <Text className={cn("font-semibold text-foreground", isNativePhone ? "text-base" : "text-sm")}>
                  Shogo Desktop signs in as a device
                </Text>
                <Text className={cn("text-muted-foreground mt-1.5", isNativePhone ? "text-sm leading-5" : "text-sm leading-5")}>
                  Each desktop install gets its own device credential. Signing out here
                  immediately revokes it. Use a manual API key only for headless / CI
                  environments that can't run the desktop login
                  flow.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* Devices section */}
        <View className="mb-3 flex-row items-center justify-between">
          <View>
            <Text className="text-xs font-semibold uppercase tracking-[1.5px] text-primary">Sessions</Text>
            <Text className="mt-1 text-lg font-semibold text-foreground">Devices</Text>
          </View>
          {!isLoading && (
            <Badge variant="outline">
              <Text className="text-xs text-muted-foreground">{deviceKeys.length} active</Text>
            </Badge>
          )}
        </View>

        {isLoading ? (
          <View className="py-12 items-center">
            <ActivityIndicator size="large" />
            <Text className="text-sm text-muted-foreground mt-3">Loading devices...</Text>
          </View>
        ) : deviceKeys.length === 0 ? (
          <Card className="mb-7 rounded-2xl border-border/80 bg-card">
            <CardContent className="p-6 items-center">
              <View className="h-12 w-12 rounded-full bg-muted/50 items-center justify-center mb-3">
                <Laptop size={22} className="text-muted-foreground/50" />
              </View>
              <Text className="text-sm font-medium text-foreground mb-1">No devices signed in</Text>
              <Text className="text-xs text-muted-foreground text-center max-w-sm">
                Open Shogo Desktop and click "Sign in to Shogo Cloud" to link this workspace.
              </Text>
            </CardContent>
          </Card>
        ) : (
          <Card className="mb-7 rounded-2xl border-border/80 bg-card">
            <CardContent className="p-0">
              {deviceKeys.map((key) =>
                isNativePhone ? (
                  <View
                    key={key.id}
                    className="gap-3 border-b border-border px-4 py-4 last:border-b-0"
                  >
                    <View className="flex-row items-start gap-3">
                      <View className="h-11 w-11 items-center justify-center rounded-lg bg-muted">
                        <PlatformIcon platform={key.devicePlatform} size={20} />
                      </View>
                      <View className="min-w-0 flex-1">
                        <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
                          {key.deviceName || key.name}
                        </Text>
                        {key.user?.email ? (
                          <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
                            {key.user.email}
                          </Text>
                        ) : null}
                        <Text className="mt-0.5 text-sm text-muted-foreground">
                          {formatLastSeen(key.lastSeenAt || key.lastUsedAt)}
                        </Text>
                        <View className="mt-2 flex-row flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            <Text className="text-xs">{platformLabel(key.devicePlatform)}</Text>
                          </Badge>
                          {key.deviceAppVersion ? (
                            <Text className="text-xs text-muted-foreground">v{key.deviceAppVersion}</Text>
                          ) : null}
                        </View>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => setRevokeTarget(key)}
                      className="h-11 flex-row items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5"
                      accessibilityRole="button"
                      accessibilityLabel={`Sign out ${key.deviceName || key.name}`}
                    >
                      <LogOut size={16} className="text-destructive" />
                      <Text className="text-sm font-medium text-destructive">Sign out</Text>
                    </Pressable>
                  </View>
                ) : (
                <View
                  key={key.id}
                  className="flex-row items-center gap-3 px-4 py-3 border-b border-border last:border-b-0"
                >
                  <View className="h-10 w-10 rounded-md bg-muted items-center justify-center">
                    <PlatformIcon platform={key.devicePlatform} size={18} />
                  </View>
                  <View className="flex-1 min-w-0">
                    <View className="flex-row items-center gap-2">
                      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                        {key.deviceName || key.name}
                      </Text>
                      <Badge variant="outline">
                        <Text className="text-[10px]">{platformLabel(key.devicePlatform)}</Text>
                      </Badge>
                      {key.deviceAppVersion && (
                        <Text className="text-xs text-muted-foreground">v{key.deviceAppVersion}</Text>
                      )}
                    </View>
                    <Text className="text-xs text-muted-foreground mt-0.5">
                      {key.user?.email} · {" "}
                        {formatLastSeen(key.lastSeenAt || key.lastUsedAt)}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => setRevokeTarget(key)}
                    className="flex-row items-center gap-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1"
                    accessibilityRole="button"
                    accessibilityLabel={`Sign out ${key.deviceName || key.name}`}
                  >
                    <LogOut size={12} className="text-destructive" />
                    <Text className="text-xs text-destructive">Sign out</Text>
                  </Pressable>
                </View>
                )
              )}
              <View className="px-4 py-2.5">
                <Text className="text-xs text-muted-foreground">
                  {deviceKeys.length} signed-in device{deviceKeys.length !== 1 ? 's' : ''}
                </Text>
              </View>
            </CardContent>
          </Card>
        )}

        {/* Manual API keys (advanced) */}
        <Pressable
          testID="manual-api-keys-toggle"
          onPress={() => setShowManualKeys((v) => !v)}
          className={cn("mb-3 flex-row items-center gap-2 py-1", isNativePhone && "min-h-11")}
          accessibilityRole="button"
          accessibilityState={{ expanded: showManualKeys }}
        >
          {showManualKeys ? (
            <ChevronDown size={isNativePhone ? 20 : 16} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={isNativePhone ? 20 : 16} className="text-muted-foreground" />
          )}
          <Text className={cn("font-semibold text-foreground", isNativePhone ? "text-lg" : "text-base")}>
            Manual API keys
          </Text>
          <Text className={cn("text-muted-foreground", isNativePhone ? "text-sm" : "text-xs")}>
            ({userKeys.length}) · advanced
          </Text>
        </Pressable>

        {showManualKeys && (
          <>
            <Text className={cn("mb-3 leading-5 text-muted-foreground", isNativePhone ? "text-sm" : "text-xs")}>
              Long-lived keys for CI, scripting, or headless environments. Most users should
              sign in via the desktop app instead.
            </Text>
            <View className={cn("mb-3", isNativePhone ? undefined : "flex-row justify-end")}>
              <Button
                size={isNativePhone ? "lg" : "sm"}
                testID="create-api-key-btn"
                onPress={() => setShowCreateModal(true)}
                className={isNativePhone ? "w-full" : undefined}
              >
                <View className="flex-row items-center gap-1.5">
                  <Plus size={isNativePhone ? 16 : 14} color="#fff" />
                  <Text className={cn("font-medium text-primary-foreground", isNativePhone ? "text-base" : "text-sm")}>Create Key</Text>
                </View>
              </Button>
            </View>
            {userKeys.length === 0 ? (
              <Card className="rounded-2xl border-border/80 bg-card">
                <CardContent className="p-6 items-center">
                  <Key size={22} className="text-muted-foreground/50 mb-2" />
                  <Text className="text-sm text-muted-foreground">
                    No manual keys yet.
                  </Text>
                </CardContent>
              </Card>
            ) : isNativePhone ? (
              <Card className="rounded-2xl border-border/80 bg-card">
                <CardContent className="p-0">
                  {userKeys.map((key) => (
                    <View key={key.id} className="gap-2 border-b border-border px-4 py-4 last:border-b-0">
                      <View className="flex-row items-start gap-3">
                        <View className="min-w-0 flex-1">
                          <Text className="text-base font-semibold text-foreground" numberOfLines={2}>
                            {key.name}
                          </Text>
                          {key.user?.name || key.user?.email ? (
                            <Text className="mt-0.5 text-sm text-muted-foreground" numberOfLines={1}>
                              {key.user?.name || key.user?.email}
                            </Text>
                          ) : null}
                        </View>
                        <Pressable
                          onPress={() => setRevokeTarget(key)}
                          hitSlop={8}
                          className="h-11 w-11 items-center justify-center rounded-lg bg-destructive/5"
                          accessibilityRole="button"
                          accessibilityLabel={`Revoke ${key.name}`}
                        >
                          <Trash2 size={20} className="text-destructive" />
                        </Pressable>
                      </View>
                      <Text className="font-mono text-sm text-muted-foreground" numberOfLines={1}>
                        {key.keyPrefix}...
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        Last used{' '}
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : 'Never'}
                      </Text>
                      <Text className="text-sm text-muted-foreground">
                        Created{' '}
                        {new Date(key.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </Text>
                    </View>
                  ))}
                  <View className="px-4 py-3">
                    <Text className="text-sm text-muted-foreground">
                      {userKeys.length} key{userKeys.length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </CardContent>
              </Card>
            ) : (
              <Card className="rounded-2xl border-border/80 bg-card">
                <CardContent className="p-0">
                  <View className="flex-row items-center px-4 py-2.5 border-b border-border bg-muted/30">
                    <View className="flex-[2]">
                      <Text className="text-xs font-medium text-muted-foreground">Name</Text>
                    </View>
                    <View className="flex-1">
                      <Text className="text-xs font-medium text-muted-foreground">Key</Text>
                    </View>
                    <View className="w-28">
                      <Text className="text-xs font-medium text-muted-foreground">Last used</Text>
                    </View>
                    <View className="w-28">
                      <Text className="text-xs font-medium text-muted-foreground">Created</Text>
                    </View>
                    <View className="w-10" />
                  </View>
                  {userKeys.map((key) => (
                    <View key={key.id} className="flex-row items-center px-4 py-3 border-b border-border">
                      <View className="flex-[2]">
                        <Text className="text-sm font-medium text-foreground">{key.name}</Text>
                        <Text className="text-xs text-muted-foreground">
                          {key.user?.name || key.user?.email}
                        </Text>
                      </View>
                      <View className="flex-1">
                        <Text className="text-sm text-muted-foreground font-mono">
                          {key.keyPrefix}...
                        </Text>
                      </View>
                      <View className="w-28">
                        <Text className="text-sm text-muted-foreground">
                          {key.lastUsedAt
                            ? new Date(key.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                            : 'Never'}
                        </Text>
                      </View>
                      <View className="w-28">
                        <Text className="text-sm text-muted-foreground">
                          {new Date(key.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </Text>
                      </View>
                      <View className="w-10 items-center">
                        <Pressable
                          onPress={() => setRevokeTarget(key)}
                          className="rounded p-1"
                          accessibilityRole="button"
                          accessibilityLabel={`Revoke ${key.name}`}
                        >
                          <Trash2 size={14} className="text-destructive" />
                        </Pressable>
                      </View>
                    </View>
                  ))}
                  <View className="px-4 py-2.5">
                    <Text className="text-xs text-muted-foreground">
                      {userKeys.length} key{userKeys.length !== 1 ? 's' : ''}
                    </Text>
                  </View>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </ScrollView>

      {/* Create Key Modal */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={closeCreateModal}
      >
        <KeyboardAvoidingView
          className="flex-1"
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          enabled={Platform.OS !== 'web'}
        >
          <Pressable
            className="flex-1 bg-black/50 justify-center items-center px-6"
            onPress={closeCreateModal}
          >
            <Pressable
              onPress={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-2xl border border-border/80 bg-background p-6"
              role="dialog"
              aria-label={createdKey ? 'API Key Created' : 'Create API Key'}
              aria-modal
            >
              {createdKey ? (
                <View className="gap-4">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-lg font-semibold text-foreground">API Key Created</Text>
                    <Pressable onPress={closeCreateModal} className="h-9 w-9 items-center justify-center rounded-full bg-muted">
                      <X size={20} className="text-muted-foreground" />
                    </Pressable>
                  </View>

                  <View className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex-row items-start gap-2">
                    <AlertTriangle size={16} className="text-amber-500 mt-0.5" />
                    <Text className="text-sm text-foreground flex-1">
                      Copy this key now. You won't be able to see it again.
                    </Text>
                  </View>

                  <View className="bg-muted rounded-xl p-3 flex-row items-center gap-2">
                    <Text
                      className="text-sm font-mono text-foreground flex-1"
                      selectable
                      numberOfLines={1}
                    >
                      {createdKey}
                    </Text>
                    <Pressable
                      onPress={() => handleCopy(createdKey)}
                      className="h-10 w-10 items-center justify-center rounded-lg bg-background"
                      accessibilityRole="button"
                      accessibilityLabel="Copy API key"
                    >
                      {copied ? (
                        <Check size={16} className="text-green-500" />
                      ) : (
                        <Copy size={16} className="text-muted-foreground" />
                      )}
                    </Pressable>
                  </View>

                  <Button onPress={closeCreateModal} className="min-h-12 w-full rounded-xl">
                    Done
                  </Button>
                </View>
              ) : (
                <View className="gap-4">
                  <View className="flex-row items-center justify-between">
                    <Text className="text-lg font-semibold text-foreground">Create API Key</Text>
                    <Pressable onPress={closeCreateModal} className="h-9 w-9 items-center justify-center rounded-full bg-muted">
                      <X size={20} className="text-muted-foreground" />
                    </Pressable>
                  </View>

                  <Text className="text-sm leading-5 text-muted-foreground">
                    This key will allow a Shogo Local instance to use cloud LLMs
                    billed to the workspace "{workspace?.name}".
                  </Text>

                  <View className="gap-1.5">
                    <Text className="text-sm font-medium text-foreground">Key name</Text>
                    <Input
                      value={newKeyName}
                      onChangeText={setNewKeyName}
                      placeholder="e.g. My Laptop, Office Desktop"
                    />
                  </View>

                  <View className="flex-row gap-3">
                    <Button variant="outline" onPress={closeCreateModal} className="min-h-11 flex-1 rounded-xl" disabled={isCreating}>
                      Cancel
                    </Button>
                    <Button
                      testID="create-api-key-submit"
                      onPress={handleCreate}
                      disabled={isCreating || !newKeyName.trim()}
                      className="min-h-11 flex-1 rounded-xl"
                    >
                      {isCreating ? 'Creating...' : 'Create Key'}
                    </Button>
                  </View>
                </View>
              )}
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* Revoke Confirmation Modal */}
      <Modal
        visible={revokeTarget !== null}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!isRevoking) setRevokeTarget(null) }}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={() => { if (!isRevoking) setRevokeTarget(null) }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="w-full max-w-sm gap-4 rounded-2xl border border-destructive/30 bg-background p-6"
            role="dialog"
            aria-label="Revoke API Key"
            aria-modal
          >
            <View className="flex-row items-center gap-3">
              <View className="h-10 w-10 items-center justify-center rounded-xl bg-destructive/10">
                <AlertTriangle size={19} className="text-destructive" />
              </View>
              <Text className="text-lg font-semibold text-foreground">
                {revokeTarget?.kind === 'device' ? 'Sign out device' : 'Revoke API Key'}
              </Text>
            </View>
            <Text className="text-sm text-muted-foreground">
              {revokeTarget?.kind === 'device'
                ? `Sign "${revokeTarget?.deviceName || revokeTarget?.name}" out of Shogo Cloud? The desktop app will be signed out the next time it makes a cloud request, and the user can sign in again at any time.`
                : `Are you sure you want to revoke "${revokeTarget?.name}"? Any Shogo Local instance using this key will lose access immediately.`}
            </Text>
            <View className="flex-row gap-3">
              <Button
                variant="outline"
                onPress={() => setRevokeTarget(null)}
                disabled={isRevoking}
                className="min-h-11 flex-1 rounded-xl"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onPress={handleRevoke}
                disabled={isRevoking}
                className="min-h-11 flex-1 rounded-xl"
              >
                {isRevoking
                  ?revokeTarget?.kind === 'device' ? 'Signing out...' : 'Revoking...'
                  :revokeTarget?.kind === 'device' ? 'Sign out' : 'Revoke'}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
})
