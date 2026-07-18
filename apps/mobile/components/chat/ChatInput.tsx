// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ChatInput Component (React Native)
 * Migrated from apps/web/src/components/app/chat/ChatInput.tsx
 *
 * Lovable.dev-style chat input with:
 * - Rounded container with subtle border
 * - Clean TextInput with "Ask Shogo..." placeholder
 * - Bottom toolbar with action buttons
 * - Agent mode selector via popover dropdown
 *
 * Supports image attachments via file picker, drag-and-drop, and paste (web).
 * Native: Expo ImagePicker + DocumentPicker (AttachSourceSheet + native-attachment-picker).
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  TextInput,
  Pressable,
  Image,
  ScrollView,
  Platform,
} from "react-native"
import { cn } from "@shogo/shared-ui/primitives"
import {
  Popover,
  PopoverBackdrop,
  PopoverContent,
} from "@/components/ui/popover"
import { usePlatformConfig } from "../../lib/platform-config"
import { AttachSourceSheet } from "./AttachSourceSheet"
import { ContextTracker } from "./ContextTracker"
import { resolveShortName, resolveTier } from "../../lib/visible-models"
import { ModelPickerMenu } from "./ModelPickerMenu"
import {
  ArrowUp,
  Plus,
  Square,
  X,
  Zap,
  Lock,
  File,
  FileText,
  FolderGit2,
  Image as ImageIcon,
  ChevronDown,
  ChevronUp,
  Trash2,
  Pencil,
  SendHorizontal,
  Bot,
  ClipboardList,
  MessageCircleQuestion,
  Check,
  Mic,
  Sparkles,
  Languages,
  Play,
} from "lucide-react-native"
import { useVoiceInput } from "./useVoiceInput"
import { VoiceWaveform } from "./VoiceWaveform"
import {
  analyzeContent,
  kindLabel,
  LONG_PASTE_MIN_CHARS,
  MAX_PASTED_TEXTS,
  buildPastedAttachments,
  type PastedTextEntry,
} from "./long-text-utils"
import { resolveChatInputTextChange, type ChatInputTextChange } from "./chat-input-text-change"
import { FileViewerModal } from "./FileViewerModal"
import { VideoPreviewModal } from "./VideoPreviewModal"
import { PastedTextChip } from "./PastedTextChip"
import { useChatBridgeOptional } from "../voice-mode/ChatBridgeContext"
import { AskUserQuestionWidget } from "./turns/AskUserQuestionWidget"
import type { ToolCallData } from "./tools/types"
import { AgentClient } from "@shogo-ai/sdk/agent"
import { agentFetch } from "../../lib/agent-fetch"
import { useChatContextSafe } from "./ChatContext"
import type { IdeContextState, IdeFileResult } from "./ideBridge"

export const DEFAULT_MODEL_PRO = "claude-sonnet-4-6"
export const DEFAULT_MODEL_FREE = "claude-haiku-4-5-20251001"

import { EnvironmentPicker } from "./EnvironmentPicker"

export type InteractionMode = "agent" | "plan" | "ask"

export interface InteractionModeConfig {
  id: InteractionMode
  label: string
  description: string
  Icon: React.ElementType
}

export const INTERACTION_MODES: InteractionModeConfig[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Full autonomous mode — reads, writes, executes",
    Icon: Bot,
  },
  {
    id: "plan",
    label: "Plan",
    description: "Research and create a plan before making changes",
    Icon: ClipboardList,
  },
  {
    id: "ask",
    label: "Ask",
    description: "Just answer questions, no tools or changes",
    Icon: MessageCircleQuestion,
  },
]

const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_FILES = 10
const INTERACTION_MODE_ORDER: InteractionMode[] = ["agent", "plan", "ask"]

/**
 * Show a native browser tooltip on hover (web only). Wraps children in a
 * `display: contents` div with the `title` attribute so layout is unaffected
 * and the trigger's own ref (e.g. for popover positioning) isn't disturbed.
 * On native this is a transparent passthrough — the icon click opens the
 * popover menu which already shows the full label.
 */
function WebTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  if (Platform.OS !== "web") return <>{children}</>
  return React.createElement(
    "div",
    { title: label, style: { display: "contents" } },
    children,
  )
}

const MIN_INPUT_HEIGHT = 60
const MAX_INPUT_HEIGHT = 200

interface AttachedFile {
  id: string
  dataUrl: string
  name: string
  type: string
  size: number
}

export interface FileAttachment {
  dataUrl: string
  name: string
  type: string
}

/**
 * A structured "@" reference attached to a chat message. Files point at a
 * path inside the current project's agent workspace (resolved to real
 * contents by the runtime); projects tag a sibling project by id — the API
 * durably attaches it to this chat's project so the merged-root runtime
 * mounts it and the agent can read its files. The `workspace` variant is
 * retained for back-compat but the menu no longer offers it.
 */
export type ChatReference =
  | { type: "file"; path: string; name: string; label?: string }
  | { type: "folder"; path: string; name: string; label?: string }
  | { type: "project"; id: string; name: string; label?: string }
  | { type: "workspace"; id: string; name: string; slug: string; summary?: string; label?: string }

/** Lightweight sibling-project shape the composer needs for the "@" menu. */
export interface ProjectMentionOption {
  id: string
  name: string
}

/** One selectable row in the "@" menu (files first, then projects). */
type MentionItem =
  | { kind: "file"; path: string; name: string }
  | { kind: "folder"; path: string; name: string }
  | { kind: "project"; id: string; name: string }

const MAX_MENTION_FILE_RESULTS = 8
const MAX_IDE_MENTION_FILE_RESULTS = 80
const MAX_MENTION_PROJECT_RESULTS = 8

function referenceKey(ref: ChatReference): string {
  if (ref.type === "file") return `file:${ref.path}`
  if (ref.type === "folder") return `folder:${ref.path}`
  if (ref.type === "project") return `project:${ref.id}`
  return `workspace:${ref.id}`
}

/**
 * Whitespace-free "@token" body for a project mention. Projects have no slug
 * and their names can contain spaces, which the inline-token model can't
 * represent, so we slugify the name (the structured reference still carries the
 * real id + name). Collisions are cosmetic — resolution keys off the id.
 */
function slugifyMention(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "project"
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] || path
}

/**
 * True when `label` (an "@token") occurs in `text` at a mention boundary —
 * start-of-string or right after whitespace, mirroring `detectMentionToken`.
 * Used to prune references whose inline text the user edited/deleted and to
 * decide what the inline-highlight overlay should pill.
 */
function labelPresent(text: string, label: string): boolean {
  if (!label) return false
  let from = 0
  for (;;) {
    const idx = text.indexOf(label, from)
    if (idx === -1) return false
    if (idx === 0 || /\s/.test(text[idx - 1])) return true
    from = idx + 1
  }
}

/** A run of composer text: either plain or a tagged "@mention". */
type MentionSegment = { text: string; mention: boolean }

/**
 * Split `text` into plain / mention runs by matching known reference `labels`
 * at mention boundaries (longest-first so `@foo.tsx` wins over `@foo`). Backs
 * the transparent overlay that draws an inline pill behind each "@mention"
 * while the real (crisp) text stays in the TextInput on top.
 */
function buildMentionSegments(text: string, labels: string[]): MentionSegment[] {
  const unique = Array.from(new Set(labels.filter(Boolean))).sort((a, b) => b.length - a.length)
  if (unique.length === 0) return [{ text, mention: false }]
  const segments: MentionSegment[] = []
  let i = 0
  let plainStart = 0
  while (i < text.length) {
    let matched: string | null = null
    if (i === 0 || /\s/.test(text[i - 1])) {
      for (const lab of unique) {
        if (text.startsWith(lab, i)) {
          matched = lab
          break
        }
      }
    }
    if (matched) {
      if (plainStart < i) segments.push({ text: text.slice(plainStart, i), mention: false })
      segments.push({ text: matched, mention: true })
      i += matched.length
      plainStart = i
    } else {
      i++
    }
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), mention: false })
  return segments
}

/**
 * Find the active "@" mention token in `text` ending at `caret`. Matches a
 * leading "@" preceded by start-of-string or whitespace with no whitespace
 * (or further "@") between it and the caret — e.g. typing `look at @comp`.
 * Returns the token's start index (the "@") and the query after it.
 */
function detectMentionToken(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  const upToCaret = text.slice(0, safeCaret)
  const match = /(^|\s)@([^\s@]*)$/.exec(upToCaret)
  if (!match) return null
  const query = match[2]
  return { start: safeCaret - query.length - 1, query }
}

export type RestoreDraftRequest = {
  nonce: number
  content: string
  files?: FileAttachment[]
}

function estimateDataUrlSize(dataUrl: string): number {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() || "" : dataUrl
  return Math.max(0, Math.floor((base64.length * 3) / 4))
}

interface SkillOption {
  name: string
  description: string
}

const SKILLS: SkillOption[] = []

export type QueuedMessage = {
  id: string
  content: string
  files?: FileAttachment[]
  selectedModel?: string
}

