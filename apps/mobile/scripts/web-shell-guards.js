// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Shared web-shell guards (SHO-405).
 *
 * Everything the phone web shell needs to refuse zoom and landscape — the media
 * query, the CSS, the rotate prompt markup, the viewport meta and the pinch
 * guard script — lives here, because the shell is built twice:
 *
 * - `app/+html.tsx` renders it (the dev server, and the shell for any future
 *   `web.output: "static"` export);
 * - the deployed `dist/index.html` is produced by Expo's **"single"** export,
 *   which ignores `+html.tsx` entirely, so `scripts/inject-analytics.js` builds
 *   the same head/body from these strings after the export.
 *
 * CommonJS on purpose: `inject-analytics.js` runs under plain `node`.
 */

/**
 * What counts as "a phone": a touch device with a phone-sized viewport, in
 * either orientation. Bounding it matters — `(pointer: coarse)` alone also
 * matches iPads and touch laptops, which must keep their pinch zoom and their
 * own type sizes (Russell: lock phones only). Both the CSS and the script use
 * this one string so they cannot disagree.
 */
const PHONE_MEDIA_QUERY = '(pointer: coarse) and (max-width: 600px), (pointer: coarse) and (max-height: 500px)'

/**
 * `content` for the viewport meta.
 *
 * Deliberately **not** `maximum-scale=1` / `user-scalable=no`: this meta is
 * global, so those two tokens would also block real pinch at tablet size in
 * Blink (measured with CDP `Input.synthesizePinchGesture`: an iPad stayed at
 * `visualViewport.scale` 1 with them and reached 2 without them, while the
 * phone stayed at 1 either way because {@link PHONE_VIEWPORT_GUARD_CSS} and
 * {@link ZOOM_GUARD_SCRIPT} already hold it). The phone lock therefore lives
 * only in the gated CSS + script, and tablets keep their pinch zoom.
 * `viewport-fit=cover` keeps the notch layout; `shrink-to-fit=no` is iOS 9 legacy.
 */
const VIEWPORT_META_CONTENT =
  'width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover'

/** Attribute used both as the marker that the guard is already present and as the script's data attribute. */
const ZOOM_GUARD_ATTRIBUTE = 'data-shogo-zoom-guard'

/** `id` of the `<style>` carrying {@link PHONE_VIEWPORT_GUARD_CSS}. */
const PHONE_GUARD_STYLE_ID = 'shogo-phone-viewport-guard'

/** `id` of the landscape rotate prompt. */
const LANDSCAPE_OVERLAY_ID = 'shogo-lock-portrait'

/**
 * Blocks pinch-zoom on phones without touching iPads or desktop.
 *
 * iOS Safari ignores `user-scalable=no` / `maximum-scale=1` for pinch (since
 * iOS 10), so `gesturestart`/`touchmove` interception is the only thing that
 * actually stops it there. Every handler re-reads the phone query, so a rotate
 * or a resize (a phone in a small browser window, an iPad in Slide Over) takes
 * effect immediately without re-registering listeners.
 */
const ZOOM_GUARD_SCRIPT = `(function(){
  try {
    var PHONE = '${PHONE_MEDIA_QUERY}';
    if (!window.matchMedia) return;
    var isPhone = function () { return window.matchMedia(PHONE).matches; };
    var block = function (event) { if (event.cancelable !== false) event.preventDefault(); };
    var active = { passive: false, capture: true };

    // iOS Safari: WebKit fires its own non-standard gesture events for pinch.
    var onGesture = function (event) { if (isPhone()) block(event); };
    document.addEventListener('gesturestart', onGesture, active);
    document.addEventListener('gesturechange', onGesture, active);
    document.addEventListener('gestureend', onGesture, active);

    // Everywhere else pinch arrives as a two-finger touchmove. The blocking
    // listener is only attached while two or more fingers are down: a
    // permanent non-passive touchmove handler on \`document\` would make the
    // browser wait on JS for every scroll.
    var guardMove = function (event) {
      if (event.touches && event.touches.length > 1 && isPhone()) block(event);
    };
    var detach = function () { document.removeEventListener('touchmove', guardMove, active); };
    document.addEventListener('touchstart', function (event) {
      if (event.touches && event.touches.length > 1 && isPhone()) document.addEventListener('touchmove', guardMove, active);
    }, { passive: true, capture: true });
    document.addEventListener('touchend', function (event) {
      if (!event.touches || event.touches.length < 2) detach();
    }, { passive: true, capture: true });
    document.addEventListener('touchcancel', detach, { passive: true, capture: true });

    // Trackpad/ctrl pinch on devices that report a coarse primary pointer.
    document.addEventListener('wheel', function (event) {
      if (event.ctrlKey && isPhone()) block(event);
    }, active);

    // Only an installed (standalone) PWA can hold an orientation lock; a plain
    // browser tab cannot, so this is best-effort by design.
    var standalone = (window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    if (standalone && isPhone() && window.screen && window.screen.orientation && window.screen.orientation.lock) {
      var pending = window.screen.orientation.lock('portrait');
      if (pending && pending.catch) pending.catch(function () {});
    }
  } catch (e) {}
})();`

