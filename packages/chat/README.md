# @shogo-ai/chat

First-class Shogo chat for React apps and script-tag embeds.

```bash
bun add @shogo-ai/chat
```

## React

```tsx
import { ChatLauncher } from '@shogo-ai/chat/react'
import { createChatClient } from '@shogo-ai/chat'

const client = createChatClient({
  apiUrl: 'https://api.shogo.ai',
  projectId: 'proj_123',
  publishableKey: 'shogo_pk_...',
  transport: 'persona',
})

export function SupportChat() {
  return <ChatLauncher client={client} title="Ask Shogo" />
}
```

For a full-page surface, render `<ChatPage client={client} />` in a container
with an explicit height. The React surface and hosted iframe both use the
shared `@shogo/chat-ui` turn renderer.

Use `transport: 'runtime'` for the live agent runtime, tools, and durable
conversation memory. Runtime chat uses the same WebChat channel as the hosted
script embed.

## Script tag

```html
<script
  src="https://api.shogo.ai/embed/v1/chat.js"
  data-project-id="proj_123"
  data-publishable-key="shogo_pk_..."
  data-transport="runtime"
></script>
```

Publishable keys are project-scoped and origin-allowlisted. Never put a
`shogo_sk_*` secret key in browser code.