export interface ChatInputProps {
  onSubmit: (
    content: string,
    files?: FileAttachment[],
    modelId?: string,
    references?: ChatReference[]
  ) => void
  disabled?: boolean
  placeholder?: string
  isStreaming?: boolean
  onStop?: () => void
  selectedModel?: string
  onModelChange?: (modelId: string) => void
  isPro?: boolean
  onUpgradeClick?: () => void
  /**
   * Pending ask_user tool call to render as an interactive question widget
   * attached above the composer (instead of inline in the message stream).
   * Null when there is no open question.
   */
  pendingQuestion?: { messageId: string; tool: ToolCallData } | null
  /** Called with the formatted response when the attached question is submitted. */
  onSubmitQuestionResponse?: (response: string) => void
  queuedMessages?: QueuedMessage[]
  onRemoveQueuedMessage?: (messageId: string) => void
  onReorderQueuedMessage?: (messageId: string, direction: "up" | "down") => void
  onEditQueuedMessage?: (messageId: string) => void
  onSendQueuedMessageNow?: (messageId: string) => void
  interactionMode?: InteractionMode
  onInteractionModeChange?: (mode: InteractionMode) => void
  dualPlan?: boolean
  onDualPlanChange?: (enabled: boolean) => void
  contextUsage?: { inputTokens: number; contextWindowTokens: number } | null
  quickActions?: { label: string; prompt: string }[]
  onQuickActionClick?: (prompt: string) => void
  restoreDraftRequest?: RestoreDraftRequest | null
  /**
   * Current project id. Enables the "@" menu's Files section (file
   * references are scoped to this project's agent workspace).
   */
  projectId?: string
  /**
   * Sibling projects (same workspace, excluding the current one) the user can
   * tag via the "@" menu's Projects section. Tagging one durably attaches it to
   * this chat's project (mounted into the runtime) so the agent can read its
   * files. Pass a referentially-stable array (memoized) so the memoized
   * ChatInput doesn't re-render every render.
   */
  projects?: ProjectMentionOption[]
  ideMode?: boolean
  ideContext?: IdeContextState
  ideFileSearch?: (query?: string) => Promise<IdeFileResult[]>
  onOpenIdeFile?: (path: string) => void
  dimWhenDisabled?: boolean
  /**
   * When true, draws an accent-colored ring on the visible input
   * container to mark this composer as the active edit target
   * (used by inline-edit-from-history flows in EditableUserMessage).
   * The ring is applied to the inner "main input container" rather
   * than to a wrapping View so it hugs the actual rounded box the
   * user sees — wrapping a ring around ChatInput from outside leaves
   * a visible 12px gap on three sides because ChatInput's outermost
   * View carries `p-3 pt-0` of its own. Drag-over state still wins
   * over this prop.
   */
  highlighted?: boolean
  /**
   * Strip the outer wrapper's horizontal padding so the visible
   * input box sits flush against its parent's left/right edges.
   * The vertical `pb-3` is kept — it's spacing between the input
   * box and whatever sits below it (file previews, model picker,
   * etc.).
   *
   * Used by `EditableUserMessage` in edit mode so the in-place
   * ChatInput aligns with the surrounding display-mode bubble
   * (which itself uses `px-3` on a Pressable). Without this, the
   * edit-mode bordered box is inset 12px relative to where the
   * display-row text sits, which reads as "the chat got fatter
   * when I clicked it" — see PR feedback.
   *
   * Bottom-composer callers (the regular chat input below the
   * messages) deliberately keep the default to preserve the gap
   * between the composer's bordered box and the panel edges.
   */
  flush?: boolean
}

