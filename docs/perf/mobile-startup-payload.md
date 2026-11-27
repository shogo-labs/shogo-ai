# Mobile cold-start payload

Per-module attribution of the JavaScript a cold start parses, for the web bundle
and the iOS bundle, plus the first cut at shrinking it (SHO-601).

Regenerate the numbers with:

```bash
# web: build, then attribute what the browser fetched before first paint
cd apps/mobile && bun run build && cd ../..
node scripts/perf/payload-report.mjs --top 40             # per-module table
node scripts/perf/cold-start-probe.mjs --cpu 4 --runs 3   # first paint / router mounted

# native: same attribution over the single JS bundle
cd apps/mobile && npx expo export --platform ios --no-bytecode \
  --source-maps external --output-dir .tmp/ios-export && cd ../..
node scripts/perf/payload-report.mjs --top 40 --native apps/mobile/.tmp/ios-export
```

`payload-report.mjs` measures the eager set rather than guessing it: it serves
the export from a throwaway server, opens it in Chromium and keeps every JS
response that lands before First Contentful Paint. Bytes per module are
*generated* bytes — each source-map segment owns the minified span up to the
next segment on its line — so the column adds up to the chunk size instead of
counting unminified source.

## Why `__common` is the whole problem

Expo Router's web output puts every module that **two or more chunks** need into
`__common-*.js`, and `__common` is script-tagged in `index.html`: the browser
parses it before anything paints. Route chunks themselves are lazy (412 chunks,
28 MB), but a dependency shared between two of them is promoted into the eager
chunk. That is how 2.6 MB of TextMate grammars — one async chunk per language,
none of them needed to paint Home — ended up in front of the first frame.

Two consequences worth keeping in mind when touching this:

- a dynamic `import()` written in a module that already lives in `__common` is
  folded into `__common`, so the import has to be one hop away, in a module that
  is itself async;
- a module imported by exactly one chunk stays in that chunk, however large it is.

## Web

19 files, **14,827,545 B → 12,080,220 B (−2,747,325 B, −18.5 %)**, 4652 → 4603
mapped modules. `__common` itself: 11,979,003 B → 9,231,678 B.

Attribution after the change (top 40 by eager bytes, with the before value and
the one-line reason each module is on the boot path):

