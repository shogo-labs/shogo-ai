// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectImportModal
 *
 * Multi-step modal driving a streaming project import:
 *   1. `options` - file picker (drag & drop on web) + chat toggle + optional
 *      archive password
 *   2. `progress` - live phase progress bar + non-fatal error list
 *   3. `done` / `fatal` - summary / retry
 *
 * Progress events come from `api.importProjectStream`, which reads Server-Sent
 * Events off the import endpoint. The bar weight assignments below are
 * deliberately coarse — the goal is a smoothly advancing bar, not precise ETA.
 *
 * Password-protected (ZipCrypto) archives are detected from the file header so
 * the password field is required only when it actually applies; the server
 * enforces this regardless.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { View, Platform, ScrollView, Pressable } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal'
import { Text } from '@/components/ui/text'
import {
  Button,
  ButtonText,
  ButtonSpinner,
  ButtonIcon,
} from '@/components/ui/button'
import { Input, InputField } from '@/components/ui/input'
import { Progress, ProgressFilledTrack } from '@/components/ui/progress'
import {
  TransferModalHeader,
  OptionGroup,
  ToggleRow,
  Disclosure,
} from '../project/transfer-modal-parts'
import {
  Upload,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  FileArchive,
  RefreshCw,
  ExternalLink,
  Lock,
} from 'lucide-react-native'
import { api, type ProjectImportProgress, type RequiredCredential } from '../../lib/api'

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
  /** True when the archive is ZipCrypto-encrypted (password required). */
  encrypted: boolean
}

/**
 * Detects ZipCrypto encryption from the first local file header's general
 * purpose bit flag (bit 0). Mirrors the server-side check.
 */
