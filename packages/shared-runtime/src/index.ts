// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export {
  initializeS3Sync,
  createS3SyncFromEnv,
  createS3SyncForProject,
  extractTarFastNonBlocking,
  S3Sync,
  type S3SyncConfig,
  type SyncStats,
} from './s3-sync'

export {
  createWorkspaceRootSync,
  conflictPathFor,
  isSharedRootPath,
  sha256Of,
  type WorkspaceRootFile,
  type WorkspaceRootManifest,
  type WorkspaceRootPresignRequest,
  type WorkspaceRootPresignResult,
  type WorkspaceRootSync,
  type WorkspaceRootSyncOptions,
  type WorkspaceRootSyncStats,
  type WorkspaceRootTransport,
} from './workspace-root-sync'

export {
  WORKSPACE_ROOT_SECRETS_VERSION,
  WORKSPACE_ROOT_SECRETS_MAX_BYTES,
  WORKSPACE_ROOT_SECRETS_MAX_PAYLOAD_BYTES,
  WORKSPACE_ROOT_SECRETS_MAX_FILES,
  WORKSPACE_ROOT_SECRETS_MAX_SLOTS,
  WORKSPACE_ROOT_SECRET_MAX_FILE_BYTES,
  WORKSPACE_SECRET_SLOT_ROOT,
  applyWorkspaceSecretSlot,
  collectWorkspaceSecretSlot,
  emptyWorkspaceRootSecrets,
  flushWorkspaceRootSecrets,
  isWorkspaceSecretFile,
  isWorkspaceSecretSlot,
  restoreWorkspaceRootSecrets,
  staleWorkspaceSecretNames,
  validateWorkspaceRootSecrets,
  workspaceRuntimeKey,
  workspaceSecretsTag,
  type WorkspaceRootSecrets,
  type WorkspaceRootSecretsTransport,
  type WorkspaceSecretFile,
  type WorkspaceSecretSlot,
} from './workspace-root-secrets'

export {
  ZERNIO_SOCIAL_TOOLKITS,
  isZernioSocialToolkit,
  normalizeToolkitName,
  zernioPlatformsFromQuery,
  type ZernioSocialToolkit,
} from './social-providers'

export {
  CAPABILITY_INFO,
  CAPABILITY_KEYS,
  mergeCapabilitySettingsIntoConfig,
  normalizeCapabilitySettings,
  type CapabilityKey,
  type CapabilitySettings,
} from './capability-settings'

export {
  CO_AUTHOR_TRAILER_KEY,
  DEFAULT_SHOGO_AGENT_EMAIL,
  DEFAULT_SHOGO_AGENT_NAME,
  SHOGO_PR_FOOTER_MARKER,
  agentIdentityFromConfig,
  getShogoAgentEmail,
  getShogoAgentName,
  inspectAgentAttribution,
  isCanonicalShogoAgentIdentity,
  isShogoAgentEmail,
  isShogoAgentIdentity,
  normalizeAgentAttribution,
  shogoCoAuthorTrailer,
  shogoPrFooter,
  withShogoCommitTrailer,
  withShogoPrFooter,
  type AgentIdentity,
  type AttributionReport,
  type NormalizeAttributionOptions,
} from './agent-attribution'

export {
  PublishedDataSync,
  createPublishedDataSyncFromEnv,
  type PublishedDataSyncConfig,
} from './published-data-sync'

export {
  GitWorkspaceSync,
  createGitSyncFromEnv,
  resolveCloudSyncMode,
  unindexablePath,
  type GitWorkspaceSyncConfig,
  type SpawnGitFn,
  type SyncParkInfo,
  type CheckpointResult,
  type CloudSyncMode,
} from './git-sync'

export { isWindowsReservedPath, findReservedPaths } from './git-reserved-names'

export {
  applyGitSafeDirectoryEnv,
  checkGitUsable,
  DUBIOUS_OWNERSHIP_RE,
  type GitUsability,
} from './git-safe-dir'

export {
  ensureWorkspaceRepo,
  type EnsureWorkspaceRepoConfig,
  type EnsureWorkspaceRepoResult,
} from './git-bootstrap'

export { wrapSseStreamWithKeepalive } from './sse-keepalive'

export {
  WorktreeManager,
  WORKTREE_BRANCH_PREFIX,
  WORKTREE_DIR_NAME,
  type WorktreeManagerConfig,
  type WorktreeInfo,
  type WorktreeStatus,
  type MergeResult,
  type MergeOutcome,
} from './git-worktree'

export {
  persistRepoToStore,
  packRepoArchive,
  restoreRepoFromStore,
  seedRepoIfAbsent,
  ensureWorkspaceGitignore,
  untrackDependencyDirs,
  DEFAULT_WORKSPACE_GITIGNORE,
  createTagLocal,
  deleteTagLocal,
  getHeadSha,
  adoptHydratedRepo,
  adoptHydratedRepoBefore,
  AdoptDeadlineError,
  normalizeKeepPaths,
  repoExistsInStore,
  repoStoreConfigFromEnv,
  type AdoptRepoResult,
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
  lfsPushIncremental,
  lfsObjectsInRange,
  lfsRemoteHasObjects,
  pushLfsObjectIds,
  classifyLfsFailure,
  parseLfsPointer,
  hasLocalLfsObject,
  localLfsObjectPath,
  LfsPushError,
  LfsPushRunner,
  LFS_PUSH_CHUNK,
  type LfsFailureReason,
  type LfsMissingObject,
  type LfsObjectRef,
  type LfsPushJob,
  type LfsPushProgress,
  type LfsPushResult,
  lfsPull,
  lfsRemoteConfigFromEnv,
  migrateOffloadedAssetsToLfs,
  DEFAULT_LFS_EXTENSIONS,
  DEFAULT_LFS_BUDGET_GB,
  lfsBudgetBytes,
  lfsOverBudget,
  lfsPushedTips,
  evictLfsOverBudget,
  type LfsEvictionResult,
  lfsStats,
  resetLfsStats,
  type LfsStats,
  withLfsLock,
  listLocalLfsObjects,
  lfsStoreBytes,
  lfsObjectsDir,
  headLfsObjectIds,
  readManagedAttributePaths,
  type LfsRemoteConfig,
  lfsTrackedPaths,
  lfsPointerText,
  findLfsPointerFiles,
  materializeLfsPointersFromStore,
  lfsObjectStoreFromEnv,
  openLfsObjectStream,
  etagMatches,
  type LfsObjectStore,
  type LfsPointerFile,
  type LfsMaterializeResult,
  type LfsObjectReadResult,
} from './lfs'

