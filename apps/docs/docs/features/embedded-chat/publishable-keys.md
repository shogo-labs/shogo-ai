---
title: Publishable keys
sidebar_position: 6
---

# Publishable keys

`shogo_pk_*` keys are the only Shogo credentials intended for anonymous
browser visitors. Each key is bound to one project and an origin allowlist.

Create one from the API:

```ts
await fetch('https://api.shogo.ai/api/api-keys', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${workspaceSecret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    kind: 'publishable',
    projectId: 'proj_123',
    allowedOrigins: ['https://www.example.com'],
  }),
})
```

The plaintext key is returned once. Revoke it from the Keys screen if it is
exposed outside the allowed site. Secret `shogo_sk_*` keys must remain
server-side.
