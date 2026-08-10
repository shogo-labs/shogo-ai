# Production e2e findings — studio.shogo.ai, 2026-08-09

Reproduction notes and fixes for every issue found during a live end-to-end
session against **production** (`studio.shogo.ai`, workspace `Admin Personal`,
user `admin@shogo.ai`).

Every number in this document was measured against production on 2026-08-09.
Claims are marked **[measured]** when I observed them directly in this session,
**[code]** when they follow from reading the current source, and
**[hypothesis]** when they are inference that still needs origin-side data.

Every **[code]** claim below has been checked against the current tree, and
several first-pass conclusions did not survive that check. The corrections are
called out inline rather than quietly removed, because two of them (§D3 and §F2)
would otherwise have sent someone to fix the wrong thing:

| § | First-pass claim | Corrected finding |
|---|---|---|
| D3 | "Exclude `node_modules` from the archive" | Already excluded. The 1.8 GB archives are user video/stock footage; the real gap is a 30 s assign timeout against a 30 min hydrate budget |
| F2 | Enter-key handling differs between composers | Handlers are identical; the project composer submits from stale state while displaying a ref |
| B2 | 524 HTML renders as an assistant message | It renders in the error banner; the fix belongs in the transport, not the renderer |
| B4 | Watchdog fires at 120 s, before the 524 | Two thresholds (120 s / 180 s); the 524 usually wins once any byte has arrived |
| F4 | The "15 more" label is wrong | It is correct — workspace-scoped (20), while the 55 total spans two workspaces |
| E4 | Confirm the composite index exists | It does not exist; it needs adding |

> **Headline correction to the earlier write-up.** The first pass concluded that
> all symptoms shared one cause (the US→EU peer proxy). That is now known to be
> wrong: there are **two independent hang sources**. The peer proxy hangs
> (§A1) *and* the project runtime origin hangs (§A4) — the latter reproduces
> with the peer proxy completely out of the path.

---

## Contents

| § | Area | Issues |
|---|---|---|
| A | Origin hangs — the dominant reliability problem | A1–A5 |
| B | Chat streaming | B1–B4 |
| C | Preview / canvas pane | C1–C5 |
| D | Project open and cold boot | D1–D4 |
| E | Client performance | E1–E7 |
| F | UX defects | F1–F4 |

---

## Reproduction harness

Two harnesses are used throughout. Both are copy-pasteable.

### 1. Browser console (authenticated, same-origin)

Sign in to `studio.shogo.ai`, open DevTools, and paste. This is how every
`/api/*` measurement below was taken.

```js
// Generic probe: returns per-attempt status + latency, treating a hang as an abort.
async function probe(url, n = 10, abortMs = 15000, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), abortMs);
    const t0 = performance.now();
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store', signal: ac.signal, ...opts });
      await r.text();
      out.push({ ms: Math.round(performance.now() - t0), status: r.status });
    } catch (e) {
      out.push({ ms: Math.round(performance.now() - t0), status: 'HANG' });
    } finally { clearTimeout(t); }
  }
  console.table(out);
  return { hangs: out.filter(r => r.status === 'HANG').length, n };
}
```

### 2. curl (unauthenticated, for `*.preview.shogo.ai`)

Preview origins do not require the session cookie for the document or its
assets, so plain curl works and removes the browser from the picture.

```bash
HOST="<projectId>.preview.shogo.ai"
for i in $(seq 1 12); do
  curl -sS -o /dev/null --max-time 15 \
    -w "%{http_code}:%{time_starttransfer}s\n" "https://$HOST/index.html"
done
# code=000 with 0 bytes received == the hang described in §A4
```

---

# A. Origin hangs — the dominant reliability problem

All of A1–A4 share one signature, and it is worth stating once because it is the
fingerprint to look for in logs:

> The TCP+TLS connection is **accepted**, then **zero bytes** of response are
> ever written. There is no HTTP status, no Cloudflare error page within 25s,
> and no `x-envoy-upstream-service-time` header on the eventual failure. An
> immediate retry on a fresh connection usually succeeds.

Healthy requests to the same pods report 6–48 ms of upstream service time, so
the origin is not slow — for these requests it never answers at all.

## A1. Cross-region peer proxy hangs on ~30% of requests

**Severity: critical.** This is the direct cause of the reported "messages stop
streaming mid way".

**Symptom.** Workspace-scoped requests that must be proxied US→EU hang for
~125 s and then return a Cloudflare 524.

**Reproduce** [measured] — run in the browser console (harness 1):

```js
await probe('/api/admin/regions/eu-frankfurt-1/api/health', 10, 15000); // cross-region
await probe('/api/health', 10, 15000);                                  // same region
```

**Result, 2026-08-09** (reproduced twice, hours apart):

| Path | Hangs | Latency when healthy |
|---|---|---|
| Cross-region (`us-ashburn-1` → `eu-frankfurt-1`) | **3 / 10** | 486–693 ms |
| Same region | **0 / 10** | 373–382 ms |

The same endpoint, the same payload, the same auth. Only the region hop differs.
Left unaborted, a hung call runs **125,290 ms** and returns HTTP 524.

**Why this workspace is affected.** The browser is served by `us-ashburn-1` but
`Admin Personal` has `homeRegion: eu-frankfurt-1`, and `HOME_REGION_ROUTING`
is set to `enforce`, so writes and workspace-scoped reads are proxied.

**Requests observed hanging to a 524** [measured]:

| Method | Endpoint | Time to 524 (ms) |
|---|---|---|
| POST | `/api/projects/:id/chat` | 125,290 |
| POST | `/api/projects/:id/runtime/prewarm` | 125,282 |
| POST | `/api/generate-project-name` | 125,283 |
| GET | `/api/projects/:id/agent-proxy/agent/q…` | 125,296 |
| GET | `/api/admin/regions/eu-frankfurt-1/api/health` | 125,293 |

**Fix.** See A2 and A3 — they are the two halves of this. Additionally, as an
immediate operational mitigation, re-home this workspace to the region that
actually serves it (or relax `enforce` for reads), which removes the hop
entirely for the affected users.

**Verification.** Re-run the two probes above; cross-region hangs should reach
0/10 and, more importantly, no single request should ever exceed the new
timeout budget from A3.

## A2. `keepalive: false` is only applied to requests that have a body

**Severity: critical. Cheapest available fix.**

