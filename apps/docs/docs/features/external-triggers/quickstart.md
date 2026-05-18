---
title: Quickstart
sidebar_position: 1
---

# External Triggers — Quickstart

**External triggers** let services like Jira, GitHub, Linear, Zapier, or
your own cron jobs send messages to a Shogo agent over plain HTTP. Combined
with [My Machines](../my-machines/quickstart), they let an agent that lives
on **your laptop or VPS** receive jobs from the outside world without you
having to expose a public port on that machine.

The path your request takes:

```
External service ──HTTPS──▶ Shogo Cloud ──tunnel──▶ Your paired machine
                                                    │
                                                    └─▶ agent-runtime
```

You give the external service one canonical URL per project. Shogo Cloud
handles the routing to wherever the agent actually runs.

## 1. Pair a machine

If you haven't already, follow the [My Machines quickstart](../my-machines/quickstart)
to install `shogo` on the machine that should handle the work and run
`shogo worker start`.

:::tip Cloning a project
Want a local copy of the project's workspace files on the machine ahead of
time? Run `shogo project pull <projectId>` — see
[Cloning projects to a paired machine](../my-machines/project-pull). The
worker also auto-clones on first request by default, so this is optional.
:::

## 2. Pin the project to that machine

In studio, open the project, then **Settings → Run on** and pick the
machine you just paired. Or do it from the SDK:

```ts
import { createClient } from '@shogo-ai/sdk'

const client = createClient({
  apiUrl: 'https://api.shogo.ai',
  shogoApiKey: process.env.SHOGO_API_KEY!,
})

const machines = await client.machines.list({ workspaceId })
const vps = machines.find((m) => m.name === 'prod-vps-1')!

await client.machines.pinProject(projectId, { instanceId: vps.id })
```

From now on, every request to:

```
https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/...
```

is relayed through `prod-vps-1`'s outbound tunnel. If the machine goes
offline, the API returns `503 instance_offline` — the external caller
retries. (Set `policy: 'prefer'` if you want offline = cloud fallback.)

## 3. Add a webhook channel

In studio, open **Channels → + Add channel → Webhook**, set a `secret`,
and save. See [Webhook channel](./webhook-channel) for the full request
shape.

## 4. Trigger it

```bash
curl -X POST https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/channels/webhook/incoming \
  -H "Authorization: Bearer $SHOGO_API_KEY" \
  -H "X-Webhook-Secret: $CHANNEL_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"message": "Fix bug PROJ-123"}'
```

The agent picks up the request **on your VPS**, runs its tool loop there,
and returns the reply in the response body.

## Wiring it to Jira (worked example)

1. In Jira, open **Project settings → Automation → Create rule**.
2. **Trigger**: "Issue created" with JQL `labels = ai-fix`.
3. **Action**: "Send web request" →

   - URL: `https://api.shogo.ai/api/projects/<projectId>/agent-proxy/agent/channels/webhook/incoming`
   - Method: `POST`
   - Headers:
     - `Authorization: Bearer <SHOGO_API_KEY>`
     - `X-Webhook-Secret: <CHANNEL_SECRET>`
     - `Content-Type: application/json`
   - Body:

     ```json
     {
       "message": "Fix Jira ticket {{issue.key}}: {{issue.summary}}",
       "metadata": { "issueKey": "{{issue.key}}", "reporter": "{{issue.reporter.displayName}}" },
       "callbackUrl": "https://your-jira.atlassian.net/.../webhook"
     }
     ```

`callbackUrl` is optional — include it if you want Shogo to POST the
agent's reply back asynchronously. Without it, the reply is returned
synchronously in the response (default timeout: 120s).

## Security model

- **Two layers of auth**:
  - `Authorization: Bearer shogo_sk_*` — proves to Shogo Cloud that the
    caller has access to the workspace and project.
  - `X-Webhook-Secret` (or a second Bearer header inside the channel) —
    proves to the channel itself that the caller is allowed to trigger it.
    Verified inside your `agent-runtime`, not in the cloud.
- **Where the code runs**: tool calls execute on your paired machine, not
  in a Shogo cloud pod. The cloud only sees encrypted bytes between the
  external caller and the worker.
- **Revocation**: removing the pin (`client.machines.unpinProject`) or
  rotating the channel secret in studio takes effect immediately.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `503 instance_offline` | Worker isn't running or tunnel dropped | Start `shogo worker start` and check the studio Machines page. |
| `401 unauthorized` (from cloud) | Bad / revoked `shogo_sk_*` key | Mint a new key in **Settings → API Keys** and retry. |
| `401` from the channel itself | Bad `X-Webhook-Secret` | Re-copy the secret from the channel editor. |
| Agent never replies | Channel not connected | Open the channel editor; `status` should be `connected`. |

## See also

- [Webhook channel reference](./webhook-channel) — full request/response shape.
- [SDK: `client.machines`](https://sdk.shogo.ai/docs/api/MachinesApi) — the programmatic pin API.
- [My Machines quickstart](../my-machines/quickstart) — pairing a machine.
