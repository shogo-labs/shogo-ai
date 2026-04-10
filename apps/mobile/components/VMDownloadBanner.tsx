// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, Pressable, Platform } from 'react-native'
import { Download, CheckCircle, AlertTriangle, RotateCcw, X } from 'lucide-react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { usePlatformConfig } from '@/lib/platform-config'
import { API_URL } from '@/lib/api'
import { cn } from '@shogo/shared-ui/primitives'

const COMPLETE_SEEN_KEY = 'shogo:vmDownloadCompleteSeen'

interface DownloadStatus {
  status: 'idle' | 'downloading' | 'extracting' | 'complete' | 'error'
  percent: number
  bytesDownloaded: number
  totalBytes: number
  error?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

export function VMDownloadBanner() {
  const { localMode } = usePlatformConfig()
  const [status, setStatus] = useState<DownloadStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [hidden, setHidden] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const completePersisted = useRef(false)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    AsyncStorage.getItem(COMPLETE_SEEN_KEY).then((v) => {
      if (v === '1') setHidden(true)
    }).catch(() => {})
  }, [])

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/vm/images/download-status`, {
        credentials: 'include',
      })
      if (!res.ok) return
      const data: DownloadStatus = await res.json()
      setStatus(data)

      if (data.status === 'complete' && !completePersisted.current) {
        completePersisted.current = true
        AsyncStorage.setItem(COMPLETE_SEEN_KEY, '1').catch(() => {})
        setTimeout(() => setHidden(true), 4000)
      }
    } catch { /* server not ready yet */ }
  }, [])

  useEffect(() => {
    if (!localMode || Platform.OS !== 'web') return

    pollStatus()

    pollRef.current = setInterval(pollStatus, 2000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [localMode, pollStatus])

  useEffect(() => {
    if (!status) return
    if (status.status === 'idle' || status.status === 'complete') {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = setInterval(pollStatus, 10000)
      }
    } else if (status.status === 'downloading' || status.status === 'extracting') {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = setInterval(pollStatus, 1000)
      }
    }
  }, [status?.status, pollStatus])

  if (!localMode || Platform.OS !== 'web') return null
  if (dismissed || hidden) return null
  if (!status) return null
  if (status.status === 'idle') return null

  const retryDownload = async () => {
    try {
      setStatus({ status: 'downloading', percent: 0, bytesDownloaded: 0, totalBytes: 0 })
      await fetch(`${API_URL}/api/vm/images/download`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch { /* polling will pick up the result */ }
  }

  if (status.status === 'complete') {
    return (
      <View className="mx-4 mt-2 flex-row items-center gap-2.5 rounded-xl border border-green-500/20 bg-green-500/5 px-4 py-2.5">
        <CheckCircle size={15} className="text-green-500" />
        <Text className="text-xs font-medium text-green-600 flex-1">
          Sandbox environment ready
        </Text>
        <Pressable onPress={() => setHidden(true)} className="p-0.5">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    )
  }

  if (status.status === 'error') {
    return (
      <View className="mx-4 mt-2 flex-row items-center gap-2.5 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-2.5">
        <AlertTriangle size={15} className="text-destructive" />
        <Text className="text-xs text-destructive flex-1" numberOfLines={1}>
          Sandbox setup failed{status.error ? `: ${status.error}` : ''}
        </Text>
        <Pressable
          onPress={retryDownload}
          className="flex-row items-center gap-1 rounded-md bg-destructive/10 px-2 py-1"
        >
          <RotateCcw size={10} className="text-destructive" />
          <Text className="text-[10px] font-semibold text-destructive">Retry</Text>
        </Pressable>
        <Pressable onPress={() => setDismissed(true)} className="p-0.5">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
    )
  }

  const isExtracting = status.status === 'extracting'
  const percent = isExtracting ? 100 : (status.percent ?? 0)
  const label = isExtracting
    ? 'Extracting sandbox environment...'
    : status.totalBytes > 0
      ? `Downloading sandbox (${formatBytes(status.bytesDownloaded)} / ${formatBytes(status.totalBytes)})`
      : 'Downloading sandbox environment...'

  return (
    <View className="mx-4 mt-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 gap-2">
      <View className="flex-row items-center gap-2.5">
        <Download size={14} className="text-primary" />
        <Text className="text-xs font-medium text-foreground flex-1">
          {label}
        </Text>
        <Text className="text-[10px] font-semibold text-muted-foreground tabular-nums">
          {percent}%
        </Text>
        <Pressable onPress={() => setDismissed(true)} className="p-0.5">
          <X size={12} className="text-muted-foreground" />
        </Pressable>
      </View>
      <View className="h-1.5 rounded-full bg-muted overflow-hidden">
        <View
          className={cn('h-full rounded-full', isExtracting ? 'bg-green-500' : 'bg-primary')}
          style={{ width: `${percent}%` }}
        />
      </View>
    </View>
  )
}
