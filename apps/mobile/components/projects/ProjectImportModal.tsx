// SPDX-License-Identifier: MIT
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
import { Input, InputField } from '@/components/ui/input'
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
  Lock,
} from 'lucide-react-native'
import {
  api,
  type ProjectImportProgress,
  type RequiredCredential,
} from '../../lib/api'

// Friendly grouping for credential checklist items by source channel.
const CHANNEL_LABELS: Record<string, { label: string; hint?: string }> = {
  telegram: { label: 'Telegram', hint: 'Bot token & chat ID' },
  discord: { label: 'Discord', hint: 'Bot token / webhook URL' },
  slack: { label: 'Slack', hint: 'Bot token & signing secret' },
  whatsapp: { label: 'WhatsApp', hint: 'Cloud API token' },
  email: { label: 'Email', hint: 'SMTP credentials' },
  webhook: { label: 'Webhook', hint: 'Endpoint secret' },
  openai: { label: 'OpenAI', hint: 'API key' },
  anthropic: { label: 'Anthropic', hint: 'API key' },
  github: { label: 'GitHub', hint: 'Personal access token' },
}

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
// their `done/total` to interpolate inside their band; the rest snap to
// `end` on entry.
const PHASE_BANDS: Record<
  ProjectImportProgress['phase'] | 'idle',
  [number, number, string]
> = {
  idle: [0, 0, 'Ready'],
  upload: [0, 25, 'Uploading'],
  parse: [25, 35, 'Parsing archive'],
  createProject: [35, 45, 'Creating project'],
  writeFiles: [45, 80, 'Writing files'],
  importChats: [80, 95, 'Importing chats'],
  syncToS3: [95, 99, 'Syncing workspace'],
  done: [100, 100, 'Done'],
  error: [0, 0, 'Error'],
}

function phaseBand(phase: ProjectImportProgress['phase']): [number, number, string] {
  return PHASE_BANDS[phase] ?? [0, 0, 'Working']
}

function computePercent(ev: ProjectImportProgress | null): number {
  if (!ev) return 0
  const [start, end] = phaseBand(ev.phase)
  if (ev.phase === 'writeFiles' || ev.phase === 'importChats') {
    const frac = ev.total > 0 ? ev.done / ev.total : 0
    return Math.round(start + (end - start) * frac)
  }
  if (ev.phase === 'upload') {
    const frac = ev.total > 0 ? ev.loaded / ev.total : 0
    return Math.round(start + (end - start) * frac)
  }
  if (ev.phase === 'syncToS3') {
    return ev.status === 'ok' || ev.status === 'skipped' ? end : start
  }
  return end
}

