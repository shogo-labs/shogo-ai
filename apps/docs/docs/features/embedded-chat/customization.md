---
title: Customization
sidebar_position: 6
---

# Customization

React surfaces accept the same defaults as the WebChat channel:

```tsx
<ChatLauncher
  client={client}
  title="Ask our team"
  subtitle="Usually replies in a few minutes"
  primaryColor="#6366f1"
  position="bottom-right"
  suggestedPrompts={['What can you help with?', 'Talk to a person']}
  poweredBy
/>
```

The script loader exposes equivalent `data-*` attributes, including
`data-title`, `data-primary-color`, `data-theme`, and `data-mode`.
`window.ShogoChat.open()`, `.close()`, and `.toggle()` control the launcher.

Identify visitors without putting secrets in the page:

```js
window.ShogoChat.identify({
  name: 'Ada',
  email: 'ada@example.com',
  metadata: { plan: 'pro' },
})
```

The package emits status, message, tool-call, and error events through the
client API. Keep publishable keys restricted to the origins that need them.
