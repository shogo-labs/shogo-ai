# Example Discovery Sessions

## Example 1: Add API Key Authentication

### Initial Intent

> "Add API key authentication to the MCP server"

### Phase 1: Capture Intent

**Clarifying Questions**:
- What should happen when auth fails? (401/403 responses)
- Do we need key rotation? (Yes)
- Should we log auth events? (Yes, for audit)

**Session Created**:
```json
{
  "id": "sess-auth-001",
  "name": "mcp-auth",
  "intent": "Add API key authentication to the MCP server. Validate keys on requests, support rotation, log auth events.",
  "status": "discovery",
  "createdAt": 1701619200000
}
```

### Phase 2: Affected Areas

- `packages/mcp` - Server middleware, tool validation
- `packages/state-api` - Possibly persistence for keys
- `.schemas` - New `auth` schema for User, ApiKey, AuditLog

**Session Updated**:
```json
{
  "affectedPackages": ["packages/mcp", "packages/state-api", ".schemas"]
}
```

### Phase 3: Requirements

| Priority | Requirement |
|----------|-------------|
| must | Validate API key header on each MCP request |
| must | Return 401 Unauthorized for missing/invalid keys |
| must | Return 403 Forbidden for valid key without permission |
| should | Support API key rotation without downtime |
| should | Log authentication events (success/failure) |
| could | Rate limiting per API key |

**Requirements Created**: 6 entities linked to session

### Phase 4: Handoff

Summary provided to developer. Confirmed coverage. Status updated to "design".

Ready for `platform-feature-design` to create auth schema.

---

## Example 2: Add Session Persistence to Web UI

### Initial Intent

> "Make chat sessions persist across page reloads in Unit 3"

### Phase 1: Capture Intent

**Clarifying Questions**:
- Where should sessions persist? (localStorage for now)
- Should we support multiple saved sessions? (Yes, with list)
- Auto-save or explicit save? (Auto-save after each turn)

**Session Created**:
```json
{
  "id": "sess-persist-001",
  "name": "chat-persistence",
  "intent": "Persist Unit 3 chat sessions across page reloads using localStorage. Support multiple sessions with list view.",
  "status": "discovery",
  "createdAt": 1701619200000
}
```

### Phase 2: Affected Areas

- `apps/web` - Unit 3 components, hooks, localStorage logic
- (No backend changes needed for localStorage approach)

**Session Updated**:
```json
{
  "affectedPackages": ["apps/web"]
}
```

### Phase 3: Requirements

| Priority | Requirement |
|----------|-------------|
| must | Auto-save chat messages to localStorage after each turn |
| must | Restore last session on page load |
| must | Store agent.chat sessionId for resumption |
| should | Show list of saved sessions |
| should | Allow switching between sessions |
| should | Delete old sessions (manual or auto after 30 days) |
| could | Export session as JSON |

**Requirements Created**: 7 entities linked to session

### Phase 4: Handoff

Summary provided. This feature may not need a new schema (localStorage is sufficient). Could skip `platform-feature-design` and go to `platform-feature-integration`.

---

## Example 3: Add New MCP Tool

### Initial Intent

> "Add a store.delete tool to remove entities"

### Phase 1: Capture Intent

**Clarifying Questions**:
- Hard delete or soft delete? (Hard delete for now)
- Should it support batch delete? (Single entity first)

**Session Created**:
```json
{
  "id": "sess-delete-001",
  "name": "store-delete-tool",
  "intent": "Add store.delete MCP tool to remove entities from collections",
  "status": "discovery",
  "createdAt": 1701619200000
}
```

### Phase 2: Affected Areas

- `packages/mcp` - New tool in store namespace

**Session Updated**:
```json
{
  "affectedPackages": ["packages/mcp"]
}
```

### Phase 3: Requirements

| Priority | Requirement |
|----------|-------------|
| must | Delete entity by ID from specified model/schema |
| must | Return success/failure status |
| must | Handle non-existent entity gracefully |
| should | Persist deletion to database |
| could | Support batch delete by filter |

**Requirements Created**: 5 entities linked to session

### Phase 4: Handoff

Simple feature. No new schema needed. Skip to `platform-feature-integration`.
