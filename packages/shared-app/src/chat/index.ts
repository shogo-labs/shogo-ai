// SPDX-License-Identifier: AGPL-3.0-or-later
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
  useChatTransportConfig,
  buildChatApiUrl,
  type ChatTransportOptions,
  type ChatTransportConfig,
} from './useChatTransport'

export {
  useRemoteChatTransportConfig,
  buildRemoteChatApiUrl,
  type RemoteChatTransportOptions,
} from './useRemoteChatTransport'

export {
  fetchActiveTurns,
  fetchTurnStatus,
  postTurnResume,
  buildTurnStreamResumeUrl,
  useActiveTurn,
  type TurnMetaLike,
  type TurnCheckpointLike,
  type TurnStatusResult,
  type ResumeDecision,
} from './useTurnResume'
