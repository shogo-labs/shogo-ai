# Infrastructure Fixes Analysis

**Date:** January 23, 2026  
**Focus:** Infrastructure-level fixes for staging performance issues

---

## Summary of Root Causes

After analyzing the codebase and Kubernetes configurations, I've identified the following infrastructure-level issues that are causing the problems seen in E2E testing.

---

## Issue 1: API Server Not Directly Accessible (403/Failure)

### Root Cause
There is **no DomainMapping** for `api-staging.shogo.ai`. Looking at `k8s/overlays/staging/domain-mappings.yaml`:

```yaml
# Only these mappings exist:
- studio-staging.shogo.ai → studio service
- mcp-staging.shogo.ai → mcp-workspace-1 service
# NO api-staging.shogo.ai mapping!
```

The API is designed to be accessed **only through the studio nginx proxy** at `/api/*`. Direct access to `api-staging.shogo.ai` hits nothing.

### Fix Options

**Option A (Recommended): Add API DomainMapping**

Add to `k8s/overlays/staging/domain-mappings.yaml`:

```yaml
---
apiVersion: serving.knative.dev/v1beta1
kind: DomainMapping
metadata:
  name: api-staging.shogo.ai
  namespace: shogo-staging-system
spec:
  ref:
    name: api
    kind: Service
    apiVersion: serving.knative.dev/v1
```

Then add the ACM certificate ARN for `api-staging.shogo.ai` to the ALB ingress annotations.

**Option B: Remove direct API URL references**

If API should only be proxied, remove `BETTER_AUTH_URL: "https://api-staging.shogo.ai"` from the API service config since this URL doesn't work.

---

## Issue 2: /templates Route Returns 403 Forbidden

### Root Cause
This is an **nginx SPA fallback issue**. When nginx receives a request for `/templates`:

1. `try_files $uri $uri/ /index.html` checks if `/templates` exists as a file or directory
2. In the container, there may be a `/usr/share/nginx/html/templates/` directory from the build
3. nginx tries to serve it as a directory listing but `autoindex` is off → **403 Forbidden**

### Fix
Update `apps/web/nginx.conf` to handle SPA routes explicitly:

```nginx
# SPA fallback - all routes go to index.html
# IMPORTANT: Don't check $uri/ for directory listings (causes 403)
location / {
    try_files $uri /index.html;  # Remove $uri/ check
}
```

Or ensure the Vite build doesn't create any directories that match route names.

---

## Issue 3: Subdomain Check 500 Errors

### Root Cause
Looking at `apps/api/src/server.ts` line 1033-1041:

```typescript
app.get('/api/subdomains/:subdomain/check', async (c) => {
  const studioCore = await getStudioCoreStore()  // Uses Prisma
  const router = publishRoutes({ studioCore })
  // ... forwards to publish router
})
```

The `getStudioCoreStore()` creates a Prisma client. If the **PostgreSQL database is slow, overloaded, or the connection pool is exhausted**, this returns 500.

### Investigation Steps
1. Check PostgreSQL pod health and resource usage
2. Check Prisma connection pool settings
3. Check DATABASE_URL secret is correctly configured

### Fix
Add connection pool configuration to the database URL or Prisma client:

```typescript
// In apps/api/src/lib/prisma.ts
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  log: ['error', 'warn'],
})

// Add connection pool limits in DATABASE_URL:
// postgresql://user:pass@host:5432/db?connection_limit=10&pool_timeout=30
```

Also add error handling:

```typescript
app.get('/api/subdomains/:subdomain/check', async (c) => {
  try {
    const studioCore = await getStudioCoreStore()
    // ...
  } catch (error) {
    console.error('[Subdomain Check] Database error:', error)
    return c.json({ error: { code: 'database_error', message: 'Service temporarily unavailable' } }, 503)
  }
})
```

---

## Issue 4: Workspace Cold Start 502/503 Errors

### Root Cause
When a project workspace starts:

1. **Knative creates a new pod** (takes 10-30+ seconds for image pull + startup)
2. **Multiple API endpoints are called immediately** without waiting for the pod
3. The API gets 502/503 because the pod isn't ready yet

Looking at `apps/api/src/lib/knative-project-manager.ts`:

```typescript
// Line 790: Cold start timeout is only 30 seconds
await manager.waitForReady(projectId, 30000)

// Line 785: New pod creation timeout is 60 seconds
await manager.waitForReady(projectId, 60000)
```

But the readiness probe allows **60 seconds** for builds:
```typescript
readinessProbe: {
  failureThreshold: 30, // 30 * 2s = 60s
  periodSeconds: 2,
}
```

### Fixes

**A. Increase ALB Idle Timeout (Currently 60s)**

In `k8s/overlays/staging/alb-ingress.yaml`:

```yaml
alb.ingress.kubernetes.io/load-balancer-attributes: idle_timeout.timeout_seconds=120,routing.http2.enabled=true
```

**B. Increase API Service Resources**

