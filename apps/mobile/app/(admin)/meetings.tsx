// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Admin Meetings Settings - Recording behavior, auto-detection, transcription + diarization config.
 * Only shown in local mode.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
} from 'react-native'
import {
  Radio,
  Languages,
  Check,
  CheckCircle,
  AlertTriangle,
  Download,
  Users,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { createHttpClient } from '../../lib/api'

interface MeetingConfig {
  autoDetect: boolean
  autoRecord: boolean
  autoRecordConfirmCount: number
  gracePeriodSeconds: number
  autoStopSeconds: number
  whisperModel: string
  useCloudTranscription: boolean
  diarizationEnabled: boolean
}

interface TranscriptionStatus {
  localAvailable: boolean
  cloudAvailable: boolean
  binaryInstalled: boolean
  installedModels: string[]
  diarizationAvailable: boolean
}

const WHISPER_MODELS = [
  { value: 'tiny.en', label: 'Tiny (English)', desc: '~39 MB, fastest' },
  { value: 'base.en', label: 'Base (English)', desc: '~75 MB, recommended' },
  { value: 'small.en', label: 'Small (English)', desc: '~244 MB, better accuracy' },
  { value: 'tiny', label: 'Tiny (Multilingual)', desc: '~39 MB' },
  { value: 'base', label: 'Base (Multilingual)', desc: '~75 MB' },
  { value: 'small', label: 'Small (Multilingual)', desc: '~244 MB' },
]

export default function AdminMeetingsPage() {
  const [config, setConfig] = useState<MeetingConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [transcriptionStatus, setTranscriptionStatus] = useState<TranscriptionStatus | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const http = useMemo(() => createHttpClient(), [])

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await http.get<TranscriptionStatus>('/api/local/meetings/transcription-status')
      setTranscriptionStatus(data)
    } catch {}
  }, [http])

  useEffect(() => {
    Promise.all([
      http.get<MeetingConfig>('/api/local/meetings/config').then((r) => r.data),
      http.get<TranscriptionStatus>('/api/local/meetings/transcription-status')
        .then((r) => r.data)
        .catch(() => null),
    ]).then(([cfg, status]) => {
      setConfig(cfg)
      if (status) setTranscriptionStatus(status)
      setLoading(false)
    }).catch(() => {
      setLoading(false)
    })
  }, [http])

  const installSherpa = useCallback(async () => {
    setInstalling(true)
    setInstallError(null)
    try {
      const res = await http.request<{ ok?: boolean; error?: string; steps?: string[] }>(
        '/api/local/meetings/install-sherpa',
        { method: 'POST', body: { model: config?.whisperModel || 'base.en' } },
      )
      if (res.data.error) {
        setInstallError(res.data.error)
      }
      await fetchStatus()
    } catch (err: any) {
      setInstallError(err?.message || 'Install failed')
    }
    setInstalling(false)
  }, [http, fetchStatus, config?.whisperModel])

  const updateConfig = useCallback(async (patch: Partial<MeetingConfig>) => {
    if (!config) return
    const updated = { ...config, ...patch }
    setConfig(updated)
    setSaving(true)
    try {
      await http.request('/api/local/meetings/config', { method: 'PUT', body: patch })
    } catch {}
    setSaving(false)
  }, [http, config])

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (!config) {
    return (
      <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
        <View className="max-w-2xl w-full mx-auto gap-4">
          <Text className="text-2xl font-bold text-foreground">Meetings</Text>
          <View className="bg-amber-500/10 rounded-lg p-4 flex-row items-center gap-3">
            <AlertTriangle size={18} className="text-amber-500" />
            <Text className="text-sm text-foreground flex-1">
              Failed to load meeting configuration.
            </Text>
          </View>
        </View>
      </ScrollView>
    )
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-6 pb-20">
      <View className="max-w-2xl w-full mx-auto gap-8">
        {/* Header */}
        <View className="flex-row items-center gap-3">
          <View className="flex-1">
            <Text className="text-2xl font-bold text-foreground">Meetings</Text>
            <Text className="text-sm text-muted-foreground mt-1">
              Configure meeting recording, transcription, and speaker diarization.
            </Text>
          </View>
          {saving && (
            <View className="flex-row items-center gap-1.5">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-muted-foreground">Saving...</Text>
            </View>
          )}
        </View>

        {/* Status */}
        {transcriptionStatus && (
          <View className="gap-3">
            <View className="flex-row gap-3 flex-wrap">
              <View className={cn(
                'flex-1 flex-row items-center gap-2 rounded-lg p-3 min-w-[140px]',
                transcriptionStatus.localAvailable ? 'bg-green-500/10' : 'bg-amber-500/10'
              )}>
                {transcriptionStatus.localAvailable ? (
                  <CheckCircle size={14} className="text-green-500" />
                ) : (
                  <AlertTriangle size={14} className="text-amber-500" />
                )}
                <Text className="text-xs text-foreground flex-1">
                  {transcriptionStatus.localAvailable
                    ? 'Transcription ready'
                    : transcriptionStatus.binaryInstalled
                      ? 'Binary installed, no model'
                      : 'sherpa-onnx not installed'}
                </Text>
              </View>
              <View className={cn(
                'flex-1 flex-row items-center gap-2 rounded-lg p-3 min-w-[140px]',
                transcriptionStatus.diarizationAvailable ? 'bg-green-500/10' : 'bg-muted'
              )}>
                {transcriptionStatus.diarizationAvailable ? (
                  <CheckCircle size={14} className="text-green-500" />
                ) : (
                  <View className="h-2 w-2 rounded-full bg-muted-foreground" />
                )}
                <Text className="text-xs text-foreground">
                  {transcriptionStatus.diarizationAvailable
                    ? 'Speaker diarization ready'
                    : 'Diarization not installed'}
                </Text>
              </View>
              <View className={cn(
                'flex-1 flex-row items-center gap-2 rounded-lg p-3 min-w-[140px]',
                transcriptionStatus.cloudAvailable ? 'bg-green-500/10' : 'bg-muted'
              )}>
                {transcriptionStatus.cloudAvailable ? (
                  <CheckCircle size={14} className="text-green-500" />
                ) : (
                  <View className="h-2 w-2 rounded-full bg-muted-foreground" />
                )}
                <Text className="text-xs text-foreground">
                  {transcriptionStatus.cloudAvailable
                    ? 'Cloud fallback ready'
                    : 'No cloud API key'}
                </Text>
              </View>
            </View>

            {(!transcriptionStatus.binaryInstalled || !transcriptionStatus.localAvailable || !transcriptionStatus.diarizationAvailable) && (
              <Pressable
                onPress={installSherpa}
                disabled={installing}
                className={cn(
                  'flex-row items-center justify-center gap-2 rounded-lg px-4 py-2.5',
                  installing ? 'bg-primary/50' : 'bg-primary'
                )}
              >
                {installing ? (
                  <>
                    <ActivityIndicator size="small" color="white" />
                    <Text className="text-sm font-medium text-primary-foreground">
                      Installing sherpa-onnx...
                    </Text>
                  </>
                ) : (
                  <>
                    <Download size={14} color="white" />
                    <Text className="text-sm font-medium text-primary-foreground">
                      Install sherpa-onnx + models (~160 MB)
                    </Text>
                  </>
                )}
              </Pressable>
            )}

            {installError && (
              <View className="bg-destructive/10 rounded-lg p-3 flex-row items-center gap-2">
                <AlertTriangle size={14} className="text-destructive" />
                <Text className="text-xs text-destructive flex-1">{installError}</Text>
              </View>
            )}
          </View>
        )}

        {/* Recording */}
        <SectionCard
          icon={Radio}
          title="Recording"
          description="Control how meeting recording starts and stops"
        >
          <View className="gap-5">
            <ToggleRow
              label="Auto-detect meetings"
              description="Monitor activity to detect when you join a meeting"
              value={config.autoDetect}
              onToggle={(v) => updateConfig({ autoDetect: v })}
            />

            <View className="border-t border-border" />

            <ToggleRow
              label="Auto-record"
              description="Start recording automatically when a meeting is detected (no confirmation prompt)"
              value={config.autoRecord}
              onToggle={(v) => updateConfig({ autoRecord: v })}
              disabled={!config.autoDetect}
            />

          </View>
        </SectionCard>

        {/* Transcription */}
        <SectionCard
          icon={Languages}
          title="Transcription"
          description="Choose how audio is transcribed to text"
        >
          <View className="gap-5">
            <View className="gap-1.5">
              <Text className="text-sm font-medium text-foreground">Whisper model</Text>
              <Text className="text-xs text-muted-foreground">
                Larger models are more accurate but slower. Select a model, then install sherpa-onnx above to download everything.
              </Text>
              <View className="gap-1.5 mt-1.5">
                {WHISPER_MODELS.map((model) => {
                  const isSelected = config.whisperModel === model.value
                  const isInstalled = transcriptionStatus?.installedModels?.includes(model.value)
                  return (
                    <Pressable
                      key={model.value}
                      onPress={() => updateConfig({ whisperModel: model.value })}
                      className={cn(
                        'flex-row items-center px-4 py-3 rounded-lg border',
                        isSelected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-background'
                      )}
                    >
                      <View className="flex-1">
                        <View className="flex-row items-center gap-2">
                          <Text className={cn(
                            'text-sm',
                            isSelected ? 'text-primary font-medium' : 'text-foreground'
                          )}>
                            {model.label}
                          </Text>
                          {isInstalled && (
                            <View className="bg-green-500/10 rounded px-1.5 py-0.5">
                              <Text className="text-[10px] text-green-600 font-medium">installed</Text>
                            </View>
                          )}
                        </View>
                        <Text className="text-xs text-muted-foreground">{model.desc}</Text>
                      </View>
                      {isSelected && <Check size={16} className="text-primary" />}
                    </Pressable>
                  )
                })}
              </View>
            </View>

            <View className="border-t border-border" />

            <ToggleRow
              label="Cloud transcription fallback"
              description="Use OpenAI Whisper API if local transcription fails (requires API key)"
              value={config.useCloudTranscription}
              onToggle={(v) => updateConfig({ useCloudTranscription: v })}
            />
          </View>
        </SectionCard>

        {/* Diarization */}
        <SectionCard
          icon={Users}
          title="Speaker Diarization"
          description="Identify who is speaking in the meeting"
        >
          <View className="gap-5">
            <ToggleRow
              label="Enable speaker diarization"
              description="Identify and label different speakers in the transcript. Uses Pyannote segmentation + NeMo embedding models."
              value={config.diarizationEnabled}
              onToggle={(v) => updateConfig({ diarizationEnabled: v })}
            />

            {config.diarizationEnabled && transcriptionStatus && !transcriptionStatus.diarizationAvailable && (
              <View className="bg-amber-500/10 rounded-lg p-3 flex-row items-center gap-2">
                <AlertTriangle size={14} className="text-amber-500" />
                <Text className="text-xs text-foreground flex-1">
                  Diarization models not installed. Click "Install sherpa-onnx" above to download all required models.
                </Text>
              </View>
            )}

            {config.diarizationEnabled && transcriptionStatus?.diarizationAvailable && (
              <View className="bg-green-500/10 rounded-lg p-3">
                <Text className="text-xs text-foreground">
                  Speakers will be identified after each meeting recording. Diarization runs in parallel with transcription for minimal additional processing time.
                </Text>
              </View>
            )}
          </View>
        </SectionCard>
      </View>
    </ScrollView>
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

function ToggleRow({
  label,
  description,
  value,
  onToggle,
  disabled = false,
}: {
  label: string
  description: string
  value: boolean
  onToggle: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Pressable
      onPress={() => !disabled && onToggle(!value)}
      className={cn('flex-row items-center gap-3', disabled && 'opacity-50')}
      disabled={disabled}
    >
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{description}</Text>
      </View>
      <View className={cn(
        'h-6 w-10 rounded-full justify-center px-0.5',
        value ? 'bg-primary' : 'bg-muted'
      )}>
        <View className={cn(
          'h-5 w-5 rounded-full bg-white shadow-sm',
          value ? 'self-end' : 'self-start'
        )} />
      </View>
    </Pressable>
  )
}
