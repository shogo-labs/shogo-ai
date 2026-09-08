// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Turn Components Barrel Export (React Native)
 *
 * Exports all turn grouping components, hooks, and types.
 */

export { useTurnGrouping } from "./useTurnGrouping"
export { TurnList, type TurnListProps } from "./TurnList"
export { TurnGroup, type TurnGroupProps } from "./TurnGroup"
export { TurnHeader, type TurnHeaderProps } from "./TurnHeader"
export { MessageContent, type MessageContentProps } from "./MessageContent"
export { AssistantContent, type AssistantContentProps } from "./AssistantContent"
export { InlineToolWidget, type InlineToolWidgetProps } from "./InlineToolWidget"
export { ExecWidget, type ExecWidgetProps } from "./ExecWidget"
export { ToolCallGroup, type ToolCallGroupProps } from "./ToolCallGroup"
export { WorkGroup, type WorkGroupProps } from "./WorkGroup"
export { WorkedForGroup, type WorkedForGroupProps } from "./WorkedForGroup"
export { PlanningStatusLine } from "./PlanningStatusLine"
export {
  CollapsibleToolGroup,
  type CollapsibleToolGroupProps,
} from "./CollapsibleToolGroup"
export { TodoWidget, type TodoWidgetProps } from "./TodoWidget"
export {
  AskUserQuestionWidget,
  type AskUserQuestionWidgetProps,
  AskUserQuestionBar,
  type AskUserQuestionBarProps,
} from "./AskUserQuestionWidget"
export { type ConversationTurn, type TurnBoundary, type MessagePart, type GroupedMessagePart } from "./types"
export {
  groupWorkParts,
  partitionTurn,
  extractTurnTiming,
  formatWorkedDuration,
  formatRelativeTime,
  shouldShowPlanningStatus,
  type TurnPartition,
  type TurnTiming,
} from "./turnShaping"
export {
  TurnFooter,
  type TurnFooterProps,
} from "./TurnFooter"
export {
  TurnFooterProvider,
  useTurnFooterContext,
  type TurnFooterContextValue,
  type TurnFooterProviderProps,
  type MessageFeedbackThumbs,
} from "./TurnFooterContext"
export {
  summarizeWork,
  summarizeTurn,
  buildFallbackWorkedLabel,
  formatThoughtLabel,
  type WorkKind,
  type WorkTense,
  type WorkSummary,
  type WorkCounts,
} from "./workSummary"
