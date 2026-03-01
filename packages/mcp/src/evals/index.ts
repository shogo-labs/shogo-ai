/**
 * Agent Evaluation Framework
 *
 * A comprehensive framework for testing and optimizing the Shogo agent.
 *
 * @module evals
 *
 * @example
 * ```typescript
 * import {
 *   runEvalSuite,
 *   formatEvalReport,
 *   ALL_EVALS,
 *   TEMPLATE_SELECTION_EVALS,
 * } from '@shogo/mcp/evals'
 *
 * // Run all evals
 * const results = await runEvalSuite('Full Suite', ALL_EVALS, {
 *   verbose: true,
 * })
 *
 * // Print report
 * console.log(formatEvalReport(results))
 * ```
 *
 * @example
 * ```typescript
 * // Run integration tests against live agent
 * import { runIntegrationEval, establishBaseline } from '@shogo/mcp/evals'
 *
 * // First time: establish baseline
 * await establishBaseline('http://localhost:3002/api/chat')
 *
 * // After prompt changes: run and compare
 * const { results, comparison } = await runIntegrationEval({
 *   label: 'v2-prompt-update',
 *   compareBaseline: true,
 * })
 * ```
 */

// Types
export type {
  AgentEval,
  EvalCategory,
  ConversationTurn,
  ExpectedToolCall,
  ToolCall,
  ValidationCriterion,
  EvalResult,
  CriterionResult,
  EvalSuiteResult,
  CategorySummary,
  ToolCorrectnessScore,
  TemplateSelectionScore,
  AgentMetrics,
} from './types'

// Runner
export {
  runEval,
  runEvalSuite,
  formatEvalReport,
  type EvalRunnerConfig,
  type MockAgentResponse,
} from './runner'

// Validators
export {
  evaluateToolCorrectness,
  evaluateTemplateSelection,
  calculateParamSimilarity,
  extractSelectedTemplate,
  didAskClarification,
  mentionedFeatures,
  ranManualCommands,
  VALID_TEMPLATES,
  VALID_THEMES,
  THEME_MAPPINGS,
  TEMPLATE_SIMILARITY,
  // Pre-built criteria
  createTemplateSelectionCriterion,
  createNoClarificationCriterion,
  createToolUsageCriterion,
  createNoManualCommandsCriterion,
  createOfferedCustomizationCriterion,
  createErrorHandlingCriterion,
  // Runtime safety
  ranForbiddenRuntimeCommands,
  extractForbiddenCommands,
  FORBIDDEN_RUNTIME_COMMANDS,
  createNoForbiddenRuntimeCommandsCriterion,
  createExplainedAutoRebuildCriterion,
} from './validators'

// Metrics
export {
  loadMetricsHistory,
  saveMetricsHistory,
  calculateMetrics,
  createSnapshot,
  recordSnapshot,
  compareSnapshots,
  formatComparisonReport,
  getLatestSnapshot,
  getBaselineSnapshot,
  formatMetricsTable,
  type MetricsSnapshot,
  type MetricsHistory,
  type MetricsComparison,
} from './metrics'

// Integration Runner
export {
  runIntegrationEval,
  runSmokeTest,
  establishBaseline,
  checkAgentHealth,
  type IntegrationRunConfig,
} from './integration-runner'

// Test Cases
export {
  // Individual evals
  EVAL_TODO_DIRECT,
  EVAL_EXPENSE_DIRECT,
  EVAL_CRM_DIRECT,
  EVAL_KANBAN_DIRECT,
  EVAL_SEMANTIC_ORGANIZE,
  EVAL_SEMANTIC_MONEY,
  EVAL_SEMANTIC_CLIENTS,
  EVAL_AMBIGUOUS_TEAM,
  EVAL_AMBIGUOUS_TRACK,
  EVAL_PARAMS_WITH_NAME,
  EVAL_PARAMS_WITH_THEME,
  EVAL_ERROR_INVALID_TEMPLATE,
  EVAL_EDGE_TODO_VS_KANBAN,
  // Collections
  ALL_EVALS,
  TEMPLATE_SELECTION_EVALS,
  TOOL_USAGE_EVALS,
  EDGE_CASE_EVALS,
} from './test-cases'

// Extended Test Cases
export {
  EVAL_INVENTORY_DIRECT,
  EVAL_AI_CHAT_DIRECT,
  EVAL_FORM_BUILDER_DIRECT,
  EVAL_FEEDBACK_FORM_DIRECT,
  EVAL_BOOKING_APP_DIRECT,
  EVAL_SEMANTIC_VISUAL_WORKFLOW,
  EVAL_SEMANTIC_WAREHOUSE,
  EVAL_SEMANTIC_SCHEDULE_MEETINGS,
  EVAL_THEME_BLUE,
  EVAL_THEME_DEFAULT_EXPLICIT,
  EVAL_LIST_TEMPLATES,
  EVAL_SEARCH_TEMPLATES,
  EVAL_EDGE_EXPENSE_VS_INVENTORY,
  EVAL_EDGE_CRM_VS_BOOKING,
  EVAL_EDGE_FORM_VS_FEEDBACK,
  EVAL_MULTITURN_REMEMBER_TEMPLATE,
  EVAL_MULTITURN_THEME_CHANGE,
  ALL_EXTENDED_EVALS,
  EXTENDED_TEMPLATE_EVALS,
  EXTENDED_SEMANTIC_EVALS,
  EXTENDED_TOOL_USAGE_EVALS,
  EXTENDED_EDGE_CASE_EVALS,
  EXTENDED_MULTI_TURN_EVALS,
} from './test-cases-extended'

// Business User Test Cases (harder tests for non-technical users)
export {
  ALL_BUSINESS_USER_EVALS,
  VAGUE_BUSINESS_LANGUAGE_EVALS,
  BUSINESS_LOGIC_CONFUSION_EVALS,
  MULTI_TURN_COHERENCE_EVALS,
  RELATIONSHIP_CHANGE_EVALS,
  GRACEFUL_DEGRADATION_EVALS,
  ERROR_RECOVERY_EVALS,
  CONDITIONAL_LOGIC_EVALS,
  MIGRATION_CONCERN_EVALS,
  FRAMEWORK_SPECIFIC_EVALS,
  LEVEL_4_BUSINESS_EVALS,
  LEVEL_5_BUSINESS_EVALS,
  LEVEL_6_BUSINESS_EVALS,
} from './test-cases-business-user'

// API Client Usage Evals (prefer api.* over raw fetch)
export {
  ALL_API_CLIENT_EVALS,
  API_CLIENT_CRUD_EVALS,
  API_CLIENT_MIXED_EVALS,
  EVAL_API_CLIENT_TODO_CRUD,
  EVAL_API_CLIENT_CRM_MIXED,
  EVAL_API_CLIENT_ADD_DELETE,
  EVAL_API_CLIENT_EXPENSE,
  EVAL_API_CLIENT_CUSTOM_ENDPOINT_OK,
  EVAL_API_CLIENT_INVENTORY,
} from './test-cases-api-client'

// Runtime Safety Test Cases
export {
  RUNTIME_SAFETY_EVALS,
  EVAL_RESTART_VITE,
  EVAL_RUN_BUILD,
  EVAL_START_DEV_SERVER,
  EVAL_CHANGES_NOT_SHOWING,
  EVAL_PREVIEW_BROKEN,
} from './test-cases-runtime-safety'

// shadcn/UI Component Usage Test Cases
export {
  ALL_SHADCN_EVALS,
  SHADCN_COMPONENT_EVALS,
  SHADCN_IMPORT_EVALS,
} from './test-cases-shadcn'
