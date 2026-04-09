// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * InstancePicker — Sidebar component for selecting which Shogo instance to
 * control. When a remote instance is selected, the normal project interface
 * transparently routes agent traffic through the cloud tunnel proxy.
 *
 * Replaces the old "Remote Control" nav item + dedicated screens with an
 * inline picker that makes remote control feel native to the project UI.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native'
import {
  Monitor,
  Laptop,
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Link2,
} from 'lucide-react-native'
import { useRouter } from 'expo-router'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '@/components/ui/popover'
import { useActiveInstance } from '../../contexts/active-instance'
import { API_URL } from '../../lib/api'
import { authClient } from '../../lib/auth-client'

interface Instance {
  id: string
  name: string
  hostname: string
  status: 'online' | 'heartbeat' | 'offline'
  workspaceId: string
  os?: string | null
  lastSeenAt?: string | null
}

function getAuthHeaders(): Record<string, string> {
  if (Platform.OS === 'web') return {}
  const cookie = (authClient as any).getCookie?.()
  return cookie ? { Cookie: cookie } : {}
}

async function fetchInstances(workspaceId: string): Promise<Instance[]> {
  const res = await fetch(
    `${API_URL}/api/instances?workspaceId=${encodeURIComponent(workspaceId)}`,
    {
      credentials: Platform.OS === 'web' ? 'include' : 'omit',
      headers: { ...getAuthHeaders() },
    },
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.instances ?? []) as Instance[]
}

async function requestConnect(instanceId: string): Promise<void> {
  await fetch(`${API_URL}/api/instances/${instanceId}/request-connect`, {
    method: 'POST',
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
  })
}

function StatusDot({ status }: { status: Instance['status'] }) {
  const color =
    status === 'online' ? 'bg-green-500'
    : status === 'heartbeat' ? 'bg-yellow-500'
    : 'bg-muted-foreground/40'

  return <View className={cn('h-2 w-2 rounded-full', color)} />
}

interface InstancePickerProps {
  workspaceId: string | undefined
  collapsed?: boolean
  onNavPress?: () => void
}

