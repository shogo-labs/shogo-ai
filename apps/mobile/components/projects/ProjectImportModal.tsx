// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectImportModal
 *
 * Three-step modal driving a streaming project import:
 *   1. `options` - file picker + `Include chat history` toggle + Start
 *   2. `progress` - live phase progress bar + non-fatal error list
 *   3. `done` / `fatal-error` - summary / retry
 *
 * Progress events come from `api.importProjectStream`, which reads Server-Sent
 * Events off the import endpoint. The bar weight assignments below are
 * deliberately coarse — the goal is a smoothly advancing bar, not precise ETA.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { View, Platform, ScrollView } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import {
  Button,
  ButtonText,
  ButtonSpinner,
  ButtonIcon,
} from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Progress, ProgressFilledTrack } from '@/components/ui/progress'
import {
  Upload,
  X,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  FileArchive,
  RefreshCw,
  ExternalLink,
} from 'lucide-react-native'
import { api, type ProjectImportProgress } from '../../lib/api'

interface ProjectImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** Called once the imported project exists in the DB and the user clicks "Open project". */
  onOpenProject: (project: { id: string; name: string }) => void
}

type Step = 'options' | 'progress' | 'done' | 'fatal'

interface PendingFile {
  blob: Blob
  name: string
  size: number
}

// Phase -> [startPercent, endPercent, label]. writeFiles and importChats use
// their `done/total` to interpolate inside their band.
const PHASE_BANDS: Record<
  ProjectImportProgress['phase'] | 'idle',
  [number, number, string]
> = {
  idle: [0, 0, 'Ready'],
  upload: [0, 30, 'Uploading'],
  parse: [30, 40, 'Parsing archive'],
  createProject: [40, 50, 'Creating project'],
  writeFiles: [50, 85, 'Writing files'],
  importChats: [85, 100, 'Importing chats'],
  done: [100, 100, 'Done'],
  error: [0, 0, 'Error'],
}

function computePercent(ev: ProjectImportProgress | null): number {
  if (!ev) return 0
  const [start, end] = PHASE_BANDS[ev.phase]
  if (ev.phase === 'writeFiles' || ev.phase === 'importChats') {
    const frac = ev.total > 0 ? ev.done / ev.total : 0
    return Math.round(start + (end - start) * frac)
  }
  if (ev.phase === 'upload') {
    const frac = ev.total > 0 ? ev.loaded / ev.total : 0
    return Math.round(start + (end - start) * frac)
  }
  return end
}

function phaseLabel(ev: ProjectImportProgress | null): string {
  if (!ev) return ''
  const [, , label] = PHASE_BANDS[ev.phase]
  if (ev.phase === 'writeFiles') return `${label} (${ev.done} / ${ev.total})`
  if (ev.phase === 'importChats') return `${label} (${ev.done} / ${ev.total})`
  if (ev.phase === 'upload') {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
    return `${label} (${mb(ev.loaded)} / ${mb(ev.total)} MB)`
  }
  return label
}

