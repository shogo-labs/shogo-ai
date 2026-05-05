// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, Platform } from 'react-native'
import { useUpdateChecker } from '@/lib/use-update-checker'
import { X } from 'lucide-react-native'

type DesktopUpdateStatus = 'idle' | 'available' | 'downloading' | 'ready' | 'error'

function useDesktopUpdateStatus() {
  const [status, setStatus] = useState<DesktopUpdateStatus>('idle')
  const [releaseName, setReleaseName] = useState<string | null>(null)
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const desktop = typeof window !== 'undefined' ? (window as any).shogoDesktop : null
    if (!desktop?.getUpdateStatus) return

    desktop
      .getUpdateStatus()
      .then((data: { status: DesktopUpdateStatus; releaseName: string | null; availableVersion: string | null }) => {
        setStatus(data.status)
        setReleaseName(data.releaseName)
        setAvailableVersion(data.availableVersion)
      })

    desktop.onUpdateStatus(
      (data: { status: DesktopUpdateStatus; releaseName: string | null; availableVersion: string | null }) => {
        setStatus(data.status)
        setReleaseName(data.releaseName)
        setAvailableVersion(data.availableVersion)
        setDismissed(false)
      },
    )

    return () => desktop.removeUpdateListener?.()
  }, [])

  const download = useCallback(() => {
    const desktop = (window as any).shogoDesktop
    desktop?.downloadUpdate?.()
  }, [])

  const install = useCallback(() => {
    const desktop = (window as any).shogoDesktop
    desktop?.installUpdate?.()
  }, [])

  // Persistent dismiss: tells the main process to stop re-broadcasting this
  // version for the rest of the session. Falls back to local hide if the
  // desktop bridge isn't available.
  const dismissAvailable = useCallback(() => {
    const desktop = (window as any).shogoDesktop
    desktop?.dismissUpdate?.()
    setDismissed(true)
  }, [])

  return {
    status,
    releaseName,
    availableVersion,
    dismissed,
    setDismissed,
    download,
    install,
    dismissAvailable,
  }
}

export function UpdateBanner() {
  const { updateAvailable, dismiss: dismissWeb } = useUpdateChecker()
  const desktop = useDesktopUpdateStatus()

  const isDesktop = typeof window !== 'undefined' && !!(window as any).shogoDesktop?.isDesktop
  const showDesktopBanner =
    isDesktop &&
    (desktop.status === 'available' || desktop.status === 'downloading' || desktop.status === 'ready') &&
    !desktop.dismissed
  const showWebBanner = !isDesktop && updateAvailable && Platform.OS === 'web'

  if (!showDesktopBanner && !showWebBanner) return null

  if (showDesktopBanner) {
    return (
      <View className="relative flex-row items-center justify-center bg-brand-landing px-8 py-1.5">
        {desktop.status === 'available' ? (
          <>
            <Text className="text-xs font-medium text-white">
              {desktop.availableVersion ?? 'A new version'} is available.
            </Text>
            <Pressable onPress={desktop.download} className="ml-2 rounded bg-white/20 px-2 py-0.5">
              <Text className="text-xs font-semibold text-white">Download</Text>
            </Pressable>
            <Pressable onPress={desktop.dismissAvailable} className="absolute right-2 p-1">
              <X size={12} className="text-white" />
            </Pressable>
          </>
        ) : desktop.status === 'downloading' ? (
          <Text className="text-xs font-medium text-white">Downloading update…</Text>
        ) : (
          <>
            <Text className="text-xs font-medium text-white">
              {desktop.releaseName ?? 'A new version'} is ready to install.
            </Text>
            <Pressable onPress={desktop.install} className="ml-2 rounded bg-white/20 px-2 py-0.5">
              <Text className="text-xs font-semibold text-white">Restart</Text>
            </Pressable>
            <Pressable onPress={() => desktop.setDismissed(true)} className="absolute right-2 p-1">
              <X size={12} className="text-white" />
            </Pressable>
          </>
        )}
      </View>
    )
  }

  return (
    <View className="relative flex-row items-center justify-center bg-brand-landing px-8 py-1.5">
      <Text className="text-xs font-medium text-white">
        A new version is available.
      </Text>
      <Pressable
        onPress={() => {
          if (typeof window !== 'undefined') window.location.reload()
        }}
        className="ml-2 rounded bg-white/20 px-2 py-0.5"
      >
        <Text className="text-xs font-semibold text-white">Refresh</Text>
      </Pressable>
      <Pressable onPress={dismissWeb} className="absolute right-2 p-1">
        <X size={12} className="text-white" />
      </Pressable>
    </View>
  )
}
