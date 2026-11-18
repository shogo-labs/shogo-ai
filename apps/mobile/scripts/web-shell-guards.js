// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared web-shell guards (SHO-405).
 *
 * Everything the phone web shell needs to refuse zoom and landscape — the CSS,
 * the rotate prompt markup and the pinch guard script — lives here.
 *
 * Why the duplication of purpose: `app/+html.tsx` renders all three, but the
 * deployed `dist/index.html` is produced by Expo's "single" export, which strips
 * `<script>` tags (and has stripped other `+html.tsx` customizations) from that
 * file. `scripts/inject-analytics.js` therefore re-injects anything that did not
 * survive, reading the same strings from this module, so the two paths cannot
 * drift.
 *
 * CommonJS on purpose: `inject-analytics.js` runs under plain `node`.
 */

/** Attribute used both as the marker that the guard is already present and as the script's data attribute. */
const ZOOM_GUARD_ATTRIBUTE = 'data-shogo-zoom-guard'

/** `id` of the `<style>` carrying {@link PHONE_VIEWPORT_GUARD_CSS}. */
const PHONE_GUARD_STYLE_ID = 'shogo-phone-viewport-guard'

/** `id` of the landscape rotate prompt. */
const LANDSCAPE_OVERLAY_ID = 'shogo-lock-portrait'

/**
 * CSS for the phone viewport guard (SHO-405).
 *
 * - `touch-action: pan-x pan-y` on `html` drops pinch-zoom and
 *   double-tap-zoom for everything below it, so no per-input or per-screen
 *   handling is needed.
 * - iOS still auto-zooms when a focused input's font-size is under 16px;
 *   raising every form control to 16px on coarse pointers fixes all ~30
 *   `TextInput` call sites at once instead of editing each one.
 * - Phones in landscape get the rotate prompt. A browser tab cannot be locked
 *   to portrait (the Screen Orientation API needs fullscreen or an installed
 *   Android PWA and is unsupported on iOS Safari), so covering the app is the
 *   only thing that works. Tablets and desktop keep landscape.
 */
const PHONE_VIEWPORT_GUARD_CSS = `html{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (pointer:coarse){input:not([type=checkbox]):not([type=radio]),textarea,select{font-size:max(16px,1em)!important}}
#shogo-lock-portrait{display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;box-sizing:border-box;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background-color:#FFFFFF;color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none}
html.dark #shogo-lock-portrait{background-color:#121212;color:#F5F5F5}
#shogo-lock-portrait svg{width:56px;height:56px;opacity:0.75}
#shogo-lock-portrait .shogo-lock-portrait-title{font-size:17px;font-weight:600;line-height:1.3}
#shogo-lock-portrait .shogo-lock-portrait-body{font-size:14px;line-height:1.4;max-width:280px;opacity:0.65}
@media (orientation:landscape) and (max-height:500px) and (pointer:coarse){#shogo-lock-portrait{display:flex}}`

/**
 * Blocks pinch-zoom on phones without touching desktop.
 *
 * iOS Safari ignores `user-scalable=no` / `maximum-scale=1` for pinch (since
 * iOS 10), so `gesturestart`/`touchmove` interception is the only thing that
 * actually stops it there. Everything is gated on `(pointer: coarse)` so a
 * desktop browser keeps its own zoom (ctrl/⌘ + wheel, trackpad pinch).
 */
const ZOOM_GUARD_SCRIPT = `(function(){
  try {
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
    var block = function (event) { if (event.cancelable !== false) event.preventDefault(); };
    var active = { passive: false, capture: true };

    // iOS Safari: WebKit fires its own non-standard gesture events for pinch.
    document.addEventListener('gesturestart', block, active);
    document.addEventListener('gesturechange', block, active);
    document.addEventListener('gestureend', block, active);

    // Everywhere else pinch arrives as a two-finger touchmove. The blocking
    // listener is only attached while two or more fingers are down: a
    // permanent non-passive touchmove handler on \`document\` would make the
    // browser wait on JS for every scroll.
    var guardMove = function (event) {
      if (event.touches && event.touches.length > 1) block(event);
    };
    var detach = function () { document.removeEventListener('touchmove', guardMove, active); };
    document.addEventListener('touchstart', function (event) {
      if (event.touches && event.touches.length > 1) document.addEventListener('touchmove', guardMove, active);
    }, { passive: true, capture: true });
    document.addEventListener('touchend', function (event) {
      if (!event.touches || event.touches.length < 2) detach();
    }, { passive: true, capture: true });
    document.addEventListener('touchcancel', detach, { passive: true, capture: true });

    // Trackpad/ctrl pinch on devices that report a coarse primary pointer.
    document.addEventListener('wheel', function (event) {
      if (event.ctrlKey) block(event);
    }, active);

    // Only an installed (standalone) PWA can hold an orientation lock; a plain
    // browser tab cannot, so this is best-effort by design.
    var standalone = (window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    if (standalone && window.screen && window.screen.orientation && window.screen.orientation.lock) {
      var pending = window.screen.orientation.lock('portrait');
      if (pending && pending.catch) pending.catch(function () {});
    }
  } catch (e) {}
})();`

/**
 * The landscape rotate prompt. Hidden by CSS until a coarse-pointer phone is in
 * landscape, then it covers the app (see `PHONE_VIEWPORT_GUARD_CSS`) — a browser
 * tab cannot be locked to portrait, so covering it is the only thing that works.
 */
const LANDSCAPE_OVERLAY_HTML = `<div id="${LANDSCAPE_OVERLAY_ID}" role="status" aria-live="polite"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7.25" y="2.25" width="9.5" height="19.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.25h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.2 9.4a6.2 6.2 0 0 1 3.1-3.05" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.6 5.9v3.6h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="shogo-lock-portrait-title">Rotate your phone</div><div class="shogo-lock-portrait-body">Shogo is built for portrait on phones — turn your phone upright to keep going.</div></div>`

module.exports = {
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  LANDSCAPE_OVERLAY_ID,
  LANDSCAPE_OVERLAY_HTML,
}
