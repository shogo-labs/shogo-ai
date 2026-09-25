// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Detects whether an error from any supported LLM provider signals that the
 * request was rejected because the input was too long / exceeded the model's
 * context window.
 *
 * Providers vary widely in how they surface this condition:
 *   - HTTP 413 (standard)
 *   - Anthropic:  "prompt is too long", "request too large"
 *   - OpenAI:     "maximum context length", "context overflow"
 *   - AWS Bedrock: "Input is too long for requested model."
 *   - Google Vertex AI: "Request payload size exceeds the limit"
 *   - Cohere:     "total number of tokens must be at most N"
 *   - Generic:    "input length exceeds", "tokens exceed"
 */
export function isContextOverflowError(err: any): boolean {
  if (!err) return false
  const status = err.status ?? err.statusCode ?? err.code
  if (status === 413) return true
  const msg = String(err.message || err).slice(0, 512).toLowerCase()
  return (
    // Patterns that include the word "context" (existing)
    (msg.includes('context') && (msg.includes('overflow') || msg.includes('too long') || msg.includes('exceed')))
    // Anthropic / generic
    || msg.includes('prompt is too long')
    || msg.includes('maximum context length')
    || msg.includes('request too large')
    // AWS Bedrock: "Input is too long for requested model."
    || msg.includes('input is too long')
    // Google Vertex AI: "Request payload size exceeds the limit"
    || msg.includes('payload size exceeds')
    // Cohere: "total number of tokens must be at most N"
    || msg.includes('total number of tokens must be at most')
    // Generic: "input length exceeds model limit"
    || msg.includes('input length exceeds')
    // Generic token count overflow without "context" keyword
    || (msg.includes('tokens') && msg.includes('exceed') && !msg.includes('rate'))
  )
}