export function ProjectImportModal({
  open,
  onOpenChange,
  workspaceId,
  onOpenProject,
}: ProjectImportModalProps) {
  const [step, setStep] = useState<Step>('options')
  const [pendingFile, setPendingFile] = useState<PendingFile | null>(null)
  const [includeChats, setIncludeChats] = useState(true)
  const [progress, setProgress] = useState<ProjectImportProgress | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [fatalMessage, setFatalMessage] = useState<string | null>(null)
  const [done, setDone] = useState<{
    project: { id: string; name: string; description?: string | null }
    stats: {
      filesWritten: number
      filesSkipped: number
      chatsImported: number
      chatsSkipped: number
    }
  } | null>(null)

  // Keep the most recent `errors` value visible during auto-re-renders in the
  // done state. `useRef` avoids stale closure over the callback passed to the
  // streaming API.
  const errorsRef = useRef<string[]>([])

  const resetAll = useCallback(() => {
    setStep('options')
    setPendingFile(null)
    setIncludeChats(true)
    setProgress(null)
    setErrors([])
    errorsRef.current = []
    setFatalMessage(null)
    setDone(null)
  }, [])

  const close = useCallback(() => {
    if (step === 'progress') return // don't allow mid-import close
    onOpenChange(false)
    // Delay the reset so the user doesn't see a flash of "options" before
    // the animation finishes.
    setTimeout(resetAll, 300)
  }, [step, onOpenChange, resetAll])

  const pickFile = useCallback(async () => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      await new Promise<void>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.shogo-project,.zip'
        input.style.cssText =
          'position:fixed;left:-9999px;opacity:0;width:1px;height:1px;pointer-events:none'
        document.body.appendChild(input)
        const cleanup = () => {
          if (input.parentNode) input.parentNode.removeChild(input)
          resolve()
        }
        const timer = setTimeout(cleanup, 120_000)
        input.onchange = (e: any) => {
          clearTimeout(timer)
          const file = e.target?.files?.[0] as File | undefined
          if (file) {
            setPendingFile({ blob: file, name: file.name, size: file.size })
          }
          cleanup()
        }
        input.click()
      })
      return
    }

    try {
      const { getDocumentAsync } = await import('expo-document-picker')
      const result = await getDocumentAsync({
        type: ['application/zip', 'application/octet-stream'],
        copyToCacheDirectory: true,
        multiple: false,
      })
      if (result.canceled || !result.assets?.[0]) return
      const asset = result.assets[0]
      const { readAsStringAsync, EncodingType } = await import(
        'expo-file-system/legacy'
      )
      const base64 = await readAsStringAsync(asset.uri, {
        encoding: EncodingType.Base64,
      })
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'application/zip' })
      setPendingFile({
        blob,
        name: asset.name || 'project.shogo-project',
        size: asset.size || bytes.byteLength,
      })
    } catch (err: any) {
      if (err?.code !== 'ERR_CANCELED') {
        setFatalMessage(err?.message || 'Failed to pick file')
        setStep('fatal')
      }
    }
  }, [])

  const startImport = useCallback(async () => {
    if (!pendingFile) return
    setStep('progress')
    setProgress(null)
    setErrors([])
    errorsRef.current = []
    setFatalMessage(null)
    setDone(null)

    try {
      await api.importProjectStream(
        {
          file: pendingFile.blob,
          workspaceId,
          filename: pendingFile.name,
          includeChats,
        },
        (ev) => {
          if (ev.phase === 'error') {
            if (ev.fatal) {
              setFatalMessage(ev.message)
            } else {
              errorsRef.current = [...errorsRef.current, ev.message]
              setErrors(errorsRef.current)
            }
            return
          }
          if (ev.phase === 'done') {
            setDone({ project: ev.project, stats: ev.stats })
            setProgress(ev)
            return
          }
          setProgress(ev)
        },
      )
      setStep('done')
    } catch (err: any) {
      setFatalMessage(err?.message || 'Import failed')
      setStep('fatal')
    }
  }, [pendingFile, workspaceId, includeChats])

  const percent = useMemo(() => computePercent(progress), [progress])
  const label = useMemo(() => phaseLabel(progress), [progress])

  return (
    <Modal isOpen={open} onClose={close} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <ModalHeader className="px-6 pt-6 pb-4 border-b border-outline-100">
          <Heading size="lg" className="text-typography-900">
            {step === 'done'
              ? 'Import complete'
              : step === 'fatal'
                ? 'Import failed'
                : 'Import project'}
          </Heading>
          {step !== 'progress' && (
            <ModalCloseButton>
              <X size={20} className="text-typography-500" />
            </ModalCloseButton>
          )}
        </ModalHeader>

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          {step === 'options' && (
            <OptionsStep
              pendingFile={pendingFile}
              onPick={pickFile}
              onClear={() => setPendingFile(null)}
              includeChats={includeChats}
              setIncludeChats={setIncludeChats}
            />
          )}

          {step === 'progress' && (
            <ProgressStep
              percent={percent}
              label={label}
              errors={errors}
            />
          )}

          {step === 'done' && done && (
            <DoneStep done={done} errors={errors} />
          )}

          {step === 'fatal' && (
            <FatalStep message={fatalMessage || 'Import failed'} />
          )}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          {step === 'options' && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button onPress={startImport} disabled={!pendingFile}>
                <ButtonIcon as={Upload} className="text-typography-0" />
                <ButtonText>Start import</ButtonText>
              </Button>
            </>
          )}

          {step === 'progress' && (
            <Button variant="outline" disabled>
              <ButtonSpinner />
              <ButtonText>Importing...</ButtonText>
            </Button>
          )}

          {step === 'done' && done && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Close</ButtonText>
              </Button>
              <Button
                onPress={() => {
                  onOpenProject({
                    id: done.project.id,
                    name: done.project.name,
                  })
                  onOpenChange(false)
                  setTimeout(resetAll, 300)
                }}
              >
                <ButtonIcon as={ExternalLink} className="text-typography-0" />
                <ButtonText>Open project</ButtonText>
              </Button>
            </>
          )}

          {step === 'fatal' && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Close</ButtonText>
              </Button>
              <Button onPress={startImport} disabled={!pendingFile}>
                <ButtonIcon as={RefreshCw} className="text-typography-0" />
                <ButtonText>Retry</ButtonText>
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
}

// ─── Steps ────────────────────────────────────────────────────

