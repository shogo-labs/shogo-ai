// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin VM / Sandbox Settings - VM isolation status, image management,
 * configuration, and diagnostics for the desktop build.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  TextInput,
  Platform,
} from 'react-native'
import {
  Monitor,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Download,
  RotateCcw,
  HardDrive,
  Cpu,
  Settings,
  Wrench,
  Save,
  Info,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

// =============================================================================
// Desktop Bridge
// =============================================================================

const IS_LOCAL = process.env.EXPO_PUBLIC_LOCAL_MODE === 'true'
  || process.env.NODE_ENV === 'development'

function getApiBaseUrl(): string {
  const port = process.env.EXPO_PUBLIC_API_PORT ?? '8002'
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const desktop = (window as any).shogoDesktop as { apiUrl?: string } | undefined
    if (desktop?.apiUrl) return desktop.apiUrl
    const envUrl = process.env.EXPO_PUBLIC_API_URL
    if (envUrl) return envUrl
    return `http://localhost:${port}`
  }
  return process.env.EXPO_PUBLIC_API_URL || `http://localhost:${port}`
}

function createHttpBridge() {
  const base = getApiBaseUrl()
  const progressCallbacks: Array<(p: VMDownloadProgress) => void> = []

  return {
    platform: Platform.OS === 'web' ? (navigator.userAgent.includes('Win') ? 'win32' : navigator.userAgent.includes('Mac') ? 'darwin' : 'linux') : Platform.OS,
    isDesktop: true,

    async getVMImageStatus(): Promise<VMImageStatus> {
      const res = await fetch(`${base}/api/vm/images`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to fetch image status: ${res.status}`)
      return res.json()
    },

    async getVMStatus(): Promise<VMStatus> {
      const res = await fetch(`${base}/api/vm/status`, { credentials: 'include' })
      if (!res.ok) throw new Error(`Failed to fetch VM status: ${res.status}`)
      return res.json()
    },

    async setVMConfig(config: { enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number }) {
      const res = await fetch(`${base}/api/vm/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error(`Failed to save VM config: ${res.status}`)
      return res.json()
    },

    async downloadVMImages() {
      const res = await fetch(`${base}/api/vm/images/download`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Failed to start download: ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result: { success: boolean; error?: string } = { success: false }

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
                if (parsed.percent !== undefined) {
                  progressCallbacks.forEach((cb) => cb(parsed))
                }
                if (parsed.success !== undefined) {
                  result = parsed
                }
              } catch { /* ignore malformed SSE */ }
            }
          }
        }
      }

      return result.success ? { success: true } : { success: false, error: result.error }
    },

    onVMImageDownloadProgress(cb: (p: VMDownloadProgress) => void) {
      progressCallbacks.push(cb)
    },
  }
}

let _httpBridge: ReturnType<typeof createHttpBridge> | null = null

function getDesktopBridge(): any {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if ((window as any).shogoDesktop) return (window as any).shogoDesktop
    if (IS_LOCAL) {
      if (!_httpBridge) _httpBridge = createHttpBridge()
      return _httpBridge
    }
  }
  return null
}

interface VMImageStatus {
  imagesPresent: boolean
  vmAvailable: boolean
  imageVersion: string | null
  imageDir: string
}

interface VMStatus {
  available: boolean
  enabled: boolean | 'auto'
  memoryMB: number
  cpus: number
}

interface VMDownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percent: number
  stage: string
}

