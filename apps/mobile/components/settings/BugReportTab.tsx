// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, TextInput, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native'
import { Download, CheckCircle, AlertCircle, Paperclip, X } from 'lucide-react-native'
import {
  Card,
  CardContent,
  Button,
  Checkbox,
  cn,
} from '@shogo/shared-ui/primitives'

interface SystemInfo {
  appVersion: string
  electronVersion: string
  platform: string
  arch: string
  osVersion: string
  totalMemoryMB: number
  freeMemoryMB: number
  cpuModel: string
  cpuCores: number
  deviceName: string
}

interface AttachedFile {
  name: string
  size: number
  type: string
  dataUrl: string
}

function getShogoDesktop() {
  if (typeof window !== 'undefined' && (window as any).shogoDesktop) {
    return (window as any).shogoDesktop
  }
  return null
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function BugReportTab() {
  const [description, setDescription] = useState('')
  const [includeLogs, setIncludeLogs] = useState(true)
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])

  const [maxLogLines, setMaxLogLines] = useState(500)
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [isExporting, setIsExporting] = useState(false)
  const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const desktop = getShogoDesktop()

  useEffect(() => {
    if (!desktop) return
    desktop.getBugReportConfig().then((cfg: any) => {
      if (cfg?.maxLogLines) setMaxLogLines(cfg.maxLogLines)
    })
    desktop.getSystemInfo().then(setSystemInfo)
  }, [])

  // Set up hidden file input for web/desktop
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'image/*,video/*,.png,.jpg,.jpeg,.gif,.mp4,.webm,.mov'
    input.style.display = 'none'
    input.addEventListener('change', () => {
      const files = input.files
      if (!files) return
      Array.from(files).forEach((file) => {
        if (file.size > 25 * 1024 * 1024) {
          setResult({ type: 'error', message: `File "${file.name}" exceeds 25MB limit` })
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments((prev) => [
            ...prev,
            { name: file.name, size: file.size, type: file.type, dataUrl: reader.result as string },
          ])
        }
        reader.readAsDataURL(file)
      })
      input.value = ''
    })
    document.body.appendChild(input)
    fileInputRef.current = input
    return () => { document.body.removeChild(input) }
  }, [])

  const handleAttach = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleExport = useCallback(async () => {
    if (!desktop) return
    setIsExporting(true)
    setResult(null)
    try {
      // Convert attachments to base64 strings for the main process
      const attachmentData = attachments.map((a) => ({
        name: a.name,
        dataUrl: a.dataUrl,
      }))
      const res = await desktop.exportBugReport({ description, attachments: attachmentData })
      if (res.ok) {
        setResult({ type: 'success', message: `Bug report saved to: ${res.path}` })
        setDescription('')
        setAttachments([])
      } else if (res.error !== 'Cancelled') {
        setResult({ type: 'error', message: res.error || 'Export failed' })
      }
    } catch (err: any) {
      setResult({ type: 'error', message: err?.message || 'Export failed' })
    } finally {
      setIsExporting(false)
    }
  }, [desktop, description, attachments])

  if (!desktop) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Text className="text-muted-foreground text-center">
          Bug reporting is only available in the desktop app.
        </Text>
      </View>
    )
  }

  const isDisabled = !description.trim() || isExporting

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 24, gap: 20 }}>
      <View className="gap-1">
        <Text className="text-xl font-semibold text-foreground">Report a Bug</Text>
        <Text className="text-sm text-muted-foreground">
          Describe the issue and export a .zip with logs and system info to share with the team.
        </Text>
      </View>

      {/* Description */}
      <Card>
        <CardContent className="p-4 gap-3">
          <Text className="text-sm font-medium text-foreground">Description</Text>
          <TextInput
            className="min-h-[120px] rounded-md border border-input bg-background p-3 text-sm text-foreground"
            placeholder="What happened? What did you expect to happen?&#10;&#10;Steps to reproduce:&#10;1. &#10;2. &#10;3. "
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
            placeholderTextColor="#9ca3af"
          />
        </CardContent>
      </Card>

      {/* Options */}
      <Card>
        <CardContent className="p-4 gap-4">
          <Text className="text-sm font-medium text-foreground">Include in report</Text>
          <Checkbox
            checked={includeLogs}
            onCheckedChange={setIncludeLogs}
            label={`Application logs (last ${maxLogLines} lines)`}
          />
          <Checkbox
            checked={includeSystemInfo}
            onCheckedChange={setIncludeSystemInfo}
            label="System information (OS, memory, CPU)"
          />
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card>
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-medium text-foreground">Attachments</Text>
            <Pressable
              onPress={handleAttach}
              className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-md border border-input"
            >
              <Paperclip size={14} color="#6b7280" />
              <Text className="text-xs text-muted-foreground">Add screenshots or videos</Text>
            </Pressable>
          </View>
          {attachments.length === 0 && (
            <Text className="text-xs text-muted-foreground">
              No files attached. Add screenshots or screen recordings to help illustrate the issue.
            </Text>
          )}
          {attachments.length > 0 && (
            <View className="gap-2">
              {attachments.map((file, index) => (
                <View key={`${file.name}-${index}`} className="flex-row items-center gap-2 rounded-md bg-muted px-3 py-2">
                  <Text className="text-xs text-foreground flex-1" numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </Text>
                  <Pressable onPress={() => removeAttachment(index)} className="p-1">
                    <X size={12} color="#6b7280" />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </CardContent>
      </Card>

      {/* System info preview */}
      {includeSystemInfo && systemInfo && (
        <Card>
          <CardContent className="p-4 gap-2">
            <Text className="text-sm font-medium text-foreground">System Info Preview</Text>
            <View className="rounded-md bg-muted p-3 gap-1">
              <Text className="text-xs text-muted-foreground font-mono">
                App: Shogo v{systemInfo.appVersion} (Electron {systemInfo.electronVersion})
              </Text>
              <Text className="text-xs text-muted-foreground font-mono">
                OS: {systemInfo.platform} {systemInfo.osVersion} ({systemInfo.arch})
              </Text>
              <Text className="text-xs text-muted-foreground font-mono">
                Memory: {systemInfo.freeMemoryMB}MB free / {systemInfo.totalMemoryMB}MB total
              </Text>
              <Text className="text-xs text-muted-foreground font-mono">
                CPU: {systemInfo.cpuModel} ({systemInfo.cpuCores} cores)
              </Text>
              <Text className="text-xs text-muted-foreground font-mono">
                Device: {systemInfo.deviceName}
              </Text>
            </View>
          </CardContent>
        </Card>
      )}

      {/* Result message */}
      {result && (
        <View className={cn(
          'w-full rounded-lg border p-4 flex-row items-start gap-3',
          result.type === 'success' ? 'bg-background border-border' : 'border-destructive bg-destructive/10'
        )}>
          {result.type === 'success' ? (
            <CheckCircle size={16} color="#22c55e" style={{ marginTop: 2 }} />
          ) : (
            <AlertCircle size={16} color="#ef4444" style={{ marginTop: 2 }} />
          )}
          <View className="flex-1 gap-0.5">
            <Text className="font-medium text-foreground">
              {result.type === 'success' ? 'Done' : 'Error'}
            </Text>
            <Text className="text-sm text-muted-foreground">{result.message}</Text>
          </View>
        </View>
      )}

      {/* Export action */}
      <Button
        variant="outline"
        className="flex-row items-center justify-center gap-2"
        onPress={handleExport}
        disabled={isDisabled}
      >
        {isExporting ? (
          <ActivityIndicator size="small" />
        ) : (
          <Download size={16} color="#6b7280" />
        )}
        <Text className={cn('text-sm font-medium', isDisabled ? 'text-muted-foreground' : 'text-foreground')}>
          Export as .zip
        </Text>
      </Button>

      <Text className="text-xs text-muted-foreground text-center">
        Share the exported .zip file with the team via GitHub Issues, Discord, or email.
      </Text>
    </ScrollView>
  )
}
