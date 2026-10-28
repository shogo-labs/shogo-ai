# Tech Stack — Video Editor (Remotion)

## What this project is

Your workspace **is** a Remotion project. The compositions are React components,
and the same entry file (`src/index.ts`) feeds the canvas preview, Remotion
Studio and the MP4 render.

Never create a side `studio/` folder or a second Remotion project inside this
one — there is one project, one `package.json`, one composition tree. If
Remotion feels like it clashes with "the app", the answer is that the app *is*
Remotion: `src/preview.tsx` is a small Player page, nothing more.

## Layout

```
index.html               ← Vite entry for the canvas preview
vite.config.ts           ← base = $SHOGO_BASE_PATH (per-project preview path)
remotion.config.ts       ← entry point, image format, browser executable
src/
  compositions.ts        ← THE composition list (Player + Root both read it)
  index.ts               ← registerRoot for Studio + `remotion render`
  Root.tsx               ← <Composition> per entry in compositions.ts
  preview.tsx            ← canvas shell: @remotion/player, aspect-correct, controls
  videos/
    Main.tsx             ← starter composition (1080×1920, 30fps, 5s)
out/                     ← rendered MP4s (gitignored)
dist/                    ← vite build output the runtime serves (gitignored)
```

## How the preview works — read this before changing build config

The canvas preview is **the runtime's own origin serving `dist/`**. It is not a
proxy to a dev server: the runtime runs the project's `build` script
(`vite build`), watches the sources, and rebuilds on each save. So:

- `src/preview.tsx` must render the compositions with `@remotion/player` and
  nothing else. It has no data fetching, no router, no server.
- Do **not** change `scripts.build` away from `vite build`, and do not remove
  `base: process.env.SHOGO_BASE_PATH ?? '/'` from `vite.config.ts` — preview
  URLs are served under `/p/<projectId>/`, and without that base every asset
  404s.
- There is no `server.tsx` / API sidecar in this stack. A video project has no
  backend; put any data you need in a JSON/TS module under `src/`.
- `remotion studio` is a separate dev server on its own port. It is a **quick
  command** for you and the user, not the canvas preview.

## Adding a composition

1. Create `src/videos/<Name>.tsx` — a normal React component using Remotion
   hooks (`useCurrentFrame`, `useVideoConfig`, `spring`, `interpolate`,
   `<Sequence>`, `<Audio>`, …).
2. Add one entry to `COMPOSITIONS` in `src/compositions.ts` (id, title, size,
   fps, durationInFrames, component). `Root.tsx` and the Player switcher pick
   it up automatically.
3. Save. The preview rebuilds and the switcher shows the new composition; it is
   immediately renderable by id.

Keep the composition itself free of `window`/DOM assumptions and of
`Math.random()` / `Date.now()` — renders must be deterministic and each frame
must be a pure function of `useCurrentFrame()`. Use `random('<seed>')` from
Remotion when you need randomness.

Vertical video is 1080×1920, square is 1080×1080, landscape is 1920×1080. Ask
the user which one they need if it is not obvious.

## Commands

```bash
bun run build                       # the canvas preview build (vite build)
bun x remotion studio               # Studio on http://localhost:3000 — timeline, scrub, tweak props
bun x remotion render src/index.ts Main out/main.mp4
bun x remotion render src/index.ts Main out/main.mp4 --frames=0-60   # quick check
bun x remotion browser ensure       # install the headless browser if a render asks for it
bun run typecheck                   # tsc --noEmit
```

Renders are CPU-bound: a 5-second 1080×1920 clip takes a while, and the render
is silent until it finishes. Render a short `--frames` range first to check the
comp, then the full clip. Always write renders under `out/`.

## Rendering browser

The Shogo runtime image already ships Chromium at `/usr/bin/chromium` and
exposes it as `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; `remotion.config.ts` passes
that to Remotion so a render reuses it instead of downloading Chrome Headless
Shell. If a render still fails with a browser/download error on another host,
run the **Install Render Browser** quick command (`bun x remotion browser
ensure`) once and retry.

## Media assets

- Put images/audio/fonts in `public/` and reference them with
  `staticFile('name.ext')` from `remotion` — never with a relative import path.
- Very large assets belong in `public/` too; they are served, not bundled.
- Prefer short audio clips and compressed images: every frame re-renders.

## Rules

- One project, one Remotion tree. No `studio/` folder, no second `package.json`.
- Compositions live in `src/videos/`; the preview shell stays a shell.
- Deterministic frames only — no `Math.random()`, `Date.now()`, or network
  calls inside a composition.
- `remotion`, `@remotion/cli` and `@remotion/player` must stay on the same
  version. Bump all three together.
- Keep `out/` and `dist/` out of git (`.gitignore` already does).
