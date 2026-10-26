// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The Content-Security-Policy desktop stamps on every response in **local**
 * mode (cloud mode sets none, exactly like the web app). Kept as a pure
 * function so a unit test can assert the directives without booting Electron.
 *
 * `blob:` matters more than it looks. The chat file viewer fetches a shared
 * file's bytes with the app's own `fetch` and hands the media elements a
 * `blob:` URL (ShareFileViewer → MediaPreview). A directive that omits
 * `blob:` falls back to `default-src`, which has no `blob:` — so Chromium
 * refuses the source and `<video>` sits at 0:00 with no duration (SHO-229).
 * Images escaped this because `img-src` already allowed `blob:`.
 *
 * `media-src` covers `<video>`/`<audio>`, `frame-src`/`child-src` cover the
 * PDF preview's typed-`application/pdf` blob frame (SHO-224).
 */
export function buildLocalCsp(apiOrigin: string): string {
  return [
    "default-src 'self' shogo: https: http:",
    `connect-src *`,
    `frame-src 'self' shogo: blob: ${apiOrigin} http://localhost:* http://127.0.0.1:* https://*.vscode-cdn.net https:`,
    `child-src 'self' shogo: blob: ${apiOrigin} http://localhost:* http://127.0.0.1:* https://*.vscode-cdn.net https:`,
    "script-src 'self' shogo: blob: 'unsafe-inline' 'unsafe-eval'",
    "worker-src 'self' shogo: blob:",
    "style-src 'self' shogo: 'unsafe-inline'",
    "img-src * data: blob:",
    "media-src 'self' shogo: blob: data: https: http:",
    "font-src 'self' shogo: data: https:",
  ].join('; ')
}
