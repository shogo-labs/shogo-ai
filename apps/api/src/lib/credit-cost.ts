/**
 * Credit Cost Calculator
 *
 * Shared module for computing credit costs from token usage.
 * Used by both the AI chat endpoint and the AI proxy.
 *
 * Pricing is based on Anthropic's model costs:
 * - Haiku: ~$0.80/$4 per 1M tokens (input/output) - cheapest
 * - Sonnet: ~$3/$15 per 1M tokens (input/output) - 4x more than Haiku
 * - Opus: ~$15/$75 per 1M tokens (input/output) - 5x more than Sonnet
 *
 * Credit rates (per 5000 tokens):
 * - Haiku (basic): 0.025 credits
 * - Sonnet (advanced): 0.1 credits
 * - Opus: 0.5 credits
 *
 * Minimum charges:
 * - Haiku (basic): 0.2 credits
 * - Sonnet (advanced): 0.5 credits
 * - Opus: 1.0 credits
 */

export const MODEL_CREDIT_CONFIG = {
  haiku: {
    creditsPerTokenBatch: 0.025,
    tokenBatchSize: 5000,
    minimumCharge: 0.2,
  },
  sonnet: {
    creditsPerTokenBatch: 0.1,
    tokenBatchSize: 5000,
    minimumCharge: 0.5,
  },
  opus: {
    creditsPerTokenBatch: 0.5,
    tokenBatchSize: 5000,
    minimumCharge: 1.0,
  },
} as const

export type ModelName = keyof typeof MODEL_CREDIT_CONFIG
export type AgentMode = 'basic' | 'advanced'

/**
 * Map agent mode to model name for credit calculation.
 */
export function agentModeToModel(agentMode?: AgentMode): ModelName {
  if (agentMode === 'basic') return 'haiku'
  return 'sonnet' // default for 'advanced' or undefined
}

/**
 * Map a proxy model string (e.g. "claude-sonnet", "claude-haiku-4-5") to a billing ModelName.
 */
export function proxyModelToBillingModel(proxyModel: string): ModelName {
  const lower = proxyModel.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('haiku')) return 'haiku'
  // Default to sonnet for any sonnet variant or unknown models
  return 'sonnet'
}

/**
 * Calculate credit cost based on total tokens consumed and model used.
 *
 * @param totalTokens - Combined input + output tokens
 * @param modelOrAgentMode - Model name ('haiku', 'sonnet', 'opus') or agent mode ('basic', 'advanced')
 * @returns Credits to charge (with model-specific minimum)
 */
export function calculateCreditCost(
  totalTokens: number,
  modelOrAgentMode?: ModelName | AgentMode
): number {
  // Determine the model from input
  let model: ModelName = 'sonnet' // default
  if (modelOrAgentMode === 'basic' || modelOrAgentMode === 'advanced') {
    model = agentModeToModel(modelOrAgentMode as AgentMode)
  } else if (modelOrAgentMode && modelOrAgentMode in MODEL_CREDIT_CONFIG) {
    model = modelOrAgentMode as ModelName
  }

  const config = MODEL_CREDIT_CONFIG[model]

  // Calculate raw credits based on tokens
  const rawCredits = (totalTokens / config.tokenBatchSize) * config.creditsPerTokenBatch

  // Round up to nearest 0.1
  const rounded = Math.ceil(rawCredits * 10) / 10

  // Enforce model-specific minimum
  return Math.max(rounded, config.minimumCharge)
}
