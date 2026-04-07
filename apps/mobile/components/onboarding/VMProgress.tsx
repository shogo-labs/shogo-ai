// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, Platform } from 'react-native'
import { Download, CheckCircle, AlertTriangle, RotateCcw } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface VMDownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percent: number
  stage: string
}

function getDesktopBridge(): any {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return (window as any).shogoDesktop
  }
  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

type DownloadState = 'idle' | 'downloading' | 'extracting' | 'complete' | 'error' | 'already-present'

interface VMProgressProps {
  autoStart?: boolean
}

export function VMProgress({ autoStart = true }: VMProgressProps) {
  const [state, setState] = useState<DownloadState>('idle')
  const [progress, setProgress] = useState<VMDownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) return

    bridge.getVMImageStatus().then((status: any) => {
      if (status?.imagesPresent) {
        setState('already-present')
        return
      }
      if (autoStart) {
        startDownload()
      }
    }).catch(() => {})

    bridge.onVMImageDownloadProgress((p: VMDownloadProgress) => {
      setProgress(p)
      if (p.stage === 'extracting') {
        setState('extracting')
      } else {
        setState('downloading')
      }
    })
  }, [])

  const startDownload = useCallback(async () => {
    const bridge = getDesktopBridge()
    if (!bridge) return

    setState('downloading')
    setError(null)
    try {
      const result = await bridge.downloadVMImages()
      if (result?.success) {
        setState('complete')
      } else {
        setError(result?.error || 'Download failed')
        setState('error')
      }
    } catch (err: any) {
      setError(err?.message || 'Download failed')
      setState('error')
    }
  }, [])

  if (!getDesktopBridge()) return null

  if (state === 'already-present') {
    return (
      <View className="flex-row items-center gap-2 bg-green-500/10 px-4 py-3 rounded-xl">
        <CheckCircle size={16} className="text-green-500" />
        <Text className="text-sm text-green-500">Sandbox environment ready</Text>
      </View>
    )
  }

  if (state === 'complete') {
    return (
      <View className="flex-row items-center gap-2 bg-green-500/10 px-4 py-3 rounded-xl">
        <CheckCircle size={16} className="text-green-500" />
        <Text className="text-sm text-green-500">Sandbox environment installed</Text>
      </View>
    )
  }

  if (state === 'error') {
    return (
      <View className="gap-3 bg-destructive/10 px-4 py-3 rounded-xl">
        <View className="flex-row items-center gap-2">
          <AlertTriangle size={16} className="text-destructive" />
          <Text className="text-sm text-destructive flex-1">{error}</Text>
        </View>
        <Pressable
          onPress={startDownload}
          className="flex-row items-center gap-2 self-start bg-destructive/20 px-3 py-1.5 rounded-lg"
        >
          <RotateCcw size={12} className="text-destructive" />
          <Text className="text-xs font-medium text-destructive">Retry</Text>
        </Pressable>
      </View>
    )
  }

  const percent = progress?.percent ?? 0
  const isExtracting = state === 'extracting'

  return (
    <View className="gap-2 bg-card border border-border rounded-xl px-4 py-3">
      <View className="flex-row items-center gap-2">
        <Download size={14} className="text-muted-foreground" />
        <Text className="text-sm text-muted-foreground flex-1">
          {isExtracting
            ? 'Extracting files...'
            : progress?.totalBytes
              ? `${formatBytes(progress.bytesDownloaded)} / ${formatBytes(progress.totalBytes)}`
              : 'Starting download...'}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {isExtracting ? '100%' : `${percent}%`}
        </Text>
      </View>
      <View className="h-1.5 bg-muted rounded-full overflow-hidden">
        <View
          className="h-full bg-primary rounded-full"
          style={{ width: `${isExtracting ? 100 : percent}%` }}
        />
      </View>
    </View>
  )
}
