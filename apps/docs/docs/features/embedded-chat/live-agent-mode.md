---
title: Live agent mode
sidebar_position: 5
---

# Live agent mode

Use the runtime transport when the site should connect to the live agent
runtime instead of only the cloud ProjectAgent persona:

```ts
const client = createChatClient({
  apiUrl: 'https://api.shogo.ai',
  projectId: 'proj_123',
  publishableKey: 'shogo_pk_...',
  transport: 'runtime',
  visitor: { metadata: { plan: 'pro' } },
})
```

Runtime mode uses the WebChat channel for tools, memory, typing events,
history replay, and stop controls. Sessions are keyed by a stable visitor
identity and use sliding 24-hour browser tokens.

Connect and configure WebChat in Studio before deploying the runtime embed.
Cold starts can delay the first turn while the agent pod becomes ready.
Anonymous visitors cannot use workspace-writing tools by default.
