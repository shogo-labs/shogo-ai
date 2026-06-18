// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// @shogo/desktop-terminal — renderer-only desktop terminal pieces.
//
// Loaded LAZILY by apps/mobile/.../terminal/pty-factory.ts when
// `isDesktop()` is true. Mobile/web must never reach this package.
//
// IMPORTANT: this package may NOT be imported from mobile/web code
// paths. The only legal consumer is the pty-factory's `await import()`
// behind an `isDesktop()` runtime gate.

export const DESKTOP_TERMINAL_VERSION = '0.0.1-phase10'

export {
  ShogoTerminalSurface,
} from './renderer/ShogoTerminalSurface'
export type {
  ShogoTerminalSurfaceHandle,
  ShogoTerminalSurfaceProps,
  SurfacePtyClient,
} from './renderer/ShogoTerminalSurface'

export { isDesktop, getDesktopBridge } from './renderer/desktop-features'
export type {
  ShogoDesktopTerminalBridge,
  MessagePortLike,
} from './renderer/desktop-features'

export {
  DesktopPtyClient,
  createDesktopPtyClient,
  spawnDesktopPtyClient,
} from './renderer/desktop-pty-client'
export type {
  DesktopPtySpawnOptions,
  DesktopPtyClientOptions,
  PtyClientListeners,
  PtyClientState,
} from './renderer/desktop-pty-client'

// Phase 3 — OSC tracker
export { Osc633Tracker } from './renderer/osc633-tracker'
export type {
  Command,
  CommandState,
  CommandMarker,
  MarkerFactory,
  TrackerEvent,
  TrackerListener,
} from './renderer/osc633-tracker'

export {
  CommandNavigation,
  collectPromptAnchors,
  detectPlatform,
  findNextPromptLine,
  findPrevPromptLine,
  matchNavChord,
} from './renderer/command-navigation'
export type {
  CommandNavigationOptions,
  NavDirection,
  Platform,
  PromptAnchor,
  ScrollHost,
} from './renderer/command-navigation'

export {
  StickyScroll,
  computeStickyState,
  formatElapsed,
  useStickyScroll,
} from './renderer/sticky-scroll'
export type {
  StickyScrollProps,
  StickyState,
  UseStickyScrollOptions,
} from './renderer/sticky-scroll'

export {
  describeRunningSummary,
  getRunningSummary,
  installBeforeUnloadGuard,
} from './renderer/background-process-warn'
export type {
  RunningCommandReport,
  RunningSummary,
  RunningSummaryOptions,
  SessionLike,
  BeforeUnloadTarget,
} from './renderer/background-process-warn'

// Phase 5 — search, GPU, splits, profiles, write batcher
export {
  WriteBatcher,
  coalesceChunks,
} from './renderer/write-batcher'
export type {
  WriteBatcherOptions,
  WriteChunk,
  WriteSink,
} from './renderer/write-batcher'

export { GpuRenderer } from './renderer/gpu-renderer'
export type {
  GpuRendererOptions,
  RendererState,
  WebglAddonLike,
  WebglAddonFactory,
  XtermLike,
} from './renderer/gpu-renderer'

export {
  SearchController,
  SearchPopover,
  useSearch,
} from './renderer/search-popover'
export type {
  SearchAddonLike,
  SearchControllerOptions,
  SearchHits,
  SearchOptions,
  SearchPopoverProps,
  UseSearchValue,
} from './renderer/search-popover'

export {
  MIN_RATIO,
  SplitsLayout,
  clampRatio,
  closeLeaf,
  countLeaves,
  findLeaf,
  splitLeaf,
  updateRatio,
  walkLeaves,
} from './renderer/splits-layout'
export type {
  LeafNode,
  SplitDirection,
  SplitNode,
  SplitsLayoutProps,
  TreeNode,
} from './renderer/splits-layout'

export {
  SplitsHost,
  leafIdAtIndex,
  leafInDirection,
} from './renderer/splits-host'
export type {
  SplitsHostProps,
  SplitsController,
} from './renderer/splits-host'

export {
  DEFAULT_RESOLVER,
  MemoryKeyValueStore,
  ProfilesStore,
} from './renderer/profiles-store'
export type {
  DetectedShell,
  KeyValueStore,
  ProfilesDocument,
  ProfilesStoreOptions,
  ShellResolver,
  TerminalProfile,
} from './renderer/profiles-store'

