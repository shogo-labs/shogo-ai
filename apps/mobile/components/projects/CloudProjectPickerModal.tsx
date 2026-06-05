// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CloudProjectPickerModal
 *
 * Lists the cloud projects the connected `SHOGO_API_KEY` can see and lets
 * the user open one locally. Opening links a local `Project` keyed by the
 * cloud project id; the desktop runtime adapter then auto-pulls the
 * workspace files (git clone / Files API) and starts a `CloudSyncWatcher`
 * to push local edits back on the next start.
 *
 * Desktop/local-only — surfaced from `ProjectSourceMenu`'s "Open from
 * Cloud…" row, which is itself gated on `localMode && shogoKeyConnected`.
 * The list call still degrades to a signed-out empty state if the flags
 * race the backend.
 *
 * Mirrors `ProjectImportModal`'s shell (TransferModalHeader + ModalBody +
 * ModalFooter) so the two read as one consistent surface.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonIcon } from '@/components/ui/button'
import { cn } from '@shogo/shared-ui/primitives'
import {
  Cloud,
  CloudOff,
  CloudDownload,
  Check,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react-native'
import { TransferModalHeader } from '../project/transfer-modal-parts'
import {
  useOpenCloudProject,
  type CloudProjectListItem,
} from '../project/useOpenCloudProject'

interface CloudProjectPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the linked project once the user opens one. */
  onOpenProject: (project: { id: string; name: string }) => void
}

/** Coarse "x ago" — enough to order recents, not a precise timestamp. */
function relativeTime(value?: string | null): string | null {
  if (!value) return null
  const t = new Date(value).getTime()
  if (!Number.isFinite(t)) return null
  const diff = Date.now() - t
  if (diff < 0) return null
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export function CloudProjectPickerModal({
  open,
  onOpenChange,
  onOpenProject,
}: CloudProjectPickerModalProps) {
  // `null` items = still loading (distinguish from a loaded-empty list).
  const [items, setItems] = useState<CloudProjectListItem[] | null>(null)
  const [signedIn, setSignedIn] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)

  const handleSuccess = useCallback(
    (project: { id: string; name: string }) => {
      onOpenProject(project)
      onOpenChange(false)
    },
    [onOpenProject, onOpenChange],
  )

  const { listProjects, openProject } = useOpenCloudProject({ onSuccess: handleSuccess })

  const load = useCallback(async () => {
    setItems(null)
    setError(null)
    try {
      const res = await listProjects()
      setSignedIn(res.signedIn)
      setItems(res.projects)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load cloud projects')
      setItems([])
    }
  }, [listProjects])

  // Refetch each time the modal opens so a project created on another
  // device shows up without an app restart.
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const close = useCallback(() => {
    if (openingId) return // don't close mid-open
    onOpenChange(false)
  }, [openingId, onOpenChange])

  const handlePick = useCallback(
    async (item: CloudProjectListItem) => {
      if (openingId) return
      setOpeningId(item.id)
      try {
        // On success `handleSuccess` fires (navigates + closes); on
        // failure the hook surfaces an Alert and we stay open.
        await openProject(item.id, item.name)
      } finally {
        setOpeningId(null)
      }
    },
    [openProject, openingId],
  )

  const sorted = useMemo(() => {
    if (!items) return null
    return [...items].sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
      return tb - ta
    })
  }, [items])

  return (
    <Modal isOpen={open} onClose={close} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <TransferModalHeader
          icon={Cloud}
          title="Open from Cloud"
          showClose={!openingId}
        />

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-3">
          <Text className="text-sm text-typography-600 leading-relaxed">
            Pick a cloud project to sync to this machine. Its files are pulled
            locally and your edits sync back automatically while it's open.
          </Text>

          {sorted === null ? (
            <LoadingState />
          ) : !signedIn ? (
            <SignedOutState />
          ) : error ? (
            <ErrorState message={error} />
          ) : sorted.length === 0 ? (
            <EmptyState />
          ) : (
            <ScrollView className="max-h-[360px]" showsVerticalScrollIndicator={false}>
              <View className="rounded-xl border border-outline-100 bg-background-50 overflow-hidden">
                {sorted.map((item, i) => (
                  <ProjectRow
                    key={item.id}
                    item={item}
                    first={i === 0}
                    busy={openingId === item.id}
                    disabled={!!openingId && openingId !== item.id}
                    onPress={() => handlePick(item)}
                  />
                ))}
              </View>
            </ScrollView>
          )}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          <Button variant="outline" onPress={close} disabled={!!openingId}>
            <ButtonText>{openingId ? 'Opening…' : 'Cancel'}</ButtonText>
          </Button>
          <Button variant="outline" onPress={load} disabled={sorted === null || !!openingId}>
            <ButtonIcon as={RefreshCw} />
            <ButtonText>Refresh</ButtonText>
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

// ─── Rows + states ────────────────────────────────────────────────────

function ProjectRow({
  item,
  first,
  busy,
  disabled,
  onPress,
}: {
  item: CloudProjectListItem
  first: boolean
  busy: boolean
  disabled: boolean
  onPress: () => void
}) {
  const when = relativeTime(item.updatedAt)
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      className={cn(
        'flex-row items-center gap-3 px-4 py-3 active:bg-background-100',
        !first && 'border-t border-outline-100',
        disabled && 'opacity-50',
      )}
    >
      <View className="h-8 w-8 items-center justify-center rounded-md bg-primary-500/10">
        <Cloud size={16} className="text-primary-500" />
      </View>
      <View className="flex-1 min-w-0">
        <Text className="text-sm font-medium text-typography-900" numberOfLines={1}>
          {item.name?.trim() || 'Untitled project'}
        </Text>
        {when && <Text className="text-[11px] text-typography-500">Updated {when}</Text>}
      </View>

      {busy ? (
        <ActivityIndicator size="small" />
      ) : item.cloudLinked ? (
        <View className="flex-row items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5">
          <Check size={12} className="text-emerald-500" />
          <Text className="text-[11px] font-medium text-emerald-600">Linked</Text>
        </View>
      ) : (
        <CloudDownload size={16} className="text-typography-400" />
      )}
    </Pressable>
  )
}

function LoadingState() {
  return (
    <View className="items-center justify-center gap-3 py-10">
      <ActivityIndicator size="small" />
      <Text className="text-xs text-typography-500">Loading cloud projects…</Text>
    </View>
  )
}

function EmptyState() {
  return (
    <View className="items-center gap-2 py-10">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-background-100">
        <Cloud size={22} className="text-typography-500" />
      </View>
      <Text className="text-sm font-medium text-typography-900">No cloud projects yet</Text>
      <Text className="text-xs text-typography-500 text-center px-4 leading-relaxed">
        Create a project in the Shogo cloud and it'll show up here to sync.
      </Text>
    </View>
  )
}

function SignedOutState() {
  return (
    <View className="items-center gap-2 py-10">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-background-100">
        <CloudOff size={22} className="text-typography-500" />
      </View>
      <Text className="text-sm font-medium text-typography-900">Not connected to cloud</Text>
      <Text className="text-xs text-typography-500 text-center px-4 leading-relaxed">
        Connect a Shogo cloud API key in Settings to browse and sync your cloud projects.
      </Text>
    </View>
  )
}

function ErrorState({ message }: { message: string }) {
  return (
    <View className="items-center gap-2 py-8">
      <View className="h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle size={22} className="text-red-500" />
      </View>
      <Text className="text-sm font-medium text-typography-900">Couldn't load projects</Text>
      <Text className="text-xs text-typography-600 text-center px-4 leading-relaxed">{message}</Text>
    </View>
  )
}
