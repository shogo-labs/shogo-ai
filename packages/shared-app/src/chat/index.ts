// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
export {
  extractTextContent,
  formatErrorMessage,
  isTunnelDisconnectError,
  formatToolName,
  getToolCategory,
  ERROR_CODE_MESSAGES,
} from './message-helpers'

export {
  buildChatStreamErrorReport,
  classifyChatError,
  shouldReportChatError,
  chatErrorMessage,
  SHOGO_TELEMETRY_TAG,
  type ChatErrorClass,
  type ChatErrorContext,
  type ChatErrorReport,
} from './chat-error-telemetry'

export {
  useChatTransportConfig,
  buildChatApiUrl,
  buildChatTurnUrl,
  type ChatTransportOptions,
  type ChatTransportConfig,
} from './useChatTransport'

export {
  createAutoResumingFetch,
  defaultBuildResumeUrl,
  type AutoResumingFetchOptions,
} from './auto-resuming-fetch'

export {
  useRemoteChatTransportConfig,
  buildRemoteChatApiUrl,
  type RemoteChatTransportOptions,
} from './useRemoteChatTransport'

export {
  truncateMessagesFrom,
  getPrecedingCheckpoint,
  rollbackProjectToCheckpoint,
  SHOGO_FILES_REVERTED_EVENT,
  type TruncateFromResult,
  type PrecedingCheckpoint,
  type PrecedingCheckpointReason,
  type PrecedingCheckpointResult,
  type RollbackResult,
  type FilesRevertedDetail,
} from './message-edit-api'