function OptionsStep({
  pendingFile,
  onPick,
  onClear,
  includeChats,
  setIncludeChats,
}: {
  pendingFile: PendingFile | null
  onPick: () => void
  onClear: () => void
  includeChats: boolean
  setIncludeChats: (v: boolean) => void
}) {
  return (
    <>
      <Text className="text-sm text-typography-600 leading-relaxed">
        Choose a <Text className="font-mono text-xs">.shogo-project</Text> archive to import into this workspace.
      </Text>

      {pendingFile ? (
        <View className="flex-row items-center gap-3 rounded-lg border border-outline-100 bg-background-50 px-4 py-3">
          <FileArchive size={20} className="text-typography-500" />
          <View className="flex-1">
            <Text
              className="text-sm font-medium text-typography-900"
              numberOfLines={1}
            >
              {pendingFile.name}
            </Text>
            <Text className="text-xs text-typography-500">
              {(pendingFile.size / (1024 * 1024)).toFixed(2)} MB
            </Text>
          </View>
          <Button size="xs" variant="outline" onPress={onClear}>
            <ButtonText>Change</ButtonText>
          </Button>
        </View>
      ) : (
        <Button variant="outline" onPress={onPick}>
          <ButtonIcon as={Upload} />
          <ButtonText>Choose file...</ButtonText>
        </Button>
      )}

      <View className="flex-row items-start gap-3 rounded-lg border border-outline-100 bg-background-50 px-4 py-3">
        <View className="mt-0.5">
          <MessageSquare size={18} className="text-typography-500" />
        </View>
        <View className="flex-1">
          <Text className="text-sm font-medium text-typography-900">
            Include chat history
          </Text>
          <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
            If the archive contains conversations, import them alongside the project files.
          </Text>
        </View>
        <Switch value={includeChats} onValueChange={setIncludeChats} />
      </View>
    </>
  )
}

function ProgressStep({
  percent,
  label,
  errors,
}: {
  percent: number
  label: string
  errors: string[]
}) {
  return (
    <>
      <View className="gap-2">
        <View className="flex-row justify-between items-baseline">
          <Text className="text-sm font-medium text-typography-900">
            {label}
          </Text>
          <Text className="text-xs text-typography-500 font-mono">
            {percent}%
          </Text>
        </View>
        <Progress value={percent}>
          <ProgressFilledTrack />
        </Progress>
      </View>

      <Text className="text-xs text-typography-500 leading-relaxed">
        This can take a minute for large projects with a prebuilt app. Please don't close this window.
      </Text>

      {errors.length > 0 && <ErrorList errors={errors} />}
    </>
  )
}

function DoneStep({
  done,
  errors,
}: {
  done: {
    project: { id: string; name: string; description?: string | null }
    stats: {
      filesWritten: number
      filesSkipped: number
      chatsImported: number
      chatsSkipped: number
    }
  }
  errors: string[]
}) {
  return (
    <>
      <View className="flex-row items-center gap-3">
        <CheckCircle2 size={22} className="text-emerald-500" />
        <View className="flex-1">
          <Text
            className="text-base font-semibold text-typography-900"
            numberOfLines={1}
          >
            {done.project.name}
          </Text>
          <Text className="text-xs text-typography-500">
            Imported into this workspace.
          </Text>
        </View>
      </View>

      <View className="rounded-lg border border-outline-100 bg-background-50 p-4 gap-1">
        <Text className="text-xs text-typography-500">
          <Text className="font-medium text-typography-900">
            {done.stats.filesWritten}
          </Text>{' '}
          file{done.stats.filesWritten === 1 ? '' : 's'} written
          {done.stats.filesSkipped > 0 ? `, ${done.stats.filesSkipped} skipped` : ''}
        </Text>
        <Text className="text-xs text-typography-500">
          <Text className="font-medium text-typography-900">
            {done.stats.chatsImported}
          </Text>{' '}
          chat session{done.stats.chatsImported === 1 ? '' : 's'} imported
          {done.stats.chatsSkipped > 0 ? `, ${done.stats.chatsSkipped} skipped` : ''}
        </Text>
      </View>

      {errors.length > 0 && <ErrorList errors={errors} />}
    </>
  )
}

function FatalStep({ message }: { message: string }) {
  return (
    <View className="flex-row items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
      <AlertTriangle size={20} className="text-red-500 mt-0.5" />
      <View className="flex-1">
        <Text className="text-sm font-semibold text-red-500">
          Import could not complete
        </Text>
        <Text className="text-xs text-typography-600 mt-1 leading-relaxed">
          {message}
        </Text>
      </View>
    </View>
  )
}

function ErrorList({ errors }: { errors: string[] }) {
  const [expanded, setExpanded] = useState(false)
  const preview = expanded ? errors : errors.slice(0, 3)
  return (
    <View className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 gap-2">
      <View className="flex-row items-center gap-2">
        <AlertTriangle size={14} className="text-amber-500" />
        <Text className="text-xs font-semibold text-amber-600">
          {errors.length} warning{errors.length === 1 ? '' : 's'}
        </Text>
      </View>
      <ScrollView className="max-h-32">
        <View className="gap-1">
          {preview.map((msg, i) => (
            <Text
              key={i}
              className="text-[11px] text-typography-600 font-mono"
            >
              {msg}
            </Text>
          ))}
        </View>
      </ScrollView>
      {errors.length > 3 && (
        <Button
          size="xs"
          variant="link"
          onPress={() => setExpanded((v) => !v)}
        >
          <ButtonText>
            {expanded
              ? 'Show less'
              : `Show ${errors.length - 3} more`}
          </ButtonText>
        </Button>
      )}
    </View>
  )
}