| # | module | eager bytes | before | share | why it stays eager |
|---|---|---:|---:|---:|---|
| 1 | `livekit-client/dist/livekit-client.esm.mjs` | 508.2 KB | 508.2 KB | 4.3% | Huddle media (LiveKit). Loaded lazily by `lib/huddle-media.ts`; see “What could not leave”. |
| 2 | `@sentry/conventions/dist/attributes.mjs` | 340.4 KB | 340.4 KB | 2.9% | `Sentry.init()` runs in the first frame of the root layout. |
| 3 | `ai/dist/index.mjs` | 228.9 KB | 228.9 KB | 1.9% | Chat streaming; `ChatPanel` and the turn widgets are in the first-paint shell. |
| 4 | `react-dom/cjs/react-dom-client.production.js` | 171.0 KB | 171.0 KB | 1.4% | The renderer. |
| 5 | `@mediapipe/tasks-vision/vision_bundle.mjs` | 134.4 KB | 134.4 KB | 1.1% | Camera effects for huddles — same hoist as `livekit-client`. |
| 6 | `@sentry/replay/build/npm/esm/index.js` | 125.1 KB | 125.1 KB | 1.1% | Sentry `replayIntegration`, part of `@sentry/react-native`’s own graph. |
| 7 | `components/chat/ChatPanel.tsx` | 117.5 KB | 117.5 KB | 1.0% | First-paint shell (router layout, home screen, chat panel). |
| 8 | `mobx-state-tree/dist/mobx-state-tree.module.js` | 114.7 KB | 114.7 KB | 1.0% | The domain store is created before the first screen renders. |
| 9 | `packages/agent/dist/chunk-WFQHKM7T.js` | 90.9 KB | 90.9 KB | 0.8% | Shared SDK client used during boot. |
| 10 | `streamdown/dist/chunk-D32TOXHM.js` | 86.2 KB | 86.2 KB | 0.7% | Markdown renderer for chat bubbles. |
| 11 | `app/(app)/settings.tsx` | 79.8 KB | 79.8 KB | 0.7% | First-paint shell (router layout, home screen, chat panel). |
| 12 | `app/(app)/projects/[id]/_layout.tsx` | 72.9 KB | 72.9 KB | 0.6% | First-paint shell (router layout, home screen, chat panel). |
| 13 | `mobx/dist/mobx.esm.js` | 65.7 KB | 65.7 KB | 0.6% | The domain store is created before the first screen renders. |
| 14 | `components/island/buddy/buddy-webview.generated.ts` | 62.9 KB | 62.9 KB | 0.5% | First-paint shell (router layout, home screen, chat panel). |
| 15 | `zod/v3/types.js` | 60.4 KB | 60.4 KB | 0.5% | Every API response is validated through zod. |
| 16 | `components/analytics/SharedAnalytics.tsx` | 60.1 KB | 60.1 KB | 0.5% | First-paint shell (router layout, home screen, chat panel). |
| 17 | `@sentry/core/build/esm/index.js` | 56.4 KB | 56.4 KB | 0.5% | `Sentry.init()` runs in the first frame of the root layout. |
| 18 | `@ai-sdk/provider-utils/dist/index.mjs` | 42.3 KB | 54.7 KB | 0.4% | Chat streaming; `ChatPanel` and the turn widgets are in the first-paint shell. |
| 19 | `@sentry/core/build/esm/browser.js` | 52.2 KB | 52.2 KB | 0.4% | `Sentry.init()` runs in the first frame of the root layout. |
| 20 | `@ai-sdk/gateway/dist/index.mjs` | 51.8 KB | 51.8 KB | 0.4% | Chat streaming; `ChatPanel` and the turn widgets are in the first-paint shell. |
| 21 | `components/island/buddy/engine.ts` | 51.8 KB | 51.8 KB | 0.4% | First-paint shell (router layout, home screen, chat panel). |
| 22 | `parse5/dist/parser/index.js` | 50.2 KB | 50.2 KB | 0.4% | Markdown → HTML for chat bubbles on the first screen. |
| 23 | `components/project/panels/ide/Terminal.tsx` | 50.0 KB | 50.0 KB | 0.4% | First-paint shell (router layout, home screen, chat panel). |
| 24 | `parse5/dist/tokenizer/index.js` | 49.3 KB | — | 0.4% | Markdown → HTML for chat bubbles on the first screen. |
| 25 | `@sentry/feedback/build/npm/esm/index.js` | 48.3 KB | — | 0.4% | `Sentry.init()` runs in the first frame of the root layout. |
| 26 | `entities/dist/esm/generated/decode-data-html.js` | 46.6 KB | — | 0.4% | Markdown → HTML for chat bubbles on the first screen. |
| 27 | `marked/lib/marked.esm.js` | 46.2 KB | — | 0.4% | Markdown fallback renderer. |
| 28 | `components/chat/ChatInput.tsx` | 45.9 KB | — | 0.4% | First-paint shell (router layout, home screen, chat panel). |
| 29 | `date-fns/index.js` | 45.2 KB | — | 0.4% | Message and run timestamps. |
| 30 | `components/team-chat/MessageRow.tsx` | 41.0 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 31 | `lib/api.ts` | 38.9 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 32 | `components/project/panels/ChannelsPanel.tsx` | 38.8 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 33 | `packages/sdk/dist/index.js` | 38.0 KB | — | 0.3% | Shared SDK client used during boot. |
| 34 | `zod/v4/core/schemas.js` | 37.7 KB | — | 0.3% | Every API response is validated through zod. |
| 35 | `components/project/panels/CapabilitiesPanel.tsx` | 36.2 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 36 | `components/admin/ModelsCard.tsx` | 34.5 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 37 | `app/(admin)/admin/settings.tsx` | 31.6 KB | — | 0.3% | First-paint shell (router layout, home screen, chat panel). |
| 38 | `tailwind-merge/dist/bundle-mjs.mjs` | 30.1 KB | — | 0.3% | `cn()` className merge on every component. |
| 39 | `zod/v4/classic/schemas.js` | 28.7 KB | — | 0.2% | Every API response is validated through zod. |

Modules that left the eager set (the 17 that were in the top 40 by eager bytes;
the remaining `@shikijs/langs` grammars sat below the cut — 2.62 MB in total, now
one async chunk loaded by the code previews):