interface VMDiagnostics {
  platform: string
  arch: string
  hypervisor: string
  hypervisorFound: boolean
  executionMode: string
  imageDir: string
  logFile: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

// =============================================================================
// Main Page
// =============================================================================

async function fetchDiagnostics(): Promise<VMDiagnostics | null> {
  try {
    const base = getApiBaseUrl()
    const res = await fetch(`${base}/api/vm/diagnostics`, { credentials: 'include' })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

export default function AdminVMPage() {
  const [imageStatus, setImageStatus] = useState<VMImageStatus | null>(null)
  const [vmStatus, setVMStatus] = useState<VMStatus | null>(null)
  const [diagnostics, setDiagnostics] = useState<VMDiagnostics | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const bridge = getDesktopBridge()

  const loadStatus = useCallback(async () => {
    const b = getDesktopBridge()
    if (!b) {
      setIsLoading(false)
      return
    }
    try {
      const [imgStatus, vmStat, diag] = await Promise.all([
        b.getVMImageStatus(),
        b.getVMStatus(),
        fetchDiagnostics(),
      ])
      setImageStatus(imgStatus)
      setVMStatus(vmStat)
      setDiagnostics(diag)
    } catch (err: any) {
      setError(err?.message || 'Failed to load VM status')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  if (!bridge) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
        <View className="max-w-2xl w-full mx-auto gap-6">
          <View>
            <Text className="text-2xl font-bold text-foreground">VM / Sandbox</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              VM isolation settings for sandboxed agent execution.
            </Text>
          </View>
          <View className="bg-card border border-border rounded-xl p-6 items-center gap-3">
            <Monitor size={32} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground text-center">
              VM settings are only available in the Shogo Desktop app.
            </Text>
          </View>
        </View>
      </ScrollView>
    )
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
      <View className="max-w-2xl w-full mx-auto gap-8">
        <View>
          <Text className="text-2xl font-bold text-foreground">VM / Sandbox</Text>
          <Text className="text-sm text-muted-foreground mt-1">
            VM isolation settings for sandboxed agent execution.
          </Text>
        </View>

        {error && (
          <View className="flex-row items-center gap-2 bg-destructive/10 px-4 py-3 rounded-xl">
            <AlertTriangle size={16} className="text-destructive" />
            <Text className="text-sm text-destructive flex-1">{error}</Text>
          </View>
        )}

        <StatusOverviewSection imageStatus={imageStatus} vmStatus={vmStatus} />
        <VMImagesSection imageStatus={imageStatus} onRefresh={loadStatus} />
        {vmStatus && <VMConfigSection vmStatus={vmStatus} onSaved={loadStatus} />}
        <DiagnosticsSection imageStatus={imageStatus} vmStatus={vmStatus} diagnostics={diagnostics} />
      </View>
    </ScrollView>
  )
}

// =============================================================================
// Section 1: Status Overview
// =============================================================================

function StatusOverviewSection({
  imageStatus,
  vmStatus,
}: {
  imageStatus: VMImageStatus | null
  vmStatus: VMStatus | null
}) {
  const vmAvailable = vmStatus?.available ?? false
  const imagesPresent = imageStatus?.imagesPresent ?? false
  const isolationEnabled = vmStatus?.enabled
  const isActive = vmAvailable && imagesPresent

  const modeLabel =
    isolationEnabled === true
      ? 'Enabled'
      : isolationEnabled === false
        ? 'Disabled'
        : 'Auto'

  return (
    <SectionCard
      icon={Monitor}
      title="Status Overview"
      description="Current VM isolation state"
    >
      <View className="gap-4">
        {/* Main status badge */}
        <View
          className={cn(
            'flex-row items-center gap-2.5 rounded-lg p-3',
            isActive ? 'bg-green-500/10' : 'bg-yellow-500/10',
          )}
        >
          {isActive ? (
            <CheckCircle size={18} className="text-green-500" />
          ) : (
            <AlertTriangle size={18} className="text-yellow-500" />
          )}
          <View className="flex-1">
            <Text
              className={cn(
                'text-sm font-semibold',
                isActive ? 'text-green-500' : 'text-yellow-500',
              )}
            >
              {isActive
                ? 'VM Isolation Active'
                : 'VM Isolation Unavailable — Using Host Execution'}
            </Text>
            {!isActive && (
              <Text className="text-xs text-muted-foreground mt-0.5">
                {!imagesPresent
                  ? 'VM images need to be downloaded'
                  : 'Hypervisor (QEMU / Virtualization.framework) not found'}
              </Text>
            )}
          </View>
        </View>

        {/* Status grid */}
        <View className="flex-row flex-wrap gap-3">
          <StatusBadge
            label="VM Images"
            ok={imagesPresent}
            detail={imagesPresent ? (imageStatus?.imageVersion ? `v${imageStatus.imageVersion}` : 'Present') : 'Missing'}
          />
          <StatusBadge
            label="Hypervisor"
            ok={vmAvailable}
            detail={vmAvailable ? 'Found' : 'Not found'}
          />
          <StatusBadge
            label="Isolation Mode"
            ok={isolationEnabled !== false}
            detail={modeLabel}
          />
        </View>
      </View>
    </SectionCard>
  )
}

function StatusBadge({
  label,
  ok,
  detail,
}: {
  label: string
  ok: boolean
  detail: string
}) {
  return (
    <View className="flex-1 min-w-[120px] bg-background border border-border rounded-lg p-3">
      <Text className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </Text>
      <View className="flex-row items-center gap-1.5">
        {ok ? (
          <CheckCircle size={12} className="text-green-500" />
        ) : (
          <XCircle size={12} className="text-destructive" />
        )}
        <Text className={cn('text-sm font-medium', ok ? 'text-foreground' : 'text-destructive')}>
          {detail}
        </Text>
      </View>
    </View>
  )
}

// =============================================================================
// Section 2: VM Images
// =============================================================================

type DownloadState = 'idle' | 'downloading' | 'extracting' | 'complete' | 'error'

function VMImagesSection({
  imageStatus,
  onRefresh,
}: {
  imageStatus: VMImageStatus | null
  onRefresh: () => void
}) {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle')
  const [progress, setProgress] = useState<VMDownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) return
    bridge.onVMImageDownloadProgress((p: VMDownloadProgress) => {
      setProgress(p)
      setDownloadState(p.stage === 'extracting' ? 'extracting' : 'downloading')
    })
  }, [])

  const startDownload = useCallback(async () => {
    const bridge = getDesktopBridge()
    if (!bridge) return
    setDownloadState('downloading')
    setDownloadError(null)
    try {
      const result = await bridge.downloadVMImages()
      if (result?.success) {
        setDownloadState('complete')
        onRefresh()
      } else {
        setDownloadError(result?.error || 'Download failed')
        setDownloadState('error')
      }
    } catch (err: any) {
      setDownloadError(err?.message || 'Download failed')
      setDownloadState('error')
    }
  }, [onRefresh])

  const imagesPresent = imageStatus?.imagesPresent ?? false

  return (
    <SectionCard
      icon={HardDrive}
      title="VM Images"
      description="Kernel and root filesystem for the sandbox VM"
    >
      {imagesPresent && downloadState !== 'downloading' && downloadState !== 'extracting' ? (
        <View className="gap-3">
          <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
            <CheckCircle size={16} className="text-green-500" />
            <View className="flex-1">
              <Text className="text-sm font-medium text-green-500">Images installed</Text>
              {imageStatus?.imageVersion && (
                <Text className="text-xs text-muted-foreground">
                  Version {imageStatus.imageVersion}
                </Text>
              )}
            </View>
          </View>
          <InfoRow label="Image Directory" value={imageStatus?.imageDir ?? '—'} mono />
        </View>
      ) : downloadState === 'complete' ? (
        <View className="flex-row items-center gap-2 bg-green-500/10 rounded-lg p-3">
          <CheckCircle size={16} className="text-green-500" />
          <Text className="text-sm font-medium text-green-500">
            VM images downloaded successfully
          </Text>
        </View>
      ) : downloadState === 'error' ? (
        <View className="gap-3">
          <View className="flex-row items-center gap-2 bg-destructive/10 rounded-lg p-3">
            <AlertTriangle size={16} className="text-destructive" />
            <Text className="text-sm text-destructive flex-1">
              {downloadError}
            </Text>
          </View>
          <Pressable
            onPress={startDownload}
            className="flex-row items-center gap-2 self-start bg-primary px-4 py-2 rounded-lg"
          >
            <RotateCcw size={14} className="text-primary-foreground" />
            <Text className="text-sm font-medium text-primary-foreground">Retry Download</Text>
          </Pressable>
        </View>
      ) : downloadState === 'downloading' || downloadState === 'extracting' ? (
        <View className="gap-3">
          <View className="flex-row items-center gap-2">
            <Download size={14} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground flex-1">
              {downloadState === 'extracting'
                ? 'Extracting files...'
                : progress?.totalBytes
                  ? `${formatBytes(progress.bytesDownloaded)} / ${formatBytes(progress.totalBytes)}`
                  : 'Starting download...'}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {downloadState === 'extracting' ? '100%' : `${progress?.percent ?? 0}%`}
            </Text>
          </View>
          <View className="h-2 bg-muted rounded-full overflow-hidden">
            <View
              className="h-full bg-primary rounded-full"
              style={{
                width: `${downloadState === 'extracting' ? 100 : (progress?.percent ?? 0)}%`,
              }}
            />
          </View>
        </View>
      ) : (
        <View className="gap-3">
          <View className="flex-row items-center gap-2 bg-yellow-500/10 rounded-lg p-3">
            <AlertTriangle size={16} className="text-yellow-500" />
            <View className="flex-1">
              <Text className="text-sm font-medium text-yellow-500">
                VM images not installed
              </Text>
              <Text className="text-xs text-muted-foreground mt-0.5">
                Download the sandbox environment (~1.4 GB) to enable VM isolation.
              </Text>
            </View>
          </View>
          {imageStatus?.imageDir && (
            <InfoRow label="Target Directory" value={imageStatus.imageDir} mono />
          )}
          <Pressable
            onPress={startDownload}
            className="flex-row items-center gap-2 self-start bg-primary px-4 py-2.5 rounded-lg"
          >
            <Download size={14} className="text-primary-foreground" />
            <Text className="text-sm font-medium text-primary-foreground">
              Download VM Images
            </Text>
          </Pressable>
        </View>
      )}
    </SectionCard>
  )
}

// =============================================================================
// Section 3: VM Configuration
// =============================================================================

function VMConfigSection({
  vmStatus,
  onSaved,
}: {
  vmStatus: VMStatus
  onSaved: () => void
}) {
  const [memoryMB, setMemoryMB] = useState(String(vmStatus.memoryMB))
  const [cpus, setCpus] = useState(String(vmStatus.cpus))
  const [enabled, setEnabled] = useState<boolean | 'auto'>(vmStatus.enabled)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setMemoryMB(String(vmStatus.memoryMB))
    setCpus(String(vmStatus.cpus))
    setEnabled(vmStatus.enabled)
  }, [vmStatus])

  const handleSave = async () => {
    const bridge = getDesktopBridge()
    if (!bridge) return
    setSaving(true)
    setMessage(null)
    try {
      await bridge.setVMConfig({
        enabled,
        memoryMB: parseInt(memoryMB, 10) || 1536,
        cpus: parseInt(cpus, 10) || 0,
      })
      setMessage({ type: 'ok', text: 'Settings saved — restart the app to apply changes' })
      onSaved()
    } catch (err: any) {
      setMessage({ type: 'error', text: err?.message || 'Failed to save' })
    } finally {
      setSaving(false)
    }
    setTimeout(() => setMessage(null), 6000)
  }

  const modeOptions: Array<{ value: boolean | 'auto'; label: string; desc: string }> = [
    { value: 'auto', label: 'Auto', desc: 'Enable if hypervisor and images are available' },
    { value: true, label: 'Enabled', desc: 'Always use VM isolation' },
    { value: false, label: 'Disabled', desc: 'Use host execution (no sandbox)' },
  ]

  return (
    <SectionCard
      icon={Settings}
      title="Configuration"
      description="VM isolation settings — changes require an app restart"
    >
      <View className="gap-4">
        {/* Isolation Mode */}
        <View className="gap-1.5">
          <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Isolation Mode
          </Text>
          <View className="flex-row flex-wrap gap-2">
            {modeOptions.map((opt) => (
              <Pressable
                key={String(opt.value)}
                onPress={() => setEnabled(opt.value)}
                className={cn(
                  'flex-1 min-w-[100px] border rounded-lg px-3 py-2.5',
                  enabled === opt.value
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-background',
                )}
              >
                <Text
                  className={cn(
                    'text-sm font-medium',
                    enabled === opt.value ? 'text-primary' : 'text-foreground',
                  )}
                >
                  {opt.label}
                </Text>
                <Text className="text-[10px] text-muted-foreground mt-0.5">{opt.desc}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Memory */}
        <View className="gap-1">
          <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Memory (MB)
          </Text>
          <TextInput
            value={memoryMB}
            onChangeText={setMemoryMB}
            keyboardType="numeric"
            className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background web:outline-none"
          />
          <Text className="text-[10px] text-muted-foreground">
            RAM allocated to each sandbox VM (default: 1536)
          </Text>
        </View>

        {/* CPUs */}
        <View className="gap-1">
          <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            CPUs
          </Text>
          <TextInput
            value={cpus}
            onChangeText={setCpus}
            keyboardType="numeric"
            className="border border-border rounded-lg px-3 py-2 text-sm text-foreground bg-background web:outline-none"
          />
          <Text className="text-[10px] text-muted-foreground">
            CPU cores per VM. 0 = auto (half of physical cores)
          </Text>
        </View>

        {/* Save */}
        <View className="flex-row items-center gap-3 mt-1">
          <Pressable
            onPress={handleSave}
            disabled={saving}
            className={cn(
              'flex-row items-center gap-1.5 px-4 py-2 rounded-lg',
              saving ? 'bg-muted' : 'bg-primary',
            )}
          >
            {saving ? (
              <ActivityIndicator size="small" />
            ) : (
              <Save size={13} className="text-primary-foreground" />
            )}
            <Text
              className={cn(
                'text-sm font-medium',
                saving ? 'text-muted-foreground' : 'text-primary-foreground',
              )}
            >
              Save
            </Text>
          </Pressable>
          {message && (
            <Text
              className={cn(
                'text-xs flex-1',
                message.type === 'ok' ? 'text-green-500' : 'text-destructive',
              )}
            >
              {message.text}
            </Text>
          )}
        </View>
      </View>
    </SectionCard>
  )
}

// =============================================================================
// Section 4: Diagnostics
// =============================================================================

function DiagnosticsSection({
  imageStatus,
  vmStatus,
  diagnostics,
}: {
  imageStatus: VMImageStatus | null
  vmStatus: VMStatus | null
  diagnostics: VMDiagnostics | null
}) {
  const platform = diagnostics?.platform ?? 'unknown'
  const isWindows = platform === 'win32'
  const isMac = platform === 'darwin'

  return (
    <SectionCard
      icon={Wrench}
      title="Diagnostics"
      description="System information and troubleshooting"
    >
      <View className="gap-3">
        <InfoRow label="Platform" value={platform} />
        <InfoRow label="Architecture" value={diagnostics?.arch ?? '—'} />
        <InfoRow
          label="Hypervisor"
          value={diagnostics?.hypervisor ?? 'Unknown'}
        />
        <InfoRow
          label="Hypervisor Status"
          value={diagnostics?.hypervisorFound ? 'Found' : 'Not found'}
        />
        <InfoRow
          label="Execution Mode"
          value={diagnostics?.executionMode ?? (vmStatus?.available ? 'VM Isolation' : 'Host Execution (fallback)')}
        />
        {(diagnostics?.imageDir || imageStatus?.imageDir) && (
          <InfoRow label="Image Directory" value={diagnostics?.imageDir ?? imageStatus?.imageDir ?? '—'} mono />
        )}
        {diagnostics?.logFile && (
          <InfoRow label="Log File" value={diagnostics.logFile} mono />
        )}

        {!vmStatus?.available && (
          <View className="flex-row items-start gap-2 bg-muted/50 rounded-lg p-3 mt-1">
            <Info size={14} className="text-muted-foreground mt-0.5" />
            <Text className="text-xs text-muted-foreground flex-1">
              {isWindows
                ? 'VM isolation requires QEMU installed (winget install qemu) and VM images downloaded. Ensure Windows Hypervisor Platform (WHPX) is enabled in Windows Features.'
                : isMac
                  ? 'VM isolation requires macOS 13+ with Apple Silicon or Intel with Hypervisor.framework entitlements.'
                  : 'VM isolation is not supported on this platform.'}
            </Text>
          </View>
        )}
      </View>
    </SectionCard>
  )
}

// =============================================================================
// Shared Components
// =============================================================================

function SectionCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: any
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <View className="bg-card border border-border rounded-xl overflow-hidden">
      <View className="px-5 py-4 border-b border-border">
        <View className="flex-row items-center gap-2.5 mb-1">
          <Icon size={16} className="text-foreground" />
          <Text className="text-base font-semibold text-foreground">{title}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <View className="px-5 py-4">{children}</View>
    </View>
  )
}

function InfoRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Text className="text-xs font-medium text-muted-foreground uppercase tracking-wider min-w-[100px]">
        {label}
      </Text>
      <Text
        className={cn(
          'text-sm text-foreground text-right flex-1',
          mono && 'font-mono text-xs',
        )}
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  )
}
