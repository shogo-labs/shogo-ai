# Shogo AI Chat

An AI chatbot example built with the Shogo SDK, featuring a modern chat interface powered by the AI SDK and Anthropic models via the Shogo AI Proxy.

## Features

- **Vite + React** SPA with Hono API server
- [AI SDK v6](https://ai-sdk.dev/docs/introduction) for streaming chat completions
- [shadcn/ui](https://ui.shadcn.com) components with [Tailwind CSS](https://tailwindcss.com)
- [Radix UI](https://radix-ui.com) primitives for accessibility
- **Shogo AI Proxy** for secure model access (no API keys exposed to the client)
- **Prisma** + PostgreSQL for chat history and user data
- Dark/light mode support via `next-themes`
- Model selector with multiple Anthropic Claude models

## Running Locally

1. Make sure Docker infrastructure is running (`bun run docker:infra` from repo root)
2. Copy `.env.example` to `.env` and configure:

```bash
DATABASE_URL="postgresql://project:project_dev@localhost:5433/ai_chat"
AI_PROXY_URL=http://localhost:8002/api/ai/v1
AI_PROXY_TOKEN=<your-proxy-token>
```

3. Install dependencies and set up the database:

```bash
bun install
bun run db:push
```

4. Start the development server:

```bash
bun run dev
```

Your app should now be running at [http://localhost:3001](http://localhost:3001).

## Architecture

- `server.tsx` - Hono API server with AI streaming endpoint
- `src/App.tsx` - Root React component with auth + chat orchestration
- `src/components/chat.tsx` - Main chat component (AI SDK v6 `useChat`)
- `src/components/app-sidebar.tsx` - Sidebar with chat history
- `src/components/multimodal-input.tsx` - Input with file attachments + model selector
- `src/components/messages.tsx` / `message.tsx` - Message rendering with markdown
- `src/lib/ai/models.ts` - Available AI models configuration
