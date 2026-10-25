// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ProjectImportModal
 *
 * Drives a streaming project import. Import has no options step (SHO-211):
 * the moment a file is chosen the import starts, and when it finishes the
 * user lands on the imported project.
 *
 *   1. `progress` - live phase progress bar + non-fatal error list
 *   2. `done` / `fatal` - only when there is something to read: warnings that
 *      would otherwise be lost, or a failure with Retry
 *
 * Two ways in:
 *   - `ProjectSourceMenu` picks the archive itself and passes it as
 *     `initialFile`; this modal opens straight into `progress`.
 *   - Nothing picked yet (drag-and-drop on web, or a caller that just mounts
 *     the modal) - the dropzone is the first view.
 *
 * Password-protected (ZipCrypto) archives are the only thing that still stops
 * the flow: the password is required input, not an option, so an encrypted
 * archive shows one field and an Import button.
 *
 * Progress events come from `api.importProjectStream`, which reads Server-Sent
 * Events off the import endpoint. The bar weight assignments below are
 * deliberately coarse — the goal is a smoothly advancing bar, not precise ETA.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '../project/transfer-modal-parts'
import {
  Upload,
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
import {
  describeArchive,
  usePickShogoArchive,
  type PickedShogoArchive,
} from './usePickShogoArchive'

interface ProjectImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  /** Called as soon as the imported project exists and the user is sent to it. */
  onOpenProject: (project: { id: string; name: string }) => void
  /**
   * An archive the caller already picked (the source menu's file dialog).
   * The import starts on open — there is nothing to confirm.
   */
  initialFile?: PickedShogoArchive | null
}

type Step = 'pick' | 'password' | 'progress' | 'done' | 'fatal'

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

interface ImportedProject {
  id: string
  name: string
  description?: string | null
}

interface DoneState {
  project: ImportedProject
  stats: {
    filesWritten: number
    filesSkipped: number
    chatsImported: number
    chatsSkipped: number
  }
  requiredCredentials: RequiredCredential[]
  warnings: string[]
  secretsAutoFilled: boolean
}