function ChatInputImpl({
  onSubmit,
  disabled = false,
  placeholder = "Ask Shogo...",
  isStreaming = false,
  onStop,
  selectedModel: controlledModel,
  onModelChange,
  isPro = false,
  onUpgradeClick,
  pendingQuestion,
  onSubmitQuestionResponse,
  queuedMessages = [],
  onRemoveQueuedMessage,
  onReorderQueuedMessage,
  onEditQueuedMessage,
  onSendQueuedMessageNow,
  interactionMode: controlledInteractionMode,
  onInteractionModeChange,
  dualPlan = false,
  onDualPlanChange,
  contextUsage,
  quickActions = [],
  onQuickActionClick,
  restoreDraftRequest,
  projectId,
  projects = [],
  ideMode = false,
  ideContext,
  ideFileSearch,
  onOpenIdeFile,
  dimWhenDisabled = true,
  highlighted = false,
  flush = false,
}: ChatInputProps) {
  const { features } = usePlatformConfig()
  const effectiveIsPro = features.billing ? isPro : true

  const bridge = useChatBridgeOptional()
  const ezAvailable = Platform.OS === "web" && features.ezMode && !!bridge
  const ezActive = bridge?.ezModeActive ?? false

  const textInputRef = useRef<TextInput>(null)
  const dropZoneRef = useRef<View>(null)
  const dragCounterRef = useRef(0)
  const inputValueRef = useRef("")
  // Guards against the DOM paste listener AND onChangeText both firing for
  // the same clipboard event, which would create duplicate chips.
  const pasteHandledRef = useRef(false)
  // Coalesced-flush scaffolding for `handleChangeText` (declared here, ahead
  // of `composerDisplayValue` below, so the rendered TextInput can always
  // show the freshest typed text even on a render that fires BEFORE the
  // buffered `setInputValue` flush — see `handleChangeText` for why this
  // buffering exists at all.
  const pendingTextChangeRef = useRef<Extract<
    ChatInputTextChange,
    { type: "text" }
  > | null>(null)
  const textChangeFlushHandleRef = useRef<number | null>(null)

  const [inputValue, setInputValue] = useState("")
  // Cancels a pending coalesced text-change flush (see `handleChangeText`)
  // before any DISCRETE, immediate write to `inputValue` (submit, mention
  // insertion, skill insertion, draft restore, voice transcript append) so a
  // stale buffered keystroke can never fire afterward and clobber it.
  const cancelPendingTextChangeFlush = useCallback(() => {
    pendingTextChangeRef.current = null
    if (textChangeFlushHandleRef.current != null) {
      cancelAnimationFrame(textChangeFlushHandleRef.current)
      textChangeFlushHandleRef.current = null
    }
  }, [])
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT)
  const [pendingFiles, setPendingFiles] = useState<AttachedFile[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [isProcessingFiles, setIsProcessingFiles] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const [queueExpanded, setQueueExpanded] = useState(true)
  // Row hover & action-icon visibility are now CSS-driven (Tailwind `group` /
  // `group-hover:`) rather than React-state driven — see the comment above
  // the row Pressable below for why.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [interactionModeOpen, setInteractionModeOpen] = useState(false)
  const [attachSheetOpen, setAttachSheetOpen] = useState(false)

  useEffect(() => {
    inputValueRef.current = inputValue
  }, [inputValue])

  const [internalModel, setInternalModel] = useState<string>(
    effectiveIsPro ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE
  )
  const currentModelId = controlledModel ?? internalModel

  const handleModelChange = useCallback(
    (modelId: string) => {
      const tier = resolveTier(modelId)
      if (tier !== "economy" && !effectiveIsPro) {
        onUpgradeClick?.()
        return
      }

      if (onModelChange) {
        onModelChange(modelId)
      } else {
        setInternalModel(modelId)
      }
    },
    [onModelChange, effectiveIsPro, onUpgradeClick]
  )

  const [internalInteractionMode, setInternalInteractionMode] = useState<InteractionMode>("agent")
  const interactionMode = controlledInteractionMode ?? internalInteractionMode

  const handleInteractionModeChange = useCallback(
    (mode: InteractionMode) => {
      if (onInteractionModeChange) {
        onInteractionModeChange(mode)
      } else {
        setInternalInteractionMode(mode)
      }
    },
    [onInteractionModeChange]
  )

  const cycleInteractionMode = useCallback(() => {
    if (disabled) return
    const currentIndex = INTERACTION_MODE_ORDER.indexOf(interactionMode)
    const nextIndex = (currentIndex + 1) % INTERACTION_MODE_ORDER.length
    handleInteractionModeChange(INTERACTION_MODE_ORDER[nextIndex])
  }, [disabled, handleInteractionModeChange, interactionMode])

  const currentInteractionConfig = useMemo(
    () => INTERACTION_MODES.find((m) => m.id === interactionMode) || INTERACTION_MODES[0],
    [interactionMode]
  )

  const [quickActionsOpen, setQuickActionsOpen] = useState(false)

  // Long-text pastes are extracted out of the TextInput and rendered as
  // compact ChatGPT-style file chips. The input stays editable so the user
  // can keep typing and paste additional long blocks (each becomes its own
  // chip).
  const [pastedTexts, setPastedTexts] = useState<PastedTextEntry[]>([])
  const [viewingPastedId, setViewingPastedId] = useState<string | null>(null)
  const [previewVideoFile, setPreviewVideoFile] = useState<{ url: string; name: string } | null>(null)
  const lastRestoredDraftNonceRef = useRef<number | null>(null)

  useEffect(() => {
    if (!restoreDraftRequest) return
    if (restoreDraftRequest.nonce === lastRestoredDraftNonceRef.current) return

    lastRestoredDraftNonceRef.current = restoreDraftRequest.nonce
    cancelPendingTextChangeFlush()
    inputValueRef.current = restoreDraftRequest.content
    setInputValue(restoreDraftRequest.content)
    setPendingFiles(
      (restoreDraftRequest.files ?? []).map((file, index) => ({
        id: `restored-${restoreDraftRequest.nonce}-${index}`,
        dataUrl: file.dataUrl,
        name: file.name,
        type: file.type,
        size: estimateDataUrlSize(file.dataUrl),
      }))
    )
    setPastedTexts([])
    setViewingPastedId(null)
    setFileError(null)
    setTimeout(() => textInputRef.current?.focus(), 0)
  }, [restoreDraftRequest, cancelPendingTextChangeFlush])

  const addPastedText = useCallback((content: string) => {
    const info = analyzeContent(content)
    if (!info.isLong) return false
    setPastedTexts((prev) => {
      if (prev.length >= MAX_PASTED_TEXTS) return prev
      return [
        ...prev,
        {
          id: `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          content,
          info,
        },
      ]
    })
    return true
  }, [])

  const handleRemovePastedText = useCallback((id: string) => {
    setPastedTexts((prev) => prev.filter((p) => p.id !== id))
    setViewingPastedId((curr) => (curr === id ? null : curr))
  }, [])

  const handleUpdatePastedText = useCallback((id: string, content: string) => {
    setPastedTexts((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, content, info: analyzeContent(content) } : p
      )
    )
  }, [])

  const viewingPasted = useMemo(
    () => pastedTexts.find((p) => p.id === viewingPastedId) ?? null,
    [pastedTexts, viewingPastedId]
  )

  // Skill picker state
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [filterText, setFilterText] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filteredSkills = useMemo(() => {
    if (!filterText) return SKILLS
    const lower = filterText.toLowerCase()
    return SKILLS.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower)
    )
  }, [filterText])

  // ---- "@" mention menu (files + sibling projects) --------------------------
  const chatContext = useChatContextSafe()
  const agentUrl = chatContext?.agentUrl ?? null
  const agentClient = useMemo(
    () =>
      agentUrl ? new AgentClient({ baseUrl: agentUrl.replace(/\/$/, ""), fetch: agentFetch }) : null,
    [agentUrl]
  )

  const [references, setReferences] = useState<ChatReference[]>([])
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionIndex, setMentionIndex] = useState(0)
  const [fileResults, setFileResults] = useState<IdeFileResult[]>([])
  // Per-project cache of the workspace file list, so name matching as the user
  // types is instant and doesn't refetch the tree on every keystroke.
  const treeFilesRef = useRef<{
    projectId: string | null
    files: { path: string; name: string }[]
  }>({ projectId: null, files: [] })
  // The active "@" token's range in the input, so selecting an item can strip
  // exactly that token regardless of where the caret is.
  const mentionTokenRef = useRef<{ start: number; end: number } | null>(null)
  const activeMentionStateRef = useRef<{ start: number; end: number; query: string } | null>(null)
  // One-shot caret override: after inserting an inline "@mention" we move the
  // caret to just past it, then release control so normal typing isn't pinned.
  const [selectionOverride, setSelectionOverride] = useState<
    { start: number; end: number } | undefined
  >(undefined)
  // Mirror the TextInput's internal scroll so the highlight overlay tracks it
  // once the composer grows past its max height and starts scrolling.
  const [overlayScrollY, setOverlayScrollY] = useState(0)

  const closeMentionMenu = useCallback(() => {
    setShowMentionMenu(false)
    setMentionQuery("")
    setMentionIndex(0)
    mentionTokenRef.current = null
    activeMentionStateRef.current = null
  }, [])

  // Re-evaluate the active "@" token whenever the text or caret changes.
  const updateMentionState = useCallback(
    (text: string, caret: number) => {
      const token = detectMentionToken(text, caret)
      if (!token) {
        if (mentionTokenRef.current) {
          mentionTokenRef.current = null
          activeMentionStateRef.current = null
          setShowMentionMenu(false)
          setMentionQuery("")
          setMentionIndex(0)
        }
        return
      }

      const nextState = { start: token.start, end: caret, query: token.query }
      const currentState = activeMentionStateRef.current
      if (
        currentState &&
        currentState.start === nextState.start &&
        currentState.end === nextState.end &&
        currentState.query === nextState.query
      ) {
        return
      }

      activeMentionStateRef.current = nextState
      mentionTokenRef.current = { start: token.start, end: caret }
      setShowMentionMenu(true)
      setMentionIndex(0)
      setMentionQuery((prev) => (prev === token.query ? prev : token.query))
    },
    []
  )

  // Debounced file search against the project's agent workspace, matched by
  // FILE NAME (the composer "@" menu is a name picker, not a content search).
  // We cache the workspace file list once per project, then filter by basename
  // as the user types; deeper files the name-cache misses are backfilled from
  // the content index but still filtered to basename matches so results stay
  // name-relevant. Gated on `projectId` so the Files section only appears in a
  // project composer (and stays empty in the inline-edit composer).
  useEffect(() => {
    if (!showMentionMenu) {
      setFileResults([])
      return
    }
    if (ideMode && !ideFileSearch) {
      setFileResults([])
      return
    }
    if (!ideMode && (!agentClient || !projectId)) {
      setFileResults([])
      return
    }
    let cancelled = false
    const q = mentionQuery.trim().toLowerCase()
    const filterIdeItems = (items: IdeFileResult[]) => {
      const seen = new Set<string>()
      return items.filter((item) => {
        if (!item?.path || !item?.name || seen.has(item.path)) return false
        seen.add(item.path)
        return !q || item.path.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)
      }).slice(0, MAX_IDE_MENTION_FILE_RESULTS)
    }
    const contextItems = ideMode && Array.isArray(ideContext?.workspaceItems)
      ? filterIdeItems(ideContext.workspaceItems)
      : []
    if (ideMode && contextItems.length > 0) setFileResults(contextItems)
    const timer = setTimeout(async () => {
      try {
        if (ideMode && ideFileSearch) {
          const results = await ideFileSearch(mentionQuery.trim())
          if (!cancelled) {
            const liveResults = filterIdeItems(results)
            setFileResults(liveResults.length > 0 ? liveResults : contextItems)
          }
          return
        }

        // Load + cache the workspace file list once per project. The tree route
        // is shallow (eager-depth), so this covers the common top-level files;
        // the content-index backfill below reaches deeper ones.
        if (treeFilesRef.current.projectId !== projectId) {
          const tree = await agentClient?.getWorkspaceTree("")
          const files: { path: string; name: string }[] = []
          const walk = (nodes: any[]) => {
            for (const node of nodes) {
              if (node?.type === "file" && node.path) {
                files.push({ path: node.path, name: node.name || basename(node.path) })
              } else if (node?.type === "directory" && Array.isArray(node.children)) {
                walk(node.children)
              }
            }
          }
          walk(Array.isArray(tree) ? tree : [])
          treeFilesRef.current = { projectId: projectId ?? null, files }
        }

        const seen = new Set<string>()
        const results: IdeFileResult[] = []
        const push = (f: { path: string; name: string }) => {
          if (results.length >= MAX_MENTION_FILE_RESULTS || seen.has(f.path)) return
          seen.add(f.path)
          results.push({ type: "file", path: f.path, name: f.name })
        }

        if (!q) {
          // No query yet: show the first cached files as suggestions.
          for (const f of treeFilesRef.current.files) push(f)
        } else {
          // Name match against the cached list first…
          for (const f of treeFilesRef.current.files) {
            if (f.name.toLowerCase().includes(q)) push(f)
          }
          // …then backfill deeper files from the content index, keeping only
          // those whose basename matches the typed query.
          if (results.length < MAX_MENTION_FILE_RESULTS) {
            try {
              const hits = await agentClient?.searchFiles(mentionQuery.trim(), {
                limit: MAX_MENTION_FILE_RESULTS * 4,
              })
              for (const hit of hits ?? []) {
                if (!hit?.path) continue
                const name = basename(hit.path)
                if (name.toLowerCase().includes(q)) push({ path: hit.path, name })
              }
            } catch {
              /* name matches from the cache already populated results */
            }
          }
        }
        if (!cancelled) setFileResults(results)
      } catch {
        if (!cancelled) setFileResults([])
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [showMentionMenu, mentionQuery, agentClient, projectId, ideMode, ideFileSearch, ideContext?.workspaceItems])

  const filteredProjects = useMemo(() => {
    if (ideMode) return []
    const q = mentionQuery.trim().toLowerCase()
    const list = projects ?? []
    const matched = q
      ? list.filter(
          (p) =>
            p.name.toLowerCase().includes(q) || slugifyMention(p.name).includes(q)
        )
      : list
    return matched.slice(0, MAX_MENTION_PROJECT_RESULTS)
  }, [projects, mentionQuery, ideMode])

  // Flat, ordered list backing keyboard navigation (files first, then projects).
  const mentionItems = useMemo<MentionItem[]>(
    () => [
      ...fileResults.map((f) => ({ kind: f.type, path: f.path, name: f.name })),
      ...filteredProjects.map((p) => ({
        kind: "project" as const,
        id: p.id,
        name: p.name,
      })),
    ],
    [fileResults, filteredProjects]
  )

  const addReference = useCallback((ref: ChatReference) => {
    setReferences((prev) =>
      prev.some((r) => referenceKey(r) === referenceKey(ref)) ? prev : [...prev, ref]
    )
  }, [])

  const selectMention = useCallback(
    (item: MentionItem) => {
      // Insert the mention INLINE as an "@token" (replacing the active query,
      // or appended at the caret-less end) so it renders as a pill where it
      // was typed — instead of stripping it into a chip above the box. Files
      // tag by basename, projects by slugified name (both whitespace-free).
      // A mention is a discrete selection (click/Enter), not a keystroke —
      // cancel any still-pending coalesced text flush so it can't fire
      // afterward and overwrite the inline "@token" we're about to insert.
      cancelPendingTextChangeFlush()
      const base = inputValueRef.current
      const token = mentionTokenRef.current
      const label = `@${item.kind === "project" ? slugifyMention(item.name) : item.name}`
      let caret: number
      if (token) {
        const start = Math.max(0, Math.min(token.start, base.length))
        const end = Math.max(start, Math.min(token.end, base.length))
        const insert = `${label} `
        const next = base.slice(0, start) + insert + base.slice(end)
        inputValueRef.current = next
        setInputValue(next)
        caret = start + insert.length
      } else {
        const sep = base.length === 0 || base.endsWith(" ") ? "" : " "
        const insert = `${sep}${label} `
        const next = base + insert
        inputValueRef.current = next
        setInputValue(next)
        caret = next.length
      }

      if (item.kind === "file") {
        addReference({ type: "file", path: item.path, name: item.name, label })
      } else if (item.kind === "folder") {
        addReference({ type: "folder", path: item.path, name: item.name, label })
      } else {
        addReference({ type: "project", id: item.id, name: item.name, label })
      }

      closeMentionMenu()
      setSelectionOverride({ start: caret, end: caret })
      setTimeout(() => {
        textInputRef.current?.focus()
        setSelectionOverride(undefined)
      }, 0)
    },
    [addReference, closeMentionMenu, cancelPendingTextChangeFlush]
  )

  // Keep references in sync with what's actually visible: if the user edits or
  // deletes a mention's inline "@token", drop the matching reference so we
  // don't ship context the composer no longer shows.
  useEffect(() => {
    setReferences((prev) => {
      const next = prev.filter((r) => !r.label || labelPresent(inputValue, r.label))
      return next.length === prev.length ? prev : next
    })
  }, [inputValue])

  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }, [])

  const handleRemoveFile = useCallback((fileId: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.id !== fileId))
    setFileError(null)
  }, [])

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const handleAttachClick = useCallback(() => {
    if (Platform.OS === "web") {
      fileInputRef.current?.click()
      return
    }
    setAttachSheetOpen(true)
  }, [])

  const processFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file: File) => {
      const lowerName = file.name.toLowerCase()
      const isExempt =
        lowerName.endsWith(".zip") ||
        lowerName.endsWith(".shogo") ||
        lowerName.endsWith(".shogo-project") ||
        file.type === "application/zip" ||
        file.type === "application/x-zip-compressed"
      if (!isExempt && file.size > MAX_FILE_SIZE) {
        setFileError(`File "${file.name}" exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`)
        return
      }

      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        setPendingFiles((prev) => {
          if (prev.length >= MAX_FILES) {
            setFileError(`Maximum ${MAX_FILES} files allowed`)
            return prev
          }
          setFileError(null)
          return [
            ...prev,
            {
              id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              dataUrl,
              name: file.name,
              type: file.type,
              size: file.size,
            },
          ]
        })
      }
      reader.readAsDataURL(file)
    })
  }, [])

  const handleWebFileChange = useCallback(
    (e: any) => {
      const files = e.target?.files
      if (!files || files.length === 0) return
      processFiles(files)
      if (e.target) e.target.value = ""
    },
    [processFiles]
  )

  // Drag-and-drop support (web only)
  // Uses dragenter/dragleave counter to avoid flicker when cursor crosses child elements
  useEffect(() => {
    if (Platform.OS !== "web") return
    const node = dropZoneRef.current as unknown as HTMLElement | null
    if (!node) return

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      if (dragCounterRef.current === 1) {
        setIsDragOver(true)
      }
    }
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDragOver(false)
      }
    }
    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setIsDragOver(false)
      if (e.dataTransfer?.files?.length) {
        processFiles(Array.from(e.dataTransfer.files))
      }
    }

    node.addEventListener("dragover", handleDragOver)
    node.addEventListener("dragenter", handleDragEnter)
    node.addEventListener("dragleave", handleDragLeave)
    node.addEventListener("drop", handleDrop)
    return () => {
      node.removeEventListener("dragover", handleDragOver)
      node.removeEventListener("dragenter", handleDragEnter)
      node.removeEventListener("dragleave", handleDragLeave)
      node.removeEventListener("drop", handleDrop)
    }
  }, [processFiles])

  // Paste image support (web only)
  useEffect(() => {
    if (Platform.OS !== "web") return
    const node = dropZoneRef.current as unknown as HTMLElement | null
    if (!node) return

    const handlePaste = (e: ClipboardEvent) => {
      const cd = e.clipboardData
      if (!cd) return
      const items = cd.items
      const imageFiles: File[] = []
      if (items) {
        for (let i = 0; i < items.length; i++) {
          if (items[i].type.startsWith("image/")) {
            const file = items[i].getAsFile()
            if (file) imageFiles.push(file)
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        processFiles(imageFiles)
        return
      }

      const text = cd.getData("text")
      if (text && text.length >= LONG_PASTE_MIN_CHARS) {
        const info = analyzeContent(text)
        if (info.isLong) {
          e.preventDefault()
          pasteHandledRef.current = true
          addPastedText(text)
          setTimeout(() => { pasteHandledRef.current = false }, 0)
        }
      }
    }

    node.addEventListener("paste", handlePaste as EventListener)
    return () => {
      node.removeEventListener("paste", handlePaste as EventListener)
    }
  }, [processFiles, addPastedText])

  const appendTranscriptToInput = useCallback((transcript: string) => {
    const normalized = transcript.trim()
    if (!normalized) return

    cancelPendingTextChangeFlush()
    setInputValue((current) => {
      const prefix =
        current.length === 0 || /\s$/.test(current) ? current : `${current} `
      const next = `${prefix}${normalized}`
      inputValueRef.current = next
      return next
    })
    setShowSkillPicker(false)
    setFilterText("")
    setTimeout(() => textInputRef.current?.focus(), 0)
  }, [cancelPendingTextChangeFlush])

  const voiceInput = useVoiceInput({
    onTranscript: appendTranscriptToInput,
  })

  // Inline "@mention" highlight overlay. Mirror EXACTLY what the TextInput
  // shows (including the live voice transcript) so the pills line up with the
  // real text painted on top. Falls back to `pendingTextChangeRef` (read live
  // at render time, not just on the coalesced-flush's own render) so a render
  // triggered by something else while a flush is still pending never shows
  // stale text — see `handleChangeText`'s coalescing comment.
  const composerDisplayValue =
    voiceInput.isRecording && voiceInput.liveTranscript
      ? voiceInput.liveTranscript
      : pendingTextChangeRef.current?.text ?? inputValue
  const mentionLabels = useMemo(
    () => references.map((r) => r.label).filter((l): l is string => !!l),
    [references]
  )
  const mentionSegments = useMemo(
    () => buildMentionSegments(composerDisplayValue, mentionLabels),
    [composerDisplayValue, mentionLabels]
  )

  const selectSkill = useCallback(
    (skill: SkillOption) => {
      // Read the ref (not the `inputValue` state) so this reflects the
      // freshest keystroke even if a coalesced flush (see `handleChangeText`)
      // hasn't committed to state yet, then cancel it — this discrete
      // selection should win over any buffered typing.
      const current = inputValueRef.current
      cancelPendingTextChangeFlush()
      const spaceIndex = current.indexOf(" ")
      const afterPrefix = spaceIndex === -1 ? "" : current.slice(spaceIndex)
      const next = `/${skill.name}${afterPrefix || " "}`
      inputValueRef.current = next
      setInputValue(next)
      setShowSkillPicker(false)
      textInputRef.current?.focus()
    },
    [cancelPendingTextChangeFlush]
  )

  const handleSubmit = useCallback(() => {
    const trimmedContent = inputValue.trim()
    if (
      (!trimmedContent &&
        pendingFiles.length === 0 &&
        pastedTexts.length === 0 &&
        references.length === 0) ||
      disabled ||
      isProcessingFiles ||
      voiceInput.isBusy
    ) {
      return
    }

    // Pasted long-text blocks are shipped as file attachments (ChatGPT-style).
    // The typed text is sent as the message body; the model receives both the
    // text part and the file parts so it sees everything.
    const pastedAttachments: FileAttachment[] = buildPastedAttachments(pastedTexts)
    const combinedFiles: FileAttachment[] = [
      ...pendingFiles.map((f) => ({ dataUrl: f.dataUrl, name: f.name, type: f.type })),
      ...pastedAttachments,
    ]
    const fileData = combinedFiles.length > 0 ? combinedFiles : undefined
    const refData = references.length > 0 ? references : undefined

    onSubmit(trimmedContent, fileData, currentModelId, refData)
    // Drop any still-pending coalesced text-change flush (see
    // `handleChangeText`) so it can't fire AFTER this clear and resurrect
    // text the user already sent.
    cancelPendingTextChangeFlush()
    inputValueRef.current = ""
    setInputValue("")
    setInputHeight(MIN_INPUT_HEIGHT)
    setPendingFiles([])
    setPastedTexts([])
    setViewingPastedId(null)
    setReferences([])
    setFileError(null)
    closeMentionMenu()

    textInputRef.current?.focus()
  }, [disabled, onSubmit, pendingFiles, isProcessingFiles, currentModelId, inputValue, pastedTexts, references, voiceInput.isBusy, closeMentionMenu, cancelPendingTextChangeFlush])

  // Coalesces "text" changes into at most one React commit per animation
  // frame. If the browser's main thread falls behind (e.g. a big Streamdown
  // re-render while a message streams in) it can buffer several native
  // `input` events and fire them back-to-back once it catches up. Each one
  // used to call `setInputValue` + `setInputHeight` + skill-picker state +
  // `updateMentionState` immediately, so a burst of ~50+ could pile up
  // enough nested updates in a single unyielded batch to trip React's
  // "Maximum update depth exceeded" safety limit — Sentry JAVASCRIPT-REACT-3C
  // (see `ChatInput.max-update-depth-repro.test.tsx` for the reproduction).
  // `inputValueRef` still updates SYNCHRONOUSLY on every keystroke so other
  // synchronous readers (onSelectionChange, selectMention, submit) always
  // see the freshest text — only the actual state commits are throttled.
  const flushPendingTextChange = useCallback(() => {
    textChangeFlushHandleRef.current = null
    const change = pendingTextChangeRef.current
    pendingTextChangeRef.current = null
    if (!change) return

    setInputValue(change.text)
    if (change.resetHeight) {
      setInputHeight(MIN_INPUT_HEIGHT)
    }

    if (change.skillPicker.open) {
      setShowSkillPicker(true)
      setFilterText(change.skillPicker.filterText ?? "")
      setSelectedIndex(0)
    } else {
      setShowSkillPicker(false)
    }

    updateMentionState(change.text, change.mentionCaret)
  }, [updateMentionState])

  useEffect(() => {
    return () => {
      if (textChangeFlushHandleRef.current != null) {
        cancelAnimationFrame(textChangeFlushHandleRef.current)
      }
    }
  }, [])

  const handleChangeText = useCallback(
    (text: string) => {
      const change = resolveChatInputTextChange(
        inputValueRef.current,
        text,
        pasteHandledRef.current,
      )
      pasteHandledRef.current = false

      if (change.type === "paste-handled" || change.type === "unchanged") {
        return
      }

      if (change.type === "long-paste") {
        // Rare, one-shot event (a real paste) — never arrives in a burst,
        // so it can flush immediately. Also drop any still-pending coalesced
        // "text" change so a stale, smaller value doesn't clobber this one.
        cancelPendingTextChangeFlush()
        addPastedText(change.inserted)
        inputValueRef.current = change.restored
        setInputValue(change.restored)
        setShowSkillPicker(false)
        closeMentionMenu()
        return
      }

      inputValueRef.current = change.text
      pendingTextChangeRef.current = change
      if (textChangeFlushHandleRef.current == null) {
        textChangeFlushHandleRef.current = requestAnimationFrame(flushPendingTextChange)
      }
    },
    [addPastedText, closeMentionMenu, flushPendingTextChange, cancelPendingTextChangeFlush]
  )

  const removeReference = useCallback((key: string) => {
    setReferences((prev) => prev.filter((ref) => referenceKey(ref) !== key))
  }, [])

  const getFileIcon = useCallback((fileType: string) => {
    if (fileType.startsWith("image/")) {
      return <ImageIcon className="h-4 w-4 text-muted-foreground" size={16} />
    }
    if (
      fileType.includes("pdf") ||
      fileType.includes("document") ||
      fileType.includes("text")
    ) {
      return <FileText className="h-4 w-4 text-muted-foreground" size={16} />
    }
    return <File className="h-4 w-4 text-muted-foreground" size={16} />
  }, [])

  return (
    // `flush` callers (EditableUserMessage's inline edit) want the
    // bordered input box to extend to the parent's left/right
    // edges so it aligns with the surrounding display-mode bubble.
    // We keep the bottom padding either way — it separates the
    // composer from whatever sits beneath it (file previews,
    // toolbar dropdowns, etc.).
    <View className={cn(flush ? "pb-3" : "p-3 pt-0")}>
      {ideMode && (ideContext?.activeFile || references.length > 0) && (
        <View className="mb-2 gap-1.5">
          {ideContext?.activeFile && (
            <View className="flex-row flex-wrap items-center gap-1.5">
              <Text className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Context
              </Text>
              <Pressable
                onPress={() => onOpenIdeFile?.(ideContext.activeFile?.path ?? "")}
                className="flex-row items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1"
              >
                <FileText className="h-3 w-3 text-muted-foreground" size={12} />
                <Text className="max-w-[220px] text-[11px] text-foreground" numberOfLines={1}>
                  {ideContext.activeFile.path}
                </Text>
              </Pressable>
              {ideContext.activeFile.selection && (
                <View className="rounded-full border border-border bg-muted/50 px-2 py-1">
                  <Text className="text-[11px] text-muted-foreground">
                    lines {ideContext.activeFile.selection.startLine}-{ideContext.activeFile.selection.endLine}
                    {ideContext.activeFile.selection.truncated ? " · truncated" : ""}
                  </Text>
                </View>
              )}
            </View>
          )}
          {references.length > 0 && (
            <View className="flex-row flex-wrap gap-1.5">
              {references.map((ref) => {
                const key = referenceKey(ref)
                const isFolder = ref.type === "folder"
                const isFile = ref.type === "file"
                return (
                  <View key={key} className="flex-row items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1">
                    {isFolder ? (
                      <FolderGit2 className="h-3 w-3 text-muted-foreground" size={12} />
                    ) : isFile ? (
                      <FileText className="h-3 w-3 text-muted-foreground" size={12} />
                    ) : (
                      <FolderGit2 className="h-3 w-3 text-muted-foreground" size={12} />
                    )}
                    <Text className="max-w-[180px] text-[11px] text-foreground" numberOfLines={1}>
                      {ref.type === "file" || ref.type === "folder" ? ref.path : ref.name}
                    </Text>
                    <Pressable onPress={() => removeReference(key)} className="h-4 w-4 items-center justify-center rounded-full">
                      <X className="h-3 w-3 text-muted-foreground" size={12} />
                    </Pressable>
                  </View>
                )
              })}
            </View>
          )}
        </View>
      )}

      {/* Error message */}
      {fileError && (
        <Text className="text-sm text-destructive mb-2">{fileError}</Text>
      )}

      {voiceInput.error && (
        <Text className="text-sm text-destructive mb-2">{voiceInput.error}</Text>
      )}

      {/* Pending question — interactive answer UI attached above the composer.
          Stays expanded while pending; submitting persists the answer and
          clears `pendingQuestion`, unmounting this panel. */}
      {pendingQuestion && (
        <View className="mb-2">
          <AskUserQuestionWidget
            tool={pendingQuestion.tool}
            onSubmitResponse={(response) => onSubmitQuestionResponse?.(response)}
          />
        </View>
      )}

      {/* Queued messages */}
      {queuedMessages.length > 0 && (
        <View className="rounded-t-lg border-x border-t border-border/60 bg-muted/30 overflow-hidden">
          <Pressable
            onPress={() => setQueueExpanded((prev) => !prev)}
            className="w-full flex-row items-center justify-between px-2 py-1"
          >
            <View className="flex-row items-center gap-2">
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground",
                  !queueExpanded && "-rotate-90"
                )}
                size={16}
              />
              <Text className="text-sm text-foreground">
                {queuedMessages.length} Queued
              </Text>
            </View>
          </Pressable>
          {queueExpanded && (
            <View className="border-t border-border/60">
              {queuedMessages.map((msg, index) => {
                const files = msg.files ?? []
                const imageFiles = files.filter((f) => f.type?.startsWith("image/"))
                const otherFiles = files.filter((f) => !f.type?.startsWith("image/"))
                const previewImage = imageFiles[0]
                const trimmedContent = msg.content?.trim() ?? ""
                const attachmentLabel =
                  files.length > 0
                    ? `${files.length} ${files.length === 1 ? "attachment" : "attachments"}`
                    : ""
                const primaryText = trimmedContent
                  ? trimmedContent
                  : attachmentLabel || "Empty message"
                return (
                  // CSS `group` + `hover:` / `group-hover:` (instead of a
                  // React `hoveredQueuedId` state) for both row background
                  // and action-icon visibility. The earlier state-driven
                  // approach flickered when the cursor crossed from the
                  // row body onto a nested action Pressable: RN-Web fires
                  // the row's `onHoverOut` on that child-enter transition,
                  // which collapsed `isHovered` to false — fading the
                  // actions to opacity-0 *and* dropping the row's hover
                  // bg — then the row re-asserted hover a frame later and
                  // the cycle repeated. CSS `:hover` doesn't suffer this:
                  // it stays true as long as the cursor is over the
                  // element or any descendant, so the row bg + action
                  // group remain stable while the pointer is on a button.
                  // Native has no hover, so `group-hover:` simply never
                  // activates — the explicit `Platform.OS === "web"` gate
                  // on the opacity classes keeps the actions always
                  // visible there, matching the prior behavior.
                  <Pressable
                    key={msg.id}
                    onPress={() => onEditQueuedMessage?.(msg.id)}
                    accessibilityLabel="Queued message"
                    className={cn(
                      "group flex-row items-center gap-2 px-2 py-1.5 border-b border-border/40 last:border-b-0",
                      Platform.OS === "web" && "hover:bg-muted/40"
                    )}
                  >
                    <View className="h-3 w-3 rounded-full border border-muted-foreground/30 flex-shrink-0" />
                    {previewImage && (
                      <Image
                        source={{ uri: previewImage.dataUrl }}
                        className="h-7 w-7 rounded border border-border flex-shrink-0"
                        resizeMode="cover"
                      />
                    )}
                    <View className="flex-1 min-w-0">
                      <Text className="text-xs text-foreground" numberOfLines={1}>
                        {primaryText}
                      </Text>
                      {trimmedContent && files.length > 0 && (
                        <View className="flex-row items-center gap-1 mt-0.5">
                          <ImageIcon
                            className="h-3 w-3 text-muted-foreground"
                            size={10}
                          />
                          <Text
                            className="text-[10px] text-muted-foreground"
                            numberOfLines={1}
                          >
                            {imageFiles.length > 0 && otherFiles.length > 0
                              ? `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"} + ${otherFiles.length} file${otherFiles.length === 1 ? "" : "s"}`
                              : imageFiles.length > 0
                                ? `${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}`
                                : `${otherFiles.length} file${otherFiles.length === 1 ? "" : "s"}`}
                          </Text>
                        </View>
                      )}
                    </View>
                    <View
                      className={cn(
                        "flex-row items-center gap-0.5",
                        // Fade in on row hover via CSS group-hover so
                        // crossing onto a child button doesn't tear the
                        // visibility state down. Native always shows them
                        // (no hover concept), same as before.
                        Platform.OS === "web" &&
                          "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      {/*
                        Each action button uses Pressable's children-as-
                        function API to read `{ hovered, pressed }` from
                        RN-Web directly, rather than relying on NativeWind
                        `hover:` / `group-hover:` variants. The variants
                        don't reliably produce visible styling on these
                        nested Pressables in our setup (the row hover
                        works, but per-button hover never landed any
                        background or icon-color swap on the user's
                        screen — see chat thread). State-from-children is
                        the documented Pressable API and gives us a
                        boolean we can fan out to both the wrapper bg and
                        the lucide icon's text color in one place. Native
                        platforms have no hover concept; `hovered` is
                        simply undefined there, so the icons read as the
                        default muted-foreground, matching prior behavior.
                      */}
                      {onReorderQueuedMessage && queuedMessages.length > 1 && (
                        <>
                          {index > 0 && (
                            <Pressable
                              accessibilityLabel="Move queued message up"
                              onPress={(e) => {
                                if (e?.stopPropagation) e.stopPropagation()
                                onReorderQueuedMessage(msg.id, "up")
                              }}
                            >
                              {(state: any) => {
                                const active = state.hovered || state.pressed
                                return (
                                  <View
                                    className={cn(
                                      "h-6 w-6 items-center justify-center rounded",
                                      active && "bg-muted-foreground/25",
                                    )}
                                  >
                                    <ChevronUp
                                      className={cn(
                                        "h-3 w-3",
                                        active ? "text-foreground" : "text-muted-foreground",
                                      )}
                                      size={12}
                                    />
                                  </View>
                                )
                              }}
                            </Pressable>
                          )}
                          {index < queuedMessages.length - 1 && (
                            <Pressable
                              accessibilityLabel="Move queued message down"
                              onPress={(e) => {
                                if (e?.stopPropagation) e.stopPropagation()
                                onReorderQueuedMessage(msg.id, "down")
                              }}
                            >
                              {(state: any) => {
                                const active = state.hovered || state.pressed
                                return (
                                  <View
                                    className={cn(
                                      "h-6 w-6 items-center justify-center rounded",
                                      active && "bg-muted-foreground/25",
                                    )}
                                  >
                                    <ChevronDown
                                      className={cn(
                                        "h-3 w-3",
                                        active ? "text-foreground" : "text-muted-foreground",
                                      )}
                                      size={12}
                                    />
                                  </View>
                                )
                              }}
                            </Pressable>
                          )}
                        </>
                      )}
                      {onSendQueuedMessageNow && (
                        <Pressable
                          accessibilityLabel="Send queued message now"
                          onPress={(e) => {
                            if (e?.stopPropagation) e.stopPropagation()
                            onSendQueuedMessageNow(msg.id)
                          }}
                        >
                          {(state: any) => {
                            const active = state.hovered || state.pressed
                            return (
                              <View
                                className={cn(
                                  "h-6 w-6 items-center justify-center rounded",
                                  active && "bg-muted-foreground/25",
                                )}
                              >
                                <SendHorizontal
                                  className={cn(
                                    "h-3 w-3",
                                    active ? "text-foreground" : "text-muted-foreground",
                                  )}
                                  size={12}
                                />
                              </View>
                            )
                          }}
                        </Pressable>
                      )}
                      {onEditQueuedMessage && (
                        <Pressable
                          accessibilityLabel="Edit queued message"
                          onPress={(e) => {
                            if (e?.stopPropagation) e.stopPropagation()
                            onEditQueuedMessage(msg.id)
                          }}
                        >
                          {(state: any) => {
                            const active = state.hovered || state.pressed
                            return (
                              <View
                                className={cn(
                                  "h-6 w-6 items-center justify-center rounded",
                                  active && "bg-muted-foreground/25",
                                )}
                              >
                                <Pencil
                                  className={cn(
                                    "h-3 w-3",
                                    active ? "text-foreground" : "text-muted-foreground",
                                  )}
                                  size={12}
                                />
                              </View>
                            )
                          }}
                        </Pressable>
                      )}
                      {onRemoveQueuedMessage && (
                        <Pressable
                          accessibilityLabel="Delete queued message"
                          onPress={(e) => {
                            if (e?.stopPropagation) e.stopPropagation()
                            onRemoveQueuedMessage(msg.id)
                          }}
                        >
                          {(state: any) => {
                            const active = state.hovered || state.pressed
                            return (
                              <View
                                className={cn(
                                  "h-6 w-6 items-center justify-center rounded",
                                  active && "bg-destructive/20",
                                )}
                              >
                                <Trash2
                                  className={cn(
                                    "h-3 w-3",
                                    active ? "text-destructive" : "text-muted-foreground",
                                  )}
                                  size={12}
                                />
                              </View>
                            )
                          }}
                        </Pressable>
                      )}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          )}
        </View>
      )}

      {/* Dropdown + input layer.

          This bare `relative` wrapper is the positioning context for the
          floating dropdowns (skill picker + "@" mention menu) that open
          ABOVE the composer via `bottom-full`. They MUST live here rather
          than inside the bordered input box below: that box uses
          `overflow-hidden` to clip its own rounded corners, which also
          clips anything positioned outside its bounds — so a dropdown
          anchored at `bottom: 100%` (just above the box) was being clipped
          completely out of view. The wrapper itself never clips. */}
      <View className="relative">
        {/* Skill picker dropdown */}
        {showSkillPicker && filteredSkills.length > 0 && (
          <View className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] rounded-md border border-border bg-popover shadow-md z-50">
            <ScrollView>
              {filteredSkills.map((skill, index) => (
                <Pressable
                  key={skill.name}
                  onPress={() => selectSkill(skill)}
                  className={cn(
                    "w-full px-3 py-2",
                    index === selectedIndex && "bg-accent"
                  )}
                >
                  <Text className="font-medium text-sm text-foreground">
                    /{skill.name}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {skill.description}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {/* "@" mention menu — files/folders in IDE mode; project files + sibling projects otherwise */}
        {showMentionMenu && (
          <View className="absolute bottom-full left-0 right-0 mb-1 max-h-[280px] rounded-md border border-border bg-popover shadow-md z-50">
            <ScrollView keyboardShouldPersistTaps="handled">
              {fileResults.length > 0 && (
                <>
                  <Text className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {ideMode ? "Files and folders" : "Files"}
                  </Text>
                  {fileResults.map((file, i) => {
                    const active = i === mentionIndex
                    const Icon = file.type === "folder" ? FolderGit2 : FileText
                    return (
                      <Pressable
                        key={`mention-${file.type}-${file.path}`}
                        onPress={() => selectMention({ kind: file.type, path: file.path, name: file.name })}
                        className={cn(
                          "w-full flex-row items-center gap-2 px-3 py-1.5",
                          active && "bg-accent"
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 text-muted-foreground" size={14} />
                        <View className="flex-1 min-w-0">
                          <Text className="text-xs text-foreground" numberOfLines={1}>
                            {file.name}
                          </Text>
                          {ideMode && (
                            <Text className="text-[10px] text-muted-foreground" numberOfLines={1}>
                              {file.path}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                    )
                  })}
                </>
              )}

              {filteredProjects.length > 0 && (
                <>
                  <Text className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Projects
                  </Text>
                  {filteredProjects.map((proj, i) => {
                    const idx = fileResults.length + i
                    const active = idx === mentionIndex
                    return (
                      <Pressable
                        key={`mention-project-${proj.id}`}
                        onPress={() => selectMention({ kind: "project", id: proj.id, name: proj.name })}
                        className={cn(
                          "w-full flex-row items-center gap-2 px-3 py-1.5",
                          active && "bg-accent"
                        )}
                      >
                        <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" size={14} />
                        <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                          {proj.name}
                        </Text>
                      </Pressable>
                    )
                  })}
                </>
              )}

              {mentionItems.length === 0 && (
                <Text className="px-3 py-3 text-xs text-muted-foreground">
                  {ideMode && !ideFileSearch
                    ? "IDE file bridge unavailable"
                    : !agentClient && !ideMode && (projects?.length ?? 0) === 0
                      ? "Nothing to reference yet"
                      : "No matches"}
                </Text>
              )}
            </ScrollView>
          </View>
        )}

        {/* Main input container */}
        <View
          ref={dropZoneRef as any}
          className={cn(
            "relative border bg-muted/30 overflow-hidden",
            queuedMessages.length > 0 ? "rounded-b-xl" : "rounded-xl",
            isDragOver ? "border-primary border-dashed" : "border-border/60",
            // Accent ring for the inline-edit "active edit target"
            // state. Drag-over still takes precedence (its dashed
            // primary border is more important to surface than the
            // edit-target highlight). The inner border stays at
            // 1px so toggling `highlighted` doesn't shift layout.
            highlighted && !isDragOver && "ring-2 ring-primary/70"
          )}
        >
        {/* Hidden file input for web (including mobile-web on Android/iOS browsers) */}
        {Platform.OS === "web" && (
          <input
            ref={fileInputRef as any}
            type="file"
            multiple
            capture={undefined}
            onChange={handleWebFileChange}
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
          />
        )}

        {/* Pasted long-text chips (ChatGPT-style). Multiple allowed. */}
        {pastedTexts.length > 0 && (
          <View className="flex-row flex-wrap gap-2 px-3 pt-3">
            {pastedTexts.map((entry) => (
              <PastedTextChip
                key={entry.id}
                entry={entry}
                onOpen={() => setViewingPastedId(entry.id)}
                onRemove={() => handleRemovePastedText(entry.id)}
              />
            ))}
          </View>
        )}

        {/* File attachment previews — compact thumbnails inside the input box */}
        {(pendingFiles.length > 0 || isProcessingFiles) && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, alignItems: 'flex-end' }}
          >
            {pendingFiles.map((file) => {
              const isImage = file.type.startsWith("image/")
              const isVideo = file.type.startsWith("video/")
              return (
                <View key={file.id} className="relative">
                  {isImage ? (
                    <View className="rounded-lg overflow-hidden border border-border/60" style={{ width: 72, height: 72 }}>
                      <Image
                        source={{ uri: file.dataUrl }}
                        style={{ width: 72, height: 72 }}
                        resizeMode="cover"
                      />
                    </View>
                  ) : isVideo ? (
                    <Pressable
                      onPress={() => setPreviewVideoFile({ url: file.dataUrl, name: file.name })}
                      accessibilityRole="button"
                      accessibilityLabel={`Preview video ${file.name}`}
                    >
                      <View className="rounded-lg overflow-hidden border border-border/60 bg-black/80 items-center justify-center" style={{ width: 72, height: 72 }}>
                        <View className="absolute inset-0 items-center justify-center">
                          <View className="rounded-full bg-white/20 items-center justify-center" style={{ width: 32, height: 32 }}>
                            <Play size={16} className="text-white" fill="white" />
                          </View>
                        </View>
                        <Text className="text-[9px] text-white/50 absolute bottom-1.5 left-0 right-0 text-center" numberOfLines={1}>
                          {file.name}
                        </Text>
                      </View>
                    </Pressable>
                  ) : (
                    <View
                      className="flex-row items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 px-2"
                      style={{ height: 36, maxWidth: 160 }}
                    >
                      <View className="flex-shrink-0">{getFileIcon(file.type)}</View>
                      <Text className="text-xs text-foreground flex-1 min-w-0" numberOfLines={1}>
                        {file.name}
                      </Text>
                    </View>
                  )}
                  <Pressable
                    onPress={() => handleRemoveFile(file.id)}
                    disabled={isProcessingFiles}
                    className="absolute -right-1.5 -top-1.5 h-5 w-5 rounded-full bg-background border border-border items-center justify-center"
                    style={{ zIndex: 10 }}
                  >
                    <X className="text-foreground" size={10} />
                  </Pressable>
                </View>
              )
            })}
            {isProcessingFiles && (
              <View
                className="rounded-lg border border-border/60 bg-muted/40 items-center justify-center"
                style={{ width: 72, height: 72 }}
              >
                <Text className="text-[10px] text-muted-foreground text-center">
                  Uploading…
                </Text>
              </View>
            )}
          </ScrollView>
        )}

        {/* Tagged files / projects now render INLINE as "@mention" pills via
            the highlight overlay below, so the old chip row above the box is
            gone. References themselves are still tracked + sent on submit. */}

        <View className="relative">
          {/* Highlight backdrop: a transparent mirror of the composer text that
              paints a pill behind each "@mention". The real TextInput sits on
              top (zIndex) so typed text stays crisp and the caret is native;
              only the pill backgrounds show through its transparent fill. The
              mirror MUST match the TextInput's font/line-height/padding (shared
              `text-xs` + `px-4 pt-4`) or the pills drift off the words. */}
          <View
            pointerEvents="none"
            className="absolute top-0 bottom-0 left-0 right-0 overflow-hidden px-4 pt-4"
            style={{ zIndex: 0 }}
          >
            <Text
              className="text-xs"
              style={[
                { color: "transparent", transform: [{ translateY: -overlayScrollY }] },
                Platform.OS === "web"
                  ? ({ whiteSpace: "pre-wrap", wordBreak: "break-word" } as any)
                  : null,
              ]}
            >
              {mentionSegments.map((seg, idx) =>
                seg.mention ? (
                  <Text
                    key={idx}
                    className="text-xs rounded bg-primary/20"
                    style={{ color: "transparent" }}
                  >
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={idx} className="text-xs" style={{ color: "transparent" }}>
                    {seg.text}
                  </Text>
                )
              )}
            </Text>
          </View>

        <TextInput
          ref={textInputRef}
          value={composerDisplayValue}
          selection={selectionOverride}
          onChangeText={handleChangeText}
          onSelectionChange={(e) => {
            // Re-detect against the freshest text (kept in inputValueRef by
            // handleChangeText) using the authoritative caret position.
            updateMentionState(inputValueRef.current, e.nativeEvent.selection.start)
          }}
          onScroll={(e) => {
            // Keep the inline-mention overlay aligned once the box scrolls.
            setOverlayScrollY((e.nativeEvent as any)?.contentOffset?.y ?? 0)
          }}
          onSubmitEditing={handleSubmit}
          onKeyPress={(e: any) => {
            // While the "@" menu is open, intercept navigation keys so they
            // drive the menu instead of the textarea / message submit.
            if (
              Platform.OS === "web" &&
              showMentionMenu &&
              mentionItems.length > 0
            ) {
              const key = e.nativeEvent.key
              if (key === "ArrowDown") {
                e.preventDefault()
                setMentionIndex((i) => (i + 1) % mentionItems.length)
                return
              }
              if (key === "ArrowUp") {
                e.preventDefault()
                setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
                return
              }
              if (key === "Enter" || key === "Tab") {
                e.preventDefault()
                const item = mentionItems[Math.min(mentionIndex, mentionItems.length - 1)]
                if (item) selectMention(item)
                return
              }
              if (key === "Escape") {
                e.preventDefault()
                closeMentionMenu()
                return
              }
            }
            if (Platform.OS === "web" && e.nativeEvent.key === "Tab" && e.nativeEvent.shiftKey) {
              e.preventDefault()
              cycleInteractionMode()
              return
            }
            if (Platform.OS === "web" && e.nativeEvent.key === "Enter" && !e.nativeEvent.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
          placeholder={placeholder}
          placeholderTextColor="#9ca3af"
          testID="project-composer-input"
          accessibilityLabel="Chat message input"
          editable={!disabled && !voiceInput.isRecording}
          multiline
          blurOnSubmit={false}
          onContentSizeChange={(e) => {
            const h = e.nativeEvent.contentSize.height
            const clamped = Math.min(MAX_INPUT_HEIGHT, Math.max(MIN_INPUT_HEIGHT, h))
            if (clamped !== inputHeight) {
              setInputHeight(clamped)
            }
          }}
          style={{ height: inputHeight, zIndex: 1 }}
          className={cn(
            "min-h-[60px] max-h-[200px] w-full",
            "bg-transparent",
            "px-4 pt-4 text-xs text-foreground",
            disabled && dimWhenDisabled && "opacity-50",
            Platform.OS === "web" && "outline-none no-focus-ring"
          )}
          textAlignVertical="top"
        />
        </View>

        {/* Bottom toolbar */}
        <View className="flex-row items-center justify-between p-1.5">
          {/* Left side buttons */}
          <View className="flex-row items-center gap-1">
            {/* Interaction mode selector (Agent / Plan / Ask) */}
            <Popover
              placement="top"
              size="xs"
              isOpen={interactionModeOpen}
              onOpen={() => setInteractionModeOpen(true)}
              onClose={() => setInteractionModeOpen(false)}
              trigger={(triggerProps) => (
                <WebTooltip label={`Mode: ${currentInteractionConfig.label}`}>
                  <Pressable
                    {...triggerProps}
                    disabled={disabled}
                    accessibilityLabel={`Mode: ${currentInteractionConfig.label}`}
                    className={cn(
                      "h-[22px] w-[22px] items-center justify-center rounded-md",
                      interactionMode === "agent" && "bg-muted/50",
                      interactionMode === "plan" &&
                        "border border-amber-500/45 bg-amber-500/12",
                      interactionMode === "ask" &&
                        "border border-emerald-500/45 bg-emerald-500/12"
                    )}
                    testID="interaction-mode-trigger"
                  >
                    <currentInteractionConfig.Icon
                      className={cn(
                        "h-3.5 w-3.5",
                        interactionMode === "agent" && "text-muted-foreground",
                        interactionMode === "plan" && "text-amber-400",
                        interactionMode === "ask" && "text-emerald-400"
                      )}
                      size={14}
                    />
                  </Pressable>
                </WebTooltip>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="w-[140px] p-0">
                <View className="py-1">
                  {INTERACTION_MODES.map((mode) => {
                    const isSelected = mode.id === interactionMode
                    return (
                      <Pressable
                        key={mode.id}
                        onPress={() => {
                          handleInteractionModeChange(mode.id)
                          setInteractionModeOpen(false)
                        }}
                        className={cn(
                          "flex-row items-center p-1 rounded-lg mb-1",
                          isSelected &&
                            mode.id === "agent" &&
                            "bg-accent",
                          isSelected &&
                            mode.id === "plan" &&
                            "border border-amber-500/35 bg-amber-500/12",
                          isSelected &&
                            mode.id === "ask" &&
                            "border border-emerald-500/35 bg-emerald-500/12"
                        )}
                      >
                        <View className="w-8 items-center">
                          <mode.Icon
                            className={cn(
                              "h-3.5 w-3.5",
                              isSelected &&
                                mode.id === "plan" &&
                                "text-amber-400",
                              isSelected &&
                                mode.id === "ask" &&
                                "text-emerald-400",
                              (!isSelected || mode.id === "agent") &&
                                "text-muted-foreground"
                            )}
                            size={6}
                          />
                        </View>
                        <View className="flex-1">
                          <Text
                            className={cn(
                              "text-xs",
                              isSelected &&
                                mode.id === "plan" &&
                                "text-amber-400",
                              isSelected &&
                                mode.id === "ask" &&
                                "text-emerald-400",
                              (!isSelected || mode.id === "agent") &&
                                "text-foreground"
                            )}
                          >
                            {mode.label}
                          </Text>
                        </View>
                      </Pressable>
                    )
                  })}
                  {ezAvailable && (
                    <>
                      <View className="h-px bg-border/50 mx-2 my-1" />
                      <Pressable
                        testID="ez-mode-toggle"
                        onPress={() => {
                          bridge?.toggleEzMode()
                          setInteractionModeOpen(false)
                        }}
                        className={cn(
                          "flex-row items-center p-1 rounded-lg mb-1",
                          ezActive &&
                            "border border-violet-500/35 bg-violet-500/12"
                        )}
                      >
                        <View className="w-8 items-center">
                          <Sparkles
                            className={cn(
                              "h-3.5 w-3.5",
                              ezActive
                                ? "text-violet-400"
                                : "text-muted-foreground"
                            )}
                            size={6}
                          />
                        </View>
                        <View className="flex-1">
                          <Text
                            className={cn(
                              "text-xs",
                              ezActive
                                ? "text-violet-400"
                                : "text-foreground"
                            )}
                          >
                            EZ Mode
                          </Text>
                        </View>
                      </Pressable>
                    </>
                  )}
                </View>
              </PopoverContent>
            </Popover>

            {/* Dual Plan toggle — surfaces only while in Plan mode. Persistent
                per-device preference: once on, every plan generated in Plan
                mode also produces a stakeholder summary. */}
            {interactionMode === "plan" && (
              <WebTooltip label="Also generate a stakeholder summary">
                <Pressable
                  testID="dual-plan-toggle"
                  disabled={disabled}
                  onPress={() => onDualPlanChange?.(!dualPlan)}
                  accessibilityLabel="Also generate a stakeholder summary"
                  className={cn(
                    "h-[22px] w-[22px] items-center justify-center rounded-md",
                    dualPlan
                      ? "border border-sky-500/45 bg-sky-500/12"
                      : "bg-muted/50"
                  )}
                >
                  <Languages
                    className={cn(
                      "h-3.5 w-3.5",
                      dualPlan ? "text-sky-400" : "text-muted-foreground"
                    )}
                    size={14}
                  />
                </Pressable>
              </WebTooltip>
            )}

            {/* Quick Actions selector */}
            {quickActions.length > 0 && (
              <Popover
                placement="top"
                size="xs"
                isOpen={quickActionsOpen}
                onOpen={() => setQuickActionsOpen(true)}
                onClose={() => setQuickActionsOpen(false)}
                trigger={(triggerProps) => (
                  <WebTooltip label="Quick actions">
                    <Pressable
                      {...triggerProps}
                      disabled={disabled}
                      accessibilityLabel="Quick actions"
                      className={cn(
                        "h-[22px] w-[22px] items-center justify-center rounded-md",
                        quickActionsOpen
                          ? "border border-amber-500/45 bg-amber-500/12"
                          : "bg-muted/50"
                      )}
                    >
                      <Zap
                        className={cn(
                          "h-3.5 w-3.5",
                          quickActionsOpen ? "text-amber-400" : "text-muted-foreground"
                        )}
                        size={14}
                      />
                    </Pressable>
                  </WebTooltip>
                )}
              >
                <PopoverBackdrop />
                <PopoverContent className="w-[280px] p-0">
                  <View className="py-1">
                    {quickActions.map((action) => (
                      <Pressable
                        key={action.label}
                        onPress={() => {
                          onQuickActionClick?.(action.prompt)
                          setQuickActionsOpen(false)
                        }}
                        className="flex-row items-center gap-3 p-3 rounded-lg mb-1"
                      >
                        <View className="w-8 items-center">
                          <Zap className="h-3.5 w-3.5 text-amber-400" size={14} />
                        </View>
                        <View className="flex-1">
                          <Text className="font-medium text-sm text-foreground">
                            {action.label}
                          </Text>
                          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                            {action.prompt}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                </PopoverContent>
              </Popover>
            )}

            {/* Environment selector — pick Cloud or a paired machine */}
            <EnvironmentPicker disabled={disabled} />

            {/* Model selector */}
            <Popover
              placement="top"
              size="xs"
              isOpen={modelPickerOpen}
              onOpen={() => setModelPickerOpen(true)}
              onClose={() => setModelPickerOpen(false)}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  disabled={disabled}
                  className="h-[22px] flex-row items-center gap-1 rounded-md px-1.5"
                >
                  <Text className="text-xs text-muted-foreground">
                    {resolveShortName(currentModelId)}
                  </Text>
                  <ChevronDown className="h-2 w-2 text-muted-foreground/60" size={8} />
                </Pressable>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="p-0 max-h-[360px] web:outline-none web:overflow-visible web:max-w-none">
                <ModelPickerMenu
                  currentModelId={currentModelId}
                  effectiveIsPro={effectiveIsPro}
                  onSelect={(modelId) => {
                    handleModelChange(modelId)
                    setModelPickerOpen(false)
                  }}
                />
              </PopoverContent>
            </Popover>

          </View>

          {/* Right side buttons */}
          {voiceInput.isRecording ? (
            <View className="flex-row items-center gap-2">
              <VoiceWaveform />
              <Pressable
                onPress={() => voiceInput.toggleRecording().catch(() => {})}
                role="button"
                accessibilityLabel="Stop voice recording"
                className="h-6 w-6 rounded-full bg-foreground/90 items-center justify-center active:opacity-70"
              >
                <Square className="text-background" size={10} fill="currentColor" />
              </Pressable>
            </View>
          ) : (
          <View className="flex-row items-center gap-1">
            {contextUsage && (
              <ContextTracker
                inputTokens={contextUsage.inputTokens}
                contextWindowTokens={contextUsage.contextWindowTokens}
              />
            )}

            <Pressable
              onPress={handleAttachClick}
              disabled={disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES}
              role="button"
              accessibilityLabel="Attach file"
              className="min-h-5 min-w-5 rounded-full items-center justify-center active:opacity-70"
              android_ripple={{ color: "rgba(128,128,128,0.25)" }}
            >
              <Plus
                className={cn(
                  "h-4 w-4",
                  disabled || isProcessingFiles || pendingFiles.length >= MAX_FILES
                    ? "text-muted-foreground/40"
                    : "text-muted-foreground"
                )}
                size={12}
              />
            </Pressable>

            {isStreaming ? (
              <>
                <Pressable
                  onPress={onStop}
                  accessibilityLabel="Stop"
                  testID="stop-streaming"
                  className="h-5 w-5 rounded-full bg-destructive items-center justify-center active:opacity-70"
                >
                  <Square
                    className="text-destructive-foreground m-auto"
                    size={10}
                  />
                </Pressable>
                {(inputValue.trim() || pendingFiles.length > 0 || pastedTexts.length > 0) && (
                  <Pressable
                    onPress={handleSubmit}
                    disabled={disabled || isProcessingFiles}
                    role="button"
                    accessibilityLabel="Queue message"
                    className="h-5 w-5 rounded-full items-center justify-center bg-primary"
                  >
                    <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
                  </Pressable>
                )}
              </>
            ) : (inputValue.trim() || pendingFiles.length > 0 || pastedTexts.length > 0 || references.length > 0) ? (
              <Pressable
                onPress={handleSubmit}
                disabled={disabled || isProcessingFiles}
                role="button"
                accessibilityLabel="Send message"
                className={cn(
                  "h-5 w-5 rounded-full items-center justify-center bg-primary",
                  (disabled || isProcessingFiles) && "opacity-50"
                )}
              >
                <ArrowUp className="h-3 w-3 text-primary-foreground" size={12} />
              </Pressable>
            ) : voiceInput.canRecord ? (
              <Pressable
                onPress={() => {
                  voiceInput.clearError()
                  voiceInput.toggleRecording().catch(() => {})
                }}
                disabled={disabled || isProcessingFiles}
                role="button"
                accessibilityLabel="Start voice recording"
                className="h-5 w-5 rounded-full items-center justify-center active:opacity-70"
              >
                <Mic
                  className={cn(
                    "h-4 w-4",
                    disabled || isProcessingFiles
                      ? "text-muted-foreground/40"
                      : "text-muted-foreground"
                  )}
                  size={14}
                />
              </Pressable>
            ) : null}
          </View>
          )}
        </View>
        </View>
      </View>

      <VideoPreviewModal
        visible={previewVideoFile !== null}
        onClose={() => setPreviewVideoFile(null)}
        url={previewVideoFile?.url ?? ""}
        title={previewVideoFile?.name ?? "Video preview"}
      />

      {viewingPasted && (
        <FileViewerModal
          visible={viewingPastedId !== null}
          onClose={() => setViewingPastedId(null)}
          content={viewingPasted.content}
          title={`${kindLabel(viewingPasted.info.kind)} content`}
          kind={viewingPasted.info.kind}
          sizeLabel={viewingPasted.info.sizeLabel}
          editable
          onSave={(next) => handleUpdatePastedText(viewingPasted.id, next)}
        />
      )}

      {Platform.OS !== "web" && (
        <AttachSourceSheet
          open={attachSheetOpen}
          onOpenChange={setAttachSheetOpen}
          currentCount={pendingFiles.length}
          maxFiles={MAX_FILES}
          maxFileSizeBytes={MAX_FILE_SIZE}
          onFiles={(picked) => {
            setPendingFiles((prev) => {
              const room = MAX_FILES - prev.length
              if (room <= 0) return prev
              const added = picked.slice(0, room).map((f) => ({
                id: f.id,
                dataUrl: f.dataUrl,
                name: f.name,
                type: f.type,
                size: f.size,
              }))
              if (picked.length > room) {
                setFileError(`Maximum ${MAX_FILES} files allowed`)
              } else {
                setFileError(null)
              }
              return [...prev, ...added]
            })
          }}
          onError={(message) => setFileError(message)}
        />
      )}
    </View>
  )
}

/**
 * Memoized so ChatPanel re-renders driven by streaming-token state
 * (token-level message updates, MobX reactions, scroll handlers, etc.)
 * don't re-run the entire input subtree on every commit. The default
 * shallow comparison is sufficient as long as callers pass stable
 * callbacks (`useCallback`) and stable arrays (`useMemo`) — defaulted
 * primitive props are compared by value, and inline arrows would defeat
 * memo if any reappear.
 */
export const ChatInput = memo(ChatInputImpl)

export default ChatInput