function isEncryptedHeader(head: Uint8Array): boolean {
  if (head.length < 8) return false
  const isLocalHeader =
    head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  if (!isLocalHeader) return false
  const flag = head[6] | (head[7] << 8)
  return (flag & 0x0001) === 1
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
  if (!ev) return 'Starting…'
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
  const [password, setPassword] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
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
  // *after* `done` so bootstrap progress can keep streaming, which means:
  //   - We flip to the `done` step on the event itself, not on stream close.
  //   - If the await throws AFTER `done`, we treat it as non-fatal and stay
  //     in the done state instead of flashing back to the failure screen.
  const doneReceivedRef = useRef(false)

  const resetAll = useCallback(() => {
    setStep('options')
    setPendingFile(null)
    setIncludeChats(true)
    setPassword('')
    setPasswordOpen(false)
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

  // Centralised file acceptance: detect encryption, store, and reveal the
  // password field when the archive needs one. `headBytes` lets native callers
  // pass the already-read header (RN Blobs don't reliably support `.slice`).
  const acceptFile = useCallback(
    async (blob: Blob, name: string, size: number, headBytes?: Uint8Array) => {
      let encrypted = false
      try {
        const head =
          headBytes ?? new Uint8Array(await blob.slice(0, 8).arrayBuffer())
        encrypted = isEncryptedHeader(head)
      } catch {
        encrypted = false
      }
      setPendingFile({ blob, name, size, encrypted })
      if (encrypted) setPasswordOpen(true)
    },
    [],
  )

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
          if (file) void acceptFile(file, file.name, file.size)
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
      await acceptFile(
        blob,
        asset.name || 'project.shogo',
        asset.size || bytes.byteLength,
        bytes.slice(0, 8),
      )
    } catch (err: any) {
      if (err?.code !== 'ERR_CANCELED') {
        setFatalMessage(err?.message || 'Failed to pick file')
        setStep('fatal')
      }
    }
  }, [acceptFile])

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
          password: password.length > 0 ? password : undefined,
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
      // Stream ended. Belt-and-braces in case `done` never arrived.
      if (!doneReceivedRef.current) setStep('done')
    } catch (err: any) {
      // Surface as fatal only if we never saw `done`. Post-`done` stream
      // failures usually mean "user navigated away mid-bootstrap".
      if (doneReceivedRef.current) return
      setFatalMessage(err?.message || 'Import failed')
      setStep('fatal')
    }
  }, [pendingFile, workspaceId, includeChats, password])

  const percent = useMemo(() => computePercent(progress), [progress])
  const label = useMemo(() => phaseLabel(progress), [progress])

  const needsPassword = !!pendingFile?.encrypted
  const canStart =
    !!pendingFile && (!needsPassword || password.trim().length > 0)

  const title =
    step === 'done'
      ? 'Import complete'
      : step === 'fatal'
        ? 'Import failed'
        : 'Import project'

  return (
    <Modal isOpen={open} onClose={close} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <TransferModalHeader
          icon={step === 'done' ? CheckCircle2 : Upload}
          title={title}
          showClose={step !== 'progress'}
        />

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          {step === 'options' && (
            <OptionsStep
              pendingFile={pendingFile}
              onPick={pickFile}
              onWebDrop={(file) => void acceptFile(file, file.name, file.size)}
              onClear={() => {
                setPendingFile(null)
                setPassword('')
                setPasswordOpen(false)
              }}
              includeChats={includeChats}
              setIncludeChats={setIncludeChats}
              password={password}
              setPassword={setPassword}
              passwordOpen={passwordOpen}
              setPasswordOpen={setPasswordOpen}
            />
          )}

          {step === 'progress' && (
            <ProgressStep
              percent={percent}
              label={label}
              phase={progress?.phase ?? 'idle'}
              errors={errors}
            />
          )}

          {step === 'done' && done && <DoneStep done={done} />}

          {step === 'fatal' && <FatalStep message={fatalMessage || 'Import failed'} />}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          {step === 'options' && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button onPress={startImport} disabled={!canStart}>
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
                  onOpenProject({ id: done.project.id, name: done.project.name })
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
              <Button onPress={startImport} disabled={!canStart}>
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
  onWebDrop,
  onClear,
  includeChats,
  setIncludeChats,
  password,
  setPassword,
  passwordOpen,
  setPasswordOpen,
}: {
  pendingFile: PendingFile | null
  onPick: () => void
  onWebDrop: (file: File) => void
  onClear: () => void
  includeChats: boolean
  setIncludeChats: (v: boolean) => void
  password: string
  setPassword: (v: string) => void
  passwordOpen: boolean
  setPasswordOpen: (v: boolean) => void
}) {
  const needsPassword = !!pendingFile?.encrypted
  return (
    <>
      <Text className="text-sm text-typography-600 leading-relaxed">
        Choose a <Text className="font-mono text-xs">.shogo</Text> archive to import into this workspace.
      </Text>

      {pendingFile ? (
        <OptionGroup>
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <FileArchive size={20} className="text-typography-500" />
            <View className="flex-1">
              <Text className="text-sm font-medium text-typography-900" numberOfLines={1}>
                {pendingFile.name}
              </Text>
              <Text className="text-xs text-typography-500">
                {(pendingFile.size / (1024 * 1024)).toFixed(2)} MB
                {pendingFile.encrypted ? ' · password-protected' : ''}
              </Text>
            </View>
            <Button size="xs" variant="outline" onPress={onClear}>
              <ButtonText>Change</ButtonText>
            </Button>
          </View>
        </OptionGroup>
      ) : (
        <Dropzone onPick={onPick} onWebDrop={onWebDrop} />
      )}

      {/* Import options are gated on a picked file — showing them up front is
          noise the user can't act on yet. */}
      {pendingFile && (
        <>
          <OptionGroup>
            <ToggleRow
              icon={MessageSquare}
              title="Include chat history"
              description="If the archive contains conversations, import them alongside the files."
              value={includeChats}
              onValueChange={setIncludeChats}
            />
          </OptionGroup>

          <Disclosure
            icon={Lock}
            title={needsPassword ? 'Archive password' : 'Password-protected?'}
            subtitle={
              needsPassword
                ? 'This archive is encrypted — enter its password to import.'
                : 'Enter the password if this archive was protected.'
            }
            open={passwordOpen || needsPassword}
            onToggle={() => setPasswordOpen(!passwordOpen)}
            disabled={needsPassword}
          >
            <Input>
              <InputField
                placeholder={needsPassword ? 'Password' : 'Leave empty if not protected'}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="off"
                autoCorrect={false}
              />
            </Input>
          </Disclosure>
        </>
      )}
    </>
  )
}

