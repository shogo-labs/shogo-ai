---
title: React quickstart
sidebar_position: 2
---

# React quickstart

Install the chat package:

```bash
bun add @shogo-ai/chat
```

Create a project-scoped publishable key with the exact origins where the
component will run:

```bash
SHOGO_API_KEY=shogo_sk_... \
shogo keys create --publishable --project proj_123 \
  --origins https://www.example.com
```

Render an Intercom-style launcher:

```tsx
import { createChatClient } from '@shogo-ai/chat'
import { ChatLauncher } from '@shogo-ai/chat/react'

const client = createChatClient({
  apiUrl: 'https://api.shogo.ai',
  projectId: 'proj_123',
  publishableKey: import.meta.env.VITE_SHOGO_PUBLISHABLE_KEY,
})

export default function App() {
  return <ChatLauncher client={client} title="Chat with us" />
}
```

For a full-page route, render `<ChatPage client={client} />` inside a
flex container with an explicit height. Use `transport: 'runtime'` for the
live agent and its tools; the default `persona` transport is the lightweight
ProjectAgent path.