The API is constrained:
```yaml
resources:
  requests:
    memory: "256Mi"
    cpu: "100m"
  limits:
    memory: "512Mi"
    cpu: "500m"
```

Increase for better concurrent request handling:
```yaml
resources:
  requests:
    memory: "512Mi"
    cpu: "200m"
  limits:
    memory: "1Gi"
    cpu: "1000m"
```

**C. Implement Proper Cold-Start Waiting in Frontend**

The frontend should wait for `/sandbox/url` to succeed before calling other endpoints like `/files`, `/terminal/commands`, etc.

**D. Add Startup Probe to API Service**

```yaml
startupProbe:
  httpGet:
    path: /health
    port: 8002
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 12  # 60 seconds total
```

---

## Issue 5: 30-Second Page Load Times

### Root Cause
Multiple factors:

1. **Schema fetching on every page load**: The frontend fetches 9 schema collections via MCP on every navigation
2. **No browser caching of schema data**
3. **Sequential requests**: Many MCP POST calls happen sequentially

### Fixes

**A. Add Schema Caching in MCP Service**

The MCP should return `Cache-Control` headers for schema responses:

```typescript
// In MCP response
res.setHeader('Cache-Control', 'public, max-age=300')  // 5 minute cache
```

**B. Consider Schema Bundling**

Bundle schemas into the frontend build instead of fetching at runtime:
```typescript
// At build time, fetch and embed schemas
const schemas = await fetchSchemas()
fs.writeFileSync('src/generated/schemas.json', JSON.stringify(schemas))
```

**C. Add nginx Proxy Caching**

In `apps/web/nginx.conf`:

```nginx
# Cache MCP schema responses
location /mcp {
    proxy_cache_valid 200 5m;
    # ... existing config
}
```

---

## Issue 6: Race Condition - Schema Not Found

### Root Cause
In `apps/web/src/providers/AuthGate.tsx` (or similar), the auth check runs **before** schemas are loaded:

```
[AuthGate] Failed to check pending invitations: Error: Query failed: Schema 'studio-core' not found
```

The timing:
1. App mounts
2. AuthGate queries `studio-core` schema ← **FAILS because schema not loaded**
3. DomainProvider loads schemas (takes 1-2 seconds)

### Fix
Ensure schema loading completes before auth queries. In the provider hierarchy:

```tsx
// Correct order:
<DomainProvider>  {/* Loads schemas first */}
  <SchemasReadyGate>  {/* Wait for schemas */}
    <AuthGate>  {/* Now safe to query */}
      <App />
    </AuthGate>
  </SchemasReadyGate>
</DomainProvider>
```

Or add a schema-ready check:

```typescript
// In AuthGate
const { schemasLoaded } = useDomainContext()
if (!schemasLoaded) return <Loading />
// Then proceed with auth check
```

---

## Issue 7: Database Proxy Font 404s

### Root Cause
Prisma Studio fonts are requested through the database proxy:
```
/api/projects/{id}/database/proxy/inter-latin-400-normal.*.woff2 → 404
```

The proxy isn't serving static assets from Prisma Studio.

### Fix
In the database proxy route, handle static assets:

```typescript
// apps/api/src/routes/database.ts
router.get('/projects/:projectId/database/proxy/*', async (c) => {
  const path = c.req.param('*')
  
  // Serve fonts from Prisma Studio's static directory
  if (path.endsWith('.woff') || path.endsWith('.woff2')) {
    // Proxy to Prisma Studio static assets
    // Or serve from a bundled location
  }
})
```

Or configure Prisma Studio to use external font CDN.

---

## Kubernetes Configuration Summary

### Recommended Changes to `k8s/overlays/staging/`

| File | Change | Priority |
|------|--------|----------|
| `domain-mappings.yaml` | Add api-staging.shogo.ai DomainMapping | High |
| `alb-ingress.yaml` | Increase idle_timeout to 120s | High |
| `api-service.yaml` | Increase CPU/memory limits | Medium |
| `api-service.yaml` | Add startupProbe | Medium |

### Recommended Changes to `apps/web/`

| File | Change | Priority |
|------|--------|----------|
| `nginx.conf` | Fix try_files for SPA routes | High |

### Recommended Changes to `apps/api/`

| File | Change | Priority |
|------|--------|----------|
| `server.ts` | Add error handling for subdomain check | High |
| `lib/prisma.ts` | Add connection pool config | Medium |
| `routes/database.ts` | Handle Prisma Studio static assets | Low |

---

## Quick Wins (Can Deploy Today)

1. **Add API DomainMapping** - 5 minute fix, solves API accessibility
2. **Fix nginx try_files** - 2 minute fix, solves /templates 403
3. **Increase ALB idle timeout** - 1 line change, helps with timeouts

## Requires More Investigation

1. **PostgreSQL performance** - Check pod logs, connections, resource usage
2. **Schema caching strategy** - Need to understand schema versioning requirements
3. **Cold start optimization** - May need pre-warming or different scaling strategy

---

*Analysis based on codebase review and E2E test results*