export {
  S3_MULTIPART_THRESHOLD_BYTES,
  S3_MULTIPART_PART_BYTES,
  objectExists,
  putFileToObjectStore,
  headObject,
  stampObjectMetadata,
  isObjectNotFound,
  type S3ObjectStore,
} from './s3-object'

export {
  isShogoRuntimeState,
  isShogoStatePath,
  isShogoRuntimeSubtree,
  SHOGO_RUNTIME_SUBTREES,
  toPosixPath,
  directorySizeBytes,
  resolveGitDir,
  evictStaleGitLock,
  isRepoIdle,
  isRepairInProgress,
  acquireRepairLock,
  buildShogoExcludeBlock,
  buildShogoGitHubExcludeBlock,
  ensureShogoExcludes,
  ensureShogoGitHubExcludes,
  untrackShogoStatePaths,
  prepareCheckpointRepo,
  stripShogoLfsRules,
  SHOGO_MEMORY_HISTORY_PREFIX,
  SHOGO_EXCLUDE_HEADER,
  SHOGO_EXCLUDE_FOOTER,
  SHOGO_EXCLUDE_LINES,
  SHOGO_GITHUB_EXCLUDE_HEADER,
  SHOGO_GITHUB_EXCLUDE_FOOTER,
  SHOGO_GITHUB_EXCLUDE_LINES,
  type UntrackResult,
} from './shogo-state-paths'

export {
  repairCheckpointRepo,
  readRepairMarker,
  repairedBytes,
  filterExportStream,
  parseMarks,
  type RepairOptions,
  type RepairResult,
} from './checkpoint-repo-repair'

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
  assertStandaloneEnv,
  isInKubernetes,
  isStandalone,
  isTruthyEnv,
  logNoApiUrlOnce,
  logStandaloneOnce,
  parseAgentModelPin,
  pinnedAgentModel,
  resolveApiUrl,
  StandaloneConfigError,
  type AgentModelPin,
} from './standalone'

export {
  createRuntimeApp,
  type RuntimeAppConfig,
  type RuntimeState,
  type RuntimeApp,
} from './server-framework'

export {
  notifyProxyAuthFailure,
  startTokenRefreshLoop,
  type TokenRefreshHandle,
  type TokenRefreshOptions,
} from './token-refresh'

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
  isDockerTechStack,
  getMinimumInstanceSize,
  getDeclaredPorts,
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
  encodeTurnCompleteFrame,
  TURN_COMPLETE_EVENT_TYPE,
  type StreamBufferWriter,
  type TurnCompleteFrameData,
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
  isContentHashedFilename,
  sharedStaticAssetCacheControl,
  staticAssetCacheControl,
  shouldServeSpaFallback,
} from './static-asset-cache'

export {
  BINARY_FILE_EXTENSIONS,
  isBinaryBuffer,
  isBinaryFilePath,
} from './file-types'

export {
  recordBuildError,
  getBuildErrors,
  clearBuildErrors,
  _resetBuildBufferForTests,
  type BuildErrorEntry,
} from './diagnostics-build-buffer'

export {
  publishedDbName,
  publishedDbSecretName,
  toPublishedDatabaseUrl,
  assertPublishedDatabaseUrl,
  PUBLISHED_DB_CONNECTION_LIMIT,
  parseSchema,
  classifySchemaChange,
  describeDestructiveChanges,
  type PublishedEnvironmentName,
  type SchemaField,
  type ParsedSchema,
  type DestructiveChange,
} from './published-database'

export {
  buildPublishSchema,
  publishedSchemaHash,
  parseModelTables,
  parseSeedRelations,
  parseSerialIdColumns,
  orderSeedTables,
  quoteIdent,
  quoteLiteral,
  buildSeedSql,
  countSeedRows,
  dropOrphanedSeedRows,
  PublishSchemaError,
  type PublishSchema,
  type SeedOrphan,
  type SeedRelation,
  type SeedTableData,
} from './published-schema'

export {
  parseByteRange,
  fileRangeResponse,
  type ParsedByteRange,
  type SliceableFile,
  type FileRangeResponseOptions,
} from './byte-range'

export {
  publishedImageRepository,
  publishedImageRepositoryOf,
  publishedImageTag,
  publishedImageCommitTag,
  publishedImageTagRef,
  publishedImageDigestRef,
  isDigestPinnedImageRef,
  digestOfImageRef,
} from './published-image-ref'

export {
  WHATSAPP_GRAPH_VERSION,
  WHATSAPP_API_BASE,
  verifyMetaSignature,
} from './whatsapp-graph'
