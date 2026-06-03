---
title: API (OpenAI-compatible)
sidebar_position: 4
---

# Shogo API

Shogo exposes an **OpenAI-compatible REST API** so you can call Shogo models
from any OpenAI client library, your backend, or `curl`. You authenticate with a
**Shogo API key** (`shogo_sk_…`), and usage is billed to your workspace just
like usage inside the app.

The first model available on the public API is **Hoshi 1.0** (`hoshi-1.0`).

## Base URL

```
https://api.shogo.ai/v1
```

Because the API follows the OpenAI wire format, you only need to change the
**base URL** and **API key** in any existing OpenAI integration.

## Authentication

Send your Shogo API key as a bearer token:

```
Authorization: Bearer shogo_sk_your_key_here
```

Create and manage keys from **Settings → API Keys** in the Shogo app. Treat a
key like a password — it grants access to your workspace's usage and billing.
Revoke a key from the same screen if it leaks.

:::note
The public API accepts **only** Shogo API keys (`shogo_sk_…`). Internal
credentials such as runtime tokens are not valid here.
:::

## Models

Hoshi 1.0 is served under the stable id `hoshi-1.0`. List the models available
to your key:

```bash
curl https://api.shogo.ai/v1/models \
  -H "Authorization: Bearer $SHOGO_API_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "hoshi-1.0",
      "object": "model",
      "owned_by": "shogo",
      "display_name": "Hoshi 1.0"
    }
  ]
}
```

## Chat completions

### curl

```bash
curl https://api.shogo.ai/v1/chat/completions \
  -H "Authorization: Bearer $SHOGO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hoshi-1.0",
    "messages": [
      { "role": "user", "content": "Write a haiku about debugging." }
    ]
  }'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.shogo.ai/v1",
    api_key="shogo_sk_your_key_here",
)

resp = client.chat.completions.create(
    model="hoshi-1.0",
    messages=[{"role": "user", "content": "Write a haiku about debugging."}],
)
print(resp.choices[0].message.content)
```

### OpenAI SDK (JavaScript / TypeScript)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://api.shogo.ai/v1",
  apiKey: process.env.SHOGO_API_KEY,
});

const resp = await client.chat.completions.create({
  model: "hoshi-1.0",
  messages: [{ role: "user", content: "Write a haiku about debugging." }],
});
console.log(resp.choices[0].message.content);
```

### Streaming

Set `"stream": true` to receive server-sent events in the standard OpenAI
chunk format:

```bash
curl https://api.shogo.ai/v1/chat/completions \
  -H "Authorization: Bearer $SHOGO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "hoshi-1.0",
    "stream": true,
    "messages": [{ "role": "user", "content": "Count to five." }]
  }'
```

## Errors

Errors use the OpenAI error envelope:

```json
{
  "error": {
    "message": "The model 'foo' does not exist or you do not have access to it.",
    "type": "invalid_request_error",
    "code": "model_not_found"
  }
}
```

| Status | `code`                  | Meaning                                                        |
| ------ | ----------------------- | -------------------------------------------------------------- |
| 401    | `invalid_api_key`       | Missing or invalid `shogo_sk_` key.                            |
| 404    | `model_not_found`       | The requested model is not available on the public API.        |
| 402    | `usage_limit_reached`   | Your workspace is out of included usage; enable usage-based pricing or upgrade. |
| 403    | `model_tier_restricted` | Your plan does not include access to this model tier.          |
| 429    | `rate_limited`          | Too many requests; retry after the `Retry-After` header.       |

## Billing

Calls are metered to the workspace that owns the API key, using the same usage
windows and limits as the Shogo app. See [Billing](../features/billing) for how
included usage and usage-based pricing work.
