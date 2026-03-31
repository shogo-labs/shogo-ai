# Composio User ID Migration Guide

## Background

We changed the Composio `userId` format from:

```
shogo_{userId}_{projectId}          (legacy)
```

to:

```
shogo_{userId}_{workspaceId}_{projectId}   (current)
```

Because the Composio API does not support renaming or reassigning connected accounts
to a different user ID, we cannot migrate existing connections in-place. Instead we
deployed a **dual-lookup** strategy: every place that queries `connectedAccounts.list()`
sends both the new and legacy ID formats so existing connections continue to work.

New connections are always created under the current format. Over time, as users
re-authenticate expired connections (or disconnect and reconnect), all connections
will naturally migrate to the new format.

---

## Where the dual-lookup lives

| File | Location | What it does |
|------|----------|--------------|
| `packages/agent-runtime/src/composio.ts` | `storedLegacyComposioUserId` (line ~23) | Stores the legacy ID alongside the primary one |
| `packages/agent-runtime/src/composio.ts` | `initComposioSession()` (line ~258) | Sets `storedLegacyComposioUserId` on session init |
| `packages/agent-runtime/src/composio.ts` | `resetComposioSession()` | Clears legacy ID on reset |
| `packages/agent-runtime/src/composio.ts` | `checkComposioAuth()` (line ~480) | Queries both IDs in `connectedAccounts.list()` |
| `packages/agent-runtime/src/composio.ts` | `buildLegacyComposioUserId()` (line ~312) | Helper to build legacy format string |
| `apps/api/src/routes/integrations.ts` | `buildLegacyComposioUserId()` (line ~164) | Same helper, server-side |
| `apps/api/src/routes/integrations.ts` | GET `/integrations/connections` (line ~316) | Queries both IDs |
| `apps/api/src/routes/integrations.ts` | GET `/integrations/status/:toolkit` (line ~403) | Queries both IDs + defaults |
| `packages/agent-runtime/src/__tests__/composio-sdk.e2e.test.ts` | `buildLegacyComposioUserId` test | Unit test for legacy helper |

All locations are marked with:
```
TODO: Remove after all existing connections have been re-authenticated under the new format.
```

You can find them all with:
```bash
rg "TODO.*Remove.*legacy|TODO.*Remove after all existing|buildLegacyComposioUserId" --type ts
```

---

## How to check if migration is complete

### Step 1: Query Composio for legacy-format connected accounts

Use the Composio API to list all connected accounts and filter for ones whose
`userId` matches the legacy two-segment format but not the new three-segment format.

```bash
# Set your Composio API key
export COMPOSIO_API_KEY="your-composio-api-key"

# List all connected accounts (paginated -- adjust cursor/limit as needed)
curl -s "https://backend.composio.dev/api/v1/connectedAccounts?limit=100" \
  -H "x-api-key: $COMPOSIO_API_KEY" | \
  jq '[.items[] | select(.clientUniqueUserId != null) |
    select(.clientUniqueUserId | test("^shogo_")) |
    select((.clientUniqueUserId | split("_") | length) == 3) |
    {id, userId: .clientUniqueUserId, app: .appName, status}]'
```

The `split("_") | length == 3` filter catches IDs like `shogo_user123_project456`
(3 segments). The new format `shogo_user123_workspace789_project456` has 4 segments.

If this returns an empty array, all connections are on the new format.

### Step 2: Check for active legacy connections specifically

Focus on connections that are actually `ACTIVE` (expired/failed ones don't matter):

```bash
curl -s "https://backend.composio.dev/api/v1/connectedAccounts?limit=100" \
  -H "x-api-key: $COMPOSIO_API_KEY" | \
  jq '[.items[] | select(.clientUniqueUserId != null) |
    select(.clientUniqueUserId | test("^shogo_")) |
    select((.clientUniqueUserId | split("_") | length) == 3) |
    select(.status == "ACTIVE") |
    {id, userId: .clientUniqueUserId, app: .appName, status}]'
```

### Step 3: Check both staging and production

Run the above queries against both environments:

```bash
# Staging
COMPOSIO_API_KEY="staging-key" # ... run queries

# Production
COMPOSIO_API_KEY="prod-key"    # ... run queries
```

---

## When to remove the dual-lookup

Remove the legacy code when **all** of the following are true:

1. **Zero active legacy connections** in both staging and production (Step 2 above
   returns empty for both environments).
2. **Sufficient time has passed** -- at least 90 days since deployment, giving OAuth
   tokens time to expire and users a chance to re-auth naturally. Most OAuth tokens
   expire in 30-60 days; 90 days provides a comfortable buffer.
3. **No user reports** of missing integrations in the past 30 days.

### Suggested timeline

| Milestone | Action |
|-----------|--------|
| Deploy + 0 days | Dual-lookup goes live. New connections use new format. |
| Deploy + 30 days | Run Step 1/2 queries. Expect most connections migrated. |
| Deploy + 60 days | Run again. If legacy count is very low, consider notifying remaining users. |
| Deploy + 90 days | Final check. If zero active legacy connections, proceed with removal. |

---

## How to remove the dual-lookup

1. Search for all marked locations:
   ```bash
   rg "TODO.*Remove.*legacy|TODO.*Remove after all existing|buildLegacyComposioUserId|storedLegacyComposioUserId" --type ts
   ```

2. In `packages/agent-runtime/src/composio.ts`:
   - Delete `storedLegacyComposioUserId` declaration and all assignments
   - Delete `buildLegacyComposioUserId()` function
   - In `checkComposioAuth()`, replace the dual `userIds` array with just `[storedComposioUserId]`
   - In `resetComposioSession()`, remove the `storedLegacyComposioUserId = null` line

3. In `apps/api/src/routes/integrations.ts`:
   - Delete `buildLegacyComposioUserId()` function
   - In GET `/integrations/connections`, replace dual `userIds` with just `[composioUserId]`
   - In GET `/integrations/status/:toolkit`, remove legacy IDs from `candidateIds` array

4. In `packages/agent-runtime/src/__tests__/composio-sdk.e2e.test.ts`:
   - Remove `buildLegacyComposioUserId` import and its test case

5. Delete this file (`docs/composio-legacy-userid-migration.md`).

6. Run tests, deploy to staging, verify integrations still work, then deploy to production.