`apps/api/src/lib/region-peer-proxy.ts:107-132` documents the exact failure mode
in its own comments: a Bun keep-alive bug ([oven-sh/bun#32847], **unfixed as of
Bun 1.3.14**) returns a socket to the connection pool mid-request-message, so the
next request written to that socket is parsed as a continuation of the abandoned
body — the peer's HTTP parser never sees a request line and answers a bare 400
that never reaches a route handler. The comment even names this symptom: "a chat
POST rejected upstream makes the unrelated resume GET after it fail."

The mitigation is applied inside a `hasBody` ternary [code]:

```ts
...(hasBody ? { body: c.req.raw.body, duplex: 'half', keepalive: false } : {}),
```

Because `hasBody` is false for GET and HEAD, **every proxied GET still draws
from the poisoned pool** — including the SSE stream reads and the resume polls
that chat recovery depends on.

**Fix.** Hoist `keepalive: false` out of the ternary so it applies to all
proxied requests:

```ts
const init: RequestInit = {
  method: c.req.method,
  headers,
  keepalive: false,                       // always, not only when there is a body
  ...(hasBody ? { body: c.req.raw.body, duplex: 'half' } : {}),
};
```

**Caveat that must be checked before treating this as complete** [measured]: a
`DELETE` also hung once during testing *even though it takes the
`keepalive: false` branch*, then succeeded on retry in 1.8 s. So connection
reuse is probably not the whole story. Confirm against origin-side logs whether
the hung request ever arrives at the peer pod at all.

## A3. The peer proxy has no timeout, no retry, and no circuit breaker

**Severity: critical.**

Because the outbound `fetch` to the peer region is unbounded, a poisoned
connection costs the **full Cloudflare timeout (~125 s)** rather than a fast
retry. This is what turns a transient socket problem into a dead user request.

Confirmed [code]: neither `proxyToPeer` (`region-peer-proxy.ts:73-152`) nor
`callPeerInternal` (`:173-207`) has an `AbortSignal`, timeout, retry loop or
circuit breaker. `pinChatToHomeRegion` maps a 502 to a retryable 503
(`chat-region-pin.ts:130`), but that is a status translation, not a transport
retry.

**This is an outlier in the codebase, which is the strongest argument for fixing
it.** Every comparable proxy path is already defended:

| Path | Timeout | Retries |
|---|---|---|
| Agent proxy (`server.ts:3137-3278`) | 30 min/attempt | **24**, exponential |
| Project chat upstream (`project-chat.ts:1137-1224`) | 4 h | **30** |
| `proxyToPeer` / `callPeerInternal` | **none** | **none** |

Call sites that inherit the gap: `middleware/home-region-router.ts:278`,
`lib/chat-region-pin.ts:125`, `server.ts:5430`, and
`services/billing.service.ts:870,932`.

**Fix.** Bound every peer call and make one hang cheap:

1. Attach an `AbortSignal.timeout(...)` — a short budget (5–10 s) for JSON
   routes, a longer one for SSE, applied to *response start* rather than total
   duration so streams are not cut.
2. Retry once on a timeout or connection error, on a fresh connection. Given A2,
   the retry will usually succeed immediately.
3. Add a per-peer circuit breaker so a sustained peer failure fails fast instead
   of queueing 125 s requests.

**Verification.** With a 10 s response-start timeout and one retry, the
cross-region probe in A1 should show no request exceeding ~20 s, and the
observable hang rate should drop to roughly the square of the current rate.

## A4. The project runtime origin hangs too — independent of the peer proxy

**Severity: critical. This is a second, separate root cause and it was missed in
the first pass.**

**Symptom.** Requests to a running project's preview origin hang with zero bytes
received, then succeed on retry. This is the direct cause of the blank / stuck
preview pane (§C1).

**Reproduce** [measured] — pick any project with a running runtime, then use
harness 2. No auth, no peer proxy, no API involvement:

```bash
HOST="2753be0c-21e1-4ddb-9bd5-972303b3be92.preview.shogo.ai"
for i in $(seq 1 12); do
  curl -sS -o /dev/null --max-time 15 -w "%{http_code}:%{time_starttransfer}s\n" \
    "https://$HOST/index.html"
done
```

**Results** [measured] — the rate varies by pod and by moment, but no project
tested was clean:

| Project | Hangs | Latency when healthy |
|---|---|---|
| `2753be0c` (`/index.html`, 12 attempts) | 1 / 12 | 0.98–1.38 s |
| `2753be0c` (`/index.html`, 8 attempts, later) | 3 / 8 | 422–509 ms |
| `9cb72c3a` (`/index.html`, 8 attempts) | 4 / 8 | 507–558 ms |
| `9cb72c3a` (`/assets/index-*.js`, 1.1 MB) | 1 timeout at 25 s, then 4 × 200 in ~2.7 s | — |

Failures cluster in bursts (for `9cb72c3a`, the first four hung and the last
four succeeded), which points at a per-pod condition rather than packet loss.

**The decisive test — it is the pod, not the edge path** [measured]. The same
runtime is reachable two completely different ways. Both hang at the same rate:

| Path to the same runtime | Route | Hangs |
|---|---|---|
| Direct subdomain (CF Worker → regional Kourier → pod) | `https://<id>.preview.shogo.ai/index.html` | 3 / 8 |
| API proxy (CF → API pod → agent proxy → pod) | `/api/projects/<id>/preview/index.html` | 3 / 8 |

Meanwhile same-region `/api/health` against the API pod hangs **0 / 10**. So the
API pod and the edge are healthy; the shared element in both failing paths is
the **project runtime pod**.

Also note the failure is *not* path-specific in a stable way: within one sweep,
bare `/` timed out at 20 s while `/?_v=0` returned 200 in 1.19 s a second later,
and `/agent/canvas/bridge.js` returned 200 in 1.07 s. Small responses (449 B,
17 KB, 31 KB) mostly succeed; the 1.1 MB bundle fails most often.

**Leading hypothesis** [hypothesis]. The runtime's Bun HTTP server stops
answering while the VM is busy — most plausibly CPU starvation inside a
single-vCPU Firecracker guest during a Vite/esbuild rebuild, which would block
the event loop and explain why large responses (which need many event-loop
turns) fail more than small ones. The project that failed worst had just been
edited by the agent.

**How to confirm.** This needs origin-side data that a browser cannot see:

1. Do the hung requests appear in the runtime pod's access log at all? If not,
   the problem is above the pod (Kourier / activator / Worker). If they arrive
   and are never answered, it is the Bun server or the guest's CPU.
2. Sample guest CPU and event-loop lag during a rebuild, and correlate with
   the hang windows.
3. Check the Bun version in the runtime image against the keep-alive bug in A2 —
   the same bug on the *server* side would produce exactly this signature.

**Fix.** Dependent on the confirmation above, but two things are worth doing
regardless: give the runtime a CPU reservation (or de-prioritise the build) so
the HTTP server cannot be starved, and make every client of a runtime origin
retry a zero-byte hang rather than treating it as fatal (§C4).

## A5. Cloudflare's ~125 s origin timeout is the binding limit and is configured nowhere

**Severity: high.**

Every internal hop is tuned for long streams, but the edge is not, and the edge
is the tightest constraint:

| Hop | Limit |
|---|---|
| Cloudflare → origin | **~100–125 s** (observed; not configured in this repo) |
| Chat upstream fetch (`project-chat.ts:1140`) | `CHAT_UPSTREAM_FETCH_TIMEOUT_MS`, default **4 h** |
| Chat stream idle (`project-chat.ts:184`) | `CHAT_STREAM_IDLE_TIMEOUT_MS`, default **1 h** |
| Agent proxy per attempt (`server.ts:3140`) | **30 min** |
| API Knative service (`k8s/overlays/production/api-service.yaml`) | `timeoutSeconds: 1800` |
| Project Knative service (`knative-project-manager.ts`) | `timeoutSeconds: 3600`, `responseStartTimeoutSeconds: 600` |
| OCI load balancer | 1800 s idle |
| Knative activator | deliberately bypassed via `target-burst-capacity: "0"` |

So an operation the platform believes it has **four hours** for is killed by the
edge at ~2 minutes, and the limit that actually governs production is not
represented in version control. The only Terraform timeout in
`terraform/modules/cloudflare-lb/main.tf:135` is `timeout = 10` on the health
monitor, which is unrelated.

The codebase clearly knows the real number without encoding it — `server.ts:2795`
caps the `/sandbox/url` wait at **60 s** with the comment "under Cloudflare's 100s
timeout", and `ai-proxy.ts:313-317` mitigates the "~100s idle TCP kill" with 15 s
keepalives. That knowledge lives in comments and magic numbers scattered across
handlers.

**Fix.** Pick one source of truth: define the edge budget once (a shared constant
or env var), derive the per-route waits from it, and encode the Cloudflare side in
`terraform/modules/cloudflare-lb`. Then either raise it for streaming routes or
stop having any request wait that long — return immediately and stream progress
over a channel that tolerates reconnection.

---

# B. Chat streaming

## B1. A turn dies mid-stream and never recovers

**Severity: critical** (user-reported symptom).

**Symptom.** The assistant streams for a few seconds, stops permanently, and the
turn is lost.

**Reproduce** [measured]. Open a project in an EU-homed workspace while being
served from the US, and send messages until a turn dies. It is bimodal —
roughly one turn in four in my session.

**Instrument it** — patch `fetch` before sending so the wire is visible:

```js
(() => {
  const orig = window.fetch;
  window.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    const r = await orig(...args);
    if (!url.includes('/chat')) return r;
    const t0 = performance.now(); let n = 0, last = 0;
    const [a, b] = r.body.tee();
    (async () => {
      for await (const c of a) {
        n++; const t = performance.now();
        console.log(`chunk ${n} @${Math.round(t - t0)}ms gap=${Math.round(t - last)}ms`);
        last = t;
      }
      console.log(`stream ended: ${n} chunks in ${Math.round(performance.now() - t0)}ms`);
    })();
    return new Response(b, r);
  };
})();
```

**Two turns in the same project, minutes apart** [measured]:

| | Stalled turn | Healthy turn |
|---|---|---|
| Chunks | 5, all in the first 3.9 s | 254 over 22.1 s |
| Then | permanently silent, stream never closed | clean completion |
| Median inter-chunk gap | — | 30 ms |
| p95 / max gap | 1,750 ms before silence | 253 ms / 349 ms |
| Companion `POST /chat` | 524 after 125.3 s | 200 |
| Keepalive frames after the cut | **zero**, for the following 950 s | n/a |

**Root cause.** A1 — the proxied response body itself is wedged. The absence of
even a keepalive comment is the key evidence: the API injects an SSE keepalive
every 15 s, so if the break were above the keepalive generator those bytes would
have been captured. Nothing traversed the connection, so the break is below it.

**Fix.** A2 + A3. The recovery machinery described in B3 is already present and
sound; it simply cannot help while the transport is silently wedged.

## B2. Cloudflare's raw 524 HTML is rendered into the chat error banner

**Severity: high — this is the single most visible defect in the product.**

**Symptom.** The chat surface shows, in a red error banner:

```
<!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" ...
```

**Reproduce** [measured]. Trigger a hang per A1 and wait ~125 s for the 524.

**Root cause — the exact three-hop path** [code]:

1. `packages/shared-app/src/chat/auto-resuming-fetch.ts:110-111` passes a non-OK
   response straight through with no content-type check:
   ```ts
   const initialResponse = await baseFetch(input as any, init)
   if (!initialResponse.ok || !initialResponse.body) return initialResponse
   ```
2. The AI SDK turns the entire body into an error message —
   `node_modules/ai/dist/index.mjs` in `HttpChatTransport.sendMessages`:
   `if (!response.ok) throw new Error(await response.text() ?? '…')`.
3. `formatErrorMessage` (`packages/shared-app/src/chat/message-helpers.ts:85-104`)
   tries `JSON.parse`, tests a list of connection-error regexes, and otherwise
   **returns the string unchanged** — so the HTML reaches the banner rendered at
   `apps/mobile/components/chat/ChatPanel.tsx:2542-2547` and `:5288-5316`.

**Correction to the earlier write-up:** this lands in the **error banner**, not in
an assistant message bubble. Assistant bubbles render `part.text` from
`message.parts` (`AssistantContent.tsx:713-722`), which requires `text-delta`
chunks from a live 200 stream. The distinction matters because the fix belongs at
the transport boundary, not in the message renderer.

**Fix.** Gate on status and content-type in `auto-resuming-fetch.ts` around
line 110, before the response is passed to the SDK:

```ts
const ct = initialResponse.headers.get('content-type') ?? ''
if (!initialResponse.ok) {
  const body = await initialResponse.text().catch(() => '')
  const isHtml = ct.includes('text/html') || body.trimStart().startsWith('<!DOCTYPE')
  throw new Error(isHtml
    ? `The connection timed out (${initialResponse.status}). Tap Retry to continue.`
    : (body.slice(0, 200) || `HTTP ${initialResponse.status}`))
}
if (!initialResponse.body) return initialResponse
if (!ct.includes('text/event-stream') && !ct.includes('text/plain')) {
  throw new Error(`Unexpected response type: ${ct || '(none)'}`)
}
```

Add a defence-in-depth HTML check in `formatErrorMessage` before its final
`return cleaned`, and a regression test that feeds a Cloudflare 524 page through
the transport and asserts no markup reaches the UI.

## B3. Resume gives up on any non-200, and 404 means "wrong region"

**Severity: high.**

The client wraps every send in `packages/shared-app/src/chat/auto-resuming-fetch.ts`,
which will re-attach up to 8 times — but the loop stops on any non-200, and the
code itself documents 404 as the wrong-region case [code].

**Reproduce** [measured]. During a stalled turn, watch for
`GET /api/projects/:id/chat/:sessionId` returning **404 after 8.1 s and 9.0 s** —
the signature of a resume landing in a region that does not hold the turn buffer.

**Fix.** Treat 404 as *retryable against the correct region* rather than fatal:
resolve the owning region for the session (or route the resume through the peer
proxy explicitly) and retry there before giving up. A 404 from the wrong region
is not evidence that the buffer is gone.

## B4. The stall watchdog and the 524 race, and which wins depends on the phase

**Severity: medium.** More nuanced than the first pass claimed.

`apps/mobile/lib/chat-stall-watchdog.ts:58-59` defines **two** thresholds, and
`ChatPanel.tsx:3996-4050` polls every 15 s and calls `stop()` when either trips
[code]:

```ts
export const DEFAULT_SUBMITTED_STALL_MS = 120_000
export const DEFAULT_STREAMING_STALL_MS = 180_000
```

Which fires first depends on whether any bytes ever arrived:

| Phase | Threshold | vs the ~125 s 524 |
|---|---|---|
| `submitted`, no wire bytes at all | 120 s | **watchdog first** — the turn dies 5 s before the error that explains it |
| `streaming`, then silence | 180 s | **524 first** — the transport error arrives ~55 s earlier |

So the "torn down before the cause arrives" problem is real, but only for turns
that never produced a byte. The stalled turn I measured had 5 chunks before going
silent, which puts it in the second row.

Note also that the watchdog is suppressed while the tab is hidden
(`documentHidden` in `isChatStalled`), so a backgrounded tab will not recover on
its own.

**Fix.** Lower `DEFAULT_STREAMING_STALL_MS` below the edge timeout (110 s) so the
client always reacts before Cloudflare, and make the watchdog's action attempt a
resume rather than a bare `stop()`. Once A3 lands, the transport error arrives at
~10–20 s and the watchdog returns to being a genuine last resort.

---

# C. Preview / canvas pane

The trigger is A4. C1–C4 are the reasons one transient hang becomes a
permanently broken pane. All four are small, independent client fixes.

**Important:** preview traffic never touches the API. It goes visitor →
`*.preview.shogo.ai` wildcard → Cloudflare Worker (KV `projectId → region`) →
that region's Kourier → the project pod. `region-peer-proxy.ts` is not in the
path, so §A1/A2 cannot explain a blank preview.

## C1. Readiness is inferred from the API, never verified against the preview origin

**Severity: high.**

`usePreviewReadiness` in `apps/mobile/app/(app)/projects/[id]/_layout.tsx:3876`
latches on the API's same-origin `running` flag and deliberately does not probe
the preview host — the comment at `:3949` cites avoiding CORS console noise [code]:

```ts
// Gate the canvas iframe on the same-origin `running` signal (no cross-origin
// probe of the preview host → no CORS console noise). Until ready, this is
// null so the loading screen stays visible.
const readyCanvasBaseUrl = usePreviewReadiness(canvasBaseUrl, previewRunning)
```

The latch is also one-way and cached (`warmPreviewReadyCache`), so it never
recovers and a broken preview is re-shown instantly when switching back.

**Reproduce** [measured]. This is a clean, repeatable demonstration that
`ready: true` is not evidence the preview serves:

```js
const id = '2753be0c-21e1-4ddb-9bd5-972303b3be92';
const j = await (await fetch(`/api/projects/${id}/sandbox/url`, { credentials: 'include' })).json();
console.log(j.ready, j.status);                       // → true 'running'   (471 ms)
await probe(`${j.canvasBaseUrl}/?_v=0`, 1, 30000);     // → HANG at 30.7 s
await probe(`${j.canvasBaseUrl}/agent/canvas/bridge.js`, 1, 30000); // → 200 in 734 ms
```

The API reports the runtime running, another route on that very origin answers
in under a second, and the document the iframe needs never arrives.

**Fix.** Gate on the origin that is about to be embedded. `/agent/canvas/bridge.js`
is same-origin *to the iframe*, needs no token, and returns in ~1 s, so a real
probe is cheap and produces no CORS noise if performed from inside a hidden
frame — or simply let the iframe's own load succeed/fail drive readiness (C4)
and drop the pre-gate. Also make the latch two-way so a runtime restart
re-enters the loading state instead of showing a dead frame.

## C2. `canvas-ready` is posted before the app mounts, so the spinner clears too early

**Severity: high.** This is why the failure presents as a *silent white pane*
rather than a loading state.

`packages/agent-runtime/static/canvas-bridge.js:467-479` posts `canvas-ready`
from a deferred classic script, and its own comment notes this runs **before**
the user's ES module [code]:

```js
// The bridge runs as a deferred classic script, which executes BEFORE the
// user's ES module main.tsx. Posting canvas-ready here means the parent
// can push the theme before React's first paint, avoiding FOUC.
if (window.parent !== window) {
  window.parent.postMessage({ type: 'canvas-ready' }, '*')
}
```

So the message means "the bridge can receive messages", but the parent treats it
as "the preview is up" and hides the spinner.

**Reproduce** [measured]. Serve a preview where `index.html`, the CSS and
`bridge.js` load but `/assets/index-*.js` hangs (A4 does this on its own).
Result: a styled, empty, spinner-free white frame — `<div id="root">` never
populated. Both presentations were observed in this session: a permanent white
pane, and a permanent "Loading preview…" spinner when the document itself hung.

**Fix.** Separate the two signals. Keep `canvas-ready` for the theme handshake,
and add a distinct `canvas-mounted` posted from the app after React's first
commit. Clear the spinner on `canvas-mounted`; treat `canvas-ready` without a
following `canvas-mounted` within a few seconds as a failure.

## C3. A failed resource fetch inside the preview is invisible

**Severity: medium. One-character fix.**

`canvas-bridge.js:448` registers the error listener without capture [code]:

```js
window.addEventListener('error', function (e) { ... })
```

Resource-load errors (a `<script>` that fails to fetch) do not bubble — they
only reach `window` in the capture phase. So a hung or failed main bundle never
becomes a `canvas-error`, which means no error overlay and no Retry button.

**Fix.** `window.addEventListener('error', handler, true)`, and branch on
`e.target instanceof HTMLElement` to report the failing resource URL rather than
an empty message. This alone converts today's silent white pane into the error
overlay that already exists.

## C4. Nothing retries a failed iframe load

**Severity: high. Best value-for-effort fix in this section.**

`CanvasIframe` (`apps/mobile/components/canvas/CanvasWebView.tsx:216-228`) reads
no load or error state off the iframe; `loading` is cleared only by
`canvas-ready`, and the error overlay with its Retry button appears only on
`canvas-error` from an already-running bridge [code]. So a single transient hang
is permanent for the session, and the only escape is a manual page reload.

**Fix.** Add a watchdog next to the existing `refreshCount` state, which already
does exactly the right thing when bumped:

```tsx
// If neither `canvas-mounted` (C2) nor an onError arrives, reload the frame.
useEffect(() => {
  if (!loading) return
  const t = setTimeout(() => setRefreshCount(c => c + 1), 8000)
  return () => clearTimeout(t)
}, [loading, refreshCount])
```

Cap it (3 attempts, backing off) and surface the existing error overlay after
the cap so a genuinely dead runtime still reports itself.

## C5. `canvasBaseUrl` is returned without the preview token that `url` carries

**Severity: low — latent, not currently user-visible.**

`GET /api/projects/:id/sandbox/url` returns [measured]:

| Field | Carries `__preview_token`? |
|---|---|
| `url` | **yes** |
| `canvasBaseUrl` | no |
| `proxyUrl`, `directUrl`, `agentUrl` | no |

The canvas pane uses `canvasBaseUrl`, and because it has no query string,
`CanvasWebView.tsx:218` appends `?_v=0`, producing exactly the token-less URL
observed in the live DOM: `https://<id>.preview.shogo.ai/?_v=0`.

Today this is harmless — token-less requests to the preview root return 200
(verified: 4/4 no-token requests succeeded, and the runtime's own auth returns
**401**, not the 404 I first saw, which turned out to be a transient cold-start
artifact). But the two fields disagreeing is a trap: the moment the preview root
is actually gated, the canvas pane breaks while `previewUrl` keeps working.

**Fix.** Make the API mint one authenticated preview base and have both fields
derive from it, or document explicitly that the preview root is unauthenticated
by design and remove the token from `url`.

---

# D. Project open and cold boot

## D1. `/sandbox/url` reports `ready: true` while the preview root is wedged

Covered by C1 (client) and A4 (origin). Recording it separately because the API
contract is itself misleading: `ready` currently means "the runtime process
reports running", not "the preview serves". Any consumer will make the same
mistake the client made.

**Fix.** Either rename the field to something honest (`runtimeRunning`) or make
`ready` mean what it says by having the API verify the preview root before
returning true, with the result cached briefly.

## D2. A warm-pool miss blocks synchronously on a full cold boot

**Severity: high** for perceived speed.

Production routes every project to metal — `SHOGO_METAL_ALL_PROJECTS=true` is set
in `k8s/overlays/production-us/api-service.yaml:566-586` and the matching `-eu`
overlay (**not** in the base `production` overlay), read at
`apps/api/src/lib/metal-eligibility.ts:18-20`. In this mode every project is
eligible and there is deliberately **no Knative fallback** — a miss returns a
retryable 503 rather than silently landing elsewhere.

A pool miss then blocks on a full boot in the request path
(`apps/metal-agent/src/pool.ts:760-763`) [code]:

```ts
async assign(projectId: string, env: Record<string, string> = {}): Promise<AssignedVm> {
  let vm = this.claim()
  if (!vm) vm = await this.heavy.run(() => this.bootOne(false))
```

**Correction on pool depth.** `METAL_POOL_SIZE` defaults to **1** in code
(`apps/metal-agent/src/config.ts:66-67`), but production hosts are configured
outside this repo via `/etc/metal-agent.env`, and the two provisioning paths
disagree: `scripts/metal-agent/host-bootstrap.sh:222` writes **0**, while burst
cloud-init defaults to **6** (`metal-cloud-init.ts:111,126`). So the effective
production depth is unknown from the repo alone.

**Reproduce.** First confirm the actual value —
`grep METAL_POOL_SIZE /etc/metal-agent.env` on a production host — then open two
cold projects in the same region simultaneously and compare `/sandbox/url`
latency against a warm resume (7.4–7.8 s in my runs, which was the *lucky* warm
case).

**Fix.** Set `METAL_POOL_SIZE` explicitly to the same value on every host (4–8),
sized against host memory headroom, so the number is deliberate rather than a
by-product of which provisioning script ran.

## D3. Hydrate is slow for large archives — but the fixes I would have recommended are already in

**Severity: high. Read this before starting work here: three of the obvious
levers are already pulled.**

**Already fixed — do not re-recommend** [code]:

- **The 8.3 MiB/s assumption is gone.** `METAL_HYDRATE_TIMEOUT_PER_MIB_MS` was
  raised from 120 ms to **400 ms/MiB** (≈2.5 MiB/s) in commit `44538b893`, and
  `config.ts:179-183` documents exactly the reasoning — "at 120 ms/MiB it assumed
  8.3 MiB/s, which a 3 MB/s patch misses for anything over ~280 MiB — and hydrate
  is fail-closed, so an expired budget is not a slow boot but a project that
  cannot open."
- **Ranged/parallel hydration exists.** Commit `6bbe8d5b4` added
  `hydrate-proxy.ts` and `ranged-stream.ts`: the host fetches N-wide with ranged
  GETs and serves the guest a stream, with `applyArchive()` preferring the proxy
  over a direct presigned pull. Benchmarks in
  `scratch/recovery/bench-ranged-get.ts` measured host ranged GETs at roughly
  **5× guest single-stream** (1.5–10.6 MB/s), which is what motivated it.
- **`node_modules` is already excluded** from `project-src.tar.gz`
  (`packages/shared-runtime/src/s3-sync.ts:1005-1009` excludes `node_modules`,
  `.expo`, `.metro-cache`, `.expo-shared`). My earlier "cheapest lever: exclude
  node_modules" was simply wrong.

**What the >1 GB archives actually contain.** The runtime comment at
`packages/agent-runtime/src/server.ts:6233-6236` names them: the two projects past
the 1 GiB cap (1.85 GB and 1.77 GB) hold **generated video frames and downloaded
stock footage** — user content, not dependencies. `dist`, `.next`/`build` and
`.git` are also still included by the packer.

**The real remaining gap: the API gives up before hydrate can finish.**
`METAL_ASSIGN_TIMEOUT_MS` defaults to **30 s**
(`apps/api/src/lib/metal-warm-pool-controller.ts:219`), while the hydrate budget
is `60 s + 400 ms/MiB` capped at **30 minutes** (`pool.ts:1031-1035`, `:248`). For
a 1.8 GB archive the budget is ~12 minutes and the caller abandons at 30 seconds,
returning a retryable 503 while the boot continues in the background. That is the
mismatch users experience as "it never opens".

**Fix, in order.**
1. Deploy commits `44538b893` and `6bbe8d5b4` to production hosts if they are not
   there yet, and set `METAL_HYDRATE_PROXY_MAX` (default 12).
2. Reconcile `METAL_ASSIGN_TIMEOUT_MS` with the hydrate budget — either raise it,
   or better, return `202 Accepted` plus a poll/progress endpoint so a 12-minute
   hydrate is a *reported* wait instead of a timeout.
3. Archive hygiene targeting the actual bloat: quota or exclude large generated
   media, and stop packing reproducible `dist` output.
4. Make hydrate progress observable so a slow boot reports "hydrating, 340 MB of
   1.2 GB" instead of a generic stall (feeds D4).

## D4. "This is taking longer than expected" — no per-poll timeout

**Severity: medium** (user-reported symptom).

`useAgentUrl` (`packages/shared-app/src/hooks/useAgentUrl.ts`) polls
`/sandbox/url` on the schedule `[750, 1000, 1500, 2000, 3000]` ms (`:63-66`). The
fetch at `:230-234` does pass a `signal`, but it is the effect-teardown
controller — **there is no per-request timeout**, so one hung poll blocks the loop
for the full ~125 s. The stall timer at `:197-202` then fires at
`STALL_THRESHOLD_MS = 45_000` (`:84`) [code].

The copy is gated at `apps/mobile/app/(app)/projects/[id]/_layout.tsx:2571-2573`
and rendered at `:2783-2800`:

```ts
const stillBootingRuntime = !isLoading && !!project && !remoteProjectAgentBaseUrl && !runtimeReady
const showStalledRecovery = stillBootingRuntime && (runtimeStalled || !!runtimeError)
```

**Reproduce.** Hang a `/sandbox/url` poll (A1 or A4) and wait 45 s. Note the
endpoint already takes 7.4–7.8 s when healthy, so the headroom is small — and
`server.ts:2795` caps its server-side wait at 60 s, which is *above* the 45 s
client stall threshold. A single healthy-but-slow boot can therefore trip the
message before the server has even given up.

**Fix.** Give each poll its own budget and keep it below the server's wait:

```ts
signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
```

Treat a timeout as a retryable poll rather than a stall. Separately, make the copy
actionable — report the phase (`booting`, `hydrating`, `starting dev server`) using
D3's progress, because "taking longer than expected" tells the user nothing.

---

# E. Client performance

Cold load of the authenticated home screen, cache disabled [measured]:

| Metric | Value |
|---|---|
| `domContentLoaded` | 233 ms |
| `load` event | 1,426 ms |
| Time to first content (earlier run) | **10.4 s** |
| JS decoded, all scripts | **18.37 MB** across 7 scripts |
| API calls on the home screen | **19**, in 5 sequential waves |
| First API start → last API end | 424 ms → 2,653 ms |
| Per-call latency | 375–506 ms (upstream service time: 6–48 ms) |

The origin is not the bottleneck. It does its work in tens of milliseconds while
each call costs ~400 ms end to end.

## E1. A single 15.1 MB JS bundle with no route splitting

**Severity: high.** [measured]

| Script | Decoded |
|---|---|
| `index-*.js` | **15,461 KB** |
| `__common-*.js` | 2,683 KB |
| `fbevents.js` (Facebook Pixel) | 398 KB |
| Facebook pixel loader | 263 KB |
| `__expo-metro-runtime-*.js` | 4 KB |

The served HTML is a 3 KB Expo shell whose only content is three deferred
bundles. `load` fires at 1.4 s but first content took 10.4 s, so roughly **9 s
is script parse and execution**, not download.

**Root cause** [code]. `apps/mobile/app.json:30-34` sets the web bundler output
to `"single"`:

```json
"web": { "bundler": "metro", "output": "single", ... }
```

That produces one SPA bundle and makes route-level splitting impossible — the
`lazy: true` on the root stack (`app/_layout.tsx:203`) has no effect on the
production build, and there is no `React.lazy()` anywhere in app code. The
`__common` chunk is Metro's shared-dependency chunk for the few genuine dynamic
imports (Shiki, xterm, pickers), which are already done correctly and are the
pattern to extend.

The single largest avoidable contributor is `apps/mobile/lib/icon-interop.ts:19`,
imported unconditionally from the root layout:

```ts
import * as LucideIcons from 'lucide-react-native'
```

This registers **every** Lucide icon with no tree-shaking. Monaco is also pulled
in statically by the IDE panels (`components/project/panels/ide/CodeEditor.tsx`)
even though it is only reachable on a project route.

**Fix, in ascending effort.** Replace the wildcard Lucide import with a curated
per-icon registry; defer `monaco-cancellation-silencer` and the Monaco imports to
the IDE route; switch `output` to `"static"` so Expo Router emits per-route
chunks, then wrap `projects/[id]`, admin and analytics in `React.lazy()`. Also
defer the 661 KB of third-party trackers until after first paint.

## E2. 19 calls in 5 sequential waves

**Severity: medium.** [measured] The waves are clearly visible in the timeline —
each one waits a full round trip before the next begins:

| Wave | Start | Calls |
|---|---|---|
| 1 | 424 ms | `/api/version`, `/api/config`, `/api/auth/get-session` |
| 2 | 811 ms | `/api/me` |
| 3 | 1,285 ms | `/api/me` (again), `/api/workspaces`, `/api/invitations`, `/api/tech-stacks`, `/api/members`, `/api/platform/visible-models`, `/api/notifications/unread-count` |
| 4 | 1,714 ms | `/api/subscriptions`, `/api/billing/workspace-plan` ×2, `/api/usage-wallets`, `/api/projects`, `/api/workspaces` (again), `/api/members` (again) |
| 5 | 2,257 ms | `/api/billing/workspace-plan` (third) |

**Root cause** [code]. Two of the waves are avoidable serialisation:

1. `app/index.tsx:37-46` blocks the redirect into `/(app)` on `/api/me`, so the
   entire authenticated shell waits on an onboarding check.
2. `AppSidebar.tsx:1604-1617` chains projects *after* workspaces inside a
   `.then()`, even though `workspaceProjectFilter` can use the persisted
   `getActiveWorkspaceId()` immediately (`lib/project-load.ts:6-10`) without
   waiting for `loadAll` at all.

After auth, `/api/workspaces`, `/api/members`, `/api/me`, `workspace-plan` and
`/api/subscriptions` have **no cross-dependencies** and can all run together.

**Fix.** One parallel bootstrap (`Promise.all`) in `(app)/_layout.tsx`; drop the
sidebar's `.then()` chain in favour of the persisted workspace id; don't block the
redirect on the onboarding check; and collapse the billing/subscription/wallet
trio into one endpoint since they are always fetched together for one workspace.

## E3. Six duplicate requests per load

**Severity: medium.** [measured] Exactly reproduced across runs:

| Endpoint | Times called |
|---|---|
| `/api/me` | 2 |
| `/api/workspaces` | 2 |
| `/api/members` | 2 |
| `/api/billing/workspace-plan` | **3** |

`workspace-plan` is called with two different parameter shapes
(`?workspaceId=` and `?workspaceIds=`), which confirmed two independent hooks
fetching the same thing.

**Root cause** [code]. Not React Query and not StrictMode — it is **two
independent mount-time loaders plus an effect re-run**. `AppSidebar` and the home
screen each bootstrap the same data:

| Endpoint | Call sites |
|---|---|
| `/api/me` | `app/index.tsx:40` (onboarding gate) and `AppSidebar.tsx:1591` (admin check); possibly a third via `use-is-super-admin.ts:29` |
| `/api/workspaces` | `AppSidebar.tsx:1608` and `app/(app)/index.tsx:307` |
| `/api/members` | `app/(app)/index.tsx:305-308`, duplicated by the effect re-running |
| `workspace-plan` | `useBillingData` in **both** `AppSidebar.tsx:1675` and `index.tsx:335`, plus a batch `getWorkspacePlans` at `AppSidebar.tsx:1766` |

The home effect re-runs when `currentWorkspace?.id` changes
(`index.tsx:334` deps), which is what produces the second wave of workspace,
member and project fetches.

**Fix.** Hoist the bootstrap into one place — `(app)/_layout.tsx` or a dedicated
provider — and have the sidebar and home read from the store instead of fetching.
Call `useBillingData` once and pass it down by context. At ~400 ms per call this
is roughly 1.5 s of trivially recoverable latency.

## E4. The client requests the entire projects list even though the API paginates

**Severity: high, and the fix is client-only.** [measured]

`GET /api/projects` returns `{ ok, items, total }` with **all 55 projects and a
155,146-byte payload**. The API *does* honour pagination — the client simply
never sends it:

| Request | Payload |
|---|---|
| `/api/projects` | 155,146 bytes |
| `/api/projects?limit=5&offset=0` | 6,716 bytes |

**Reproduce.**

```js
const a = await (await fetch('/api/projects', { credentials: 'include' })).text();
const b = await (await fetch('/api/projects?limit=5', { credentials: 'include' })).text();
console.log(a.length, b.length);   // 155146 6716
```

**Root cause** [code]. The API supports `limit`, `offset` and `orderBy`
(`apps/api/src/generated/project.routes.ts:171-182`) and the client even has a
paginated loader — `loadPage` with a default limit of 50
(`packages/domain-stores/src/project.collection.ts:174-177`). The list screens
just don't use it: `loadAll` builds its URL from the filter alone with no bounds
(`project.collection.ts:127-129`), and it is called from
`AppSidebar.tsx:1614` and `app/(app)/index.tsx:306`, plus again on every workspace
switch (`AppSidebar.tsx:1652, 1784, 1816`).

The `beforeList` hook also joins on every row
(`apps/api/src/generated/project.hooks.ts:112-117`), which is where E6 comes from:

```ts
return { ok: true, data: { where: { workspaceId }, include: { workspace: true, folder: true } } }
```

**The composite index does not exist** — `prisma/schema.prisma:319-323` has
`@@index([workspaceId])` and `@@index([createdAt])` as *separate* indexes, so an
ordered per-workspace page cannot be served from one index.

**Fix.** Switch the sidebar and home to `loadPage({ workspaceId }, { limit: 50 })`
(they render 5 rows before the toggle — see F4), default `orderBy` to
`{ createdAt: 'desc' }` in the hook when `workspaceId` is present, and add
`@@index([workspaceId, createdAt(sort: Desc)])`.

## E5. Base64 PNG thumbnails are inlined into the list payload — 48.7% of the bytes

**Severity: high.** This is the single largest concrete win on this screen. [measured]

Only **2 of 55** projects have a thumbnail, but each is a **~37 KB
`data:image/png;base64,…` URI embedded directly in the JSON**. Those two rows
account for **75,540 bytes — 48.7% of the whole response**.

```js
const j = await (await fetch('/api/projects', { credentials: 'include' })).json();
const t = j.items.find(i => i.thumbnailUrl).thumbnailUrl;
console.log(t.slice(0, 32), t.length);   // "data:image/png;base64,iVBORw0KGg" 37194
```

**Fix.** Store thumbnails in object storage and return a URL. Failing that, omit
`thumbnailUrl` from list responses entirely and fetch it per-card on demand. A
data URI also defeats HTTP caching, so today every load re-downloads both images
inside a JSON body that cannot be cached independently.

## E6. The full workspace object is duplicated onto all 55 rows — 12.4% of the bytes

**Severity: medium.** [measured] There are only **2 distinct workspace objects**
across 55 rows, yet the join is serialised on every row: **19,300 bytes, 12.4%**
of the response. It includes fields a list cannot use, such as `ssoSettings`,
`composioScope` and `homeRegion`.

**Fix.** Return `workspaceId` on each row and the workspace objects once in a
sibling map, or select only `{ id, name, slug }` for list responses.

Together, E5 and E6 are **61% of a 155 KB payload the client requests on every
load and does not need.**

## E7. Wasted calls: `/api/local/*` in the cloud, and a 9-second 404

**Severity: low.** [measured] Each wasted call costs a full ~400 ms round trip and
adds console noise that hides real errors.

**Root cause** [code]. The server only mounts `/api/local/*` when
`SHOGO_LOCAL_MODE === 'true'` (`apps/api/src/server.ts:1031-1046`), so in cloud
these 404. Most client call sites are correctly gated on
`usePlatformConfig().localMode` — but two are not:

- `apps/mobile/app/(app)/projects/[id]/_layout.tsx:686-692` — `refreshLocalProject`
  fires on **every project mount** (`:718-722`). Its comment claims it is a "no-op
  outside `SHOGO_LOCAL_MODE`", but the request still goes out.
- `apps/mobile/.../SecuritySettingsPanel.tsx:23` — unguarded on mount.

So this does not affect the pure home screen; it affects every project open, which
is the slow path that least needs an extra round trip.

The 9-second 404 is separate: `ChatPanel.tsx:1193-1198` calls `loadById` for a
`chatSessionId` that can come from a stale URL param or a stale
`shogo:lastChatSession:${projectId}` AsyncStorage key pointing at a deleted
session.

**Fix.** Add the same `localMode` early-return used by `CloudSyncStatusPill.tsx:90`
to both unguarded sites. For the chat 404, clear the stored session id when a
`loadById` 404s so the next open doesn't repeat it.

---

# F. UX defects

## F1. A successful sign-in does not navigate away from `/sign-in`

**Severity: high** — it reads as a failed login.

**Symptom** [measured]. After submitting valid credentials, the tab stayed on
`/sign-in` with a valid session cookie already set. Manual navigation was
required.

**Key diagnostic** [measured]: loading `/sign-in` *while already authenticated*
**does** redirect. So the guard exists and works; what fails is the state it
depends on.

**Root cause** [code]. A redirect *is* implemented — `sign-in.tsx:62` calls
`router.replace(resolveNext())`, and `resolveNext()` returns `'/'` by default
(`:37-42`). But `/` is `app/index.tsx`, which only forwards to `/(app)` when
`isAuthenticated` is true (`:70-84`), and `isAuthenticated` is `!!user`
(`AuthProvider.tsx:257`) — **not "a session cookie exists"**.

The email sign-in path only populates `user` when the response happens to include
it (`AuthProvider.tsx:118`):

```ts
if (data?.user) setUser(data.user as AuthUser)
```

The Google and Apple handlers fall back to `getSession()` when `data.user` is
absent (`AuthProvider.tsx:188-189`, `217-218`); **email does not**. So when Better
Auth sets the cookie but omits `data.user`, you get: cookie valid,
`isAuthenticated` false, `router.replace('/')` → `index.tsx` bounces straight back
to `/(auth)/sign-in`. Nothing is hung; the auth state is simply desynced from the
cookie. The same gap explains why the guard in `(auth)/_layout.tsx:18-20` can
render the form for a user who is actually signed in.

**Fix.** Mirror the OAuth paths — in `AuthProvider.handleSignIn`, if `data?.user`
is missing after a successful `signIn.email`, call `authClient.getSession()` and
set the user from that. Then in `sign-in.tsx`, navigate to `/(app)` directly
rather than via the `/` gate, so a single stale render cannot bounce the user
back.

## F2. Enter does not send in the project chat composer

**Severity: high** — it is the primary interaction in the product.

**Symptom** [measured]. In the **project** composer, pressing Enter left the text
in the box; clicking Send was required. In the **home** composer, Enter did
submit (after a delay). Same session, same browser.

**Reproduce.** Open a project, type into the composer, press Enter, and observe
that the text remains and no `/chat` request is issued. Compare with the home
screen composer.

**Root cause — it is not the key handling** [code]. Both composers have
effectively identical `onKeyPress` handlers that intercept unshifted Enter and
call `handleSubmit()`. The difference is *what `handleSubmit` reads*:

| | Home (`CompactChatInput.tsx`) | Project (`ChatInput.tsx`) |
|---|---|---|
| Displayed text | controlled `value` | `pendingTextChangeRef.current?.text ?? inputValue` (`:1086-1089`) |
| Submitted text | `value.trim()` (`:440`) | `inputValue.trim()` (`:1118`) |
| In sync? | yes | **no** |

The project composer coalesces typing: it writes to `inputValueRef.current`
immediately but defers the `inputValue` state commit to the next animation frame
(`ChatInput.tsx:1261-1276`). The composer *displays* the ref, but `handleSubmit`
*reads the state*. Press Enter before the frame commits and `inputValue` is still
empty, so the guard at `:1118-1129` early-returns — the text stays visible and
nothing is sent. Clicking Send later works because by then the frame has flushed.

This also explains why the home composer was fine: it has no coalescing, so
`value` and its ref never diverge.

**Fix.** One line at `ChatInput.tsx:1118` — submit from the same source the user
can see:

```ts
const trimmedContent = (pendingTextChangeRef.current?.text ?? inputValue).trim()
```

Flush or cancel the pending change before submitting so the cleared input does not
get re-applied, and align the Send button's enabled state (`ChatInput.tsx:2345`)
to the same source. Add a test that types and immediately submits within one
frame. Note both composers rely solely on `onKeyPress` — on React Native Web,
`onSubmitEditing` does not fire for Enter on a multiline input with
`blurOnSubmit={false}` — so adding an `isComposing` guard is still worthwhile for
IME users.

## F3. Auto-naming failures leave projects called "New Project" (and worse)

**Severity: medium** — it is why the sidebar is unusable.

**Symptom** [measured]. **6 of 55** projects are literally named `New Project`,
two of which have `lastMessageAt: null` and were created 18 seconds apart. One
project is named **`Debug: runtime error`**, auto-named from an
error-report message rather than from user intent.

**Root cause — four independent ways to land on "New Project"** [code]:

1. The draft is created with the name hardcoded (`app/(app)/index.tsx:475-477`),
   so it is the starting state rather than a fallback.
2. The client heuristic itself returns `"New Project"` when the prompt has no
   meaningful words (`index.tsx:115`), as does the server's fallback
   (`apps/api/src/server.ts:6292-6294`).
3. The AI rename is fire-and-forget with **no timeout and no retry**
   (`index.tsx:614-631`), and `HttpClient` uses a bare `fetch` with no timeout
   (`packages/sdk/src/http/client.ts:228-234`). There is no server-side timeout on
   the title model either, so this call can run until the edge kills it — which is
   exactly the 524 and the 84.8 s retry I measured.
4. **Renaming from the project chat updates the session, not the project.**
   `ChatPanel.tsx:2325-2344` writes the generated name to
   `updateChatSession(..., { inferredName })`. The server *can* persist to the
   project when passed a `projectId` (`server.ts:6388-6398`), but **no client
   caller passes it**.

That fourth point is why sending messages to a badly-named project never fixes
the name.

**Fix.** Pass `projectId` through `api.generateProjectName` so the server persists
the rename; have `ChatPanel` also call `actions.updateProject`; add
`AbortSignal.timeout(15_000)` plus one retry on the client call; and use the
heuristic name at draft creation instead of hardcoding `'New Project'`. Separately,
exclude system-generated messages (canvas error reports, `🐞` diagnostics) from the
naming input — that is how a project ended up called `Debug: runtime error`.

## F4. The sidebar caps the project list at 5

**Severity: low.**

`apps/mobile/components/layout/AppSidebar.tsx:399` sets
`MAX_VISIBLE_PROJECTS = 5`; overflow collapses behind a "N more" toggle at
`:2037-2051`, with pinned projects and the currently-open project always forced
into view (`:1740-1752`) [code].

**Correction to the earlier write-up:** the "15 more" label is *correct*, not
stale. `hiddenProjectCount` is derived from `workspaceProjects`, which is scoped
to the active workspace — 20 projects there, 5 shown, 15 hidden. The 55 from E4
is the unscoped total across both workspaces in the account, so the two numbers
were never measuring the same thing.

**Fix.** Raise `MAX_VISIBLE_PROJECTS` (20 is a reasonable default), or default
`showAllProjects` to true on wide layouts where the vertical space exists. The
home screen's empty area is a separate opportunity to surface recent work.

---

## Suggested order of work

**One-line and near-one-line changes, all independently shippable:**

1. **A2** — hoist `keepalive: false` out of the `hasBody` ternary. Directly targets
   a documented Bun bug that the file itself already explains.
2. **F2** — submit from `pendingTextChangeRef.current ?? inputValue` at
   `ChatInput.tsx:1118`. Fixes Enter-to-send, the primary interaction in the product.
3. **C3** — add `true` to the bridge's error listener so failed resource loads
   surface in the error overlay that already exists.
4. **E5** — stop inlining base64 thumbnails in list responses. Removes 48.7% of the
   projects payload.
5. **E4** — pass `limit` from the list screens, and add the
   `(workspaceId, createdAt)` composite index that does not currently exist.

**Then, in order of impact:**

6. **A3** — bound the peer proxy with timeout + retry + breaker, matching what the
   agent proxy and chat upstream already do. Converts a 125 s dead request into a
   fast retry and de-risks everything in B.
7. **B2** — gate on status and content-type in `auto-resuming-fetch.ts` so
   Cloudflare HTML can never reach the UI.
8. **A4 confirmation** — get origin-side logs for the runtime hang. This is the
   second root cause, it is still unattributed, and everything in C is only
   mitigation for it.
9. **C4 + C2** — preview reload watchdog and a real `canvas-mounted` signal. Turns
   a permanently broken pane into a brief flicker.
10. **F1** — add the `getSession()` fallback to email sign-in and navigate to
    `/(app)` directly.
11. **D3** — reconcile `METAL_ASSIGN_TIMEOUT_MS` (30 s) with the hydrate budget
    (up to 30 min). The throughput and budget fixes are already committed; this
    mismatch is the remaining gap.
12. **F3** — pass `projectId` to the naming endpoint so a rename can actually
    persist, and stop naming projects after crash reports.
13. **E3 + E2** — hoist the bootstrap into one parallel load and drop the
    duplicates. ~1.5 s.
14. **E1** — trim the wildcard Lucide import first (cheap), then move web output
    off `"single"` and lazy-load the project route. ~9 s of parse time at stake.
15. **A5** — define the edge budget once and put it in version control.

[oven-sh/bun#32847]: https://github.com/oven-sh/bun/issues/32847