// Phase 6 — links, drag-drop, recent pickers
export {
  CwdLinkProvider,
  findLinksInRow,
  isAbsolutePath,
  joinPath,
  resolveCwdAtRow,
  tokeniseRow,
} from './renderer/links/cwd-link-provider'
export type {
  CommandWithCwd,
  FindLinksOptions,
  LinkMatch,
  LinkProviderOptions,
  OpenFileTarget,
  TrackerCwdLookup,
} from './renderer/links/cwd-link-provider'

export {
  dropDataFromEvent,
  formatDropPaths,
  posixQuote,
  quotePaths,
} from './renderer/drag-drop-paste'
export type {
  DropData,
  DropFile,
  FormatDropResult,
} from './renderer/drag-drop-paste'

export {
  CommandHistorySource,
  DirectoryHistorySource,
  dedupe,
  fuzzyFilter,
  trackerAdapter,
} from './renderer/history/history-sources'
export type {
  CommandHistoryEntry,
  CommandHistoryOptions,
  DirectoryHistoryEntry,
  DirectoryHistoryOptions,
  ExtraDirsSource,
  HistoryReader,
  MinimalTracker,
  TrackerHistoryAdapter,
} from './renderer/history/history-sources'

export {
  RecentCommandPicker,
  RecentDirectoryPicker,
  pickerReducer,
  useCommandPicker,
  useDirectoryPicker,
} from './renderer/pickers/recent-pickers'
export type {
  CommandPickerHandle,
  DirectoryPickerHandle,
  PickerAction,
  PickerState,
  RecentCommandPickerProps,
  RecentDirectoryPickerProps,
  UseCommandPickerOptions,
  UseDirectoryPickerOptions,
} from './renderer/pickers/recent-pickers'

// Phase 10 — Settings + Telemetry
export {
  DEFAULT_SETTINGS,
  SettingsStore,
  SettingsValidationError,
  validateSettingsPatch,
} from './renderer/settings-store'
export type {
  ApprovalDefault,
  CursorStyle,
  RestorePolicy,
  SettingsStoreOptions,
  TerminalSettings,
  TerminalSettingsDocument,
} from './renderer/settings-store'

export {
  MemorySink,
  TelemetryEmitter,
  consoleSink,
  devTelemetry,
} from './renderer/telemetry'
export type {
  TelemetryEmitterOptions,
  TelemetryEnvelope,
  TelemetryEvent,
  TelemetrySink,
} from './renderer/telemetry'

// Phase 9 — Restore notification (renderer side of session persistence)
export {
  RestoreCoordinator,
  RestoreNotification,
  useRestoreNotification,
} from './renderer/restore-notification'
export type {
  RestoreClient,
  RestoreCoordinatorOptions,
  RestoreMode,
  RestoreNotificationProps,
  RestoreSnapshot,
  RestoreSnapshotInfo,
  RestoreState,
  SessionSnapshotSummary,
} from './renderer/restore-notification'

// Phase 8 — Cursor AI: ⌘K, Debug-with-AI, Approval
export {
  ApprovalStore,
  DESTRUCTIVE_DENIES,
  SAFE_DEFAULTS,
  workspaceHashOf,
} from './renderer/approval-store'
export type {
  ApprovalDecision,
  ApprovalDocument,
  ApprovalKind,
  ApprovalRule,
  ApprovalStoreOptions,
  ApprovalVerdict,
  EvaluatedRule,
} from './renderer/approval-store'

export {
  CmdKController,
  CmdKPopover,
  useCmdK,
} from './renderer/cmd-k-popover'
export type {
  CmdKControllerOptions,
  CmdKPopoverProps,
  CmdKSnapshot,
  CmdKState,
  LlmClient,
  LlmStreamContext,
  LlmStreamHandle,
  LlmStreamRequest,
} from './renderer/cmd-k-popover'

