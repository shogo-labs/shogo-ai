# Runtime-token auth — operator gotchas

This document captures the non-obvious behaviors and risks introduced by the
runtime-token auth path (`via: 'runtimeToken'`). Reviewers of any change
that touches `authMiddleware`, `authorizeProject`, or `deriveRuntimeToken`
should skim this before shipping.

The code: [`runtime-token.ts`](./runtime-token.ts),
[`../middleware/auth.ts`](../middleware/auth.ts).

## What the token is

`deriveRuntimeToken(projectId) = HMAC-SHA256(signingSecret, "runtime-auth:" + projectId)`

- Deterministic — the API re-derives it per request, we never store it.
- Project-scoped — each token only authenticates requests for **its**
  `projectId`. A token for project A can't act on project B.
- Injected into every managed pod at assign-time as `RUNTIME_AUTH_SECRET`
  (see `knative-project-manager.ts`, `runtime/build-project-env.ts`).
- **Bearer capability, no replay window.** Tokens are valid as long as
  the signing secret is stable and the project exists. There is no
  `iat`, no nonce, no short-lived refresh. Whoever holds the token can
  act on the project — treat it like any other bearer key. If you need
  per-request freshness, layer a nonce in your application protocol.
- **Transport.** The SDK sends the token as `x-runtime-token`. The API
  also accepts `Authorization: Bearer <token>` (as long as the value
  does not start with `shogo_sk_`) because some proxies strip
  non-standard headers. Both paths hit the same HMAC check; our own
  SDK always uses the dedicated header.

## Gotchas

### 1. Signing-secret rotation invalidates every live pod's token

`getSigningSecret()` falls back across `AI_PROXY_SECRET` → `BETTER_AUTH_SECRET`
→ `PREVIEW_TOKEN_SECRET`. Whenever the resolved secret changes:

- All pod `RUNTIME_AUTH_SECRET`s become invalid against the API.
- Pods keep serving their own origin (their secret is just an env var) but
  their outbound calls to the Shogo API start returning 401/403.
- Pods recover only after they restart (they pick up the new derived token
  via env at boot).

Rotating the signing secret in production should therefore be done with the
same playbook as agent-proxy / heartbeat-sync rotation: drain + restart
pods, or run both secrets in parallel during the rollout window.

### 2. Local ↔ cloud signing-secret mismatch

When tunneling a local pod to cloud (or vice versa), the pod's
`RUNTIME_AUTH_SECRET` was derived against one signing secret; the API it
talks to must be configured with the same secret. Same caveat already
documented on `instance-tunnel.ts` applies to every runtime-token call.

Symptoms of a mismatch: pod boots normally, voice UI loads, but the first
call to `/api/voice/signed-url` 401s with "invalid runtime-token" in the
API log.

### 3. `userId` is the project owner — representation, not assertion

`AuthContext.userId` for a `via === 'runtimeToken'` request is a **real
`user` row**: the project's owner `Member` (`role = 'owner'` scoped to
the projectId first, falling back to the owning workspace's owner,
tie-broken by oldest `createdAt`). The resolution happens in the same
`project.findUnique` that confirms the project exists in
[`../middleware/auth.ts`](../middleware/auth.ts), so there's no extra
round-trip.

What this means for consumers:

- `prisma.user.findUnique({ where: { id: auth.userId } })` just works.
  No `via === 'runtimeToken'` branching is needed for identity lookups.
- `UsageEvent.memberId` / analytics attribution lands on the project
  owner. This is the most honest attribution available — the pod is
  acting on the owner's project on the owner's behalf — but it is
  **not** an identity assertion. The pod did not authenticate as that
  user; the token is still project-scoped. Treat downstream audit
  rows as "pod-for-project-X, owner-of-record Y" rather than "user Y
  did Z".
- **Authorization still branches on `via`**, never on userId shape.
  Code that must refuse runtime callers (translator flow in §7,
  super_admin guards) checks `auth.via === 'runtimeToken'`. A userId
  string-prefix check would silently accept runtime callers now that
  we stamp real ids.
- Rate-limit buckets keyed on `userId` will bucket all pod traffic
  for a project under its owner's id. If the owner also has a
  session, those share a bucket — acceptable in practice; use
  `workspaceId` or `projectId` if per-pod fairness matters.
- If a project somehow has no owner in either scope (invariant
  violation), the middleware falls through to 401 at `requireAuth`
  rather than silently attributing to a random user. A `console.warn`
  captures projectId + path for triage.

