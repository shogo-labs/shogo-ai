// SPDX-License-Identifier: AGPL-3.0-or-later
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
  TextInput,
  Modal,
  ActivityIndicator,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
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
} from 'lucide-react-native'
import { PlatformApi, type ApiKeyInfo } from '@shogo-ai/sdk'
import { useAuth } from '../../contexts/auth'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { createHttpClient } from '../../lib/api'
import {
  Card,
  CardContent,
  Button,
  Input,
  Badge,
  cn,
} from '@shogo/shared-ui/primitives'

export default function ApiKeysPage() {
  const router = useRouter()
  const { user } = useAuth()
  const workspace = useActiveWorkspace()

  const platform = useMemo(() => new PlatformApi(createHttpClient()), [])

  const [keys, setKeys] = useState<ApiKeyInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [newKeyName, setNewKeyName] = useState('Shogo Local')
  const [isCreating, setIsCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  const loadKeys = useCallback(async () => {
    if (!workspace?.id) return
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
    if (Platform.OS === 'web') {
      await navigator.clipboard.writeText(text)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const closeCreateModal = () => {
    setShowCreateModal(false)
    setCreatedKey(null)
    setNewKeyName('Shogo Local')
    setCopied(false)
  }

  return (
    <View className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center gap-3 px-6 py-4 border-b border-border">
        <Pressable onPress={() => router.canGoBack() ? router.back() : router.replace('/(app)/settings')}>
          <ArrowLeft size={20} className="text-foreground" />
        </Pressable>
        <View className="flex-1">
          <Text className="text-xl font-bold text-foreground">API Keys</Text>
          <Text className="text-sm text-muted-foreground">
            Manage API keys for Shogo Local
          </Text>
        </View>
        <Button size="sm" onPress={() => setShowCreateModal(true)}>
          <View className="flex-row items-center gap-1.5">
            <Plus size={14} color="#fff" />
            <Text className="text-sm font-medium text-primary-foreground">Create Key</Text>
          </View>
        </Button>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="p-6 pb-20 max-w-3xl w-full mx-auto"
      >
        {/* Info banner */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <View className="flex-row items-start gap-3">
              <Monitor size={20} className="text-primary mt-0.5" />
              <View className="flex-1">
                <Text className="text-sm font-medium text-foreground">
                  Use API keys with Shogo Local
                </Text>
                <Text className="text-xs text-muted-foreground mt-1 leading-5">
                  Enter your API key in your Shogo Local settings to use our cloud
                  LLMs. Usage will be billed to this workspace's credit balance.
                </Text>
              </View>
            </View>
          </CardContent>
        </Card>

        {/* Keys list */}
        {isLoading ? (
          <View className="py-12 items-center">
            <ActivityIndicator size="large" />
            <Text className="text-sm text-muted-foreground mt-3">Loading API keys...</Text>
          </View>
        ) : keys.length === 0 ? (
          <View className="py-16 items-center">
            <View className="h-16 w-16 rounded-full bg-muted/50 items-center justify-center mb-4">
              <Key size={28} className="text-muted-foreground/50" />
            </View>
            <Text className="text-base font-medium text-foreground mb-1">No API keys yet</Text>
            <Text className="text-sm text-muted-foreground mb-4">
              Create an API key to connect a Shogo Local instance.
            </Text>
            <Button onPress={() => setShowCreateModal(true)}>
              <View className="flex-row items-center gap-1.5">
                <Plus size={14} color="#fff" />
                <Text className="text-sm font-medium text-primary-foreground">Create API Key</Text>
              </View>
            </Button>
          </View>
        ) : (
          <Card>
            <CardContent className="p-0">
              {/* Table header */}
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

              {keys.map((key) => (
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
                    <Pressable onPress={() => setRevokeTarget(key)}>
                      <Trash2 size={14} className="text-muted-foreground" />
                    </Pressable>
                  </View>
                </View>
              ))}

              <View className="px-4 py-2.5">
                <Text className="text-xs text-muted-foreground">
                  {keys.length} key{keys.length !== 1 ? 's' : ''}
                </Text>
              </View>
            </CardContent>
          </Card>
        )}
      </ScrollView>

      {/* Create Key Modal */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={closeCreateModal}
      >
        <Pressable
          className="flex-1 bg-black/50 justify-center items-center px-6"
          onPress={closeCreateModal}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            className="bg-background rounded-xl p-6 w-full max-w-md"
          >
            {createdKey ? (
              <View className="gap-4">
                <View className="flex-row items-center justify-between">
                  <Text className="text-lg font-semibold text-foreground">API Key Created</Text>
                  <Pressable onPress={closeCreateModal} className="p-1">
                    <X size={20} className="text-muted-foreground" />
                  </Pressable>
                </View>

                <View className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 flex-row items-start gap-2">
                  <AlertTriangle size={16} className="text-amber-500 mt-0.5" />
                  <Text className="text-sm text-foreground flex-1">
                    Copy this key now. You won't be able to see it again.
                  </Text>
                </View>

                <View className="bg-muted rounded-lg p-3 flex-row items-center gap-2">
                  <Text
                    className="text-sm font-mono text-foreground flex-1"
                    selectable
                    numberOfLines={1}
                  >
                    {createdKey}
                  </Text>
                  <Pressable onPress={() => handleCopy(createdKey)}>
                    {copied ? (
                      <Check size={16} className="text-green-500" />
                    ) : (
                      <Copy size={16} className="text-muted-foreground" />
                    )}
                  </Pressable>
                </View>

                <Button onPress={closeCreateModal} className="w-full">
                  Done
                </Button>
              </View>
            ) : (
              <View className="gap-4">
                <View className="flex-row items-center justify-between">
                  <Text className="text-lg font-semibold text-foreground">Create API Key</Text>
                  <Pressable onPress={closeCreateModal} className="p-1">
                    <X size={20} className="text-muted-foreground" />
                  </Pressable>
                </View>

                <Text className="text-sm text-muted-foreground">
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
                  <Button variant="outline" onPress={closeCreateModal} className="flex-1" disabled={isCreating}>
                    Cancel
                  </Button>
                  <Button
                    onPress={handleCreate}
                    disabled={isCreating || !newKeyName.trim()}
                    className="flex-1"
                  >
                    {isCreating ? 'Creating...' : 'Create Key'}
                  </Button>
                </View>
              </View>
            )}
          </Pressable>
        </Pressable>
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
            className="bg-background rounded-xl p-6 w-full max-w-sm gap-4"
          >
            <Text className="text-lg font-semibold text-foreground">Revoke API Key</Text>
            <Text className="text-sm text-muted-foreground">
              Are you sure you want to revoke "{revokeTarget?.name}"? Any Shogo Local
              instance using this key will lose access immediately.
            </Text>
            <View className="flex-row gap-3">
              <Button
                variant="outline"
                onPress={() => setRevokeTarget(null)}
                disabled={isRevoking}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onPress={handleRevoke}
                disabled={isRevoking}
                className="flex-1"
              >
                {isRevoking ? 'Revoking...' : 'Revoke'}
              </Button>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}
