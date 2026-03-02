# Staging Environment Debugging Guide

How to connect to the staging EKS cluster, read logs, and query the database.

## Prerequisites

- **AWS CLI** with the `shogo` profile configured
- **kubectl** installed
- **psql** (PostgreSQL client) for direct DB queries

Verify your AWS identity:

```bash
aws --profile shogo sts get-caller-identity
```

## 1. Connect to EKS

```bash
aws eks update-kubeconfig --region us-east-1 --name shogo-staging --profile shogo
```

Verify:

```bash
kubectl get nodes
```

## 2. Cluster Layout

| Namespace | What lives there |
|---|---|
| `shogo-staging-system` | API, Studio (web), Docs, CloudNativePG (platform-pg, projects-pg), image-prepuller |
| `shogo-staging-workspaces` | Per-project agent Knative Services (warm-pool pods) |
| `knative-serving` | Knative controller and networking |

### Key services

```bash
# System namespace — API, Studio, DB
kubectl get pods -n shogo-staging-system

# Workspace namespace — agent pods (may be scaled to zero)
kubectl get pods -n shogo-staging-workspaces

# Knative services (one per active project)
kubectl get ksvc -n shogo-staging-workspaces
```

## 3. Reading Logs

### API server logs

The API runs as a Knative Service in `shogo-staging-system`:

```bash
# Live tail (last 100 lines, follow)
kubectl logs -n shogo-staging-system -l serving.knative.dev/service=api \
  -c user-container --tail=100 -f

# Search for a specific project
kubectl logs -n shogo-staging-system -l serving.knative.dev/service=api \
  -c user-container --since=1h | grep "PROJECT_ID"

# Filter for billing events
kubectl logs -n shogo-staging-system -l serving.knative.dev/service=api \
  -c user-container --since=1h | grep "\[ProjectChat\]"
```

### Agent runtime logs (per-project pods)

Each project gets a Knative Service. Find the service name in the DB (`knativeServiceName` column on the `projects` table), then:

```bash
# List active agent pods
kubectl get pods -n shogo-staging-workspaces

# Tail a specific agent pod (replace with actual pod name)
kubectl logs -n shogo-staging-workspaces <pod-name> -c user-container --tail=200 -f

# If the pod has scaled to zero, there won't be any pods.
# Check the Knative service status instead:
kubectl get ksvc <service-name> -n shogo-staging-workspaces -o yaml
```

### Studio (web frontend) logs

```bash
kubectl logs -n shogo-staging-system -l serving.knative.dev/service=studio \
  -c user-container --tail=100
```

### Important: pods restart frequently

Knative auto-scales pods. After a period of inactivity, pods scale to zero and logs are lost. If you need to investigate something that happened hours ago, the pod logs are likely gone. Use the **database** instead — chat messages, tool call logs, and usage events are persisted.

## 4. Database Access

Staging uses **CloudNativePG** (in-cluster PostgreSQL), not RDS.

| Database | Cluster | Service | Contains |
|---|---|---|---|
| Platform | `platform-pg` | `platform-pg-rw` | Users, workspaces, projects, chat sessions, billing |
| Projects | `projects-pg` | `projects-pg-rw` | Per-project runtime databases |

### Option A: kubectl exec (simplest, no port-forward needed)

```bash
# Platform database — run SQL directly
kubectl exec -n shogo-staging-system platform-pg-2 -- \
  psql -U postgres -d shogo -c "SELECT id, name FROM projects LIMIT 5;"

# Projects database
kubectl exec -n shogo-staging-system projects-pg-2 -- \
  psql -U postgres -d projects -c "\dt"
```

> **Note:** The pod name (`platform-pg-2`) may change. Find the current one:
> ```bash
> kubectl get pods -n shogo-staging-system -l cnpg.io/cluster=platform-pg
> ```

### Option B: Port-forward (for interactive psql sessions or GUI tools)

```bash
# Forward platform DB to localhost:15432
kubectl port-forward -n shogo-staging-system svc/platform-pg-rw 15432:5432 &

# Get the connection URI
kubectl get secret platform-pg-app -n shogo-staging-system \
  -o jsonpath='{.data.uri}' | base64 -d

# Connect (replace password from the secret above)
psql -h 127.0.0.1 -p 15432 -U shogo -d shogo
```

Port-forwards can be flaky over long sessions. If you get "connection refused", restart the forward. For quick one-off queries, **Option A** (kubectl exec) is more reliable.

## 5. Common Debugging Queries

### Look up a project

```sql
SELECT id, name, type, "workspaceId", "templateId",
       "knativeServiceName", "createdAt"
FROM projects
WHERE id = '<PROJECT_ID>';
```

