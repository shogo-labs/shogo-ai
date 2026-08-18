// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Preview loader page — the warm-hostname landing page for a preview link.
 *
 * The preview-router Worker (terraform/modules/preview-router) already swaps an
 * ingress 404/503 for a "waking up" interstitial, but it can only do that for a
 * request that REACHED the edge. It sits behind DNS, TLS and the Worker route of
 * `{projectId}.preview.<base>` — a hostname unique to one project. If any of
 * those fail (no wildcard record, cert not active, a resolver caching an old
 * NXDOMAIN), the browser paints its own "server IP address could not be found"
 * error and no code of ours gets a say.
 *
 * So a preview link points here instead — an anonymous page on the API origin,
 * a hostname every client has already resolved and every app request keeps warm.
 * It renders the waking state immediately, polls `/api/preview/{id}/wake` for
 * backend readiness, and only hands off to the preview origin once the browser
 * has PROVEN it can reach it (see the reachability probe in the inline script).
 * Every failure mode — cold pod, missing DomainMapping, edge or DNS trouble —
 * therefore shows the same recoverable Shogo UI rather than a browser error.
 *
 * Served by `GET /api/preview/:projectId/open` in server.ts. Kept dependency-
 * free (no bundle, no external asset) so the page renders even when nothing
 * else about the project is healthy, and visually matched to the Worker's
 * interstitial so a hand-off mid-wake isn't a jarring change.
 */

export interface PreviewLoaderPageOptions {
  /** Absolute url on the preview origin the browser should end up on. */
  targetUrl: string
  /** Same-origin path the page polls for backend readiness. */
  wakeUrl: string
  /**
   * Absolute url on the preview ORIGIN used purely as a reachability probe.
   * `/__shogo/wake` is the Worker's own control endpoint, so it answers even
   * when the project's pod is still cold.
   */
  probeUrl: string
  /** Preview hostname, shown under the spinner. */
  label: string
}

/** Inline a value into a <script> without letting it close the tag. */
function jsonForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PAGE_STYLE = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea}
.card{width:100%;max-width:380px;padding:40px 32px;text-align:center}
.spin{width:38px;height:38px;margin:0 auto 22px;border:3px solid #2a2a33;border-top-color:#6d5cff;
border-radius:50%;animation:s 0.9s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
h1{font-size:17px;margin:0 0 8px;font-weight:600}
p{font-size:13px;color:#9a9aa5;margin:0;line-height:1.5}
.host{margin-top:14px;font-size:11px;color:#6f6f7a;font-family:ui-monospace,monospace;word-break:break-all}
button{margin-top:20px;padding:8px 16px;font-size:12px;font-weight:600;color:#e7e7ea;
background:#1a1a22;border:1px solid #2a2a33;border-radius:8px;cursor:pointer;font-family:inherit}
button:hover{background:#22222c}
a{color:#9a8cff}
@media(prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
`

/**
 * The waking page. Polls for readiness, verifies the preview origin is
 * reachable from THIS browser, then replaces itself with the preview.
 */
export function renderPreviewLoaderPage(opts: PreviewLoaderPageOptions): string {
  const { targetUrl, wakeUrl, probeUrl, label } = opts
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Waking up · Shogo</title>
<style>${PAGE_STYLE}</style></head>
<body><main class="card" role="status" aria-live="polite">
<div class="spin"></div>
<h1 id="title">Waking things up</h1>
<p id="message">This preview went to sleep after sitting idle. It is starting back up &mdash; this usually takes a few seconds.</p>
<div class="host">${escapeHtml(label)}</div>
<button id="retry" type="button" hidden>Try again now</button>
<noscript><p>Enable JavaScript, or <a href="${escapeHtml(targetUrl)}">open the preview directly</a>.</p></noscript>
</main>
<script>(function(){
  var TARGET = ${jsonForScript(targetUrl)};
  var WAKE = ${jsonForScript(wakeUrl)};
  var PROBE = ${jsonForScript(probeUrl)};

  // Cold Knative starts run to ~180s and a metal microVM resume can be slower,
  // so we never give up — we only soften the copy as the wait grows.
  var SLOW_MS = 30000;
  var VERY_SLOW_MS = 120000;

  var started = Date.now();
  var attempt = 0;
  var timer = null;
  var titleEl = document.getElementById('title');
  var messageEl = document.getElementById('message');
  var retryEl = document.getElementById('retry');

  function say(text){ if (messageEl && messageEl.textContent !== text) messageEl.textContent = text; }

  function waitingMessage(unreachable){
    var waited = Date.now() - started;
    if (unreachable) return 'Almost ready \\u2014 waiting for the preview address to answer.';
    if (waited > VERY_SLOW_MS) return 'Still starting. A cold build can take a couple of minutes; this page moves on by itself.';
    if (waited > SLOW_MS) return 'Taking a little longer than usual. Hang tight \\u2014 this page moves on by itself.';
    return 'This preview went to sleep after sitting idle. It is starting back up \\u2014 this usually takes a few seconds.';
  }

  // Can THIS browser reach the preview origin at all? A no-cors response is
  // opaque (we cannot read it), but the promise still rejects on a DNS, TLS or
  // connection failure — which is the only thing we need to know. Redirecting
  // without checking is what puts a browser error page on screen.
  function reachable(){
    return fetch(PROBE, { mode: 'no-cors', cache: 'no-store' }).then(
      function(){ return true },
      function(){ return false }
    );
  }

  function schedule(unreachable){
    say(waitingMessage(unreachable));
    if (retryEl && Date.now() - started > SLOW_MS) retryEl.hidden = false;
    timer = setTimeout(poll, Math.min(1000 + attempt * 250, 3000));
  }

  function stop(heading, text){
    if (timer) clearTimeout(timer);
    var spinner = document.querySelector('.spin');
    if (spinner && spinner.parentNode) spinner.parentNode.removeChild(spinner);
    if (retryEl) retryEl.hidden = true;
    if (titleEl) titleEl.textContent = heading;
    say(text);
  }

  function poll(){
    attempt++;
    fetch(WAKE, { cache: 'no-store' })
      .then(function(res){
        if (res.status === 404) return { missing: true };
        return res.ok ? res.json() : { ready: false };
      })
      .then(function(data){
        if (data && data.missing) {
          stop('Preview not found', 'This project no longer exists, or the link is incomplete.');
          return;
        }
        if (!data || data.ready !== true) { schedule(false); return; }
        return reachable().then(function(ok){
          if (ok) window.location.replace(TARGET);
          else schedule(true);
        });
      })
      .catch(function(){ schedule(false); });
  }

  if (retryEl) retryEl.addEventListener('click', function(){
    if (timer) clearTimeout(timer);
    attempt = 0;
    poll();
  });

  poll();
})();</script>
</body></html>`
}

/** Shown when the project id in a preview link doesn't resolve. */
export function renderPreviewMissingPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Preview not found · Shogo</title>
<style>${PAGE_STYLE}</style></head>
<body><main class="card">
<h1>Preview not found</h1>
<p>This project no longer exists, or the link is incomplete.</p>
</main></body></html>`
}
