/**
 * AI SDK Configuration
 * 
 * Uses OpenAI provider. Can be swapped for other providers.
 */

import { createOpenAI } from '@ai-sdk/openai'

// Create OpenAI provider instance
export const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
})

// Get the language model
export function getLanguageModel(modelId: string = 'gpt-4o-mini') {
  return openai(modelId)
}

// System prompt for the AI assistant
export const systemPrompt = `You are a helpful AI assistant built with the Vercel AI SDK and @shogo-ai/sdk.

You provide clear, concise, and accurate responses. When asked about code, provide well-formatted examples with explanations.

Be friendly and professional in your responses. If you don't know something, say so rather than making things up.`