### Find the workspace owner

```sql
SELECT u.id, u.name, u.email
FROM users u
JOIN members m ON m."userId" = u.id
WHERE m."workspaceId" = '<WORKSPACE_ID>';
```

### Chat sessions for a project

```sql
SELECT id, "inferredName", "contextType", "createdAt", "lastActiveAt"
FROM chat_sessions
WHERE "contextId" = '<PROJECT_ID>'
ORDER BY "createdAt" DESC;
```

### Chat messages in a session

```sql
-- Summary (truncated content)
SELECT id, role, LEFT(content, 200) AS preview, "createdAt"
FROM chat_messages
WHERE "sessionId" = '<SESSION_ID>'
ORDER BY "createdAt" ASC;

-- Full content for a specific message
SELECT content, parts
FROM chat_messages
WHERE id = '<MESSAGE_ID>';
```

### Tool call logs for a session

```sql
SELECT id, "toolName", "messageId", status,
       args, LEFT(result::text, 200) AS result_preview,
       duration, "createdAt"
FROM tool_call_logs
WHERE "chatSessionId" = '<SESSION_ID>'
ORDER BY "createdAt" ASC;
```

### Billing / credit usage

```sql
-- Current credits for a workspace
SELECT * FROM credit_ledgers WHERE "workspaceId" = '<WORKSPACE_ID>';

-- Recent usage events
SELECT id, "workspaceId", "eventType", "creditCost", "createdAt"
FROM usage_events
WHERE "workspaceId" = '<WORKSPACE_ID>'
ORDER BY "createdAt" DESC
LIMIT 20;
```

### Agent config for a project

```sql
SELECT "projectId", "systemPrompt", "modelProvider", "modelName",
       "heartbeatEnabled", "heartbeatInterval"
FROM agent_configs
WHERE "projectId" = '<PROJECT_ID>';
```

### Knative service status for a project

```bash
# Get the knativeServiceName from the DB, then:
kubectl get ksvc <SERVICE_NAME> -n shogo-staging-workspaces \
  -o jsonpath='{.status.conditions}' | jq .
```

## 6. Investigating Canvas Issues

Canvas state is stored in a `.canvas-state.json` file inside each project's workspace directory on the agent pod's filesystem (S3-synced). It is **not** in the platform database.

If the pod is still running:

```bash
# Find the pod
kubectl get pods -n shogo-staging-workspaces -l serving.knative.dev/service=<KNATIVE_SVC_NAME>

# Read the canvas state
kubectl exec -n shogo-staging-workspaces <POD_NAME> -c user-container -- \
  cat /app/workspace/.canvas-state.json | jq .

# List all files in the workspace
kubectl exec -n shogo-staging-workspaces <POD_NAME> -c user-container -- \
  ls -la /app/workspace/
```

If the pod has scaled to zero, the canvas state may be in S3 (the workspace syncs to S3 on shutdown). Check the project's S3 bucket path.

## 7. Useful kubectl Shortcuts

```bash
# All pods across both namespaces
kubectl get pods -n shogo-staging-system -n shogo-staging-workspaces

# Events (useful for pod crashes, scheduling issues)
kubectl get events -n shogo-staging-workspaces --sort-by='.lastTimestamp' | tail -20

# Describe a pod (see env vars, restart reasons, resource limits)
kubectl describe pod <POD_NAME> -n shogo-staging-workspaces

# Get env vars for a running agent pod
kubectl exec -n shogo-staging-workspaces <POD_NAME> -c user-container -- env | sort

# Force-restart a Knative service (triggers new revision)
kubectl delete pods -n shogo-staging-workspaces -l serving.knative.dev/service=<SVC_NAME>
```

## 8. Domains

| Service | URL |
|---|---|
| Studio | https://studio-staging.shogo.ai |
| API | https://api-staging.shogo.ai |
| Docs | https://docs-staging.shogo.ai |

## 9. Common Gotchas

- **Port-forwards drop silently.** If `psql` says "connection refused", restart the `kubectl port-forward` command.
- **Pods scale to zero.** Knative scales idle pods to zero after ~5 minutes. Logs are gone once the pod is terminated — query the DB instead.
- **Use `postgres` user for kubectl exec.** The `shogo` user requires password auth which doesn't work with peer auth inside the pod. Use `-U postgres` for kubectl exec, or use the secret-based URI for port-forwarded connections.
- **API pod restarts on deploy.** Each `git push` to staging triggers a new Knative revision. The old pod terminates and logs are lost.
- **`platform-pg-2` pod name may change.** Always discover it dynamically: `kubectl get pods -n shogo-staging-system -l cnpg.io/cluster=platform-pg`.