function Dropzone({
  onPick,
  onWebDrop,
}: {
  onPick: () => void
  onWebDrop: (file: File) => void
}) {
  const dropRef = useRef<any>(null)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    if (Platform.OS !== 'web') return
    const el = dropRef.current as HTMLElement | null
    if (!el) return
    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
      setDragActive(true)
    }
    const onDragLeave = () => setDragActive(false)
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) onWebDrop(file)
    }
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
    }
  }, [onWebDrop])

  return (
    <Pressable ref={dropRef} onPress={onPick}>
      <View
        className={
          dragActive
            ? 'items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary-400 bg-primary-50 px-6 py-8'
            : 'items-center justify-center gap-2 rounded-xl border-2 border-dashed border-outline-200 bg-background-50 px-6 py-8'
        }
      >
        <View className="h-11 w-11 items-center justify-center rounded-full bg-background-100">
          <Upload size={20} className="text-typography-600" />
        </View>
        <Text className="text-sm font-medium text-typography-900">
          Choose a <Text className="font-mono text-xs">.shogo</Text> file
        </Text>
        <Text className="text-xs text-typography-500">
          {Platform.OS === 'web' ? 'or drag and drop it here' : 'tap to browse your files'}
        </Text>
      </View>
    </Pressable>
  )
}

const PROGRESS_PHASES: { key: ProjectImportProgress['phase']; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'parse', label: 'Parse' },
  { key: 'createProject', label: 'Create' },
  { key: 'writeFiles', label: 'Files' },
  { key: 'importChats', label: 'Chats' },
]

function ProgressStep({
  percent,
  label,
  phase,
  errors,
}: {
  percent: number
  label: string
  phase: ProjectImportProgress['phase'] | 'idle'
  errors: string[]
}) {
  return (
    <>
      <View className="items-center gap-1 pt-1">
        <Text className="text-3xl font-semibold text-typography-900 font-mono">
          {percent}%
        </Text>
        <Text className="text-sm font-medium text-typography-600">{label}</Text>
      </View>

      <Progress value={percent} className="h-2">
        <ProgressFilledTrack />
      </Progress>

      {/* Compact phase stepper */}
      <View className="flex-row justify-between px-1">
        {PROGRESS_PHASES.map((p) => {
          const [start] = PHASE_BANDS[p.key]
          const reached = percent >= start
          const active = phase === p.key
          return (
            <View key={p.key} className="items-center gap-1">
              <View
                className={
                  active
                    ? 'h-2 w-2 rounded-full bg-primary-500'
                    : reached
                      ? 'h-2 w-2 rounded-full bg-primary-400'
                      : 'h-2 w-2 rounded-full bg-background-200'
                }
              />
              <Text
                className={
                  active
                    ? 'text-[10px] font-medium text-typography-700'
                    : 'text-[10px] text-typography-400'
                }
              >
                {p.label}
              </Text>
            </View>
          )
        })}
      </View>

      <Text className="text-xs text-typography-500 leading-relaxed text-center">
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
  // Intentionally minimal — see SHOG-592. The project is openable the moment we
  // hit this view; failures belong in the fatal step, not under a green check.
  return (
    <View className="items-center gap-3 py-2">
      <View className="h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
        <CheckCircle2 size={28} className="text-emerald-500" />
      </View>
      <View className="items-center gap-0.5">
        <Text className="text-base font-semibold text-typography-900 text-center" numberOfLines={2}>
          {done.project.name}
        </Text>
        <Text className="text-xs text-typography-500">Imported into this workspace.</Text>
      </View>
    </View>
  )
}

function FatalStep({ message }: { message: string }) {
  return (
    <View className="items-center gap-3 py-2">
      <View className="h-14 w-14 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle size={26} className="text-red-500" />
      </View>
      <View className="items-center gap-1 px-2">
        <Text className="text-sm font-semibold text-typography-900 text-center">
          Import could not complete
        </Text>
        <Text className="text-xs text-typography-600 leading-relaxed text-center">
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
    <View className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 gap-2">
      <View className="flex-row items-center gap-2">
        <AlertTriangle size={14} className="text-amber-500" />
        <Text className="text-xs font-semibold text-amber-600">
          {errors.length} warning{errors.length === 1 ? '' : 's'}
        </Text>
      </View>
      <ScrollView className="max-h-32">
        <View className="gap-1">
          {preview.map((msg, i) => (
            <Text key={i} className="text-[11px] text-typography-600 font-mono">
              {msg}
            </Text>
          ))}
        </View>
      </ScrollView>
      {errors.length > 3 && (
        <Button size="xs" variant="link" onPress={() => setExpanded((v) => !v)}>
          <ButtonText>
            {expanded ? 'Show less' : `Show ${errors.length - 3} more`}
          </ButtonText>
        </Button>
      )}
    </View>
  )
}
