// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The profile picture control on the profile page.
 *
 * Picking a photo resizes it to 512x512 and uploads it straight away, showing
 * the resized image locally while the upload is in flight so the change is
 * visible immediately. The server writes the URL into `User.image` and this
 * calls `refreshSession()` afterwards, so every other surface (message authors,
 * member lists, the account menu) picks the new picture up from the same source
 * of truth rather than from a second copy held here.
 */

import { useState } from 'react'
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native'
import { Camera, Image as ImageIcon } from 'lucide-react-native'
import { Avatar, Button, cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import { pickAvatarPhoto, type AvatarPhotoSource } from '../../lib/avatar-picker'
import { prepareAvatarImage, removeAvatar, uploadAvatar } from '../../lib/avatar-image'
import { resolveAvatarUrl } from '../../lib/chat-attachment-url'

function initials(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase()
  return `${parts[0].slice(0, 1)}${parts[parts.length - 1].slice(0, 1)}`.toUpperCase()
}

const SOURCE_ROWS: { source: AvatarPhotoSource; label: string; hint: string; Icon: typeof Camera }[] = [
  { source: 'library', label: 'Choose from library', hint: 'Pick an existing photo', Icon: ImageIcon },
  { source: 'camera', label: 'Take photo', hint: 'Use your camera', Icon: Camera },
]

export function ProfilePhoto({ isPhone = false }: { isPhone?: boolean }) {
  const { user, refreshSession } = useAuth()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pendingUri, setPendingUri] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (source: AvatarPhotoSource) => {
    setSheetOpen(false)
    setError(null)

    const picked = await pickAvatarPhoto(source)
    if (!picked.ok) {
      if (picked.reason !== 'cancelled') setError(picked.message ?? 'Could not open that photo.')
      return
    }

    setBusy(true)
    try {
      const prepared = await prepareAvatarImage(picked.photo.uri, picked.photo)
      setPendingUri(prepared.uri)
      await uploadAvatar(prepared.uri)
      await refreshSession()
    } catch (cause: any) {
      setError(cause?.message ?? 'Could not save your photo.')
    } finally {
      setPendingUri(null)
      setBusy(false)
    }
  }

  const remove = async () => {
    setError(null)
    setBusy(true)
    try {
      await removeAvatar()
      await refreshSession()
    } catch (cause: any) {
      setError(cause?.message ?? 'Could not remove your photo.')
    } finally {
      setBusy(false)
    }
  }

  const shown = pendingUri ?? resolveAvatarUrl(user?.image)

  return (
    <View
      className={cn('gap-3', isPhone ? 'items-start' : 'flex-row items-center gap-4')}
      testID="profile-photo"
    >
      <View className="relative">
        <Avatar fallback={initials(user?.name)} src={shown} size="lg" />
        {busy && (
          <View className="absolute inset-0 items-center justify-center rounded-full bg-background/60">
            <ActivityIndicator size="small" />
          </View>
        )}
      </View>

      <View className="min-w-0 flex-1 gap-1.5">
        <Text className="text-sm font-medium text-foreground">Your photo</Text>
        <Text className="text-xs text-muted-foreground">
          Square, up to 1 MB. We resize it to 512x512.
        </Text>

        <View className="flex-row flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onPress={() => { setError(null); setSheetOpen(true) }}
            testID="profile-photo-change"
          >
            {user?.image ? 'Change photo' : 'Add photo'}
          </Button>
          {user?.image ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onPress={remove}
              testID="profile-photo-remove"
            >
              Remove
            </Button>
          ) : null}
        </View>

        {error ? (
          <Text className="text-xs text-destructive" testID="profile-photo-error">{error}</Text>
        ) : null}
      </View>

      <Modal visible={sheetOpen} transparent animationType="fade" onRequestClose={() => setSheetOpen(false)}>
        <View className="flex-1 justify-end">
          <Pressable
            className="absolute inset-0 bg-black/40"
            onPress={() => setSheetOpen(false)}
            accessibilityLabel="Dismiss photo options"
          />
          <View className="z-10 w-full gap-1 rounded-t-3xl border border-outline-100 border-b-0 bg-background p-4">
            {SOURCE_ROWS.map(({ source, label, hint, Icon }) => (
              <Pressable
                key={source}
                onPress={() => choose(source)}
                className="flex-row items-center gap-3 rounded-xl px-3 py-3 active:bg-secondary"
                testID={`profile-photo-source-${source}`}
              >
                <Icon size={20} className="text-foreground" />
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-medium text-foreground">{label}</Text>
                  <Text className="text-xs text-muted-foreground">{hint}</Text>
                </View>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setSheetOpen(false)}
              className="items-center rounded-xl px-3 py-3 active:bg-secondary"
              testID="profile-photo-cancel"
            >
              <Text className="text-base text-muted-foreground">Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  )
}
