// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
export {
  initializeS3Sync,
  createS3SyncFromEnv,
  S3Sync,
  type S3SyncConfig,
  type SyncStats,
} from './s3-sync'

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
  buildClaudeCodeEnv,
  type AIProxyConfig,
} from './ai-proxy'

export {
  createSessionManager,
  type ModelTier,
  type V2SessionOptions,
  type SessionManagerOptions,
  type SessionManager,
} from './sdk-session'

export {
  streamSdkToUI,
  type UIMessageStreamWriter,
  type StreamSdkToUIOptions,
} from './sdk-stream'

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
  TSLanguageServer,
  LSPServerManager,
  lspManager,
  WorkspaceLSPManager,
  type LSPMessage,
  type LSPDiagnostic,
  type TSLanguageServerOptions,
  type WorkspaceLSPManagerOptions,
} from './lsp-service'

export {
  PlatformPackageManager,
  pkg,
  type PkgInstallOptions,
  type PkgExecOptions,
} from './platform-pkg'