### 4. The pod is the capability boundary

Anyone who can reach `POST/GET /api/voice/*` **on the pod's origin** can
start voice for that project. The pod's runtime-token env is
project-scoped, not user-scoped — the pod itself has no idea which end
user is on the other side of the socket.

Implications for template authors:

- Do NOT mount `createVoiceHandlers()` without thinking about who can
  reach the pod.
- If the generated app has app-level auth (sign-in, API keys, invite
  tokens), gate the `/api/voice/*` mount behind it.
- Previews / public demos → open access is fine; that's the whole point
  of "zero-config voice in a preview iframe".
- Production pods with end users → add the same auth middleware to
  `/api/voice/*` as the rest of the app.

AGENTS.md in the template surface points at this rule; `.cursor/rules/shogo.mdc`
restates it so code review agents catch accidental mounts.

### 5. Shared-agent `/voice/signed-url` is **not** reachable via runtime-token

The middleware only sets `via: 'runtimeToken'` when a `projectId` is
supplied via query / route param. Shared-agent paths that do not carry
a `projectId` fall through to session auth, which means an
unauthenticated caller gets a 401. Do not add a `projectId` to those
routes without thinking through the scope widening.

### 6. Timing-safe comparison is mandatory

The token compare uses `safeTokenEqual` from `lib/crypto-util.ts`
(constant-time, length-guarded). Never reimplement: we consolidated
three copy-pasted variants into that one helper for a reason. Any new
token / HMAC check in this codebase should import from there.

### 7. Runtime-token is **not** a valid auth for the translator flow

`authorizeChatSession` explicitly rejects callers with
`auth.via === 'runtimeToken'`. The translator overlay at
`/voice/translator/chat/:chatSessionId` is a per-end-user resource;
runtime tokens are project-scoped capabilities with no end-user
identity. The `via`-based check (not a userId string-shape check) is
load-bearing — per §3 we stamp a real project-owner userId for
runtime callers, so a `userId.startsWith('runtime:')` check would
silently accept them. The explicit rejection also beats relying on a
membership lookup to fail: intent is obvious in code review, and the
401/403 behavior is consistent regardless of whether the owner
happens to have access to the target session.

Covered by the `POST /voice/translator/chat/:chatSessionId —
runtime-token rejection` test in
`apps/api/src/__tests__/voice-routes-runtime-token.test.ts`.

### 8. Dev-fallback signing secret is weak

When neither `AI_PROXY_SECRET`, `BETTER_AUTH_SECRET`, nor
`PREVIEW_TOKEN_SECRET` is set AND `NODE_ENV !== 'production'`,
`getSigningSecret()` falls back to the hardcoded
`'shogo-dev-only-runtime-token-secret'`. Any dev-mode pod's token is
therefore trivially forgeable by anyone who can read this repo. This
is intentional for DX (fresh clones "just work"), but it means:

- Never run a staging/canary environment without `NODE_ENV=production`
  or at least one of the three signing-secret env vars set. If you
  forget, the API happily accepts tokens an attacker can compute from
  a projectId alone.
- In production the fallback throws on first call (`getSigningSecret`
  checks `NODE_ENV === 'production'`) — that's the intended tripwire.

### 9. 401 vs 403 is a minor enumeration oracle

Two failure modes produce different status codes:

- Bad HMAC (wrong token, or right token with wrong scoped projectId) →
  `authMiddleware` falls through to session auth → downstream handler
  returns **401**.
- Correct HMAC but `authCtx.projectId !== projectId` (e.g. the route
  param differs from the query param used to derive the token) →
  `authorizeProject` returns **403 forbidden**.

This lets a holder of a valid token A probe whether projectId B exists
by observing 403 vs 401. Not a meaningful escalation (projectId
enumeration is already possible via other surfaces, and the caller
still can't act on B), but worth knowing when reviewing security
reports. If we ever want airtight scope isolation, collapse both paths
to 401.

### 10. Log redaction

Never log `x-runtime-token`, `Authorization`, `Cookie`, or the three
`x-tunnel-auth-*` headers in plaintext. `lib/crypto-util.ts` exports
`redactSensitiveHeaders()` and `fingerprintSecret()` — use them for
any request-logging code path. The `[authMiddleware] runtime-token
derive failed` log line is already sanitized (logs `projectId` +
`path` + `err.message`, never the token).
