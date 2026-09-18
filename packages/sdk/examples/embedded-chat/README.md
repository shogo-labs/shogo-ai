# Embedded chat example

This directory contains a small Vite/React example and a framework-free
script-tag example. Set the `VITE_SHOGO_*` variables before starting the
development server.

```tsx
import { createChatClient } from '@shogo-ai/chat'
import { ChatPage } from '@shogo-ai/chat/react'

const client = createChatClient({
  apiUrl: import.meta.env.VITE_SHOGO_API_URL,
  projectId: import.meta.env.VITE_SHOGO_PROJECT_ID,
  publishableKey: import.meta.env.VITE_SHOGO_PUBLISHABLE_KEY,
  transport: 'runtime',
})

export function App() {
  return <ChatPage client={client} />
}
```
