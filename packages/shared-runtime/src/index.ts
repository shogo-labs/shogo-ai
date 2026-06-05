// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export {
  initializeS3Sync,
  createS3SyncFromEnv,
  createS3SyncForProject,
  S3Sync,
  type S3SyncConfig,
  type SyncStats,
} from './s3-sync'

export {
  GitWorkspaceSync,
  createGitSyncFromEnv,
  resolveCloudSyncMode,
  type GitWorkspaceSyncConfig,
  type SpawnGitFn,
  type CloudSyncMode,
} from './git-sync'

export {
  ensureWorkspaceRepo,
  type EnsureWorkspaceRepoConfig,
  type EnsureWorkspaceRepoResult,
} from './git-bootstrap'

export {
  persistRepoToStore,
  restoreRepoFromStore,
  seedRepoIfAbsent,
  createTagLocal,
  deleteTagLocal,
  getHeadSha,
  repoExistsInStore,
  repoStoreConfigFromEnv,
  type RepoStoreConfig,
} from './repo-store'

export {
  gatherCommitMeta,
  type CommitMeta,
} from './checkpoint-record'

export {
  classifyLargeFiles,
  syncLargeFiles,
  restoreLargeFiles,
  largeFileThreshold,
  largeFileSyncConfigFromEnv,
  hasManagedExclude,
  clearManagedExclude,
  DEFAULT_LARGE_FILE_BYTES,
  type LargeFileSyncConfig,
} from './large-file-sync'

export {
  lfsKeyPrefix,
  isValidLfsOid,
  lfsObjectKey,
  buildLfsEndpointUrl,
  buildManagedAttributesBlock,
  writeManagedGitAttributes,
  ensureLfsRepoSetup,
  autoTrackLargeFiles,
  lfsPushAll,
  lfsPull,
  lfsRemoteConfigFromEnv,
  migrateOffloadedAssetsToLfs,
  DEFAULT_LFS_EXTENSIONS,
  type LfsRemoteConfig,
} from './lfs'

export {
  initializePostgresBackup,
  createPostgresBackupFromEnv,
  waitForPostgres,
  PostgresBackup,
  type PostgresBackupConfig,
} from './postgres-backup'

export {
  verifyPreviewToken,
  extractProjectIdFromToken,
  validatePreviewAccess,
  type PreviewTokenPayload,
} from './preview-token'

export {
  extractUserText,
  findLastUserMessage,
} from './chat-message'

export {
  configureAIProxy,
  type AIProxyConfig,
} from './ai-proxy'

export {
  initInstrumentation,
  shutdownInstrumentation,
  traceOperation,
  type InstrumentationConfig,
} from './instrumentation'

export {
  createLogger,
  type Logger,
  type LogLevel,
} from './logger'

export {
  sendMessage,
  sendMessages,
  sendMessageJSON,
  type Message as AIMessage,
  type SendMessageOptions,
  type MessageResponse,
} from './ai-client'

export {
  checkSelfAssign,
  type SelfAssignConfig,
} from './self-assign'

export {
  createRuntimeApp,
  type RuntimeAppConfig,
  type RuntimeState,
  type RuntimeApp,
} from './server-framework'

export {
  RUNTIME_CONFIG,
  buildRuntimeEnv,
  type RuntimeTypeConfig,
} from './runtime-types'

export {
  TECH_STACK_REGISTRY,
  getStackEntry,
  isMobileTechStack,
  usesMetroBundler,
  stackSeedsItself,
  type StackTarget,
  type StackRegistryEntry,
} from './tech-stack-registry'

export {
  TSLanguageServer,
  LSPServerManager,
  lspManager,
  WorkspaceLSPManager,
  resolveBin,
  type LSPMessage,
  type LSPDiagnostic,
  type TSLanguageServerOptions,
  type WorkspaceLSPManagerOptions,
} from './lsp-service'

export {
  PlatformPackageManager,
  pkg,
  isNodeAvailableOnWindows,
  isNodeAvailableOnUnix,
  resolveBinInvocation,
  _resetUnixNodeCache,
  type PkgInstallOptions,
  type PkgExecOptions,
} from './platform-pkg'

export {
  StreamBufferStore,
  createBufferingTransform,
  type StreamBufferWriter,
} from './stream-buffer'


export {
  diagnosticsRoutes,
  parseTscOutput,
  parseEslintOutput,
  _clearDiagnosticsCacheForTests,
  type Diagnostic,
  type DiagnosticSource,
  type DiagnosticSeverity,
  type DiagnosticsResult,
  type DiagnosticsRoutesConfig,
} from './diagnostics'

export {
  isMacOSJunkName,
  isMacOSJunkPath,
} from './macos-junk'

export {
  BINARY_FILE_EXTENSIONS,
  isBinaryFilePath,
} from './file-types'

export {
  recordBuildError,
  getBuildErrors,
  clearBuildErrors,
  _resetBuildBufferForTests,
  type BuildErrorEntry,
} from './diagnostics-build-buffer'