export function InstancePicker({ workspaceId, collapsed, onNavPress }: InstancePickerProps) {
  const router = useRouter()
  const { instance: activeInstance, setInstance, clearInstance } = useActiveInstance()
  const [isOpen, setIsOpen] = useState(false)
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)

  const [connectError, setConnectError] = useState<string | null>(null)

  useEffect(() => {
    if (activeInstance && workspaceId && activeInstance.workspaceId !== workspaceId) {
      clearInstance()
    }
  }, [activeInstance, workspaceId, clearInstance])

  const loadInstances = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setConnectError(null)
    try {
      const list = await fetchInstances(workspaceId)
      setInstances(list)
    } catch {
      setInstances([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (isOpen) loadInstances()
  }, [isOpen, loadInstances])

  const handleSelect = useCallback(async (inst: Instance) => {
    setConnectError(null)

    if (inst.status !== 'online') {
      setConnecting(inst.id)
      try {
        await requestConnect(inst.id)
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const updated = await fetchInstances(inst.workspaceId)
          const found = updated.find((u) => u.id === inst.id)
          if (found && found.status === 'online') {
            setInstance({
              instanceId: found.id,
              name: found.name,
              hostname: found.hostname,
              workspaceId: found.workspaceId,
            })
            setInstances(updated)
            setConnecting(null)
            setIsOpen(false)
            return
          }
        }
        setConnectError(`Could not connect to ${inst.name}. Make sure the desktop app is running.`)
      } catch {
        setConnectError(`Failed to reach ${inst.name}. Check your network connection.`)
      }
      setConnecting(null)
      return
    }

    setInstance({
      instanceId: inst.id,
      name: inst.name,
      hostname: inst.hostname,
      workspaceId: inst.workspaceId,
    })
    setIsOpen(false)
  }, [setInstance])

  const handleDisconnect = useCallback(() => {
    clearInstance()
    setIsOpen(false)
  }, [clearInstance])

  const handlePairDevice = useCallback(() => {
    setIsOpen(false)
    onNavPress?.()
    router.push('/(app)/remote-control/pair' as any)
  }, [onNavPress, router])

  const label = activeInstance ? activeInstance.name : 'This device'
  const StatusIcon = activeInstance ? Laptop : Monitor

  const popoverBody = (
          <View className="py-2">
            <Text className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Controlling
            </Text>

            {/* Local / this device option */}
            <Pressable
              onPress={handleDisconnect}
              className="flex-row items-center gap-3 px-4 py-2.5 active:bg-muted"
            >
              <Monitor size={16} className="text-muted-foreground" />
              <Text className="text-sm text-foreground flex-1">This device</Text>
              {!activeInstance && <Check size={16} className="text-primary" />}
            </Pressable>

            {/* Divider */}
            <View className="h-px bg-border mx-3 my-1" />

            <Text className="px-4 pt-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Remote instances
            </Text>

            {loading && (
              <View className="px-4 py-3 items-center">
                <ActivityIndicator size="small" />
              </View>
            )}

            {!loading && instances.length === 0 && (
              <View className="px-4 py-3 gap-3">
                <View className="gap-2">
                  <View className="flex-row items-start gap-2">
                    <Text className="text-xs font-bold text-primary w-4">1</Text>
                    <Text className="text-xs text-muted-foreground flex-1">Install Shogo Desktop on your computer</Text>
                  </View>
                  <View className="flex-row items-start gap-2">
                    <Text className="text-xs font-bold text-primary w-4">2</Text>
                    <Text className="text-xs text-muted-foreground flex-1">Enable cloud sync and generate a pairing code</Text>
                  </View>
                  <View className="flex-row items-start gap-2">
                    <Text className="text-xs font-bold text-primary w-4">3</Text>
                    <Text className="text-xs text-muted-foreground flex-1">Pair this device using the code below</Text>
                  </View>
                </View>
                <Pressable
                  onPress={handlePairDevice}
                  disabled={!workspaceId}
                  className={cn(
                    'flex-row items-center justify-center gap-2 py-2.5 rounded-lg',
                    workspaceId ? 'bg-primary active:opacity-80' : 'bg-muted',
                  )}
                >
                  <Link2 size={14} color={workspaceId ? '#fff' : undefined} className={!workspaceId ? 'text-muted-foreground' : undefined} />
                  <Text className={cn('text-sm font-medium', workspaceId ? 'text-primary-foreground' : 'text-muted-foreground')}>
                    Pair Device
                  </Text>
                </Pressable>
              </View>
            )}

            {!loading && instances.map((inst) => {
              const isActive = activeInstance?.instanceId === inst.id
              const isConnecting = connecting === inst.id

              return (
                <Pressable
                  key={inst.id}
                  onPress={() => handleSelect(inst)}
                  disabled={isConnecting}
                  className={cn(
                    'flex-row items-center gap-3 px-4 py-2.5 active:bg-muted',
                    isConnecting && 'opacity-50',
                  )}
                >
                  <Laptop size={16} className="text-muted-foreground" />
                  <View className="flex-1 min-w-0">
                    <Text className="text-sm text-foreground" numberOfLines={1}>
                      {inst.name}
                    </Text>
                    <View className="flex-row items-center gap-1.5 mt-0.5">
                      <StatusDot status={inst.status} />
                      <Text className="text-[11px] text-muted-foreground">
                        {inst.status === 'online' ? 'Online' : inst.status === 'heartbeat' ? 'Standby' : 'Offline'}
                      </Text>
                    </View>
                  </View>
                  {isConnecting && <ActivityIndicator size="small" />}
                  {isActive && !isConnecting && <Check size={16} className="text-primary" />}
                </Pressable>
              )
            })}

            {connectError && (
              <View className="px-4 py-2">
                <Text className="text-xs text-destructive text-center">
                  {connectError}
                </Text>
              </View>
            )}

            {!loading && instances.length > 0 && (
              <>
                <View className="h-px bg-border mx-3 my-1" />
                <Pressable
                  onPress={handlePairDevice}
                  disabled={!workspaceId}
                  className="flex-row items-center gap-3 px-4 py-2.5 active:bg-muted"
                >
                  <Plus size={16} className="text-muted-foreground" />
                  <Text className="text-sm text-muted-foreground">Pair New Device</Text>
                </Pressable>
              </>
            )}
          </View>
  )

  return (
    <Popover
      placement="right"
      size="sm"
      isOpen={isOpen}
      onOpen={() => setIsOpen(true)}
      onClose={() => setIsOpen(false)}
      trigger={(triggerProps) =>
        collapsed ? (
          <Pressable
            {...triggerProps}
            accessibilityLabel="Instance selector"
            className={cn(
              'items-center justify-center rounded-md px-2 py-2',
              activeInstance ? 'bg-primary/10' : 'active:bg-accent/50',
            )}
          >
            <StatusIcon
              size={16}
              className={activeInstance ? 'text-primary' : 'text-muted-foreground'}
            />
          </Pressable>
        ) : (
          <Pressable
            {...triggerProps}
            className={cn(
              'flex-row items-center gap-3 rounded-md px-3 py-2',
              activeInstance ? 'bg-primary/10' : 'active:bg-accent/50',
            )}
          >
            <StatusIcon
              size={16}
              className={activeInstance ? 'text-primary' : 'text-muted-foreground'}
            />
            <Text
              className={cn(
                'text-sm flex-1',
                activeInstance ? 'text-primary font-medium' : 'text-muted-foreground',
              )}
              numberOfLines={1}
            >
              {label}
            </Text>
            {isOpen ? (
              <ChevronDown size={14} className="text-muted-foreground" />
            ) : (
              <ChevronRight size={14} className="text-muted-foreground" />
            )}
          </Pressable>
        )
      }
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0">
        <PopoverBody>
          {popoverBody}
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