export function ProjectImportModal({
  open,
  onOpenChange,
  workspaceId,
  onOpenProject,
  initialFile = null,
}: ProjectImportModalProps) {
  const [step, setStep] = useState<Step>('pick')
  const [file, setFile] = useState<PickedShogoArchive | null>(null)
  const [password, setPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [progress, setProgress] = useState<ProjectImportProgress | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [fatalMessage, setFatalMessage] = useState<string | null>(null)
  const [done, setDone] = useState<DoneState | null>(null)

  const { pickArchive } = usePickShogoArchive()

  // Non-fatal errors arrive before `done`, which carries its own warnings; both
  // have to survive until the summary is built.
  const errorsRef = useRef<string[]>([])

  // The SSE stream stays open *after* `done` so bootstrap progress can keep
  // streaming. Once `done` has arrived the import is complete, so a later
  // stream failure means "user already left mid-bootstrap" — not a failure.
  const doneReceivedRef = useRef(false)

  // Invalidates callbacks from a superseded run (a retry, or a reset after the
  // modal closed) so they can't write state into the next import.
  const runTokenRef = useRef(0)

  // Guards the "already handed this file to the import" effect: the same
  // archive object must not restart the import on every re-render.
  const handledFileRef = useRef<PickedShogoArchive | null>(null)

  const resetAll = useCallback(() => {
    runTokenRef.current++
    setStep('pick')
    setFile(null)
    setPassword('')
    setPasswordError(null)
    setProgress(null)
    setErrors([])
    errorsRef.current = []
    setFatalMessage(null)
    setDone(null)
    handledFileRef.current = null
  }, [])

  const close = useCallback(() => {
    if (step === 'progress') return // don't allow mid-import close
    onOpenChange(false)
    // Delay the reset so the user doesn't see a flash of the dropzone before
    // the animation finishes.
    setTimeout(resetAll, 300)
  }, [step, onOpenChange, resetAll])

  const finishImport = useCallback(
    (project: ImportedProject) => {
      onOpenProject({ id: project.id, name: project.name })
      onOpenChange(false)
      setTimeout(resetAll, 300)
    },
    [onOpenProject, onOpenChange, resetAll],
  )

  const runImport = useCallback(
    async (target: PickedShogoArchive, archivePassword: string) => {
      const token = ++runTokenRef.current
      const isCurrent = () => runTokenRef.current === token

      setStep('progress')
      setProgress(null)
      setErrors([])
      errorsRef.current = []
      setFatalMessage(null)
      setPasswordError(null)
      setDone(null)
      doneReceivedRef.current = false

      try {
        await api.importProjectStream(
          {
            file: target.blob,
            workspaceId,
            filename: target.name,
            // Chats always come along; the toggle is gone (SHO-211).
            includeChats: true,
            password: archivePassword.length > 0 ? archivePassword : undefined,
          },
          (ev) => {
            if (!isCurrent()) return
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
              const warnings = [...errorsRef.current, ...(ev.warnings || [])]
              const result: DoneState = {
                project: ev.project,
                stats: ev.stats,
                requiredCredentials: ev.requiredCredentials || [],
                warnings,
                secretsAutoFilled: !!ev.secretsAutoFilled,
              }
              setDone(result)
              setProgress(ev)
              // Nothing to read -> go straight to the project. Warnings keep
              // the summary up so they aren't lost.
              if (warnings.length === 0) finishImport(result.project)
              else setStep('done')
              return
            }
            setProgress(ev)
          },
        )
      } catch (err: any) {
        // Post-`done` stream failures are non-fatal (see doneReceivedRef).
        if (!isCurrent() || doneReceivedRef.current) return
        const message = err?.message || 'Import failed'
        // A wrong password is a correction, not a dead end: keep the field.
        if (target.encrypted && /password/i.test(message)) {
          setPasswordError(message)
          setStep('password')
          return
        }
        setFatalMessage(message)
        setStep('fatal')
      }
    },
    [workspaceId, finishImport],
  )

  /** A chosen archive starts importing unless it needs its password first. */
  const beginImport = useCallback(
    (next: PickedShogoArchive) => {
      setFile(next)
      setPassword('')
      setPasswordError(null)
      if (next.encrypted) {
        setStep('password')
        return
      }
      void runImport(next, '')
    },
    [runImport],
  )

  useEffect(() => {
    if (!open || !initialFile) return
    if (handledFileRef.current === initialFile) return
    handledFileRef.current = initialFile
    beginImport(initialFile)
  }, [open, initialFile, beginImport])

  const handlePickFromDropzone = useCallback(async () => {
    try {
      const picked = await pickArchive()
      if (!picked) return
      beginImport(picked)
    } catch (err: any) {
      setFatalMessage(err?.message || 'Failed to pick file')
      setStep('fatal')
    }
  }, [pickArchive, beginImport])

  const handleWebDrop = useCallback(
    (dropped: File) => {
      void (async () => {
        const described = await describeArchive(
          dropped,
          dropped.name,
          dropped.size,
        )
        beginImport(described)
      })()
    },
    [beginImport],
  )

  const percent = useMemo(() => computePercent(progress), [progress])
  const label = useMemo(() => phaseLabel(progress), [progress])

  // `initialFile` means the caller already picked: never flash the dropzone
  // while the open effect is still a render away.
  const view: Step =
    step === 'pick' && initialFile
      ? initialFile.encrypted
        ? 'password'
        : 'progress'
      : step

  const title =
    view === 'done'
      ? 'Import complete'
      : view === 'fatal'
        ? 'Import failed'
        : 'Import project'

  return (
    <Modal isOpen={open} onClose={close} size="md">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <TransferModalHeader
          icon={view === 'done' ? CheckCircle2 : Upload}
          title={title}
          showClose={view !== 'progress'}
        />

        <ModalBody className="px-6 py-5" contentContainerClassName="gap-4">
          {view === 'pick' && (
            <Dropzone
              onPick={() => void handlePickFromDropzone()}
              onWebDrop={handleWebDrop}
            />
          )}

          {view === 'password' && (
            <PasswordStep
              file={file ?? initialFile}
              password={password}
              setPassword={(value) => {
                setPassword(value)
                setPasswordError(null)
              }}
              error={passwordError}
            />
          )}

          {view === 'progress' && (
            <ProgressStep
              percent={percent}
              label={label}
              phase={progress?.phase ?? 'idle'}
              errors={errors}
            />
          )}

          {view === 'done' && done && (
            <DoneStep done={done} warnings={done.warnings} />
          )}

          {view === 'fatal' && <FatalStep message={fatalMessage || 'Import failed'} />}
        </ModalBody>

        <ModalFooter className="px-6 py-4 border-t border-outline-100 gap-2">
          {view === 'pick' && (
            <Button variant="outline" onPress={close}>
              <ButtonText>Cancel</ButtonText>
            </Button>
          )}

          {view === 'password' && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button
                onPress={() => {
                  const target = file ?? initialFile
                  if (target) void runImport(target, password.trim())
                }}
                disabled={password.trim().length === 0}
              >
                <ButtonIcon as={Upload} className="text-typography-0" />
                <ButtonText>Import</ButtonText>
              </Button>
            </>
          )}

          {view === 'progress' && (
            <Button variant="outline" disabled>
              <ButtonSpinner />
              <ButtonText>Importing...</ButtonText>
            </Button>
          )}

          {view === 'done' && done && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Close</ButtonText>
              </Button>
              <Button onPress={() => finishImport(done.project)}>
                <ButtonIcon as={ExternalLink} className="text-typography-0" />
                <ButtonText>Open project</ButtonText>
              </Button>
            </>
          )}

          {view === 'fatal' && (
            <>
              <Button variant="outline" onPress={close}>
                <ButtonText>Close</ButtonText>
              </Button>
              <Button
                onPress={() => {
                  const target = file ?? initialFile
                  if (target) void runImport(target, password.trim())
                }}
                disabled={!(file ?? initialFile)}
              >
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

function PasswordStep({
  file,
  password,
  setPassword,
  error,
}: {
  file: PickedShogoArchive | null
  password: string
  setPassword: (value: string) => void
  error: string | null
}) {
  return (
    <>
      <Text className="text-sm text-typography-600 leading-relaxed">
        This archive is password-protected. Enter its password to import it.
      </Text>

      {file && (
        <OptionGroup>
          <View className="flex-row items-center gap-3 px-4 py-3.5">
            <FileArchive size={20} className="text-typography-500" />
            <View className="flex-1">
              <Text
                className="text-sm font-medium text-typography-900"
                numberOfLines={1}
              >
                {file.name}
              </Text>
              <Text className="text-xs text-typography-500">
                {(file.size / (1024 * 1024)).toFixed(2)} MB · password-protected
              </Text>
            </View>
            <Lock size={14} className="text-typography-400" />
          </View>
        </OptionGroup>
      )}

      <Input isInvalid={!!error}>
        <InputField
          placeholder="Archive password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="off"
          autoCorrect={false}
        />
      </Input>

      {error && (
        <Text className="text-xs text-red-500 leading-relaxed">{error}</Text>
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
      const dropped = e.dataTransfer?.files?.[0]
      if (dropped) onWebDrop(dropped)
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
          {Platform.OS === 'web'
            ? 'It starts importing as soon as you pick it, or drag and drop it here'
            : 'tap to browse your files'}
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
  warnings,
}: {
  done: { project: ImportedProject }
  warnings: string[]
}) {
  return (
    <>
      <View className="items-center gap-3 py-2">
        <View className="h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle2 size={28} className="text-emerald-500" />
        </View>
        <View className="items-center gap-0.5">
          <Text
            className="text-base font-semibold text-typography-900 text-center"
            numberOfLines={2}
          >
            {done.project.name}
          </Text>
          <Text className="text-xs text-typography-500">
            Imported into this workspace.
          </Text>
        </View>
      </View>

      {/* The only reason this screen exists instead of navigating away. */}
      {warnings.length > 0 && <ErrorList errors={warnings} />}
    </>
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