/**
 * CSS for the phone viewport guard (SHO-405), gated on {@link PHONE_MEDIA_QUERY}.
 *
 * - `touch-action: pan-x pan-y` drops pinch-zoom and double-tap-zoom for
 *   everything below `html`, so no per-input or per-screen handling is needed.
 * - iOS still auto-zooms when a focused input's font-size is under 16px;
 *   raising every form control to 16px on phones fixes all ~30 `TextInput`
 *   call sites at once instead of editing each one.
 * - Phones in landscape get the rotate prompt below. A browser tab cannot be
 *   locked to portrait (the Screen Orientation API needs fullscreen or an
 *   installed Android PWA and is unsupported on iOS Safari), so covering the
 *   app is the only thing that works.
 */
const PHONE_VIEWPORT_GUARD_CSS = `@media ${PHONE_MEDIA_QUERY}{html{touch-action:pan-x pan-y;-webkit-text-size-adjust:100%;text-size-adjust:100%}input:not([type=checkbox]):not([type=radio]),textarea,select{font-size:max(16px,1em)!important}}
#${LANDSCAPE_OVERLAY_ID}{display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;box-sizing:border-box;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center;background-color:#FFFFFF;color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;touch-action:none;-webkit-user-select:none;user-select:none}
html.dark #${LANDSCAPE_OVERLAY_ID}{background-color:#121212;color:#F5F5F5}
#${LANDSCAPE_OVERLAY_ID} svg{width:56px;height:56px;opacity:0.75}
#${LANDSCAPE_OVERLAY_ID} .shogo-lock-portrait-title{font-size:17px;font-weight:600;line-height:1.3}
#${LANDSCAPE_OVERLAY_ID} .shogo-lock-portrait-body{font-size:14px;line-height:1.4;max-width:280px;opacity:0.65}
@media (orientation:landscape) and (max-height:500px) and (pointer:coarse){#${LANDSCAPE_OVERLAY_ID}{display:flex}}`

/** The landscape rotate prompt: hidden by CSS until a phone is in landscape, then it covers the app. */
const LANDSCAPE_OVERLAY_HTML = `<div id="${LANDSCAPE_OVERLAY_ID}" role="status" aria-live="polite"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7.25" y="2.25" width="9.5" height="19.5" rx="2.25" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 5.25h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.2 9.4a6.2 6.2 0 0 1 3.1-3.05" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2.6 5.9v3.6h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><div class="shogo-lock-portrait-title">Rotate your phone</div><div class="shogo-lock-portrait-body">Shogo is built for portrait on phones — turn your phone upright to keep going.</div></div>`

module.exports = {
  PHONE_MEDIA_QUERY,
  VIEWPORT_META_CONTENT,
  ZOOM_GUARD_ATTRIBUTE,
  ZOOM_GUARD_SCRIPT,
  PHONE_GUARD_STYLE_ID,
  PHONE_VIEWPORT_GUARD_CSS,
  LANDSCAPE_OVERLAY_ID,
  LANDSCAPE_OVERLAY_HTML,
}