| removed module | before |
|---|---:|
| `@shikijs/langs/dist/cpp.mjs` | 418.8 KB |
| `@shikijs/langs/dist/cpp-macro.mjs` | 234.2 KB |
| `@shikijs/langs/dist/typescript.mjs` | 186.3 KB |
| `@shikijs/langs/dist/jsx.mjs` | 183.5 KB |
| `@shikijs/langs/dist/tsx.mjs` | 181.3 KB |
| `@shikijs/langs/dist/javascript.mjs` | 180.6 KB |
| `@shikijs/langs/dist/php.mjs` | 115.7 KB |
| `@shikijs/langs/dist/less.mjs` | 105.6 KB |
| `@shikijs/langs/dist/csharp.mjs` | 97.1 KB |
| `@shikijs/langs/dist/fortran-free-form.mjs` | 96.3 KB |
| `@shikijs/langs/dist/c.mjs` | 76.3 KB |
| `@shikijs/langs/dist/python.mjs` | 75.4 KB |
| `@shikijs/langs/dist/markdown.mjs` | 63.8 KB |
| `@shikijs/langs/dist/html.mjs` | 61.0 KB |
| `@shikijs/langs/dist/css.mjs` | 51.0 KB |
| `@shikijs/langs/dist/ruby.mjs` | 50.7 KB |
| `@shikijs/langs/dist/go.mjs` | 50.7 KB |

## Native (iOS)

One bundle, no code splitting: `expo export --platform ios --no-bytecode`
weighs **20,446,533 B before and after** — byte-identical, because the
highlighting widgets are `.web.tsx` and `shiki` never entered the native graph
(0 shiki sources in the bundle). Every module in this table is therefore eager;
this is where native launch cost actually lives.

| # | module | bytes | share | why it is in the bundle |
|---|---|---:|---:|---|
| 1 | `react-native-css-interop/.cache/ios.js` | 1.80 MB | 9.2% | NativeWind: className → style at render time. |
| 2 | `components/project/panels/ide/monaco/extraLibs.generated.ts` | 1.08 MB | 5.5% | Monaco type definitions for the IDE panel; native has no code splitting. |
| 3 | `livekit-client/dist/livekit-client.esm.mjs` | 575.0 KB | 2.9% | Huddle media; inlined on native. |
| 4 | `lucide-react-native/dist/esm/lucide-react-native.js` | 506.5 KB | 2.5% | Icons; inlined on native. |
| 5 | `@xterm/xterm/lib/xterm.js` | 474.4 KB | 2.4% | Terminal; inlined on native (async-split on web). |
| 6 | `@sentry/conventions/dist/attributes.mjs` | 340.4 KB | 1.7% | `Sentry.init()` at boot. |
| 7 | `ai/dist/index.mjs` | 227.9 KB | 1.1% | Chat streaming. |
| 8 | `lucide-react-native/dist/esm/icons/index.js` | 174.1 KB | 0.9% | Icons; inlined on native. |
| 9 | `@sentry/replay/build/npm/esm/index.js` | 123.6 KB | 0.6% | `Sentry.init()` at boot. |
| 10 | `react-native/Libraries/Renderer/implementations/ReactFabric-prod.js` | 116.9 KB | 0.6% | The renderer. |
| 11 | `components/chat/ChatPanel.tsx` | 115.4 KB | 0.6% | First-paint shell. |
| 12 | `mobx-state-tree/dist/mobx-state-tree.module.js` | 114.7 KB | 0.6% | Domain store. |
| 13 | `packages/agent/dist/chunk-WFQHKM7T.js` | 90.8 KB | 0.5% | Shared SDK client. |
| 14 | `@livekit/components-react/dist/contexts-D4V9wQRc.mjs` | 82.1 KB | 0.4% | Huddle media. |
| 15 | `app/(app)/settings.tsx` | 78.2 KB | 0.4% | First-paint shell. |
| 16 | `@xterm/addon-search/lib/addon-search.js` | 76.9 KB | 0.4% | First-paint graph. |
| 17 | `@siteed/audio-studio/build/cjs/workers/wasmGlueString.web.js` | 69.9 KB | 0.3% | Audio recording for meetings/dictation. |
| 18 | `app/(app)/projects/[id]/_layout.tsx` | 66.8 KB | 0.3% | First-paint shell. |
| 19 | `mobx/dist/mobx.esm.js` | 65.7 KB | 0.3% | Domain store. |
| 20 | `components/project/panels/ide/Workbench.tsx` | 65.4 KB | 0.3% | First-paint shell. |
| 21 | `components/island/buddy/buddy-webview.generated.ts` | 62.9 KB | 0.3% | First-paint shell. |
| 22 | `web-streams-polyfill/dist/ponyfill.mjs` | 61.5 KB | 0.3% | First-paint graph. |
| 23 | `expo/virtual/streams.js` | 61.0 KB | 0.3% | First-paint graph. |
| 24 | `components/analytics/SharedAnalytics.tsx` | 59.3 KB | 0.3% | First-paint shell. |
| 25 | `@sentry/core/build/esm/index.js` | 56.3 KB | 0.3% | `Sentry.init()` at boot. |
| 26 | `zod/v3/types.cjs` | 55.9 KB | 0.3% | API payload validation. |
| 27 | `@ai-sdk/provider-utils/dist/index.mjs` | 54.5 KB | 0.3% | Chat streaming. |
| 28 | `@sentry/core/build/esm/browser.js` | 52.1 KB | 0.3% | `Sentry.init()` at boot. |
| 29 | `@ai-sdk/gateway/dist/index.mjs` | 51.7 KB | 0.3% | Chat streaming. |
| 30 | `components/island/buddy/engine.ts` | 51.3 KB | 0.3% | First-paint shell. |
| 31 | `app/(app)/projects/index.tsx` | 51.1 KB | 0.3% | First-paint shell. |
| 32 | `@sentry/feedback/build/npm/esm/index.js` | 48.1 KB | 0.2% | `Sentry.init()` at boot. |
| 33 | `packages/email/dist/chunk-T2TLSP7M.js` | 47.3 KB | 0.2% | Shared SDK client. |
| 34 | `@livekit/components-react/dist/hooks-hQJmeINB.mjs` | 45.9 KB | 0.2% | Huddle media. |
| 35 | `date-fns/index.js` | 45.2 KB | 0.2% | Timestamps. |
| 36 | `components/chat/ChatInput.tsx` | 43.3 KB | 0.2% | First-paint shell. |
| 37 | `@ai-sdk/provider-utils/dist/index.mjs` | 42.3 KB | 0.2% | Chat streaming. |
| 38 | `marked/lib/marked.esm.js` | 40.3 KB | 0.2% | First-paint graph. |
| 39 | `components/project/panels/ChannelsPanel.tsx` | 38.2 KB | 0.2% | First-paint shell. |
| 40 | `packages/sdk/dist/index.js` | 37.7 KB | 0.2% | Shared SDK client. |