// Phase 7 — Quick Fix
export {
  BUILT_IN_RULES,
  QuickFixEngine,
  QuickFixManager,
  extractGitPathspec,
  extractMissingCommand,
  extractMissingModule,
  extractPort,
  tailLines,
} from './renderer/quick-fix'
export type {
  BufferReader,
  QuickFixAction,
  QuickFixActionKind,
  QuickFixClickEvent,
  QuickFixConfidence,
  QuickFixContext,
  QuickFixEngineOptions,
  QuickFixManagerOptions,
  QuickFixRule,
  QuickFixSuggestion,
} from './renderer/quick-fix'

export {
  BUILT_IN_MATCHERS,
  MatcherEngine,
} from './renderer/problem-matchers'
export type {
  ProblemMatcher,
  TerminalDiagnostic,
} from './renderer/problem-matchers'

// Context Aggregator — auto context injection for chat messages
// Lazy-loaded: only pulled in by terminalContextStore.enrichMessage()
export {
  ContextAggregator,
  serializeContext,
  formatContextMessage,
} from './renderer/context-aggregator'
export type {
  ActiveFileInfo,
  AggregatedContext,
  ContextAggregatorOptions,
  ContextSource,
  DiagnosticsContextSource,
  Diagnostic,
  EditorContextSource,
  GitContextSource,
  GitStatus,
} from './renderer/context-aggregator'

export {
  SnapshotStore,
  InMemorySnapshotStorage,
  captureScrollback,
  restoreScrollback,
} from './renderer/persistence/snapshot-store'
export type {
  Snapshot,
  SnapshotStorage,
  SnapshotStoreOptions,
} from './renderer/persistence/snapshot-store'

// Terminal Context — shared store bridging terminal ↔ chat (module singleton)
export {
  terminalContextStore,
} from './renderer/terminal-context-store'
export type {
  TerminalContextSnapshot,
  TerminalContextListener,
} from './renderer/terminal-context-store'

// Terminal ↔ chat bridging is provided solely by `terminalContextStore` above.
// (The former React-context variant was removed — a module singleton is the
// single source of truth so cross-tree consumers don't need a shared provider.)

// TerminalCommandExecutor — desktop-only, import directly from './renderer/terminal-command-executor'

// AgentTerminalFactory — desktop-only, import directly from './renderer/agent-terminal-factory'
// Not re-exported from barrel to avoid pulling pty-core into the Expo web bundle.

// OutputStreamer — desktop-only, import directly from './renderer/output-streamer'

// AgentTerminalPanel — desktop-only, import directly from './renderer/agent-terminal-panel'

export {
  DARK_PLUS_THEME,
  LIGHT_PLUS_THEME,
  useShogoTheme,
  resolveShogoTheme,
} from './renderer/use-shogo-theme'
export type {
  ThemeSource,
  XtermThemeColors,
  UseShogoThemeOptions,
  UseShogoThemeResult,
} from './renderer/use-shogo-theme'


// Add to Chat (Cmd+L)
export { AddToChatButton, dispatchAddToChat, onAddToChat, ADD_TO_CHAT_EVENT } from './renderer/add-to-chat-button'
export type { AddToChatButtonProps } from './renderer/add-to-chat-button'

// Terminal Selection (capture for Cmd+L)
export { captureTerminalText, formatTerminalContextForChat } from './renderer/terminal-selection'
export type { TerminalSelectionResult } from './renderer/terminal-selection'


// Command Classifier (short vs long heuristic)
export { classifyCommand, isShortCommand } from './renderer/command-classifier'
export type { CommandKind, ClassificationResult } from './renderer/command-classifier'

// Agent Terminal Tab (infinity icon, read-only, details)
export { AgentTerminalTab, InfinityIcon, AgentStatusBar } from './renderer/agent-terminal-tab'
export type { AgentTerminalInfo, AgentTerminalTabProps, AgentStatusBarProps } from './renderer/agent-terminal-tab'


// Ready Signal Detector
export { ReadySignalDetector } from './renderer/ready-signal-detector'
export type { ReadySignal, ReadySignalListener } from './renderer/ready-signal-detector'

// Background Task Manager
export { BackgroundTaskManager, backgroundTaskManager } from './renderer/background-task-manager'
export type { BackgroundTask, BackgroundTaskListener } from './renderer/background-task-manager'

// Background Terminal Indicator (chat UI)
export { BackgroundTerminalIndicator } from './renderer/background-terminal-indicator'
export type { BackgroundTerminalIndicatorProps } from './renderer/background-terminal-indicator'
