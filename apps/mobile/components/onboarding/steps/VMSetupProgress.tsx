// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, ActivityIndicator, Platform } from 'react-native'
import { CheckCircle, AlertTriangle, Download, ArrowRight, Info, SkipForward } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { API_URL } from '../../../lib/api'

interface VMSetupDiagnostics {
  platform: string
  qemuInstalled: boolean
  whpxEnabled: boolean
}

type QemuInstallStatus = 'idle' | 'installing' | 'complete' | 'error'
type WhpxEnableStatus = 'idle' | 'enabling' | 'enabled-needs-reboot' | 'error'

interface VMSetupProgressProps {
  onComplete?: () => void
  compact?: boolean
}

async function fetchDiagnostics(): Promise<VMSetupDiagnostics | null> {
  try {
    const res = await fetch(`${API_URL}/api/vm/diagnostics`, { credentials: 'include' })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

export function VMSetupProgress({ onComplete, compact = false }: VMSetupProgressProps) {
  const [diagnostics, setDiagnostics] = useState<VMSetupDiagnostics | null>(null)
  const [qemuStatus, setQemuStatus] = useState<QemuInstallStatus>('idle')
  const [qemuError, setQemuError] = useState<string | null>(null)
  const [whpxStatus, setWhpxStatus] = useState<WhpxEnableStatus>('idle')
  const [whpxError, setWhpxError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadDiagnostics = useCallback(async () => {
    const diag = await fetchDiagnostics()
    setDiagnostics(diag)
    setIsLoading(false)
    if (diag?.qemuInstalled && diag?.whpxEnabled && onComplete) {
      onComplete()
    }
  }, [onComplete])

  useEffect(() => {
    loadDiagnostics()
  }, [loadDiagnostics])

  // Poll QEMU install status while installing
  useEffect(() => {
    if (qemuStatus !== 'installing') return
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/vm/qemu/install-status`, { credentials: 'include' })
        if (!res.ok) return
        const data = await res.json()
        if (data.status === 'complete') {
          setQemuStatus('complete')
          loadDiagnostics()
        } else if (data.status === 'error') {
          setQemuStatus('error')
          setQemuError(data.error || 'Installation failed')
        }
      } catch { /* polling error, ignore */ }
    }, 2000)
    return () => clearInterval(interval)
  }, [qemuStatus, loadDiagnostics])

  const installQemu = useCallback(async () => {
    setQemuStatus('installing')
    setQemuError(null)
    try {
      const res = await fetch(`${API_URL}/api/vm/qemu/install`, {
        method: 'POST',
        credentials: 'include',
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (data.status === 'complete') {
          setQemuStatus('complete')
          loadDiagnostics()
          return
        }
        throw new Error(data.error || `Install request failed: ${res.status}`)
      }

      // Read SSE stream for progress
      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              if (!data) continue
              try {
                const parsed = JSON.parse(data)
                if (parsed.success === true) {
                  setQemuStatus('complete')
                  loadDiagnostics()
                  return
                }
                if (parsed.success === false) {
                  setQemuStatus('error')
                  setQemuError(parsed.error || 'Installation failed')
                  return
                }
              } catch { /* ignore malformed SSE */ }
            }
          }
        }
      }

      // If stream ended without explicit success/error, check final state
      if (qemuStatus === 'installing') {
        loadDiagnostics()
      }
    } catch (err: any) {
      setQemuStatus('error')
      setQemuError(err?.message || 'Installation failed')
    }
  }, [loadDiagnostics, qemuStatus])

  const enableWhpx = useCallback(async () => {
    setWhpxStatus('enabling')
    setWhpxError(null)
    try {
      const res = await fetch(`${API_URL}/api/vm/whpx/enable`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()

      if (data.success) {
        if (data.needsReboot) {
          setWhpxStatus('enabled-needs-reboot')
        } else {
          setWhpxStatus('idle')
          loadDiagnostics()
        }
      } else {
        setWhpxStatus('error')
        setWhpxError(data.error || 'Failed to enable WHPX')
      }
    } catch (err: any) {
      setWhpxStatus('error')
      setWhpxError(err?.message || 'Failed to enable WHPX')
    }
  }, [loadDiagnostics])

  if (Platform.OS !== 'web') return null

  if (isLoading) {
    return (
      <View className="items-center justify-center py-4">
        <ActivityIndicator size="small" />
      </View>
    )
  }

  if (!diagnostics || diagnostics.platform !== 'win32') {
    return null
  }

  const qemuReady = diagnostics.qemuInstalled || qemuStatus === 'complete'
  const whpxReady = diagnostics.whpxEnabled
  const whpxPendingReboot = whpxStatus === 'enabled-needs-reboot'
  const allReady = qemuReady && whpxReady

  if (allReady && compact) return null

  return (
    <View className={cn('gap-3', compact ? '' : 'gap-4')}>
      {/* QEMU status */}
      <View className={cn(
        'rounded-xl border px-4 py-3',
        qemuReady
          ? 'border-green-500/20 bg-green-500/5'
          : qemuStatus === 'error'
            ? 'border-destructive/20 bg-destructive/5'
            : 'border-border bg-card',
      )}>
        <View className="flex-row items-center gap-2.5">
          {qemuReady ? (
            <CheckCircle size={15} className="text-green-500" />
          ) : qemuStatus === 'error' ? (
            <AlertTriangle size={15} className="text-destructive" />
          ) : qemuStatus === 'installing' ? (
            <ActivityIndicator size="small" />
          ) : (
            <Download size={15} className="text-muted-foreground" />
          )}
          <View className="flex-1">
            <Text className={cn(
              'text-sm font-medium',
              qemuReady ? 'text-green-600' : qemuStatus === 'error' ? 'text-destructive' : 'text-foreground',
            )}>
              {qemuReady
                ? 'QEMU installed'
                : qemuStatus === 'installing'
                  ? 'Installing QEMU...'
                  : qemuStatus === 'error'
                    ? 'QEMU installation failed'
                    : 'QEMU not installed'}
            </Text>
            {!qemuReady && qemuStatus === 'idle' && (
              <Text className="text-xs text-muted-foreground mt-0.5">
                Required for VM sandboxing (~200 MB via winget)
              </Text>
            )}
            {qemuStatus === 'error' && qemuError && (
              <Text className="text-xs text-destructive mt-0.5" numberOfLines={2}>
                {qemuError}
              </Text>
            )}
          </View>
          {!qemuReady && qemuStatus === 'idle' && (
            <Pressable
              onPress={installQemu}
              className="rounded-lg bg-primary px-3 py-1.5"
            >
              <Text className="text-xs font-semibold text-primary-foreground">Install</Text>
            </Pressable>
          )}
          {qemuStatus === 'error' && (
            <Pressable
              onPress={installQemu}
              className="rounded-lg bg-destructive/10 px-3 py-1.5"
            >
              <Text className="text-xs font-semibold text-destructive">Retry</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* WHPX status */}
      <View className={cn(
        'rounded-xl border px-4 py-3',
        whpxReady
          ? 'border-green-500/20 bg-green-500/5'
          : whpxPendingReboot
            ? 'border-amber-500/20 bg-amber-500/5'
            : whpxStatus === 'error'
              ? 'border-destructive/20 bg-destructive/5'
              : 'border-border bg-card',
      )}>
        <View className="flex-row items-center gap-2.5">
          {whpxReady ? (
            <CheckCircle size={15} className="text-green-500" />
          ) : whpxPendingReboot ? (
            <Info size={15} className="text-amber-600" />
          ) : whpxStatus === 'enabling' ? (
            <ActivityIndicator size="small" />
          ) : whpxStatus === 'error' ? (
            <AlertTriangle size={15} className="text-destructive" />
          ) : (
            <Info size={15} className="text-muted-foreground" />
          )}
          <View className="flex-1">
            <Text className={cn(
              'text-sm font-medium',
              whpxReady ? 'text-green-600'
                : whpxPendingReboot ? 'text-amber-700'
                : whpxStatus === 'error' ? 'text-destructive'
                : 'text-foreground',
            )}>
              {whpxReady
                ? 'Windows Hypervisor Platform enabled'
                : whpxPendingReboot
                  ? 'Restart required'
                  : whpxStatus === 'enabling'
                    ? 'Enabling (check for UAC prompt)...'
                    : whpxStatus === 'error'
                      ? 'Failed to enable WHPX'
                      : 'Windows Hypervisor Platform not enabled'}
            </Text>
            {whpxPendingReboot && (
              <Text className="text-xs text-amber-600 mt-0.5">
                WHPX has been enabled. Restart your computer for it to activate.
              </Text>
            )}
            {whpxStatus === 'error' && whpxError && (
              <Text className="text-xs text-destructive mt-0.5" numberOfLines={2}>
                {whpxError}
              </Text>
            )}
            {!whpxReady && !whpxPendingReboot && whpxStatus === 'idle' && (
              <Text className="text-xs text-muted-foreground mt-0.5">
                Requires admin permission (UAC prompt will appear)
              </Text>
            )}
          </View>
          {!whpxReady && !whpxPendingReboot && whpxStatus === 'idle' && (
            <Pressable
              onPress={enableWhpx}
              className="rounded-lg bg-primary px-3 py-1.5"
            >
              <Text className="text-xs font-semibold text-primary-foreground">Enable</Text>
            </Pressable>
          )}
          {whpxStatus === 'error' && (
            <Pressable
              onPress={enableWhpx}
              className="rounded-lg bg-destructive/10 px-3 py-1.5"
            >
              <Text className="text-xs font-semibold text-destructive">Retry</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* All ready, pending reboot, or skip */}
      {allReady || (qemuReady && whpxPendingReboot) ? (
        onComplete && (
          <Pressable
            onPress={onComplete}
            className="flex-row items-center justify-center gap-2 py-3 rounded-xl bg-primary"
          >
            <Text className="text-sm font-semibold text-primary-foreground">Continue</Text>
            <ArrowRight size={16} color="#fff" />
          </Pressable>
        )
      ) : (
        onComplete && !compact && (
          <Pressable
            onPress={onComplete}
            className="flex-row items-center justify-center gap-1.5 py-2"
          >
            <SkipForward size={13} className="text-muted-foreground" />
            <Text className="text-xs text-muted-foreground">
              Skip — VM isolation is optional
            </Text>
          </Pressable>
        )
      )}
    </View>
  )
}
