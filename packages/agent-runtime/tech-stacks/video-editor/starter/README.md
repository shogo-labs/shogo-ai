# Video Editor

A Remotion project: your video compositions are React components, and one
entry file feeds both the canvas preview and the MP4 render.

## What is what

| Path | Role |
| --- | --- |
| `src/compositions.ts` | the list of compositions — **add a composition here first** |
| `src/videos/*.tsx` | the compositions themselves (plain React + Remotion hooks) |
| `src/Root.tsx` | registers every composition from `src/compositions.ts` |
| `src/index.ts` | Remotion's entry point (`registerRoot`) — used by Studio and `remotion render` |
| `src/preview.tsx` | the canvas shell: a `@remotion/player` page, **nothing else** |

## Commands

```bash
bun run build                       # what the canvas preview runs (vite build → dist/)
bun x remotion studio               # timeline editor on http://localhost:3000
bun x remotion render src/index.ts Main out/main.mp4
bun x remotion browser ensure       # once, if a render complains about the browser
```

`remotion studio` and `remotion render` both read `src/index.ts`; `bun run build`
reads `index.html` → `src/preview.tsx`. Keep composition code in `src/videos/`
so the two never disagree about what the video is.