## What could not leave, and why

- **`livekit-client` (508 KB) and `@mediapipe/tasks-vision` (134 KB) on web** —
  both are reached through `lib/huddle-media.ts`, which every screen imports (it
  backs `HuddleDock`), and Metro promotes the static dependencies of that dynamic
  target into `__common`. Moving them needs the huddle media factory to hang off
  a module that is only reachable from a lazy chunk — a change to the huddle
  wiring, not a build tweak, so it belongs on its own card.
- **Sentry (~1.0 MB)** — `Sentry.init()` runs in the root layout before the first
  frame, and `@sentry/react-native` pulls `@sentry/conventions`,
  `@sentry/replay` and `@sentry/feedback` as one graph. Splitting it means losing
  early error capture, which is a product decision.
- **`ai` + `@ai-sdk/*` (~330 KB), `streamdown`/`marked`/`parse5` (~270 KB),
  `zod` (~430 KB), `mobx-state-tree`/`mobx` (~180 KB)** — all on the path that
  renders a chat turn, which is the first screen of the app. Nothing to strip
  without changing what Home shows.
- **`app/(app)/settings.tsx` (80 KB) and the `(admin)` route group** — the router
  loads every route group's layout at boot; the admin group is only excluded when
  `EXPO_PUBLIC_LOCAL_MODE=true` (see `apps/mobile/metro.config.js`).

## Cold start (4× CPU, 390×844, sign-in path, 3 runs)

| | before | after |
|---|---:|---:|
| first contentful paint | 1668 ms | 1576 ms |
| router mounted (`root:layout:mounted`) | 1333 ms | 1238 ms |
| eager JS fetched before FCP | 13.81 MB | 11.19 MB |

The probe reaches the sign-in screen in both runs (the harness serves static
files with no API), so these are shell numbers rather than Home-with-data
numbers; the parse saving is the part that carries over. Neither metric
regressed.