function phaseLabel(ev: ProjectImportProgress | null): string {
  if (!ev) return ''
  const [, , label] = phaseBand(ev.phase)
  if (ev.phase === 'writeFiles') return `${label} (${ev.done} / ${ev.total})`
  if (ev.phase === 'importChats') return `${label} (${ev.done} / ${ev.total})`
  if (ev.phase === 'upload') {
    const mb = (n: number) => (n / (1024 * 1024)).toFixed(1)
    return `${label} (${mb(ev.loaded)} / ${mb(ev.total)} MB)`
  }
  if (ev.phase === 'syncToS3') {
    if (ev.status === 'ok') return 'Workspace synced'
    if (ev.status === 'skipped') return 'Workspace sync skipped'
    if (ev.status === 'failed') return 'Workspace sync failed'
    return label
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
  const [passphrase, setPassphrase] = useState('')
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
    requiredCredentials: RequiredCredential[]
    warnings: string[]
    secretsAutoFilled: boolean
  } | null>(null)

  // Keep the most recent `errors` value visible during auto-re-renders in the
  // done state. `useRef` avoids stale closure over the callback passed to the
  // streaming API.
  const errorsRef = useRef<string[]>([])

  // Tracks whether `done` has been received. The SSE stream stays open
  // *after* `done` so bootstrap progress (install → generate → …) can keep
  // streaming, which means:
  //   - We flip to the `done` step on the event itself, not on stream close
  //     (so "Open project" enables immediately while bootstrap continues).
  //   - If the await throws AFTER `done` (e.g. user closed the modal mid-
  //     bootstrap and the EventSource was torn down), we treat it as a
  //     non-fatal "bootstrap interrupted" and stay in the done state instead
  //     of flashing the user back to the failure screen.
  const doneReceivedRef = useRef(false)

  const resetAll = useCallback(() => {
    setStep('options')
    setPendingFile(null)
    setIncludeChats(true)
    setPassphrase('')
    setProgress(null)
    setErrors([])
    errorsRef.current = []
    setFatalMessage(null)
    setDone(null)
    doneReceivedRef.current = false
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
        input.accept = '.shogo,.shogo-project,.zip'
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
        name: asset.name || 'project.shogo',
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
    doneReceivedRef.current = false

    try {
      await api.importProjectStream(
        {
          file: pendingFile.blob,
          workspaceId,
          filename: pendingFile.name,
          includeChats,
          passphrase: passphrase.length > 0 ? passphrase : undefined,
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
            doneReceivedRef.current = true
            setDone({
              project: ev.project,
              stats: ev.stats,
              requiredCredentials: ev.requiredCredentials || [],
              warnings: ev.warnings || [],
              secretsAutoFilled: !!ev.secretsAutoFilled,
            })
            setProgress(ev)
            setStep('done')
            return
          }
          setProgress(ev)
        },
      )
      // Stream ended. Belt-and-braces in case `done` never arrived (the
      // helper would also throw in that case, but defend anyway).
      if (!doneReceivedRef.current) setStep('done')
    } catch (err: any) {
      // Surface as fatal only if we never saw `done`. Post-`done` stream
      // failures usually mean "user navigated away mid-bootstrap" and
      // shouldn't reverse a successful import in the UI.
      if (doneReceivedRef.current) return
      setFatalMessage(err?.message || 'Import failed')
      setStep('fatal')
    }
  }, [pendingFile, workspaceId, includeChats, passphrase])

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
              passphrase={passphrase}
              setPassphrase={setPassphrase}
            />
          )}

          {step === 'progress' && (
            <ProgressStep percent={percent} label={label} errors={errors} />
          )}

          {step === 'done' && done && <DoneStep done={done} />}

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
  passphrase,
  setPassphrase,
}: {
  pendingFile: PendingFile | null
  onPick: () => void
  onClear: () => void
  includeChats: boolean
  setIncludeChats: (v: boolean) => void
  passphrase: string
  setPassphrase: (v: string) => void
}) {
  return (
    <>
      <Text className="text-sm text-typography-600 leading-relaxed">
        Choose a <Text className="font-mono text-xs">.shogo</Text> archive to import into this workspace.
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

      {/* Import options are gated on a picked file. Showing them up front
          is noise: the user can't act on them yet, the toggles are pre-set
          to sensible defaults, and the passphrase field is irrelevant
          until we know what's in the archive. */}
      {pendingFile && (
        <>
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

          {/* Optional passphrase: when the bundle ships an encryptedSecrets
              blob, this lets us auto-fill credentials. We don't know
              whether the bundle is encrypted until parse-time, so the
              field is always available once a file is picked; leaving it
              blank simply skips the auto-fill. */}
          <View className="rounded-lg border border-outline-100 bg-background-50 px-4 py-3 gap-2">
            <View className="flex-row items-start gap-3">
              <View className="mt-0.5">
                <Lock size={18} className="text-typography-500" />
              </View>
              <View className="flex-1">
                <Text className="text-sm font-medium text-typography-900">
                  Passphrase (optional)
                </Text>
                <Text className="text-xs text-typography-500 mt-0.5 leading-relaxed">
                  If the bundle was exported with encrypted credentials, enter the same passphrase here to auto-fill bot tokens, API keys, and <Text className="font-mono text-xs">.env</Text> secrets.
                </Text>
              </View>
            </View>
            <Input>
              <InputField
                placeholder="Leave empty if not encrypted"
                value={passphrase}
                onChangeText={setPassphrase}
                secureTextEntry
                autoComplete="off"
                autoCorrect={false}
              />
            </Input>
          </View>
        </>
      )}
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
}: {
  done: {
    project: { id: string; name: string; description?: string | null }
  }
}) {
  // Intentionally minimal — see SHOG-592. The previous layout surfaced a
  // four-row bootstrap checklist, an import-stats card, bundle warnings,
  // and a per-file error list. All of that turned out to be noise: the
  // project is openable the moment we hit this view, the checklist could
  // never honestly reflect work happening inside the agent pod, and the
  // bundle-warning row was almost always a stale 401 from the pod-auth
  // bug. Stripping the body to just the "Imported" headline + footer
  // buttons (rendered by the parent) keeps the modal honest. Failures
  // belong in their own fatal step, not under a green check.
  return (
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
