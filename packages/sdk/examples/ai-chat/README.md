# AI Chat

A full-featured AI chatbot application built with the Vercel AI SDK and @shogo-ai/sdk. This example demonstrates how to build a ChatGPT-like interface with conversation history, streaming responses, and user authentication.

**Adapted from [Vercel AI Chatbot](https://github.com/vercel/ai-chatbot)** - converted from Next.js to TanStack Start + Vite + Bun.

## Features

- 🤖 **AI-powered chat** using OpenAI GPT models via Vercel AI SDK
- 💬 **Conversation history** with persistent chat storage
- 🔐 **User authentication** with email-based login
- 📝 **Multiple chats** with sidebar navigation
- ⚡ **Real-time responses** with loading states
- 🎨 **Dark theme UI** with responsive design
- 🗃️ **SQLite database** with Prisma ORM

## Quick Start

```bash
# Install dependencies
bun install

# Generate Prisma client
bun run db:generate

# Push schema to database
bun run db:push

# Start development server
bun run dev
```

Open [http://localhost:3005](http://localhost:3005) in your browser.

## Configuration

### OpenAI API Key

To enable actual AI responses (instead of demo mode), create a `.env` file:

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
```

Without an API key, the app runs in "demo mode" and returns a message explaining how to configure it.

## Tech Stack

- **Runtime**: Bun
- **Framework**: TanStack Start + Vite
- **UI**: React with custom CSS (dark theme)
- **Database**: SQLite with Prisma
- **AI**: Vercel AI SDK with OpenAI
- **SDK**: @shogo-ai/sdk for database access

## Project Structure

```
ai-chat/
├── prisma/
│   └── schema.prisma      # Database schema (User, Chat, Message)
├── src/
│   ├── lib/
│   │   ├── ai.ts          # AI SDK configuration
│   │   └── shogo.ts       # @shogo-ai/sdk setup
│   ├── routes/
│   │   ├── __root.tsx     # Root layout with styles
│   │   └── index.tsx      # Main chat interface
│   └── utils/
│       ├── db.ts          # Prisma client
│       ├── user.ts        # User server functions
│       ├── chats.ts       # Chat server functions
│       ├── messages.ts    # Message server functions
│       └── ai.ts          # AI generation functions
├── tests/
│   └── e2e.test.ts        # Playwright E2E tests
└── package.json
```

## Database Schema

### User
- `id` - Unique identifier
- `email` - User email (unique)
- `password` - Optional password
- `createdAt` / `updatedAt` - Timestamps

### Chat
- `id` - Unique identifier
- `title` - Chat title (auto-generated from first message)
- `visibility` - "public" or "private"
- `userId` - Owner reference
- `createdAt` / `updatedAt` - Timestamps

### Message
- `id` - Unique identifier
- `role` - "user", "assistant", or "system"
- `content` - Message content
- `chatId` - Chat reference
- `createdAt` - Timestamp

## API / Server Functions

### User Functions
- `getCurrentUser()` - Get the current user
- `createUser({ email, password? })` - Create a new user
- `loginUser({ email, password? })` - Sign in or create user

### Chat Functions
- `getChats({ userId })` - List user's chats
- `getChat({ chatId, userId })` - Get chat with messages
- `createChat({ userId, title?, visibility? })` - Create new chat
- `updateChatTitle({ chatId, userId, title })` - Update title
- `deleteChat({ chatId, userId })` - Delete a chat

### Message Functions
- `getMessages({ chatId, userId })` - Get chat messages
- `saveMessage({ chatId, userId, role, content })` - Save a message
- `deleteMessage({ messageId, userId })` - Delete a message

### AI Functions
- `generateAIResponse({ messages, chatId, userId, model? })` - Generate AI response
- `quickChat({ message, history? })` - Simple chat without persistence

## Running Tests

```bash
# Run E2E tests
bun run test

# Run with UI
bun run test:ui

# Run headed (see browser)
bun run test:headed
```

## Customization

### Changing the AI Model

Edit `src/lib/ai.ts` to change the default model:

```typescript
export function getLanguageModel(modelId: string = 'gpt-4') {
  return openai(modelId)
}
```

### Custom System Prompt

Edit the `systemPrompt` in `src/lib/ai.ts`:

```typescript
export const systemPrompt = `You are a helpful assistant specialized in...`
```

### Using Different Providers

The AI SDK supports multiple providers. To use Anthropic:

```typescript
import { createAnthropic } from '@ai-sdk/anthropic'

export const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export function getLanguageModel() {
  return anthropic('claude-3-sonnet-20240229')
}
```

## License

MIT - Based on [Vercel AI Chatbot](https://github.com/vercel/ai-chatbot)
