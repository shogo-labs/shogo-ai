/**
 * AI Server Functions
 * 
 * Uses the Vercel AI SDK for streaming responses.
 */

import { createServerFn } from '@tanstack/react-start'
import { streamText } from 'ai'
import { getLanguageModel, systemPrompt } from '../lib/ai'
import { shogo } from '../lib/shogo'

export type AIMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export const generateAIResponse = createServerFn({ method: 'POST' })
  .inputValidator((data: {
    messages: AIMessage[]
    chatId: string
    userId: string
    model?: string
  }) => data)
  .handler(async ({ data }) => {
    // Verify chat ownership
    const chat = await shogo.db.chat.findFirst({
      where: { id: data.chatId, userId: data.userId },
    })
    if (!chat) {
      throw new Error('Chat not found')
    }

    // Check for API key
    if (!process.env.OPENAI_API_KEY) {
      return {
        content: `**Demo Mode**

To enable AI responses, add your OpenAI API key:

1. Create a \`.env\` file in the ai-chat directory
2. Add: \`OPENAI_API_KEY=sk-your-key-here\`
3. Restart the dev server

Your message: "${data.messages[data.messages.length - 1]?.content || ''}"`,
      }
    }

    try {
      const result = await streamText({
        model: getLanguageModel(data.model),
        system: systemPrompt,
        messages: data.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      })

      // Collect full response
      let fullResponse = ''
      for await (const chunk of result.textStream) {
        fullResponse += chunk
      }

      return { content: fullResponse }
    } catch (error) {
      console.error('AI generation error:', error)
      throw new Error('Failed to generate AI response')
    }
  })

// Simple chat function for quick testing
export const quickChat = createServerFn({ method: 'POST' })
  .inputValidator((data: { message: string; history?: AIMessage[] }) => data)
  .handler(async ({ data }) => {
    if (!process.env.OPENAI_API_KEY) {
      return {
        content: `Demo mode - configure OPENAI_API_KEY for real responses. You said: "${data.message}"`,
      }
    }

    const messages: AIMessage[] = [
      ...(data.history || []),
      { role: 'user', content: data.message },
    ]

    try {
      const result = await streamText({
        model: getLanguageModel(),
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
      })

      let fullResponse = ''
      for await (const chunk of result.textStream) {
        fullResponse += chunk
      }

      return { content: fullResponse }
    } catch (error) {
      console.error('AI chat error:', error)
      throw new Error('Failed to generate response')
    }
  })
